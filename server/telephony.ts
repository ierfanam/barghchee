import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

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
  transport: 'sip' | 'browser' | 'none';
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  aiMode: 'gemini' | 'script';
  transcript: TranscriptLine[];
  dtmfLog: { time: string; digit: string }[];
}

export interface TelephonyEvent {
  type: 'callEvent' | 'transcript' | 'dtmf';
  callId: string;
  [key: string]: any;
}

function nowIso() {
  return new Date().toISOString();
}

function faNumber(n: number): string {
  return n.toLocaleString('fa-IR');
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

function ulawEncode(sample: number): number {
  let sign = 0;
  let value = sample;
  if (value < 0) {
    sign = 0x80;
    value = -value;
  }
  value += 0x84;
  if (value > 0x7fff) value = 0x7fff;
  let exponent = 7;
  let mask = 0x4000;
  while ((value & mask) === 0 && exponent > 0) {
    mask >>= 1;
    exponent--;
  }
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ulawDecode(byte: number): number {
  const b = ~byte;
  const sign = b & 0x80;
  const exponent = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  let value = ((mantissa << 3) + 0x84) << exponent;
  value -= 0x84;
  if (sign) value = -value;
  return value;
}

function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || input.length === 0) return input;
  const inputSamples = new Int16Array(input.buffer, input.byteOffset, input.length >> 1);
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(inputSamples.length / ratio));
  const output = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = inputSamples[Math.min(idx, inputSamples.length - 1)];
    const b = inputSamples[Math.min(idx + 1, inputSamples.length - 1)];
    output[i] = Math.round(a + (b - a) * frac);
  }
  return Buffer.from(output.buffer);
}

function dtmfCode(digit: string): number {
  if (digit >= '0' && digit <= '9') return digit.charCodeAt(0) - 48;
  if (digit === '*') return 10;
  if (digit === '#') return 11;
  return -1;
}

function dtmfDigit(code: number): string | null {
  if (code >= 0 && code <= 9) return String(code);
  if (code === 10) return '*';
  if (code === 11) return '#';
  return null;
}

interface CallLeg {
  transport: 'sip' | 'browser';
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
  onIncomingCall: ((dialog: SipDialog, callerNumber: string) => void) | null = null;

  constructor(port = 5060) {
    this.localPort = port;
    this.localIp = getLocalIp();
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.handleMessage(buf.toString('utf8'), rinfo);
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

  private _pendingRegisterAuth: ((auth?: string) => void) | null = null;

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
    const branchMatch = via.match(/branch=([^;\s]+)/i);
    const branch = branchMatch ? branchMatch[1] : '';

    if (first.startsWith('SIP/2.0')) {
      const status = parseInt(first.split(' ')[1] || '0', 10);
      this.handleResponse(status, first, headers, body, rinfo, callId, branch);
      return;
    }

    const method = first.split(' ')[0];
    if (method === 'INVITE') this.handleInvite(first, headers, body, rinfo, callId);
    else if (method === 'ACK') this.handleAck(headers, callId);
    else if (method === 'BYE') this.handleBye(headers, body, rinfo, callId);
    else if (method === 'CANCEL') this.handleCancel(headers, body, rinfo, callId);
    else if (method === 'REGISTER') this.handleRegister(headers, body, rinfo);
    else if (method === 'OPTIONS' || method === 'INFO' || method === 'NOTIFY' || method === 'SUBSCRIBE') {
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

  private handleResponse(status: number, first: string, headers: Map<string, string>, body: string, rinfo: dgram.RemoteInfo, callId: string, branch: string) {
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

    if (status === 200 && headers.get('content-type')?.includes('sdp')) {
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

  private handleAck(headers: Map<string, string>, callId: string) {
  }

  private handleBye(headers: Map<string, string>, body: string, rinfo: dgram.RemoteInfo, callId: string) {
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

  private handleCancel(headers: Map<string, string>, body: string, rinfo: dgram.RemoteInfo, callId: string) {
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

  private handleRegister(headers: Map<string, string>, body: string, rinfo: dgram.RemoteInfo) {
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

interface ScriptStage {
  stage: 'greeting' | 'notice' | 'menu' | 'payment' | 'installment' | 'installment_confirm' | 'operator' | 'wrapup' | 'done';
  menuShown: number;
  timer: any;
}

class AiCallSession {
  readonly record: CallRecord;
  private ai: GoogleGenAI;
  private live: any = null;
  private leg: CallLeg | null = null;
  private script: ScriptStage | null = null;
  private audioChunks: Buffer[] = [];
  private audioTimer: any = null;
  private ended = false;
  onEvent: ((e: any) => void) | null = null;
  onTranscript: ((line: TranscriptLine) => void) | null = null;

  constructor(
    subscriber: TelephonySubscriber,
    direction: 'outbound' | 'inbound',
    ai: GoogleGenAI,
    private aiAvailable: boolean,
  ) {
    this.ai = ai;
    this.record = {
      id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      direction,
      subscriber,
      state: 'dialing',
      transport: 'none',
      startedAt: nowIso(),
      aiMode: aiAvailable ? 'gemini' : 'script',
      transcript: [],
      dtmfLog: [],
    };
  }

  attachLeg(leg: CallLeg) {
    this.leg = leg;
    this.record.transport = leg.transport;
    leg.onAudio = (pcm) => this.onCallerAudio(pcm);
    leg.onDtmf = (digit) => this.onDtmf(digit);
    leg.onConnected = () => this.onLegConnected();
    leg.onTerminated = () => this.onLegTerminated();
  }

  private onLegConnected() {
    if (this.record.state === 'connected' || this.ended) return;
    this.record.state = 'connected';
    this.emitEvent({ event: 'connected' });
    this.startAssistant();
  }

  private onLegTerminated() {
    this.endCall('terminated_by_peer');
  }

  private emitEvent(e: any) {
    if (this.onEvent) this.onEvent(e);
  }

  emitCallEvent(e: any) {
    this.emitEvent(e);
  }

  isEnded() {
    return this.ended;
  }

  private addTranscript(speaker: TranscriptLine['speaker'], text: string) {
    const line = { time: nowIso(), speaker, text };
    this.record.transcript.push(line);
    if (this.onTranscript) this.onTranscript(line);
  }

  private async startAssistant() {
    if (this.aiAvailable) {
      try {
        await this.connectGemini();
        return;
      } catch (e: any) {
        this.record.aiMode = 'script';
      }
    }
    this.startScriptFlow();
  }

  startAssistantPublic() {
    this.startAssistant();
  }

  private async connectGemini() {
    const s = this.record.subscriber;
    const systemInstruction =
      `تو «گُردآفرین»، اپراتور هوشمند صوتی شرکت توزیع نیروی برق استان ایلام هستی. این تماس تلفنی با مشترک زیر است:` +
      ` نام: ${s.name}، شماره تماس: ${s.phone}` +
      (s.billId ? `، شناسه قبض: ${s.billId}` : '') +
      (s.region ? `، منطقه: ${s.region}` : '') +
      (s.lastPayment ? `، آخرین پرداخت: ${s.lastPayment}` : '') +
      `، مبلغ بدهی معوقه: ${faNumber(s.debt)} ریال.` +
      ` وظیفه‌ات: ۱. با ادب و با نام مشترک سلام و معرفی کن. ۲. وضعیت بدهی را با لطف و احترام اطلاع بده. ۳. گزینه‌ها را اعلام کن: کلید ۱ تأیید و تسویه پرداخت، کلید ۲ درخواست قسط‌بندی، کلید ۳ صحبت با اپراتور انسانی. ۴. به پاسخ‌های مشترک با همدلی پاسخ بده، هرگز تهدید یا فحش نده. ۵. اگر مشترک قول پرداخت داد، مبلغ و تاریخ را تکرار و ثبت کن. ۶. اگر کلید ۳ فشرده شد، اعلام کن که اپراتور انسانی وصل می‌شود. همیشه به فارسی محاوره‌ای و کوتاه صحبت کن.`;

    this.live = await this.ai.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction,
      },
      callbacks: {
        onmessage: (message: any) => this.onAiMessage(message),
        onerror: (e: any) => this.onAiError(e),
        onclose: (e: any) => this.onAiClose(e),
      },
    });

    this.live.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: 'تماس برقرار شد. لطفاً الان با مشترک سلام و معرفی کن و وضعیت بدهی و گزینه‌های پرداخت را اطلاع بده.' }] }],
      turnComplete: true,
    });
  }

  private onAiMessage(message: any) {
    if (this.ended) return;
    try {
      const audio = message?.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
      if (audio && this.leg) {
        const pcm24k = Buffer.from(audio, 'base64');
        const pcm16k = resamplePcm(pcm24k, 24000, 16000);
        this.leg.sendAudio(pcm16k);
      }
      if (message?.serverContent?.userTurn?.parts) {
        let userText = '';
        for (const part of message.serverContent.userTurn.parts) if (part.text) userText += part.text;
        if (userText) this.addTranscript('caller', userText);
      }
      const modelParts = message?.serverContent?.modelTurn?.parts || [];
      let modelText = '';
      for (const part of modelParts) if (part.text) modelText += part.text;
      if (modelText) this.addTranscript('ai', modelText);
    } catch {}
  }

  private onAiError(e: any) {
    if (this.ended) return;
    this.addTranscript('system', `خطای جلسه هوش مصنوعی: ${e?.message || 'unknown'}`);
  }

  private onAiClose(e: any) {
    if (this.ended) return;
    this.endCall('ai_session_closed');
  }

  onCallerAudio(pcm16k: Buffer) {
    if (this.ended || !this.live) return;
    this.audioChunks.push(pcm16k);
    if (!this.audioTimer) {
      this.audioTimer = setInterval(() => this.flushAudio(), 100);
    }
  }

  private flushAudio() {
    if (!this.live || this.audioChunks.length === 0) return;
    const combined = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    try {
      this.live.sendRealtimeInput({
        audio: { data: combined.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    } catch {}
  }

  onDtmf(digit: string) {
    if (this.ended) return;
    const entry = { time: nowIso(), digit };
    this.record.dtmfLog.push(entry);
    this.addTranscript('dtmf', `کلید ${digit} فشرده شد`);
    this.emitEvent({ event: 'dtmf', digit });

    if (this.record.aiMode === 'gemini' && this.live) {
      try {
        this.live.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `مشترک کلید ${digit} را روی تلفن فشرد. بر اساس این ورودی ادامه مکالمه بده.` }] }],
          turnComplete: true,
        });
      } catch {}
      return;
    }
    this.handleScriptDtmf(digit);
  }

  private startScriptFlow() {
    this.record.aiMode = 'script';
    this.script = { stage: 'greeting', menuShown: 0, timer: null };
    this.runScriptStep();
  }

  private scriptLine(key: 'greeting' | 'notice' | 'menu' | 'payment' | 'installment' | 'operator' | 'wrapup'): string {
    const s = this.record.subscriber;
    switch (key) {
      case 'greeting':
        return `سلام ${s.name} عزیز، وقتتون بخیر. از طرف شرکت توزیع نیروی برق استان ایلام با شما صحبت می‌کنم.`;
      case 'notice':
        return `گزارش حساب شما را بررسی کردم. مبلغ ${faNumber(s.debt)} ریال از قبض برق شما معوقه است.${s.region ? ` منطقه خدماتی: ${s.region}.` : ''}`;
      case 'menu':
        return `لطفاً یکی از گزینه‌ها را انتخاب کنید. برای تأیید و تسویه پرداخت کلید ۱. برای درخواست قسط‌بندی کلید ۲. برای صحبت با اپراتور انسانی کلید ۳.`;
      case 'payment':
        return `بسیار خوب. لطفاً تاریخ تسویه را بگویید یا برای تأیید پرداخت فوری کلید ۱ را فشار دهید.`;
      case 'installment':
        return `درخواست قسط‌بندی شما ثبت شد. مبلغ ${faNumber(s.debt)} ریال در دو قسط مساوی ${faNumber(Math.round(s.debt / 2))} ریالی تقسیم می‌شود. قسط اول تا ده روز آینده و قسط دوم تا بیست روز آینده. برای تأیید کلید ۱ و برای انصراف کلید ۲ را فشار دهید.`;
      case 'operator':
        return `لطفاً کمی صبر کنید. در حال وصل شما به اپراتور انسانی شرکت هستیم.`;
      case 'wrapup':
        return `از صبر و همکاری شما سپاسگزارم. روزتون بخیر.`;
    }
  }

  private scriptSay(text: string, nextStage?: ScriptStage['stage'], delayMs?: number) {
    if (this.ended || !this.script) return;
    this.addTranscript('ai', text);
    if (this.leg) this.leg.sendText(text);
    const dur = delayMs || Math.min(12000, Math.max(2500, text.length * 130));
    this.script.timer = setTimeout(() => {
      if (this.ended || !this.script) return;
      if (nextStage) {
        this.script.stage = nextStage;
        if (nextStage === 'menu') this.script.menuShown++;
        this.runScriptStep();
      }
    }, dur);
  }

  private runScriptStep() {
    if (this.ended || !this.script) return;
    const stage = this.script.stage;
    if (stage === 'greeting') {
      this.scriptSay(this.scriptLine('greeting'), 'notice');
    } else if (stage === 'notice') {
      this.scriptSay(this.scriptLine('notice'), 'menu');
    } else if (stage === 'menu') {
      this.scriptSay(this.scriptLine('menu'));
    } else if (stage === 'payment') {
      this.scriptSay(this.scriptLine('payment'));
    } else if (stage === 'installment') {
      this.scriptSay(this.scriptLine('installment'));
    } else if (stage === 'operator') {
      this.scriptSay(this.scriptLine('operator'), 'wrapup');
    } else if (stage === 'wrapup') {
      this.scriptSay(this.scriptLine('wrapup'));
      this.script.timer = setTimeout(() => this.endCall('completed'), 6000);
    }
  }

  private handleScriptDtmf(digit: string) {
    if (this.ended || !this.script) return;
    if (this.script.timer) clearTimeout(this.script.timer);
    const stage = this.script.stage;
    if (stage === 'menu') {
      if (digit === '1') {
        this.script.stage = 'payment';
        this.runScriptStep();
      } else if (digit === '2') {
        this.script.stage = 'installment';
        this.runScriptStep();
      } else if (digit === '3') {
        this.script.stage = 'operator';
        this.record.outcome = 'operator_requested';
        this.runScriptStep();
      } else if (digit === '9') {
        this.script.menuShown++;
        this.scriptSay(this.scriptLine('menu'));
      } else {
        this.scriptSay(this.scriptLine('menu'));
      }
    } else if (stage === 'payment') {
      if (digit === '1') {
        this.record.outcome = 'payment_promised';
        this.script.stage = 'wrapup';
        this.runScriptStep();
      } else {
        this.scriptSay(this.scriptLine('payment'));
      }
    } else if (stage === 'installment') {
      if (digit === '1') {
        this.record.outcome = 'installment_confirmed';
        this.script.stage = 'wrapup';
        this.runScriptStep();
      } else if (digit === '2') {
        this.script.stage = 'menu';
        this.script.menuShown++;
        this.runScriptStep();
      } else {
        this.scriptSay(this.scriptLine('installment'));
      }
    } else if (stage === 'wrapup') {
      this.endCall('completed');
    } else {
      this.script.stage = 'menu';
      this.runScriptStep();
    }
  }

  async speak(text: string) {
    if (this.ended || this.record.state !== 'connected') return false;
    this.addTranscript('system', `اپراتور انسانی: ${text}`);
    if (this.record.aiMode === 'gemini' && this.live) {
      try {
        this.live.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `اپراتور انسانی این پیام را دقیقاً و با لحن دوستانه به مشترک بخوان: «${text}»` }] }],
          turnComplete: true,
        });
      } catch {}
    } else if (this.leg) {
      this.leg.sendText(text);
    }
    return true;
  }

  sendDtmfToPhone(digit: string) {
    if (this.ended || !this.leg) return;
    this.leg.sendDtmf(digit);
  }

  endCall(outcome?: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.script?.timer) clearTimeout(this.script.timer);
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.flushAudio();
    this.record.state = 'ended';
    this.record.endedAt = nowIso();
    if (outcome && !this.record.outcome) this.record.outcome = outcome;
    if (!this.record.outcome) this.record.outcome = 'completed';
    try {
      if (this.live && typeof this.live.close === 'function') this.live.close();
    } catch {}
    this.live = null;
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
  private ai: GoogleGenAI;
  private aiAvailable: boolean;
  private sip: SipStack;
  private calls = new Map<string, AiCallSession>();
  private history: CallRecord[] = [];
  private wss = new WebSocketServer({ noServer: true });
  private consoles = new Set<WebSocket>();
  private phones = new Map<string, { ws: WebSocket; phoneId: string; busyCallId: string | null }>();
  private lookupSubscriber: (phone: string) => TelephonySubscriber | null;

  constructor(lookupSubscriber: (phone: string) => TelephonySubscriber | null, sipPort = 5060) {
    this.lookupSubscriber = lookupSubscriber;
    const apiKey = process.env.GEMINI_API_KEY;
    this.aiAvailable = !!apiKey && !apiKey.includes('AutoBypassed');
    this.ai = new GoogleGenAI({ apiKey: apiKey || 'standalone-mode' });
    this.sip = new SipStack(sipPort);
    this.sip.onIncomingCall = (dialog, callerNumber) => this.handleIncomingSipCall(dialog, callerNumber);
    this.wss.on('connection', (ws) => this.handleWsConnection(ws));
    this.wss.on('error', () => {});
  }

  get wssServer() {
    return this.wss;
  }

  get sipStatus() {
    return {
      port: this.sip.localPort,
      localIp: this.sip.localIp,
      proxy: this.sip.proxyHost ? `${this.sip.proxyHost}:${this.sip.proxyPort}` : null,
      registered: this.sip.isRegistered,
    };
  }

  getStatus() {
    return {
      service: 'standalone-telephony',
      aiMode: this.aiAvailable ? 'gemini-live' : 'script-fallback',
      sip: this.sipStatus,
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
  }

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

  private wireSession(session: AiCallSession) {
    session.onEvent = (e) => {
      this.broadcast({ type: 'callEvent', callId: session.record.id, ...e });
      if (e.event === 'ended') this.finalizeCall(session);
    };
    session.onTranscript = (line) =>
      this.broadcast({ type: 'transcript', callId: session.record.id, ...line });
  }

  private handleConsoleMessage(ws: WebSocket, msg: any) {
    if (msg.type === 'dial') {
      this.startOutboundCall(msg.subscriber || { name: 'مشترک', phone: String(msg.target || ''), debt: Number(msg.debt) || 0 }, { transport: msg.transport || 'sip' })
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
    options: { transport?: 'sip' | 'browser'; phoneId?: string } = {},
  ): Promise<CallRecord> {
    const session = new AiCallSession(subscriber, 'outbound', this.ai, this.aiAvailable);
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

    const target = this.resolveSipTarget(subscriber.phone);
    if (!target) {
      session.endCall('no_route');
      this.finalizeCall(session);
      throw new Error('no_sip_route');
    }
    const dialog = this.sip.invite(subscriber.phone, target.host, target.port);
    const leg = new SipCallLeg(dialog, this.sip);
    session.attachLeg(leg);
    session.record.state = 'dialing';
    session.emitCallEvent({ event: 'dialing' });
    dialog.onConnected = () => leg.fireConnected();
    dialog.onTerminated = () => leg.fireTerminated();
    this.waitForSipAnswer(session, dialog);
    return session.record;
  }

  private async waitForSipAnswer(session: AiCallSession, dialog: SipDialog) {
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
    const session = new AiCallSession(subscriber, 'inbound', this.ai, this.aiAvailable);
    this.calls.set(session.record.id, session);
    this.wireSession(session);

    const leg = new SipCallLeg(dialog, this.sip);
    session.attachLeg(leg);
    dialog.onConnected = () => leg.fireConnected();
    dialog.onTerminated = () => leg.fireTerminated();
    session.record.state = 'connected';
    session.emitCallEvent({ event: 'connected' });
    session.startAssistantPublic();
  }

  private resolveSipTarget(phone: string): { host: string; port: number } | null {
    const ipMatch = phone.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?$/);
    if (ipMatch) return { host: ipMatch[1], port: Number(ipMatch[2] || 5060) };
    if (process.env.SIP_PROXY_HOST) {
      return { host: process.env.SIP_PROXY_HOST, port: Number(process.env.SIP_PROXY_PORT || 5060) };
    }
    return null;
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

  private finalizeCall(session: AiCallSession) {
    if ((session as any)._finalized) return;
    (session as any)._finalized = true;
    const record = session.record;
    this.calls.delete(record.id);
    this.history.unshift(record);
    if (this.history.length > 100) this.history.pop();
    this.phones.forEach((entry, phoneId) => {
      if (entry.busyCallId === record.id) entry.busyCallId = null;
    });
    session.destroy();
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

  sendText(_text: string) {
  }

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
