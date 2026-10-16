// Persistent JSON-backed data store for the Gardafarin platform.
// Acts as a drop-in repository layer: subscribers, calls, commitments, SMS outbox,
// follow-up tasks and system logs are persisted to disk so nothing is lost on restart.
// If DATABASE_URL starts with postgres:// the app runs in "postgres-ready" mode and
// warns that the pg driver must be installed; otherwise it uses the embedded store.
import fs from 'fs';
import path from 'path';

export interface SmsMessage {
  id: string;
  to: string;
  body: string;
  kind: 'receipt' | 'installment' | 'reminder';
  status: 'queued' | 'sent' | 'failed';
  createdAt: string;
  sentAt?: string;
  error?: string;
}

export interface Commitment {
  id: string;
  callId: string;
  subscriberPhone: string;
  subscriberName: string;
  type: 'payment' | 'installment';
  amount: number;
  installments?: number;
  dueDate: string; // ISO date
  source: 'ivr-dtmf' | 'voice-intent' | 'manual';
  createdAt: string;
  fulfilled: boolean;
}

export interface FollowUpTask {
  id: string;
  subscriberPhone: string;
  subscriberName: string;
  dueDate: string;
  note: string;
  done: boolean;
  createdAt: string;
}

export interface OutageReport {
  id: string;
  address: string;
  region?: string;
  billId?: string;
  subscriberName?: string;
  phone?: string;
  status: 'registered' | 'assigned' | 'resolved';
  trackingCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRequest {
  id: string;
  requestType: string;
  nationalId: string;
  phoneNumber: string;
  billId?: string;
  subscriberName?: string;
  status: 'submitted' | 'processing' | 'completed';
  referenceCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecord {
  id: string;
  billId: string;
  amount: number;
  method: 'online' | 'pos' | 'ivr-dtmf' | 'manual';
  reference: string;
  transactionResult?: string;
  paidAt: string;
  subscriberName?: string;
  phone?: string;
}

interface StoreShape {
  subscribers: any[];
  calls: any[];
  smsOutbox: SmsMessage[];
  commitments: Commitment[];
  tasks: FollowUpTask[];
  logs: { time: string; level: string; message: string }[];
  outages: OutageReport[];
  serviceRequests: ServiceRequest[];
  payments: PaymentRecord[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_CALLS = 500;
const MAX_LOGS = 1000;
const MAX_SMS = 500;

function load(): StoreShape {
  const empty: StoreShape = { subscribers: [], calls: [], smsOutbox: [], commitments: [], tasks: [], logs: [], outages: [], serviceRequests: [], payments: [] };
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return { ...empty, ...raw };
    }
  } catch (e: any) {
    console.warn('[DB] Failed to read db.json, starting fresh:', e.message);
  }
  return empty;
}

export class JsonStore {
  private data: StoreShape;
  private dirty = false;
  private flushTimer: any = null;

  constructor() {
    this.data = load();
    const url = process.env.DATABASE_URL || '';
    if (/^postgres(ql)?:\/\//i.test(url)) {
      console.warn('[DB] DATABASE_URL points to PostgreSQL. Install the "pg" driver to enable native persistence; using embedded JSON store meanwhile.');
    }
    // Periodic debounced flush
    setInterval(() => this.flush(), 5000).unref?.();
    process.on('exit', () => this.flush());
  }

  private scheduleFlush() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
    this.flushTimer.unref?.();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data));
    } catch (e: any) {
      console.warn('[DB] Flush failed:', e.message);
    }
  }

  // ---- Subscribers ----
  getSubscribers() { return this.data.subscribers; }
  setSubscribers(list: any[]) { this.data.subscribers = list; this.scheduleFlush(); }
  addSubscriber(sub: any) { this.data.subscribers.push(sub); this.scheduleFlush(); }
  updateSubscriber(id: string, patch: Partial<any>): any | null {
    const idx = this.data.subscribers.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    this.data.subscribers[idx] = { ...this.data.subscribers[idx], ...patch };
    this.scheduleFlush();
    return this.data.subscribers[idx];
  }

  // ---- Calls ----
  getCalls() { return this.data.calls; }
  addCall(record: any) {
    this.data.calls.unshift(JSON.parse(JSON.stringify(record)));
    if (this.data.calls.length > MAX_CALLS) this.data.calls.length = MAX_CALLS;
    this.scheduleFlush();
  }
  upsertCall(record: any) {
    const idx = this.data.calls.findIndex((c) => c.id === record.id);
    const clone = JSON.parse(JSON.stringify(record));
    if (idx === -1) this.addCall(clone);
    else { this.data.calls[idx] = clone; this.scheduleFlush(); }
  }

  // ---- SMS outbox ----
  getSms() { return this.data.smsOutbox; }
  addSms(msg: SmsMessage) {
    this.data.smsOutbox.unshift(msg);
    if (this.data.smsOutbox.length > MAX_SMS) this.data.smsOutbox.length = MAX_SMS;
    this.scheduleFlush();
  }
  updateSms(id: string, patch: Partial<SmsMessage>) {
    const m = this.data.smsOutbox.find((s) => s.id === id);
    if (m) { Object.assign(m, patch); this.scheduleFlush(); }
    return m || null;
  }

  // ---- Commitments ----
  getCommitments() { return this.data.commitments; }
  addCommitment(c: Commitment) { this.data.commitments.unshift(c); this.scheduleFlush(); }
  markCommitmentFulfilled(callId: string) {
    const c = this.data.commitments.find((x) => x.callId === callId && !x.fulfilled);
    if (c) { c.fulfilled = true; this.scheduleFlush(); }
    return c || null;
  }
  markCommitmentFulfilledById(id: string) {
    const c = this.data.commitments.find((x) => x.id === id);
    if (c) { c.fulfilled = true; this.scheduleFlush(); }
    return c || null;
  }
  scheduleFlushPublic() { this.scheduleFlush(); }

  // ---- Follow-up tasks ----
  getTasks() { return this.data.tasks; }
  addTask(t: FollowUpTask) { this.data.tasks.unshift(t); this.scheduleFlush(); }
  toggleTask(id: string) {
    const t = this.data.tasks.find((x) => x.id === id);
    if (t) { t.done = !t.done; this.scheduleFlush(); }
    return t || null;
  }

  // ---- Logs ----
  getLogs(limit = 200) { return this.data.logs.slice(-limit); }
  addLog(level: string, message: string) {
    this.data.logs.push({ time: new Date().toISOString(), level, message });
    if (this.data.logs.length > MAX_LOGS) this.data.logs.splice(0, this.data.logs.length - MAX_LOGS);
    this.scheduleFlush();
  }

  // ---- Outage reports (121-style incident register) ----
  getOutages() { return this.data.outages; }
  addOutage(o: OutageReport) {
    this.data.outages.unshift(o);
    if (this.data.outages.length > MAX_SMS) this.data.outages.length = MAX_SMS;
    this.scheduleFlush();
  }
  updateOutage(id: string, patch: Partial<OutageReport>) {
    const o = this.data.outages.find((x) => x.id === id);
    if (o) { Object.assign(o, patch, { updatedAt: new Date().toISOString() }); this.scheduleFlush(); }
    return o || null;
  }

  // ---- Online service requests (انشعاب جدید، تغییر نام و...) ----
  getServiceRequests() { return this.data.serviceRequests; }
  addServiceRequest(r: ServiceRequest) {
    this.data.serviceRequests.unshift(r);
    if (this.data.serviceRequests.length > MAX_SMS) this.data.serviceRequests.length = MAX_SMS;
    this.scheduleFlush();
  }
  updateServiceRequest(id: string, patch: Partial<ServiceRequest>) {
    const r = this.data.serviceRequests.find((x) => x.id === id);
    if (r) { Object.assign(r, patch, { updatedAt: new Date().toISOString() }); this.scheduleFlush(); }
    return r || null;
  }

  // ---- Payment ledger (real settlements reconcile commitments & debt) ----
  getPayments() { return this.data.payments; }
  addPayment(p: PaymentRecord) {
    this.data.payments.unshift(p);
    if (this.data.payments.length > MAX_CALLS * 4) this.data.payments.length = MAX_CALLS * 4;
    this.scheduleFlush();
  }

  // Reconcile a subscriber's debt after a verified payment: reduce debt, mark
  // matching commitments fulfilled and clear their follow-up tasks.
  applyPaymentToSubscriber(subscriberId: string, amount: number): { subscriber: any; fulfilledCommitments: Commitment[] } | null {
    const idx = this.data.subscribers.findIndex((s) => s.id === subscriberId);
    if (idx === -1) return null;
    const sub = this.data.subscribers[idx];
    const remaining = Math.max(0, (Number(sub.debt) || 0) - amount);
    const status = remaining === 0 ? 'خوش حساب' : sub.status;
    this.data.subscribers[idx] = { ...sub, debt: remaining, status, lastPayment: new Date().toISOString().slice(0, 10) };
    const phone = String(sub.phone || '');
    const smsPhone = String(sub.smsPhone || '');
    const fulfilledCommitments = this.data.commitments.filter(
      (c) => !c.fulfilled && (c.subscriberPhone === phone || c.subscriberPhone === smsPhone)
    );
    for (const c of fulfilledCommitments) {
      c.fulfilled = true;
      const task = this.data.tasks.find((t) => !t.done && t.subscriberPhone === c.subscriberPhone && /پرداخت|قسط/.test(t.note));
      if (task) task.done = true;
    }
    this.scheduleFlush();
    return { subscriber: this.data.subscribers[idx], fulfilledCommitments };
  }
}
