// Multi-channel SMS gateway for the Gardafarin platform.
// Priority order: KavehNova web service -> GSM modem (AT+CMGS) -> local outbox file.
// Every message is journaled to data/sms-outbox.jsonl so nothing is ever lost, even
// when no real gateway is configured (dry-run mode).
import fs from 'fs';
import path from 'path';
import axios from 'axios';

export interface SmsResult {
  ok: boolean;
  channel: 'kavenova' | 'gsm' | 'outbox';
  id?: string;
  error?: string;
}

const OUTBOX_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'sms-outbox.jsonl');

function journal(entry: any) {
  try {
    fs.mkdirSync(path.dirname(OUTBOX_FILE), { recursive: true });
    fs.appendFileSync(OUTBOX_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

async function sendViaKavenova(to: string, body: string): Promise<SmsResult | null> {
  const user = process.env.KAVENOVA_USER;
  const pass = process.env.KAVENOVA_PASS;
  const line = process.env.KAVENOVA_LINE;
  if (!user || !pass || !line) return null; // not configured
  try {
    const res = await axios.get('https://api.kavenova.com/rest/send', {
      params: { User: user, Pass: pass, To: to, Message: body, Line: line },
      timeout: 8000,
    });
    const sent = String(res.data).trim();
    if (/^\d+$/.test(sent)) return { ok: true, channel: 'kavenova', id: sent };
    return { ok: false, channel: 'kavenova', error: `KavehNova response: ${sent.slice(0, 120)}` };
  } catch (e: any) {
    return { ok: false, channel: 'kavenova', error: e.message };
  }
}

async function sendViaGsm(modem: any, to: string, body: string): Promise<SmsResult | null> {
  if (!modem || typeof modem.sendSms !== 'function') return null;
  try {
    const ok = await modem.sendSms(to, body);
    return ok ? { ok: true, channel: 'gsm' } : { ok: false, channel: 'gsm', error: 'Modem rejected AT+CMGS' };
  } catch (e: any) {
    return { ok: false, channel: 'gsm', error: e.message };
  }
}

export class SmsGateway {
  private modem: any = null;

  attachModem(modem: any) {
    this.modem = modem;
  }

  get channelInfo() {
    return {
      kavenovaConfigured: !!(process.env.KAVENOVA_USER && process.env.KAVENOVA_PASS && process.env.KAVENOVA_LINE),
      gsmAttached: !!this.modem,
      outboxFile: OUTBOX_FILE,
    };
  }

  async send(to: string, body: string, kind = 'generic'): Promise<SmsResult> {
    const normalized = String(to || '').replace(/^0/, '98').replace(/[^0-9]/g, '');
    let result: SmsResult = { ok: false, channel: 'outbox', error: 'no channel attempted' };

    const kn = await sendViaKavenova(normalized, body);
    if (kn && kn.ok) result = kn;
    else if (kn) {
      const gsm = await sendViaGsm(this.modem, normalized, body);
      result = gsm && gsm.ok ? gsm : { ok: false, channel: 'outbox', error: `${kn.error}; ${gsm?.error || 'gsm unavailable'}` };
    } else {
      const gsm = await sendViaGsm(this.modem, normalized, body);
      result = gsm && gsm.ok ? gsm : { ok: false, channel: 'outbox', error: gsm?.error || 'no sms gateway configured (dry-run)' };
    }

    journal({ time: new Date().toISOString(), to: normalized, kind, body, ...result });
    return result;
  }
}

// Persian receipt templates used across IVR + dashboard
export function receiptSms(sub: { name: string; billId?: string; phone: string }, amount: number): string {
  return `مشترک ${sub.name}، پرداخت مبلغ ${amount.toLocaleString('fa-IR')} ریال قبض برق ${sub.billId || ''} ثبت شد. شرکت توزیع برق ایلام - گردآفرین`;
}

export function installmentSms(sub: { name: string }, count: number, amount: number, days: number): string {
  return `${sub.name} عزیز، قسط‌بندی شما (${count} قسط ${amount.toLocaleString('fa-IR')} ریالی، قسط اول تا ${days} روز) تأیید شد. گردآفرین - برق ایلام`;
}
