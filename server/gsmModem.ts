import { SerialPort } from 'serialport';
import { resamplePcm } from './audio';

export interface GsmModemConfig {
  port: string;
  baudRate?: number;
  audioPort?: string;
  audioBaudRate?: number;
  audioRate?: number;
}

export class GsmModem {
  private port: SerialPort | null = null;
  private audioPort: SerialPort | null = null;
  private audioRate: number;
  private buffer = '';
  private responseQueue: { resolve: (v: string) => void; reject: (e: Error) => void; timer: any }[] = [];
  private opened = false;
  private callActive = false;

  onRing: ((caller: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: ((reason: string) => void) | null = null;
  onDtmf: ((digit: string) => void) | null = null;
  onAudio: ((pcm16k: Buffer) => void) | null = null;
  onLog: ((msg: string) => void) | null = null;

  constructor(private config: GsmModemConfig) {
    this.audioRate = config.audioRate || 16000;
  }

  get isOpen() {
    return this.opened;
  }

  get inCall() {
    return this.callActive;
  }

  async open(): Promise<boolean> {
    try {
      this.port = new SerialPort({
        path: this.config.port,
        baudRate: this.config.baudRate || 115200,
        autoOpen: false,
      });
      await new Promise<void>((resolve, reject) => {
        this.port!.open((err: any) => (err ? reject(err) : resolve()));
      });
      this.port.on('data', (data: Buffer) => this.handleData(data));
      this.port.on('error', (err) => this.log('serial error: ' + err.message));

      await this.at('ATE0');
      await this.at('AT+CMEE=2');
      await this.at('AT+CLIP=1');
      await this.at('AT+DDET=1,100,50');
      await this.at('AT+VTD=100');
      await this.at('ATH');

      const audioPath = this.config.audioPort;
      if (audioPath) {
        try {
          this.audioPort = new SerialPort({
            path: audioPath,
            baudRate: this.config.audioBaudRate || 115200,
            autoOpen: false,
          });
          await new Promise<void>((resolve, reject) => {
            this.audioPort!.open((err: any) => (err ? reject(err) : resolve()));
          });
          this.audioPort.on('data', (data: Buffer) => {
            if (this.callActive && this.onAudio) {
              this.onAudio(resamplePcm(data, this.audioRate, 16000));
            }
          });
          this.audioPort.on('error', () => {});
          this.log('audio channel open on ' + audioPath);
        } catch (e: any) {
          this.log('audio channel unavailable (DTMF-only mode): ' + e.message);
        }
      }

      this.opened = true;
      this.log('GSM modem ready on ' + this.config.port);
      return true;
    } catch (e: any) {
      this.log('GSM modem open failed: ' + e.message);
      return false;
    }
  }

  private log(msg: string) {
    if (this.onLog) this.onLog(msg);
  }

  private at(cmd: string, timeout = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.port) return reject(new Error('port closed'));
      const timer = setTimeout(() => {
        const idx = this.responseQueue.findIndex((r) => r.timer === timer);
        if (idx >= 0) this.responseQueue.splice(idx, 1);
        reject(new Error('AT timeout: ' + cmd));
      }, timeout);
      this.responseQueue.push({ resolve, reject, timer });
      this.port.write(cmd + '\r\n');
    });
  }

  // Send an SMS via AT+CMGS using PDU-free text mode (GSM UCS2 hex for Persian support)
  async sendSms(number: string, text: string): Promise<boolean> {
    if (!this.port || !this.opened) return false;
    try {
      await this.at('AT+CMGF=1');
      await this.at('AT+CSCS="UCS2"');
      const normalized = String(number).replace(/^0/, '98').replace(/[^0-9]/g, '');
      const hexBody = Buffer.from(text, 'utf16le')
        .swap16()
        .toString('hex')
        .toUpperCase();
      const res = await this.at(`AT+CMGS="${normalized}"`, 8000);
      // After '>' prompt, write body + Ctrl-Z
      await new Promise<void>((resolve, reject) => {
        if (!this.port) return reject(new Error('port closed'));
        this.port.write(hexBody + '\x1A', (err: any) => (err ? reject(err) : resolve()));
      });
      const sent = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CMGS timeout')), 15000);
        this.responseQueue.push({ resolve, reject, timer });
      });
      return /OK|\+CMGS/.test(res + ' ' + sent);
    } catch (e: any) {
      this.log('sendSms failed: ' + (e?.message || e));
      return false;
    }
  }

  private handleData(data: Buffer) {
    this.buffer += data.toString('latin1');
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 2);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    if (line === 'RING') {
      this.log('incoming ring');
      return;
    }
    if (line.startsWith('+CLIP:')) {
      const m = line.match(/\+CLIP:\s*"([^"]*)"/);
      const caller = m ? m[1] : 'unknown';
      this.log('caller ID: ' + caller);
      if (this.onRing) this.onRing(caller);
      return;
    }
    if (line.startsWith('+DTMF:')) {
      const m = line.match(/\+DTMF:\s*(\d)/);
      if (m && this.onDtmf) this.onDtmf(m[1]);
      return;
    }
    if (line === 'CONNECT' || line.startsWith('CONNECT')) {
      this.callActive = true;
      this.log('call connected');
      if (this.onConnected) this.onConnected();
      return;
    }
    if (line === 'NO CARRIER' || line === 'NO ANSWER' || line === 'BUSY' || line === 'ERROR') {
      if (this.callActive) {
        this.callActive = false;
        this.log('call ended: ' + line);
        if (this.onDisconnected) this.onDisconnected(line);
      }
      this.flushQueue(line);
      return;
    }
    if (line === 'OK') {
      this.flushQueue('OK');
      return;
    }
    if (line.startsWith('+CME ERROR') || line.startsWith('+CMS ERROR')) {
      this.flushQueue(line);
      return;
    }
  }

  private flushQueue(result: string) {
    const pending = this.responseQueue.shift();
    if (pending) {
      clearTimeout(pending.timer);
      if (result === 'OK') pending.resolve(result);
      else pending.reject(new Error(result));
    }
  }

  async dial(number: string): Promise<void> {
    await this.at('ATH');
    await this.at(`ATD${number};`, 30000);
  }

  async answer(): Promise<void> {
    await this.at('ATA', 15000);
  }

  async hangup(): Promise<void> {
    this.callActive = false;
    try {
      await this.at('ATH');
    } catch {}
  }

  async sendDtmf(digit: string): Promise<void> {
    if (!this.callActive) return;
    try {
      await this.at(`AT+VTS=${digit}`, 2000);
    } catch {}
  }

  sendAudio(pcm16k: Buffer) {
    if (!this.audioPort || !this.callActive || pcm16k.length === 0) return;
    const data = resamplePcm(pcm16k, 16000, this.audioRate);
    try {
      this.audioPort.write(data);
    } catch {}
  }

  async close(): Promise<void> {
    try {
      await this.hangup();
    } catch {}
    try {
      this.audioPort?.close();
    } catch {}
    try {
      this.port?.close();
    } catch {}
    this.opened = false;
  }
}
