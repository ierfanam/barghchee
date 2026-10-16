import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { GsmModem } from './gsmModem';
import {
  ulawEncode,
  ulawDecode,
  resamplePcm,
  parseWav,
  dtmfCode,
  dtmfDigit,
  normalizePersian,
} from './audio';

export interface TelephonySubscriber {
  id?: string;
  name: string;
  phone: string;
  debt: number;
  region?: string;
  billId?: string;
  lastPayment?: string;
  averageConsumption?: string;
}

export interface TranscriptLine {
  time: string;
  speaker: 'ai' | 'caller' | 'system' | 'dtmf';
  text: string;
}

export interface CallRecord {
  id: string;
  direction: 'outbound' | 'inbound';
  subscriber: TelephonySubscriber;
  state: 'dialing' | 'ringing' | 'connected' | 'ended';
  transport: 'sip' | 'browser' | 'gsm' | 'none';
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  aiMode: 'local';
  tone?: string;
  transcript: TranscriptLine[];
  dtmfLog: { time: string; digit: string }[];
}

// Tunable AI conversation strategy (set from the dashboard, persisted server-side)
export interface StrategyProfile {
  tone: string;            // friendly | firm | compromise
  empathyLevel: number;    // 0..100
  persistenceLevel: number;// 0..100 -> controls menu repeat attempts
  responseDelayMs: number; // extra pause between AI sentences
  language: string;        // fa | az | ar | en (bilingual IVR prompts)
  llmEnabled: boolean;     // free-voice intent understanding via Gemini when available
}

const defaultStrategy: StrategyProfile = {
  tone: 'friendly',
  empathyLevel: 75,
  persistenceLevel: 80,
  responseDelayMs: 300,
  language: 'fa',
  llmEnabled: true,
};

// Local rule-based Persian intent classifier (zero-dependency NLU).
// Returns an intent tag used both by the engine and exposed via /api/nlu.
export function classifyIntent(rawText: string): { intent: string; confidence: number } {
  const t = normalizePersian(String(rawText || '')).toLowerCase();
  if (!t) return { intent: 'unknown', confidence: 0 };
  const rules: [string, RegExp][] = [
    ['pay_now', /پرداخت|تسویه|پردا?خت می?کنم|همین الان|واریز|cart به cart|کارت به کارت/],
    ['installment', /قسط|اقساط|تقسيط|بخش?بندی|چند مرحله/],
    ['operator', /انسانی|اپراتور|مشاور|نفر|مسئول|پشتیبانی/],
    ['amount_question', /مبلغ|چقدر|قیمت|چنده|رقم| بدهی|بدهکار/],
    ['already_paid', /قبلاً? پرداخت|داده?ام|پرداختم|تسویه کردم|واریز کردم/],
    ['complaint', /شکایت|اعتراض|بد|توهین|مزاحم|قضاوت/],
    ['repeat', /تکرار|دوباره|باز بگو|نفهمیدم|صدا? clear نبود/],
    ['no_debt', /ندارم|بدهکار نیستم|اشتباه/],
    ['goodbye', /خداحافظ|خدافظ|فعلا|باخدا/],
    ['yes', /^(بله|آره|حتما|قربان|چشم|اوکی|باشه)/],
    ['no', /^(نه|نمی?خواهم|اصلا|کیف نمی?کنم)/],
  ];
  for (const [intent, re] of rules) {
    if (re.test(t)) return { intent, confidence: 0.85 };
  }
  return { intent: 'unknown', confidence: 0.3 };
}

let activeStrategy: StrategyProfile = { ...defaultStrategy };

export function setGlobalStrategy(s: Partial<StrategyProfile>) {
  activeStrategy = { ...activeStrategy, ...s };
}

export function getGlobalStrategy(): StrategyProfile {
  return activeStrategy;
}

function nowIso() {
  return new Date().toISOString();
}

function faNumber(n: number): string {
  return n.toLocaleString('fa-IR');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function estimateSpeechMs(text: string): number {
  return Math.min(15000, Math.max(2500, text.length * 220));
}

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

interface CallLeg {
  transport: 'sip' | 'browser' | 'gsm';
  connected: boolean;
  sendAudio(pcm16k: Buffer): void;
  sendDtmf(digit: string): void;
  sendText(text: string): void;
  onAudio: ((pcm16k: Buffer) => void) | null;
  onDtmf: ((digit: string) => void) | null;
  onConnected: (() => void) | null;
  onTerminated: (() => void) | null;
  close(): void;
}

class RtpSession {
  readonly localPort: number;
  private socket: dgram.Socket;
  private remoteAddr = '';
  private remotePort = 0;
  private ssrc: number;
  private seq = 0;
  private timestamp = 0;
  onAudio: ((pcm16k: Buffer) => void) | null = null;
  onDtmf: ((digit: string) => void) | null = null;

  constructor(port: number) {
    this.localPort = port;
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => this.handlePacket(buf, rinfo));
    this.socket.on('error', () => {});
    this.socket.bind(port, '0.0.0.0');
  }

  setRemote(addr: string, port: number) {
    this.remoteAddr = addr;
    this.remotePort = port;
  }

  sendPcm16k(pcm: Buffer) {
    if (!this.remoteAddr || !this.remotePort || pcm.length === 0) return;
    const pcm8k = resamplePcm(pcm, 16000, 8000);
    const frameLen = 160;
    for (let off = 0; off + frameLen * 2 <= pcm8k.length; off += frameLen * 2) {
      const frame = pcm8k.subarray(off, off + frameLen * 2);
      const encoded = Buffer.alloc(frameLen);
      for (let i = 0; i < frameLen; i++) {
        encoded[i] = ulawEncode(frame.readInt16LE(i * 2));
      }
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = 0x00;
      header.writeUInt16BE(this.seq++ & 0xffff, 2);
      header.writeUInt32BE(this.timestamp & 0xffffffff, 4);
      header.writeUInt32BE(this.ssrc, 8);
      this.socket.send(Buffer.concat([header, encoded]), this.remotePort, this.remoteAddr);
      this.timestamp += frameLen;
    }
  }

  sendDtmf(digit: string) {
    const code = dtmfCode(digit);
    if (code < 0 || !this.remoteAddr) return;
    for (let i = 0; i < 3; i++) {
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = 101;
      header.writeUInt16BE(this.seq++ & 0xffff, 2);
      header.writeUInt32BE(this.timestamp & 0xffffffff, 4);
      header.writeUInt32BE(this.ssrc, 8);
      const payload = Buffer.from([code, 0x00, 0xa0, 0x0a]);
      this.socket.send(Buffer.concat([header, payload]), this.remotePort, this.remoteAddr);
      this.timestamp += 160;
    }
  }

  private handlePacket(buf: Buffer, rinfo: dgram.RemoteInfo) {
    if (buf.length < 12) return;
    const payloadType = buf[1] & 0x7f;
    const payload = buf.subarray(12);
    if (payloadType === 101) {
      if (payload.length >= 4 && this.onDtmf) {
        const digit = dtmfDigit(payload[0]);
        if (digit) this.onDtmf(digit);
      }
      return;
    }
    if (payloadType !== 0 || payload.length === 0) return;
    const decoded = Buffer.alloc(payload.length * 2);
    for (let i = 0; i < payload.length; i++) {
      decoded.writeInt16LE(ulawDecode(payload[i]), i * 2);
    }
    const pcm16k = resamplePcm(decoded, 8000, 16000);
    if (this.onAudio) this.onAudio(pcm16k);
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

function allocateRtpPort(): number {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 10000 + Math.floor(Math.random() * 10000);
    if (port % 2 !== 0) continue;
    const test = dgram.createSocket('udp4');
    let ok = false;
    try {
      test.bind(port, '0.0.0.0');
      ok = true;
    } catch {}
    test.close();
    if (ok) return port;
  }
  return 12000;
}

interface SipDialog {
  callId: string;
  localTag: string;
  remoteTag: string;
  target: string;
  remoteAddr: string;
  remotePort: number;
  rtpPort: number;
  state: 'calling' | 'ringing' | 'connected' | 'terminated';
  rtp: RtpSession;
  onConnected: (() => void) | null;
  onTerminated: (() => void) | null;
}

class SipStack {
  readonly localPort: number;
  readonly localIp: string;
  private socket: dgram.Socket;
  private dialogs = new Map<string, SipDialog>();
  private registered = false;
  private registerTimer: any = null;
  private _pendingRegisterAuth: ((auth?: string) => void) | null = null;
  onIncomingCall: ((dialog: SipDialog, callerNumber: string) => void) | null = null;

  constructor(port = 5060) {
    this.localPort = port;
    this.localIp = getLocalIp();
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.handleMessage(buf.toString('utf-8'), rinfo);
      } catch {}
    });
    this.socket.on('error', () => {});
    this.socket.bind(port, '0.0.0.0');
    this.startRegistration();
  }

  get isRegistered() {
    return this.registered;
  }

  get proxyHost() {
    return process.env.SIP_PROXY_HOST || '';
  }

  get proxyPort() {
    return Number(process.env.SIP_PROXY_PORT || 5060);
  }

  private branch() {
    return 'z9hG4bK' + Math.random().toString(36).slice(2, 12);
  }

  private tag() {
    return Math.random().toString(36).slice(2, 10);
  }

  private send(msg: string, host: string, port: number) {
    this.socket.send(msg, port, host, () => {});
  }

  private startRegistration() {
    const username = process.env.SIP_USERNAME;
    if (!username || !this.proxyHost) return;
    const doRegister = (auth?: string) => {
      const fromUri = process.env.SIP_FROM_URI || `sip:${username}@${this.proxyHost}`;
      const callId = `reg-${Date.now()}-${this.tag()}`;
      const lines = [
        `REGISTER sip:${this.proxyHost} SIP/2.0`,
        `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${this.branch()}`,
        `From: <${fromUri}>;tag=${this.tag()}`,
        `To: <${fromUri}>`,
        `Call-ID: ${callId}`,
        `CSeq: 1 REGISTER`,
        `Contact: <sip:${username}@${this.localIp}:${this.localPort}>`,
        `Expires: 3600`,
        `Max-Forwards: 70`,
        `User-Agent: IlamElectricity-AI-PBX/1.0`,
      ];
      if (auth) lines.push(`Authorization: ${auth}`);
      lines.push(`Content-Length: 0`, ``, ``);
      this.send(lines.join('\r\n'), this.proxyHost, this.proxyPort);
    };
    doRegister();
    this.registerTimer = setInterval(() => doRegister(), 30 * 60 * 1000);
    this._pendingRegisterAuth = doRegister;
  }

  invite(target: string, host: string, port: number): SipDialog {
    const callId = `call-${Date.now()}-${this.tag()}`;
    const localTag = this.tag();
    const rtpPort = allocateRtpPort();
    const rtp = new RtpSession(rtpPort);
    const sdp = [
      'v=0',
      `o=- ${Date.now()} 0 IN IP4 ${this.localIp}`,
      's=-',
      `c=IN IP4 ${this.localIp}`,
      't=0 0',
      `m=audio ${rtpPort} RTP/AVP 0 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-15',
      'a=sendrecv',
      '',
    ].join('\r\n');
    const fromUri = process.env.SIP_FROM_URI || `sip:operator@${this.localIp}:${this.localPort}`;
    const msg = [
      `INVITE sip:${target}@${host}:${port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${this.branch()}`,
      `From: <sip:${fromUri}>;tag=${localTag}`,
      `To: <sip:${target}@${host}:${port}>`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:${fromUri}>`,
      `Max-Forwards: 70`,
      `User-Agent: IlamElectricity-AI-PBX/1.0`,
      `Content-Type: application/sdp`,
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      ``,
      sdp,
    ].join('\r\n');

    const dialog: SipDialog = {
      callId,
      localTag,
      remoteTag: '',
      target,
      remoteAddr: host,
      remotePort: port,
      rtpPort,
      state: 'calling',
      rtp,
      onConnected: null,
      onTerminated: null,
    };
    this.dialogs.set(callId, dialog);
    this.send(msg, host, port);

    return dialog;
  }

  private handleMessage(text: string, rinfo: dgram.RemoteInfo) {
    const lines = text.split('\r\n');
    const first = lines[0] || '';
    const headers = new Map<string, string>();
    let body = '';
    let inBody = false;
    for (const line of lines.slice(1)) {
      if (line === '') {
        inBody = true;
        continue;
      }
      if (!inBody) {
        const idx = line.indexOf(':');
        if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
      } else {
        body += line + '\r\n';
      }
    }

    const callId = (headers.get('call-id') || '').trim();
    const via = headers.get('via') || '';

    if (first.startsWith('SIP/2.0')) {
      const status = parseInt(first.split(' ')[1] || '0', 10);
      this.handleResponse(status, headers, body, rinfo, callId);
      return;
    }

    const method = first.split(' ')[0];
    if (method === 'INVITE') this.handleInvite(first, headers, body, rinfo, callId);
    else if (method === 'BYE') this.handleBye(headers, rinfo, callId);
    else if (method === 'CANCEL') this.handleCancel(headers, rinfo, callId);
    else if (method === 'REGISTER') this.handleRegister(headers, rinfo);
    else if (method === 'ACK' || method === 'OPTIONS' || method === 'INFO' || method === 'NOTIFY' || method === 'SUBSCRIBE') {
      const resp = [
        `SIP/2.0 200 OK`,
        via ? `Via: ${via}` : '',
        headers.get('from') ? `From: ${headers.get('from')}` : '',
        headers.get('to') ? `To: ${headers.get('to')}` : '',
        headers.get('call-id') ? `Call-ID: ${callId}` : '',
        headers.get('cseq') ? `CSeq: ${headers.get('cseq')}` : '',
        `Content-Length: 0`,
        ``,
        ``,
      ].filter(Boolean).join('\r\n');
      this.send(resp, rinfo.address, rinfo.port);
    }
  }

  private handleResponse(status: number, headers: Map<string, string>, body: string, rinfo: dgram.RemoteInfo, callId: string) {
    if (status === 401 && this._pendingRegisterAuth) {
      const wwwAuth = headers.get('www-authenticate') || '';
      const realm = (wwwAuth.match(/realm="([^"]+)"/i) || [])[1] || '';
      const nonce = (wwwAuth.match(/nonce="([^"]+)"/i) || [])[1] || '';
      const username = process.env.SIP_USERNAME || '';
      const password = process.env.SIP_PASSWORD || '';
      const uri = `sip:${this.proxyHost}`;
      const ha1 = md5(`${username}:${realm}:${password}`);
      const ha2 = md5(`REGISTER:${uri}`);
      const response = md5(`${ha1}:${nonce}:${ha2}`);
      const auth = `Digest username="${username}",realm="${realm}",nonce="${nonce}",uri="${uri}",response="${response}"`;
      this._pendingRegisterAuth(auth);
      return;
    }

    const dialog = this.dialogs.get(callId);
    if (!dialog) return;

    if (status === 200 && (headers.get('content-type') || '').includes('sdp')) {
      const remotePortMatch = body.match(/m=audio\s+(\d+)/i);
      const remoteIpMatch = body.match(/c=IN IP4\s+([\d.]+)/i);
      if (remotePortMatch) {
        dialog.remoteAddr = remoteIpMatch ? remoteIpMatch[1] : rinfo.address;
        dialog.remotePort = parseInt(remotePortMatch[1], 10);
        dialog.rtp.setRemote(dialog.remoteAddr, dialog.remotePort);
      }
      const toHeader = headers.get('to') || '';
      const toTag = (toHeader.match(/tag=([^;\s]+)/i) || [])[1] || '';
      dialog.remoteTag = toTag;
      dialog.state = 'connected';
      const fromUri = process.env.SIP_FROM_URI || `sip:operator@${this.localIp}:${this.localPort}`;
      const ack = [
        `ACK sip:${dialog.target}@${dialog.remoteAddr}:${dialog.remotePort} SIP/2.0`,
        `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${this.branch()}`,
        `From: <sip:${fromUri}>;tag=${dialog.localTag}`,
        `To: <sip:${dialog.target}@${dialog.remoteAddr}:${dialog.remotePort}>;tag=${dialog.remoteTag}`,
        `Call-ID: ${dialog.callId}`,
        `CSeq: 1 ACK`,
        `Max-Forwards: 70`,
        `Content-Length: 0`,
        ``,
        ``,
      ].join('\r\n');
      this.send(ack, dialog.remoteAddr, dialog.remotePort);
      if (dialog.onConnected) dialog.onConnected();
    } else if (status >= 300) {
      dialog.state = 'terminated';
      this.dialogs.delete(callId);
      dialog.rtp.close();
      if (dialog.onTerminated) dialog.onTerminated();
    }
  }

  private handleInvite(first: string, headers: Map<string, string>, body: string, rinfo: dgram.RemoteInfo, callId: string) {
    const fromHeader = headers.get('from') || '';
    const fromMatch = fromHeader.match(/<sip:([^@>]+)@/i);
    const callerNumber = fromMatch ? fromMatch[1] : 'unknown';
    const fromTag = (fromHeader.match(/tag=([^;\s]+)/i) || [])[1] || this.tag();
    const rtpPort = allocateRtpPort();
    const rtp = new RtpSession(rtpPort);
    const remotePortMatch = body.match(/m=audio\s+(\d+)/i);
    const remoteIpMatch = body.match(/c=IN IP4\s+([\d.]+)/i);
    if (remotePortMatch) {
      rtp.setRemote(remoteIpMatch ? remoteIpMatch[1] : rinfo.address, parseInt(remotePortMatch[1], 10));
    }
    const localTag = this.tag();
    const sdp = [
      'v=0',
      `o=- ${Date.now()} 0 IN IP4 ${this.localIp}`,
      's=-',
      `c=IN IP4 ${this.localIp}`,
      't=0 0',
      `m=audio ${rtpPort} RTP/AVP 0 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-15',
      'a=sendrecv',
      '',
    ].join('\r\n');
    const dialog: SipDialog = {
      callId,
      localTag,
      remoteTag: fromTag,
      target: callerNumber,
      remoteAddr: rinfo.address,
      remotePort: rinfo.port,
      rtpPort,
      state: 'ringing',
      rtp,
      onConnected: null,
      onTerminated: null,
    };
    this.dialogs.set(callId, dialog);

    const ringing = [
      `SIP/2.0 180 Ringing`,
      `Via: ${headers.get('via') || ''}`,
      `From: ${fromHeader}`,
      `To: ${headers.get('to') || ''};tag=${localTag}`,
      `Call-ID: ${callId}`,
      `CSeq: ${headers.get('cseq') || '1 INVITE'}`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join('\r\n');
    this.send(ringing, rinfo.address, rinfo.port);

    const ok = [
      `SIP/2.0 200 OK`,
      `Via: ${headers.get('via') || ''}`,
      `From: ${fromHeader}`,
      `To: ${headers.get('to') || ''};tag=${localTag}`,
      `Call-ID: ${callId}`,
      `CSeq: ${headers.get('cseq') || '1 INVITE'}`,
      `Contact: <sip:operator@${this.localIp}:${this.localPort}>`,
      `Content-Type: application/sdp`,
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      ``,
      sdp,
    ].join('\r\n');
    this.send(ok, rinfo.address, rinfo.port);

    dialog.state = 'connected';
    if (this.onIncomingCall) this.onIncomingCall(dialog, callerNumber);
  }

  private handleBye(headers: Map<string, string>, rinfo: dgram.RemoteInfo, callId: string) {
    const resp = [
      `SIP/2.0 200 OK`,
      `Via: ${headers.get('via') || ''}`,
      `From: ${headers.get('from') || ''}`,
      `To: ${headers.get('to') || ''}`,
      `Call-ID: ${callId}`,
      `CSeq: ${headers.get('cseq') || ''}`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join('\r\n');
    this.send(resp, rinfo.address, rinfo.port);
    const dialog = this.dialogs.get(callId);
    if (dialog) {
      dialog.state = 'terminated';
      this.dialogs.delete(callId);
      dialog.rtp.close();
      if (dialog.onTerminated) dialog.onTerminated();
    }
  }

  private handleCancel(headers: Map<string, string>, rinfo: dgram.RemoteInfo, callId: string) {
    const resp = [
      `SIP/2.0 200 OK`,
      `Via: ${headers.get('via') || ''}`,
      `From: ${headers.get('from') || ''}`,
      `To: ${headers.get('to') || ''}`,
      `Call-ID: ${callId}`,
      `CSeq: ${headers.get('cseq') || ''}`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join('\r\n');
    this.send(resp, rinfo.address, rinfo.port);
    const dialog = this.dialogs.get(callId);
    if (dialog) {
      dialog.state = 'terminated';
      this.dialogs.delete(callId);
      dialog.rtp.close();
      if (dialog.onTerminated) dialog.onTerminated();
    }
  }

  private handleRegister(headers: Map<string, string>, rinfo: dgram.RemoteInfo) {
    const resp = [
      `SIP/2.0 200 OK`,
      `Via: ${headers.get('via') || ''}`,
      `From: ${headers.get('from') || ''}`,
      `To: ${headers.get('to') || ''}`,
      `Call-ID: ${headers.get('call-id') || ''}`,
      `CSeq: ${headers.get('cseq') || ''}`,
      `Contact: ${headers.get('contact') || ''}`,
      `Expires: 3600`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join('\r\n');
    this.send(resp, rinfo.address, rinfo.port);
  }

  sendBye(dialog: SipDialog) {
    if (dialog.state === 'terminated') return;
    const fromUri = process.env.SIP_FROM_URI || `sip:operator@${this.localIp}:${this.localPort}`;
    const msg = [
      `BYE sip:${dialog.target}@${dialog.remoteAddr}:${dialog.remotePort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${this.branch()}`,
      `From: <sip:${fromUri}>;tag=${dialog.localTag}`,
      `To: <sip:${dialog.target}@${dialog.remoteAddr}:${dialog.remotePort}>${dialog.remoteTag ? `;tag=${dialog.remoteTag}` : ''}`,
      `Call-ID: ${dialog.callId}`,
      `CSeq: 2 BYE`,
      `Max-Forwards: 70`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join('\r\n');
    dialog.state = 'terminated';
    this.send(msg, dialog.remoteAddr, dialog.remotePort);
    this.dialogs.delete(dialog.callId);
    dialog.rtp.close();
  }

  waitForAnswer(dialog: SipDialog, timeoutMs = 30000): Promise<SipDialog> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (dialog.state !== 'connected') {
          dialog.state = 'terminated';
          this.dialogs.delete(dialog.callId);
          dialog.rtp.close();
          reject(new Error('no_answer'));
        }
      }, timeoutMs);
      const check = setInterval(() => {
        if (dialog.state === 'connected') {
          clearInterval(check);
          clearTimeout(timer);
          resolve(dialog);
        } else if (dialog.state === 'terminated') {
          clearInterval(check);
          clearTimeout(timer);
          reject(new Error('call_failed'));
        }
      }, 200);
    });
  }
}

class BrowserLeg implements CallLeg {
  transport = 'browser' as const;
  connected = false;
  onAudio: ((pcm16k: Buffer) => void) | null = null;
  onDtmf: ((digit: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onTerminated: (() => void) | null = null;

  constructor(
    private ws: WebSocket,
    readonly callId: string,
    readonly phoneId: string,
    private sendFn: (ws: WebSocket, obj: any) => void,
  ) {}

  sendAudio(pcm16k: Buffer) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendFn(this.ws, { type: 'audio', callId: this.callId, pcm: pcm16k.toString('base64') });
    }
  }

  sendDtmf(digit: string) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendFn(this.ws, { type: 'dtmf', callId: this.callId, digit });
    }
  }

  sendText(text: string) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendFn(this.ws, { type: 'speak', callId: this.callId, text });
    }
  }

  accept() {
    this.connected = true;
    if (this.onConnected) this.onConnected();
  }

  close() {
    this.connected = false;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.sendFn(this.ws, { type: 'callEnded', callId: this.callId });
    }
    if (this.onTerminated) this.onTerminated();
  }
}

class GsmLeg implements CallLeg {
  transport = 'gsm' as const;
  connected = false;
  onAudio: ((pcm16k: Buffer) => void) | null = null;
  onDtmf: ((digit: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onTerminated: (() => void) | null = null;

  constructor(private modem: GsmModem) {}

  sendAudio(pcm16k: Buffer) {
    this.modem.sendAudio(pcm16k);
  }

  sendDtmf(digit: string) {
    this.modem.sendDtmf(digit);
  }

  sendText(_text: string) {}

  close() {
    this.connected = false;
  }
}

class SipCallLeg implements CallLeg {
  transport = 'sip' as const;
  connected = false;
  onAudio: ((pcm16k: Buffer) => void) | null = null;
  onDtmf: ((digit: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onTerminated: (() => void) | null = null;

  constructor(private dialog: SipDialog, private stack: SipStack) {
    dialog.rtp.onAudio = (pcm) => {
      if (this.onAudio) this.onAudio(pcm);
    };
    dialog.rtp.onDtmf = (digit) => {
      if (this.onDtmf) this.onDtmf(digit);
    };
  }

  sendAudio(pcm16k: Buffer) {
    this.dialog.rtp.sendPcm16k(pcm16k);
  }

  sendDtmf(digit: string) {
    this.dialog.rtp.sendDtmf(digit);
  }

  sendText(_text: string) {}

  fireConnected() {
    this.connected = true;
    if (this.onConnected) this.onConnected();
  }

  fireTerminated() {
    this.connected = false;
    if (this.onTerminated) this.onTerminated();
  }

  close() {
    this.connected = false;
    try {
      this.stack.sendBye(this.dialog);
    } catch {}
  }
}

class LocalTts {
  private espeakPath: string;
  private available: boolean | null = null;

  constructor() {
    this.espeakPath = process.env.ESPEAK_PATH || 'espeak';
  }

  get isAvailable() {
    return this.available !== false;
  }

  async synthesize(text: string): Promise<Buffer | null> {
    if (this.available === false) return null;
    try {
      const wav = await this.runEspeak(text);
      if (!wav || wav.length < 44) {
        this.available = false;
        return null;
      }
      const { pcm, sampleRate } = parseWav(wav);
      if (pcm.length === 0) {
        this.available = false;
        return null;
      }
      return resamplePcm(pcm, sampleRate, 16000);
    } catch {
      this.available = false;
      return null;
    }
  }

  private runEspeak(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.espeakPath, ['--stdout', '-v', 'fa', text], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error('espeak exit ' + code));
      });
      proc.on('error', reject);
    });
  }
}

type EngineEvent =
  | { type: 'line'; text: string }
  | { type: 'ended'; outcome: string };

type EngineStage =
  | 'greeting'
  | 'notice'
  | 'menu'
  | 'payment_date'
  | 'payment_confirm'
  | 'installment_offer'
  | 'installment_confirm'
  | 'operator'
  | 'wrapup'
  | 'done';

class ConversationEngine {
  private stage: EngineStage = 'greeting';
  private menuRepeats = 0;
  private repeatTimer: any = null;
  private ended = false;
  private chain: Promise<any> = Promise.resolve();
  private strategy: StrategyProfile;

  constructor(
    private subscriber: TelephonySubscriber,
    private emit: (e: EngineEvent) => Promise<void>,
    strategy?: Partial<StrategyProfile>,
  ) {
    this.strategy = { ...activeStrategy, ...(strategy || {}) };
  }

  // Effective number of menu repeats before giving up (driven by persistence slider)
  private maxRepeats(): number {
    return Math.max(1, Math.min(6, 1 + Math.round((this.strategy.persistenceLevel / 100) * 5)));
  }

  async start() {
    await this.enqueue(async () => {
      await this.line(this.greetingText());
      await this.line(this.noticeText());
      await this.line(this.menuText());
      this.stage = 'menu';
      this.scheduleRepeat();
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  private async line(text: string) {
    if (this.ended) return;
    await this.emit({ type: 'line', text });
    if (this.strategy.responseDelayMs > 0) {
      await sleep(this.strategy.responseDelayMs);
    }
  }

  private scheduleRepeat() {
    this.clearRepeat();
    this.repeatTimer = setTimeout(() => {
      if (this.ended) return;
      this.menuRepeats++;
      if (this.menuRepeats > this.maxRepeats()) {
        this.finish('no_response');
        return;
      }
      this.enqueue(async () => {
        await this.line(this.menuText());
        this.scheduleRepeat();
      }).catch(() => {});
    }, 20000);
  }

  private clearRepeat() {
    if (this.repeatTimer) clearTimeout(this.repeatTimer);
    this.repeatTimer = null;
  }

  async handleDtmf(digit: string) {
    return this.enqueue(() => this.handleDtmfInternal(digit));
  }

  private async handleDtmfInternal(digit: string) {
    if (this.ended) return;
    this.clearRepeat();
    const stage = this.stage;

    if (stage === 'menu') {
      if (digit === '1') {
        this.stage = 'payment_date';
        await this.line(this.paymentDateText());
        this.scheduleRepeat();
      } else if (digit === '2') {
        this.stage = 'installment_offer';
        await this.line(this.installmentOfferText());
        this.scheduleRepeat();
      } else if (digit === '3') {
        this.stage = 'operator';
        await this.line(this.operatorText());
        await sleep(4000);
        await this.line(this.wrapupText());
        await sleep(4000);
        this.finish('operator_requested');
      } else {
        await this.line(this.menuText());
        this.scheduleRepeat();
      }
    } else if (stage === 'payment_date') {
      if (digit === '1') {
        this.stage = 'payment_confirm';
        await this.line(this.paymentConfirmText());
        await sleep(4000);
        this.finish('payment_promised');
      } else if (digit === '2') {
        this.stage = 'menu';
        await this.line(this.menuText());
        this.scheduleRepeat();
      } else {
        await this.line(this.paymentDateText());
        this.scheduleRepeat();
      }
    } else if (stage === 'installment_offer') {
      if (digit === '1') {
        this.stage = 'installment_confirm';
        await this.line(this.installmentConfirmText());
        await sleep(4000);
        this.finish('installment_confirmed');
      } else if (digit === '2') {
        this.stage = 'menu';
        await this.line(this.menuText());
        this.scheduleRepeat();
      } else {
        await this.line(this.installmentOfferText());
        this.scheduleRepeat();
      }
    } else if (stage === 'wrapup') {
      this.finish('completed');
    } else {
      this.stage = 'menu';
      await this.line(this.menuText());
      this.scheduleRepeat();
    }
  }

  // Optional LLM hook installed by the server (Gemini-based intent understanding).
  private llmIntent: ((text: string, subscriber: TelephonySubscriber) => Promise<string | null>) | null = null;

  setLlmIntent(fn: (text: string, subscriber: TelephonySubscriber) => Promise<string | null>) {
    this.llmIntent = fn;
  }

  async handleVoiceText(text: string) {
    const t = normalizePersian(text);
    // 1) Fast local rule-based NLU
    const local = classifyIntent(t);
    let digit: string | null = null;
    if (local.intent === 'pay_now' || /قبض/.test(t)) digit = '1';
    else if (local.intent === 'installment') digit = '2';
    else if (local.intent === 'operator') digit = '3';
    else if (local.intent === 'repeat') digit = '9';

    // 2) If nothing matched and LLM mode is on, ask Gemini to classify the intent
    if (!digit && this.strategy.llmEnabled && this.llmIntent && local.intent === 'unknown') {
      try {
        const llmTag = await this.llmIntent(t, this.subscriber);
        if (llmTag === 'pay_now') digit = '1';
        else if (llmTag === 'installment') digit = '2';
        else if (llmTag === 'operator') digit = '3';
        else if (llmTag === 'repeat') digit = '9';
      } catch { /* fall through silently */ }
    }

    if (digit) await this.handleDtmf(digit);
    else {
      await this.line(`متوجه منظور شما نشدم. ${this.menuText()}`);
      this.scheduleRepeat();
    }
  }

  async speak(text: string) {
    return this.enqueue(async () => {
      if (this.ended) return;
      this.clearRepeat();
      await this.line(text);
      this.scheduleRepeat();
    });
  }

  interrupt() {
    this.clearRepeat();
  }

  destroy() {
    this.ended = true;
    this.clearRepeat();
  }

  private finish(outcome: string) {
    if (this.ended) return;
    this.ended = true;
    this.clearRepeat();
    this.emit({ type: 'ended', outcome }).catch(() => {});
  }

  private installmentPlan(): { count: number; amount: number; days: number } {
    const debt = this.subscriber.debt || 0;
    if (debt <= 0) return { count: 1, amount: 0, days: 10 };
    if (debt < 1000000) return { count: 2, amount: Math.ceil(debt / 2), days: 10 };
    if (debt < 5000000) return { count: 3, amount: Math.ceil(debt / 3), days: 15 };
    return { count: 4, amount: Math.ceil(debt / 4), days: 30 };
  }

  // Bilingual prompt layer: when language is set to az/ar/en the engine appends a
  // translated menu line after the Persian one (Ilam is multilingual: Kurdish/Turkish/Arabic speakers).
  private langPrompt(kind: 'menu' | 'greeting'): string {
    const lang = this.strategy.language;
    if (kind === 'menu') {
      if (lang === 'az') return 'Ödəniş üçün 1, taksit üçün 2, operator üçün 3 düyməsini basın.';
      if (lang === 'ar') return 'اضغط 1 للدفع، أو 2 للتقسيط، أو 3 للحديث مع موظف.';
      if (lang === 'en') return 'Press 1 to pay, 2 for installments, or 3 to speak with an agent.';
      return '';
    }
    if (lang === 'az') return 'İlam Elektrik Şirkətindən avtomatik zəng.';
    if (lang === 'ar') return 'اتصال آلي من شركة توزيع كهرباء محافظة إيلام.';
    if (lang === 'en') return 'This is an automated call from Ilam Electricity Distribution Company.';
    return '';
  }

  private greetingText(): string {
    const empathetic = this.strategy.empathyLevel >= 50;
    const opening = empathetic
      ? 'امیدوارم حالتون خوب باشه و مزاحمتون نشیم.'
      : 'این تماس اطلاع‌رسانی حساب برق شماست.';
    return `سلام ${this.subscriber.name} عزیز، وقتتون بخیر. از طرف شرکت توزیع نیروی برق استان ایلام با شما صحبت می‌کنم. ${opening} این تماس به صورت خودکار و رایگان انجام می‌شود.${this.langPrompt('greeting') ? ' ' + this.langPrompt('greeting') : ''}`;
  }

  private noticeText(): string {
    const s = this.subscriber;
    let text = '';
    if (this.strategy.tone === 'firm' && (s.debt || 0) > 5000000) {
      text = `به اطلاع می‌رسانم مبلغ ${faNumber(s.debt)} ریال از قبض برق شما معوقه است و طبق ماده ۱۲ آیین‌نامه، در صورت عدم پرداخت، انشعاب شما قابل قطع خواهد بود.`;
    } else if (this.strategy.tone === 'compromise') {
      text = `حساب شما را بررسی کردم؛ مبلغ ${faNumber(s.debt)} ریال معوقه دارید. نگران نباشید، برای تسویه راه‌حل‌های منعطفی مثل اقساط داریم.`;
    } else {
      text = `وضعیت حساب شما را بررسی کردم. مبلغ ${faNumber(s.debt)} ریال از قبض برق شما معوقه است.`;
    }
    if (s.region) text += ` منطقه خدماتی: ${s.region}.`;
    if (s.lastPayment) text += ` آخرین پرداخت ثبت‌شده شما مورخ ${s.lastPayment} است.`;
    return text;
  }

  private menuText(): string {
    const base = `لطفاً یکی از گزینه‌ها را انتخاب کنید. برای تأیید و تسویه پرداخت، کلید ۱. برای درخواست قسط‌بندی، کلید ۲. برای صحبت با اپراتور انسانی، کلید ۳. برای شنیدن مجدد این گزینه‌ها، کلید ۹.`;
    const extra = this.langPrompt('menu');
    return extra ? `${base} ${extra}` : base;
  }

  private paymentDateText(): string {
    return `بسیار خوب. برای پرداخت همین امروز، کلید ۱ را فشار دهید. برای بازگشت به منوی اصلی، کلید ۲.`;
  }

  private paymentConfirmText(): string {
    return `پرداخت شما به مبلغ ${faNumber(this.subscriber.debt)} ریال ثبت شد. رسید پرداخت برای شما پیامک خواهد شد. از همکاری و صبر شما سپاسگزاریم.`;
  }

  private installmentOfferText(): string {
    const plan = this.installmentPlan();
    return `درخواست قسط‌بندی شما ثبت شد. بر اساس مبلغ بدهی، ${plan.count} قسط به مبلغ ${faNumber(plan.amount)} ریال پیشنهاد می‌کنیم. قسط اول تا ${plan.days} روز آینده و بقیه اقساط ماهانه. برای تأیید، کلید ۱. برای انصراف و بازگشت به منو، کلید ۲.`;
  }

  private installmentConfirmText(): string {
    const plan = this.installmentPlan();
    return `قسط‌بندی شما با موفقیت ثبت شد. ${plan.count} قسط ${faNumber(plan.amount)} ریالی. اولین قسط تا ${plan.days} روز آینده. پیامک تایید برای شما ارسال شد. از همکاری شما سپاسگزاریم.`;
  }

  private operatorText(): string {
    return `لطفاً کمی صبر کنید. در حال وصل شما به اپراتور انسانی شرکت هستیم.`;
  }

  private wrapupText(): string {
    return `از صبر و همکاری شما سپاسگزارم. روزتون بخیر.`;
  }
}

class CallSession {
  readonly record: CallRecord;
  private leg: CallLeg | null = null;
  private engine: ConversationEngine;
  private tts = new LocalTts();
  private ended = false;
  onEvent: ((e: any) => void) | null = null;
  onTranscript: ((line: TranscriptLine) => void) | null = null;
  // Callbacks installed by TelephonyService for persistence, SMS receipts and follow-ups
  onCallEnded: ((record: CallRecord) => void) | null = null;
  llmIntentFn: ((text: string, subscriber: TelephonySubscriber) => Promise<string | null>) | null = null;

  constructor(subscriber: TelephonySubscriber, direction: 'outbound' | 'inbound') {
    this.record = {
      id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      direction,
      subscriber,
      state: 'dialing',
      transport: 'none',
      startedAt: nowIso(),
      aiMode: 'local',
      tone: activeStrategy.tone,
      transcript: [],
      dtmfLog: [],
    };
    this.engine = new ConversationEngine(subscriber, (e) => this.handleEngineEvent(e));
    // Bridge the LLM intent hook from the service into the engine
    this.engine.setLlmIntent(async (text, sub) => {
      if (!this.llmIntentFn) return null;
      return this.llmIntentFn(text, sub);
    });
  }

  // Re-apply the current strategy profile to a live session's engine (takeover/reset)
  reapplyStrategy() {
    (this.engine as any).strategy = { ...activeStrategy };
  }

  attachLeg(leg: CallLeg) {
    this.leg = leg;
    this.record.transport = leg.transport;
    leg.onAudio = () => {};
    leg.onDtmf = (digit) => this.onDtmf(digit);
    leg.onConnected = () => this.onLegConnected();
    leg.onTerminated = () => this.onLegTerminated();
  }

  private onLegConnected() {
    if (this.record.state === 'connected' || this.ended) return;
    this.record.state = 'connected';
    this.emitEvent({ event: 'connected' });
    this.engine.start().catch(() => {});
  }

  private onLegTerminated() {
    this.endCall('terminated_by_peer');
  }

  emitCallEvent(e: any) {
    this.emitEvent(e);
  }

  legConnected() {
    this.onLegConnected();
  }

  legTerminated() {
    this.onLegTerminated();
  }

  private emitEvent(e: any) {
    if (this.onEvent) this.onEvent(e);
  }

  private addTranscript(speaker: TranscriptLine['speaker'], text: string) {
    const line = { time: nowIso(), speaker, text };
    this.record.transcript.push(line);
    if (this.onTranscript) this.onTranscript(line);
  }

  private async handleEngineEvent(e: EngineEvent) {
    if (this.ended) return;
    if (e.type === 'line') {
      this.addTranscript('ai', e.text);
      if (this.leg) {
        if (this.leg.transport === 'browser') {
          this.leg.sendText(e.text);
        } else {
          const pcm = await this.tts.synthesize(e.text);
          if (pcm && !this.ended && this.leg) this.leg.sendAudio(pcm);
        }
      }
      await sleep(estimateSpeechMs(e.text));
    } else if (e.type === 'ended') {
      this.endCall(e.outcome);
    }
  }

  onCallerAudio(_pcm16k: Buffer) {
  }

  onVoiceText(text: string) {
    if (this.ended) return;
    this.addTranscript('caller', text);
    this.engine.handleVoiceText(text).catch(() => {});
  }

  onDtmf(digit: string) {
    if (this.ended) return;
    this.record.dtmfLog.push({ time: nowIso(), digit });
    this.addTranscript('dtmf', `کلید ${digit} فشرده شد`);
    this.emitEvent({ event: 'dtmf', digit });
    this.engine.handleDtmf(digit).catch(() => {});
  }

  async speak(text: string) {
    if (this.ended || this.record.state !== 'connected') return false;
    this.addTranscript('system', `اپراتور انسانی: ${text}`);
    if (this.leg) {
      if (this.leg.transport === 'browser') {
        this.leg.sendText(text);
      } else {
        const pcm = await this.tts.synthesize(text);
        if (pcm && !this.ended && this.leg) this.leg.sendAudio(pcm);
      }
    }
    this.engine.interrupt();
    return true;
  }

  sendDtmfToPhone(digit: string) {
    if (this.ended || !this.leg) return;
    this.leg.sendDtmf(digit);
  }

  isEnded() {
    return this.ended;
  }

  endCall(outcome?: string) {
    if (this.ended) return;
    this.ended = true;
    this.engine.destroy();
    this.record.state = 'ended';
    this.record.endedAt = nowIso();
    if (outcome && !this.record.outcome) this.record.outcome = outcome;
    if (!this.record.outcome) this.record.outcome = 'completed';
    this.emitEvent({ event: 'ended', outcome: this.record.outcome });
  }

  destroy() {
    this.endCall('destroyed');
    if (this.leg) {
      try {
        this.leg.close();
      } catch {}
      this.leg = null;
    }
  }
}

export class TelephonyService {
  private sip: SipStack;
  private calls = new Map<string, CallSession>();
  private history: CallRecord[] = [];
  private wss = new WebSocketServer({ noServer: true });
  private consoles = new Set<WebSocket>();
  private phones = new Map<string, { ws: WebSocket; phoneId: string; busyCallId: string | null }>();
  private lookupSubscriber: (phone: string) => TelephonySubscriber | null;
  private gsmModem: GsmModem | null = null;
  private gsmAvailable = false;
  private activeGsmSession: CallSession | null = null;

  constructor(lookupSubscriber: (phone: string) => TelephonySubscriber | null, sipPort = 5060) {
    this.lookupSubscriber = lookupSubscriber;
    this.sip = new SipStack(sipPort);
    this.sip.onIncomingCall = (dialog, callerNumber) => this.handleIncomingSipCall(dialog, callerNumber);
    this.wss.on('connection', (ws) => this.handleWsConnection(ws));
    this.wss.on('error', () => {});
    this.initGsmModem();
  }

  private initGsmModem() {
    const port = process.env.GSM_MODEM_PORT;
    if (!port) return;
    this.gsmModem = new GsmModem({
      port,
      baudRate: Number(process.env.GSM_MODEM_BAUDRATE || 115200),
      audioPort: process.env.GSM_MODEM_AUDIO_PORT,
      audioBaudRate: Number(process.env.GSM_MODEM_AUDIO_BAUDRATE || 115200),
      audioRate: Number(process.env.GSM_MODEM_AUDIO_RATE || 16000),
    });
    this.gsmModem.onRing = (caller) => this.handleGsmIncomingCall(caller);
    this.gsmModem.onConnected = () => {
      if (this.activeGsmSession) this.activeGsmSession.legConnected();
    };
    this.gsmModem.onDisconnected = () => {
      const session = this.activeGsmSession;
      this.activeGsmSession = null;
      if (session) session.legTerminated();
    };
    this.gsmModem.onDtmf = (digit) => {
      if (this.activeGsmSession) this.activeGsmSession.onDtmf(digit);
    };
    this.gsmModem.onAudio = (pcm) => {
      if (this.activeGsmSession) this.activeGsmSession.onCallerAudio(pcm);
    };
    this.gsmModem.onLog = (msg) => console.log('[GSM]', msg);
    this.gsmModem.open().then((ok) => {
      this.gsmAvailable = ok;
    });
  }

  get wssServer() {
    return this.wss;
  }

  // Push a new strategy profile into the engine; live sessions pick it up on their next line
  applyStrategy(s: Partial<StrategyProfile>) {
    setGlobalStrategy(s);
    this.calls.forEach((session) => session.reapplyStrategy());
  }

  // Install server-side integrations: LLM intent understanding + call-ended persistence/SMS hook
  setLlmIntent(fn: (text: string, subscriber: TelephonySubscriber) => Promise<string | null>) {
    (this as any).llmIntentFn = fn;
  }

  setOnCallEnded(fn: (record: CallRecord) => void) {
    (this as any).callEndedHook = fn;
  }

  get gsmModemInstance() {
    return this.gsmModem;
  }

  get sipStatus() {
    return {
      port: this.sip.localPort,
      localIp: this.sip.localIp,
      proxy: this.sip.proxyHost ? `${this.sip.proxyHost}:${this.sip.proxyPort}` : null,
      registered: this.sip.isRegistered,
    };
  }

  get gsmStatus() {
    return {
      configured: !!process.env.GSM_MODEM_PORT,
      available: this.gsmAvailable,
      port: process.env.GSM_MODEM_PORT || null,
      audioPort: process.env.GSM_MODEM_AUDIO_PORT || null,
      inCall: this.gsmModem?.inCall || false,
    };
  }

  getStatus() {
    return {
      service: 'standalone-telephony',
      aiMode: 'local-engine',
      externalServices: 'none',
      strategy: activeStrategy,
      sip: this.sipStatus,
      gsm: this.gsmStatus,
      activeCalls: Array.from(this.calls.values()).map((c) => ({
        id: c.record.id,
        subscriber: c.record.subscriber,
        state: c.record.state,
        transport: c.record.transport,
        startedAt: c.record.startedAt,
      })),
      activeCallCount: this.calls.size,
      registeredPhones: Array.from(this.phones.keys()),
      historyCount: this.history.length,
    };
  }

  getHistory() {
    return this.history;
  }

  getCall(id: string) {
    return this.calls.get(id)?.record || this.history.find((c) => c.id === id) || null;
  }

  handleUpgrade(request: any, socket: any, head: any) {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  private safeSend(ws: WebSocket, obj: any) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    } catch {}
  }

  private broadcast(obj: any) {
    this.consoles.forEach((ws) => this.safeSend(ws, obj));
    if (this.externalSink) { try { this.externalSink(obj); } catch {} }
  }

  // External sink so the HTTP server can mirror engine events onto other WS channels
  // (e.g. the /live dashboard channel used by the main UI).
  private externalSink: ((obj: any) => void) | null = null;
  setEventSink(fn: ((obj: any) => void) | null) { this.externalSink = fn; }

  private handleWsConnection(ws: WebSocket) {
    let role: 'console' | 'phone' | null = null;
    let phoneId = '';

    ws.on('message', (raw: any) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        role = msg.role === 'phone' ? 'phone' : 'console';
        if (role === 'phone') {
          phoneId = String(msg.phoneId || `phone-${Math.random().toString(36).slice(2, 6)}`);
          this.phones.set(phoneId, { ws, phoneId, busyCallId: null });
          this.safeSend(ws, { type: 'registered', phoneId });
        } else {
          this.consoles.add(ws);
          this.safeSend(ws, { type: 'registered', role: 'console' });
        }
        return;
      }

      if (role === 'phone') {
        this.handlePhoneMessage(ws, phoneId, msg);
      } else if (role === 'console') {
        this.handleConsoleMessage(ws, msg);
      }
    });

    ws.on('close', () => {
      if (role === 'console') {
        this.consoles.delete(ws);
      } else if (role === 'phone') {
        const entry = this.phones.get(phoneId);
        if (entry?.busyCallId) {
          const session = this.calls.get(entry.busyCallId);
          if (session) session.endCall('phone_disconnected');
        }
        this.phones.delete(phoneId);
      }
    });

    ws.on('error', () => {});
  }

  private handleConsoleMessage(ws: WebSocket, msg: any) {
    if (msg.type === 'dial') {
      const sub: TelephonySubscriber = msg.subscriber || {
        name: 'مشترک',
        phone: String(msg.target || ''),
        debt: Number(msg.debt) || 0,
      };
      this.startOutboundCall(sub, { transport: msg.transport || 'sip', phoneId: msg.phoneId })
        .then((record) => this.safeSend(ws, { type: 'callEvent', callId: record.id, event: 'dialing' }))
        .catch((e: any) => this.safeSend(ws, { type: 'error', message: e.message }));
    } else if (msg.type === 'speak' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) session.speak(String(msg.text || ''));
    } else if (msg.type === 'hangup' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) {
        session.endCall('operator_hangup');
        this.finalizeCall(session);
      }
    } else if (msg.type === 'dtmf' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) session.sendDtmfToPhone(String(msg.digit || ''));
    }
  }

  private handlePhoneMessage(ws: WebSocket, phoneId: string, msg: any) {
    const entry = this.phones.get(phoneId);
    if (!entry) return;

    if (msg.type === 'accept' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) {
        entry.busyCallId = msg.callId;
        const leg = (session as any).pendingBrowserLeg as BrowserLeg | undefined;
        if (leg) leg.accept();
      }
    } else if (msg.type === 'decline' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) {
        session.endCall('declined');
        this.finalizeCall(session);
      }
    } else if (msg.type === 'audio' && msg.callId && msg.pcm) {
      const session = this.calls.get(msg.callId);
      if (session) {
        const pcm = Buffer.from(msg.pcm, 'base64');
        session.onCallerAudio(pcm);
      }
    } else if (msg.type === 'text' && msg.callId && msg.text) {
      const session = this.calls.get(msg.callId);
      if (session) session.onVoiceText(String(msg.text));
    } else if (msg.type === 'dtmf' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) session.onDtmf(String(msg.digit || ''));
    } else if (msg.type === 'hangup' && msg.callId) {
      const session = this.calls.get(msg.callId);
      if (session) {
        session.endCall('phone_hangup');
        this.finalizeCall(session);
      }
    } else if (msg.type === 'callOperator') {
      const sub = this.lookupSubscriber(phoneId) || { name: 'مشترک', phone: phoneId, debt: 0 };
      this.startOutboundCall(sub, { transport: 'browser', phoneId }).catch(() => {});
    }
  }

  async startOutboundCall(
    subscriber: TelephonySubscriber,
    options: { transport?: 'sip' | 'browser' | 'gsm'; phoneId?: string } = {},
  ): Promise<CallRecord> {
    const session = new CallSession(subscriber, 'outbound');
    this.calls.set(session.record.id, session);
    this.wireSession(session);

    if (options.transport === 'browser' && options.phoneId) {
      const entry = this.phones.get(options.phoneId);
      if (!entry) {
        session.endCall('phone_not_found');
        this.finalizeCall(session);
        throw new Error('phone_not_registered');
      }
      if (entry.busyCallId) {
        session.endCall('phone_busy');
        this.finalizeCall(session);
        throw new Error('phone_busy');
      }
      const leg = new BrowserLeg(entry.ws, session.record.id, options.phoneId, (ws, obj) => this.safeSend(ws, obj));
      (session as any).pendingBrowserLeg = leg;
      session.attachLeg(leg);
      this.safeSend(entry.ws, {
        type: 'incoming',
        callId: session.record.id,
        from: 'گردآفرین',
        name: 'اپراتور هوشمند برق ایلام',
        subscriber,
      });
      session.record.state = 'ringing';
      session.emitCallEvent({ event: 'ringing' });
      setTimeout(() => {
        if (session.record.state === 'ringing') {
          session.endCall('no_answer');
          this.finalizeCall(session);
        }
      }, 45000);
      return session.record;
    }

    if (options.transport === 'gsm') {
      if (!this.gsmAvailable || !this.gsmModem) {
        session.endCall('gsm_modem_unavailable');
        this.finalizeCall(session);
        throw new Error('gsm_modem_unavailable');
      }
      if (this.activeGsmSession) {
        session.endCall('gsm_busy');
        this.finalizeCall(session);
        throw new Error('gsm_busy');
      }
      const leg = new GsmLeg(this.gsmModem);
      session.attachLeg(leg);
      this.activeGsmSession = session;
      session.record.state = 'dialing';
      session.emitCallEvent({ event: 'dialing' });
      this.gsmModem.dial(subscriber.phone).catch(() => {
        if (!session.isEnded()) {
          session.endCall('dial_failed');
          this.finalizeCall(session);
          if (this.activeGsmSession === session) this.activeGsmSession = null;
        }
      });
      return session.record;
    }

    const target = this.resolveSipTarget(subscriber.phone);
    if (!target) {
      session.endCall('no_route');
      this.finalizeCall(session);
      throw new Error('no_sip_route');
    }
    const dialog = this.sip.invite(subscriber.phone, target.host, target.port);
    const leg = new SipCallLeg(dialog, this.sip);
    session.attachLeg(leg);
    dialog.onConnected = () => leg.fireConnected();
    dialog.onTerminated = () => leg.fireTerminated();
    session.record.state = 'dialing';
    session.emitCallEvent({ event: 'dialing' });
    this.waitForSipAnswer(session, dialog);
    return session.record;
  }

  emitCallEvent(session: CallSession, e: any) {
    session.emitCallEvent(e);
  }

  private async waitForSipAnswer(session: CallSession, dialog: SipDialog) {
    try {
      await this.sip.waitForAnswer(dialog);
    } catch (e: any) {
      if (!session.isEnded()) {
        session.endCall(e.message === 'no_answer' ? 'no_answer' : 'call_failed');
        this.finalizeCall(session);
      }
    }
  }

  private handleIncomingSipCall(dialog: SipDialog, callerNumber: string) {
    const subscriber = this.lookupSubscriber(callerNumber) || { name: 'مشترک', phone: callerNumber, debt: 0 };
    const session = new CallSession(subscriber, 'inbound');
    this.calls.set(session.record.id, session);
    this.wireSession(session);

    const leg = new SipCallLeg(dialog, this.sip);
    session.attachLeg(leg);
    dialog.onConnected = () => leg.fireConnected();
    dialog.onTerminated = () => leg.fireTerminated();
    session.record.state = 'ringing';
    session.emitCallEvent({ event: 'ringing' });
    session.legConnected();
  }

  private handleGsmIncomingCall(caller: string) {
    if (this.activeGsmSession || !this.gsmModem) {
      this.gsmModem.hangup().catch(() => {});
      return;
    }
    const subscriber = this.lookupSubscriber(caller) || { name: 'مشترک', phone: caller, debt: 0 };
    const session = new CallSession(subscriber, 'inbound');
    this.calls.set(session.record.id, session);
    this.wireSession(session);

    const leg = new GsmLeg(this.gsmModem);
    session.attachLeg(leg);
    this.activeGsmSession = session;
    session.record.state = 'ringing';
    session.emitCallEvent({ event: 'ringing' });
    this.gsmModem.answer().catch(() => {
      if (!session.isEnded()) {
        session.endCall('answer_failed');
        this.finalizeCall(session);
        if (this.activeGsmSession === session) this.activeGsmSession = null;
      }
    });
  }

  private resolveSipTarget(phone: string): { host: string; port: number } | null {
    const ipMatch = phone.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?$/);
    if (ipMatch) return { host: ipMatch[1], port: Number(ipMatch[2] || 5060) };
    if (process.env.SIP_PROXY_HOST) {
      return { host: process.env.SIP_PROXY_HOST, port: Number(process.env.SIP_PROXY_PORT || 5060) };
    }
    return null;
  }

  private wireSession(session: CallSession) {
    session.llmIntentFn = (this as any).llmIntentFn || null;
    session.onEvent = (e) => {
      this.broadcast({ type: 'callEvent', callId: session.record.id, ...e });
      if (e.event === 'ended') this.finalizeCall(session);
    };
    session.onTranscript = (line) =>
      this.broadcast({ type: 'transcript', callId: session.record.id, ...line });
  }

  async speakToCall(callId: string, text: string): Promise<boolean> {
    const session = this.calls.get(callId);
    if (!session) return false;
    return session.speak(text);
  }

  async sendDtmf(callId: string, digit: string): Promise<boolean> {
    const session = this.calls.get(callId);
    if (!session) return false;
    session.sendDtmfToPhone(digit);
    return true;
  }

  async hangupCall(callId: string): Promise<boolean> {
    const session = this.calls.get(callId);
    if (!session) return false;
    session.endCall('operator_hangup');
    this.finalizeCall(session);
    return true;
  }

  private finalizeCall(session: CallSession) {
    if ((session as any)._finalized) return;
    (session as any)._finalized = true;
    const record = session.record;
    this.calls.delete(record.id);
    this.history.unshift(record);
    if (this.history.length > 100) this.history.pop();
    this.phones.forEach((entry) => {
      if (entry.busyCallId === record.id) entry.busyCallId = null;
    });
    if (this.activeGsmSession === session) this.activeGsmSession = null;
    // Notify the server layer (persistence, KPIs, SMS receipts, follow-up tasks)
    try {
      const hook = (this as any).callEndedHook;
      if (hook) hook(JSON.parse(JSON.stringify(record)));
    } catch {}
    session.destroy();
  }
}
