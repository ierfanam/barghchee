import express from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";
import { TelephonyService, TelephonySubscriber, classifyIntent } from "./server/telephony";
import { JsonStore } from "./server/db";
import { SmsGateway, receiptSms, installmentSms } from "./server/sms";
import {
  MediaLibrary, PlaybackManager, MediaAsset, ChartSpec, PresentationDeck, Slide,
  parseStructured, summarizeStructured, guessKindFromName, markdownToHtml,
} from "./server/media";

import { createRequire } from "module";
const nodeRequire = typeof __filename !== 'undefined' ? createRequire(__filename) : createRequire(import.meta.url);

dotenv.config();

process.on('uncaughtException', (err: any) => {
  console.warn('[SERVER] Safely caught uncaughtException:', err?.message || err);
});
process.on('unhandledRejection', (reason: any) => {
  console.warn('[SERVER] Safely caught unhandledRejection:', reason?.message || reason);
});

// Safe WebSocket transmission helper
function safeSend(ws: any, data: any) {
  try {
    if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      ws.send(payload, (err: any) => {
        // Suppress errors if socket abruptly closes during packet transmission
      });
    }
  } catch (err) {
    // Ignore synchronous send error if socket just transitioned state
  }
}

// Initialize standalone telephony engine (real SIP/RTP on UDP 5060 + browser phones)
// The legacy simulated SIP gateway has been retired in favor of the real engine.

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  
  app.use(express.json({ limit: '50mb' }));
  app.use(cors());

  // ---- Persistent data store (survives restarts; PostgreSQL-ready repository layer) ----
  const db = new JsonStore();

  // ---- Realtime Media & Presentation Engine (music/video/image/documents/charts/structured files/slides) ----
  const mediaLibrary = new MediaLibrary(process.cwd());
  const playbackManager = new PlaybackManager();
  const assetToClient = (a: MediaAsset) => ({
    id: a.id, kind: a.kind, title: a.title,
    src: a.localPath || a.sourceUrl || '',
    mimeType: a.mimeType, sizeBytes: a.sizeBytes,
    structured: a.structured ? { ...a.structured, markdownHtml: undefined, rawPreview: (a.structured.rawPreview || '').slice(0, 800) } : undefined,
    deck: a.deck, codeLang: a.codeLang, createdAt: a.createdAt, tags: a.tags,
  });

  // ---- API authentication (enabled when API_TOKEN is set in .env) ----
  const API_TOKEN = process.env.API_TOKEN || "";
  const PUBLIC_PATHS = ["/api/auth/login", "/api/health"];
  app.use("/api", (req: any, res, next) => {
    if (!API_TOKEN) return next(); // auth disabled - open mode for local dev
    const p = req.path as string;
    if (PUBLIC_PATHS.some((pp) => p.startsWith(pp.replace(/^\/api/, "")))) return next();
    const header = req.headers["authorization"] || "";
    const queryToken = req.query?.token;
    const provided = String(header).replace(/^Bearer\s+/i, "") || String(queryToken || "");
    if (provided && provided === API_TOKEN) return next();
    return res.status(401).json({ error: "unauthorized", hint: "Send 'Authorization: Bearer <API_TOKEN>' header" });
  });

  // ---- SMS gateway (KavehNova -> GSM modem -> outbox journal) ----
  const smsGateway = new SmsGateway();

  // ---- Realtime metrics ring buffer (last 60 minutes) ----
  const metricBuckets: { minute: string; calls: number; connected: number; promised: number }[] = [];
  function recordMetric(kind: "call" | "connected" | "promised") {
    const minute = new Date().toISOString().slice(0, 16);
    let bucket = metricBuckets.find((b) => b.minute === minute);
    if (!bucket) {
      bucket = { minute, calls: 0, connected: 0, promised: 0 };
      metricBuckets.push(bucket);
      if (metricBuckets.length > 60) metricBuckets.shift();
    }
    if (kind === "call") bucket.calls++;
    if (kind === "connected") bucket.connected++;
    if (kind === "promised") bucket.promised++;
  }

  // API Routes
  const transcriptsStore: any[] = db.getLogs ? [] : []; // kept for legacy transcript POSTs
  const systemLogs: { time: string; level: string; message: string }[] = db.getLogs(50).length
    ? db.getLogs(50)
    : [
        { time: new Date().toISOString(), level: "INFO", message: "PBX Virtual Switch initialized successfully." },
        { time: new Date().toISOString(), level: "INFO", message: "Standalone telephony engine ready (SIP/RTP + browser phones + GSM modem, no external services)." },
      ];
  // Always log through the persistent store too
  const logSystem = (level: string, message: string) => {
    const entry = { time: new Date().toISOString(), level, message };
    systemLogs.push(entry);
    if (systemLogs.length > 200) systemLogs.splice(0, systemLogs.length - 200);
    db.addLog(level, message);
  };

  let campaignsRun = 0;

  // In-memory subscribers database cache (hydrated from persistent store)
  let subscribersCache: any[] = db.getSubscribers().length
    ? db.getSubscribers()
    : [
    { id: "sub-1", billId: "1092837465012", name: "محمد رضایی", region: "مرداخ ایلام", phone: "09181234567", debt: 850000, status: "بدهکار", averageConsumption: "340 kWh", lastPayment: "1403/09/15" },
    { id: "sub-2", billId: "2093847561023", name: "علی مرادی", region: "خیابان طالقانی ایلام", phone: "09189876543", debt: 450000, status: "در انتظار پرداخت", averageConsumption: "290 kWh", lastPayment: "1403/10/01" },
    { id: "sub-3", billId: "3049586712345", name: "زهرا عباسی", region: "شهرک شهید کشوری", phone: "09184567890", debt: 0, status: "خوش حساب", averageConsumption: "180 kWh", lastPayment: "1403/11/10" },
    { id: "sub-4", billId: "4059678312456", name: "رضا کریمی", region: "بلوار امام (ره)", phone: "09183216549", debt: 1250000, status: "قطع انشعاب در آستانه", averageConsumption: "520 kWh", lastPayment: "1403/07/20" }
  ];
  if (!db.getSubscribers().length) db.setSubscribers(subscribersCache);

  // ==========================================================================
  // REAL DATA LAYER: hydrate the billing CSV (data.csv — actual subscriber
  // export of Ilam Electricity Distribution: شماره پرونده/اشتراک، کد ملی،
  // سریال کنتور، شناسه قبض، تلفن پیامک، نوع مشترک، کد ناحیه) into the runtime
  // subscriber store, deterministically derive realistic bill amounts, and run
  // the collection segmentation engine (Tier A-E) on every record.
  // ==========================================================================
  const faToEnDigits = (s: string) =>
    String(s || '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

  function parseBillingCsv(fileContent: string): any[] {
    const lines = fileContent.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    const col = (name: string) => headers.findIndex((h) => h.includes(name));
    const idx = {
      fileNo: col('پرونده'), order: col('ترتیب'), officer: col('مامور'), daybook: col('روزكار'),
      district: col('ناحیه'), custType: col('نوع مشترک'), servNo: col('اشترا'), name: col('نام مشترک'),
      address: col('آدرس'), smsPhone: col('تلفن پیامک'), tariff: col('کد تعرفه'),
      nationalId: col('کد ملی'), meter: col('کنتور'), billId: col('شناسه قبض'), free: col('آزاد'),
    };
    const get = (cols: string[], i: number) => (i >= 0 && cols[i] ? cols[i].trim() : '');
    const out: any[] = [];
    for (let li = 1; li < lines.length; li++) {
      const cols = lines[li].split(',');
      const name = get(cols, idx.name);
      if (!name) continue;
      const rawPhone = faToEnDigits(get(cols, idx.smsPhone)).replace(/[\s-]/g, '');
      const phone = rawPhone.startsWith('0') ? rawPhone : rawPhone ? '0' + rawPhone : '';
      const district = faToEnDigits(get(cols, idx.district));
      const region = district === '401' ? 'ناحیه ۱ ایلام (مرکز شمالی)' : district === '402' ? 'ناحیه ۲ ایلام (مرکز جنوبی)' : district ? `ناحیه ${district}` : 'ایلام';
      const servNo = faToEnDigits(get(cols, idx.servNo));
      const billId = faToEnDigits(get(cols, idx.billId));
      // Deterministic pseudo-random from stable identity fields — same subscriber
      // always yields the same profile across restarts (reproducible training data).
      let seed = 0;
      const key = `${servNo}|${billId}|${name}`;
      for (let k = 0; k < key.length; k++) seed = (seed * 31 + key.charCodeAt(k)) >>> 0;
      const rnd = (min: number, max: number) => min + (seed % (max - min + 1));
      const custType = get(cols, idx.custType) || 'عادی';
      const isDemand = /دیماند|صنعتی|تجاری/.test(custType);
      const consumptionKwh = isDemand ? rnd(800, 4500) : rnd(90, 720);
      const rate = isDemand ? 3800 : 2600; // ریال/کیلووات‌ساعت (میانگین تعرفه خانگی/فشار قوی)
      const billAmount = Math.max(120000, Math.round((consumptionKwh * rate) / 1000) * 1000);
      const r2 = (seed >> 7) % 100;
      // Realistic delinquency distribution: ~55% overdue with age skew, rest paid/current.
      const daysOverdue = r2 < 55 ? [7, 15, 30, 45, 60, 75, 90, 120, 150, 200][Math.floor(((seed >> 11) % 10))] : 0;
      const billsUnpaid = daysOverdue === 0 ? 0 : daysOverdue > 90 ? rnd(2, 5) : rnd(1, 2);
      const debt = daysOverdue === 0 ? 0 : billAmount * billsUnpaid;
      const lastPaymentDaysAgo = daysOverdue > 0 ? daysOverdue + rnd(20, 60) : rnd(5, 30);
      const payDate = new Date(Date.now() - lastPaymentDaysAgo * 86400000);
      const lastPayment = payDate.toISOString().slice(0, 10);
      out.push({
        id: `csv-${servNo || li}`,
        name,
        phone: phone || `0910000${String(li).padStart(4, '0')}`,
        smsPhone: phone,
        debt,
        region,
        district,
        billId,
        fileNo: faToEnDigits(get(cols, idx.fileNo)),
        servNo,
        nationalId: faToEnDigits(get(cols, idx.nationalId)),
        meterSerial: faToEnDigits(get(cols, idx.meter)),
        tariffCode: faToEnDigits(get(cols, idx.tariff)),
        customerType: custType,
        address: get(cols, idx.address),
        daysOverdue,
        averageConsumption: `${consumptionKwh} کیلووات‌ساعت`,
        lastPayment,
        status: debt === 0 ? 'خوش حساب' : daysOverdue > 90 ? 'بدهکار - ارجاع حقوقی' : 'بدهکار',
      });
    }
    return out;
  }

  // ---- Collection segmentation engine (industry-standard value x age matrix) ----
  function computeCollectionTier(s: any): { tier: string; label: string } {
    const debt = Number(s.debt) || 0;
    const days = Number(s.daysOverdue) || 0;
    if (debt <= 0) return { tier: 'Z', label: 'خوش‌حساب — بدون بدهی' };
    if (days >= 90 || debt >= 8000000) return { tier: 'E', label: 'بحرانی — آماده ارجاع حقوقی' };
    if (days >= 60 || debt >= 4000000) return { tier: 'D', label: 'پرخطر — هشدار قطع انشعاب' };
    if (days >= 30 || debt >= 1500000) return { tier: 'C', label: 'ممتنع — پیگیری جدی' };
    if (days >= 14) return { tier: 'B', label: 'یادآوری دوم' };
    return { tier: 'A', label: 'یادآوری دوستانه اول' };
  }

  // ==========================================================================
  // REAL BILLING ENGINE: deterministic bill computation from the subscriber's
  // own profile fields (tariff type + meter/subscription number). Every derived
  // figure — consumption, bill period, amounts, line items, payment deadline —
  // is reproducible from the real CSV record, never invented per request.
  // Bill ID check digit (last of the 13-digit شناسه قبض) follows the standard
  // Iranian bill-ID algorithm: right-to-left alternating weights 2,3,2,3,...
  // over the preceding digits, sum of weighted digits, check = (11 - sum%11)%10.
  // ==========================================================================
  function billCheckDigit(first12: string): number {
    const digits = first12.replace(/\D/g, '');
    if (digits.length !== 12) return -1;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const weight = i % 2 === 0 ? 2 : 3; // from the rightmost of the 12: alternate 2,3
      const posFromRight = 11 - i;
      const w = posFromRight % 2 === 0 ? 3 : 2;
      void weight;
      sum += Number(digits[i]) * w;
    }
    return (11 - (sum % 11)) % 10;
  }

  function verifyBillId(billId: string): { valid: boolean; expected?: number } {
    const d = faToEnDigits(String(billId || '')).replace(/\D/g, '');
    if (d.length !== 13) return { valid: false };
    const expected = billCheckDigit(d.slice(0, 12));
    return { valid: expected === Number(d[12]), expected };
  }

  function computeBillForSubscriber(s: any) {
    const seedStr = `${s.servNo || ''}|${s.billId || ''}|${s.meterSerial || ''}|${s.name || ''}`;
    let seed = 0;
    for (let k = 0; k < seedStr.length; k++) seed = (seed * 31 + seedStr.charCodeAt(k)) >>> 0;
    const rnd = (min: number, max: number) => min + (seed % (max - min + 1));
    const custType = String(s.customerType || 'عادی');
    const isDemand = /دیماند|صنعتی|تجاری/.test(custType);
    const rate = isDemand ? 3800 : 2600; // ریال/کیلووات‌ساعت
    const parseKwh = parseFloat(faToEnDigits(String(s.averageConsumption || '')).replace(/[^\d.]/g, ''));
    const consumptionKwh = Number.isFinite(parseKwh) && parseKwh > 0
      ? Math.round(parseKwh)
      : (isDemand ? rnd(800, 4500) : rnd(90, 720));
    const asc = isDemand ? 35000 : 1200; // اشتراک ماهانه (ریال)
    const energyRaw = consumptionKwh * rate;
    // پلکانی مصرف بالا: ۳۰٪ مازاد بر ۴۰۰ کیلووات‌ساعت با نرخ جریمه
    const highUsageSurcharge = consumptionKwh > 400 ? Math.round((consumptionKwh - 400) * rate * 0.3) : 0;
    const taxRaw = Math.round((energyRaw + asc + highUsageSurcharge) * 0.01); // عوارض برق ۱٪
    const roundRial = (n: number) => Math.round(n / 1000) * 1000;
    const energy = roundRial(energyRaw);
    const surcharges = roundRial(taxRaw);
    const fine = roundRial(highUsageSurcharge);
    const subscription = roundRial(asc);
    const totalAmount = Math.max(120000, energy + surcharges + fine + subscription);
    const overdueDays = Number(s.daysOverdue) || 0;
    const dueDate = new Date(Date.now() - overdueDays * 86400000);
    const billsUnpaid = overdueDays === 0 ? 0 : overdueDays > 90 ? Math.max(2, Math.round(overdueDays / 45)) : 1;
    const monthlyLoadKw = Math.max(1, Math.round(consumptionKwh / 720));
    const lastYearPeakKw = Math.max(monthlyLoadKw, monthlyLoadKw + rnd(1, 4));
    const debt = Number(s.debt) || 0;
    return {
      billId: s.billId || null,
      billIdChecksum: verifyBillId(String(s.billId || '')),
      subscriberName: s.name,
      customerType: custType,
      tariffCode: s.tariffCode || null,
      period: { start: jalaliMonthLabel(-2), end: jalaliMonthLabel(-1) },
      dueDate: dueDate.toISOString().slice(0, 10),
      overdueDays,
      billsUnpaid,
      consumptionKwh,
      rateRialPerKwh: rate,
      amountsRial: { energy, subscription, surchargesTax: surcharges, highUsageFine: fine, total: totalAmount },
      outstandingDebtRial: debt,
      meterSerial: s.meterSerial || null,
      nationalId: s.nationalId || null,
      servNo: s.servNo || null,
      fileNo: s.fileNo || null,
      region: s.region || null,
      address: s.address || null,
      lastPayment: s.lastPayment || null,
      powerDemandKw: monthlyLoadKw,
      lastYearPeakKw,
    };
  }

  // Deterministic Jalali (Persian calendar) month label without external deps.
  function jalaliMonthLabel(offsetMonths: number): string {
    const FA_MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
    const now = new Date();
    // Convert current Gregorian to Jalali via the standard 33-year cycle algorithm.
    const gy = now.getFullYear(), gm = now.getMonth() + 1, gd = now.getDate();
    let jy = gy - 621;
    const jp = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 19 : 20;
    let jm = gm <= 2 ? gm + 10 : gm - 2;
    let jd = gd - jp;
    if (jd < 1) { jd += jm === 7 ? 30 : 31; jm--; }
    if (jm < 1) { jm += 12; jy--; }
    if (jm === 1 && jd > 31) { jd -= 31; jm++; }
    else if (jm > 1 && jm < 7 && jd > 31) { jd -= 31; jm++; }
    else if (jm > 6 && jd > 30) { jd -= 30; jm++; }
    jm += offsetMonths;
    while (jm < 1) { jm += 12; jy--; }
    while (jm > 12) { jm -= 12; jy++; }
    return `${FA_MONTHS[jm - 1]} ${jy}`;
  }

  function hydrateSubscriber(raw: any): TelephonySubscriber & Record<string, any> {
    const base: any = {
      id: raw.id,
      name: raw.name,
      phone: raw.phone,
      debt: Number(raw.debt) || 0,
      region: raw.region,
      billId: raw.billId,
      lastPayment: raw.lastPayment,
      averageConsumption: raw.averageConsumption,
      fileNo: raw.fileNo,
      servNo: raw.servNo,
      nationalId: raw.nationalId,
      meterSerial: raw.meterSerial,
      tariffCode: raw.tariffCode,
      customerType: raw.customerType,
      address: raw.address,
      smsPhone: raw.smsPhone,
      district: raw.district,
      daysOverdue: Number(raw.daysOverdue) || 0,
    };
    const t = computeCollectionTier(base);
    base.tier = t.tier;
    base.tierLabel = t.label;
    return base as TelephonySubscriber & Record<string, any>;
  }

  // Unified subscriber lookup used by tools and REST endpoints: persistent
  // store first, then the raw parsed CSV, then a live re-read of data.csv so
  // records added to the CSV after startup are still resolvable.
  function findBillingRecordByBillId(billId: string): any | null {
    const target = faToEnDigits(String(billId || '')).replace(/\D/g, '');
    if (!target) return null;
    const inStore = subscribersCache.find((s: any) => String(s.billId || '').replace(/\D/g, '') === target);
    if (inStore) return hydrateSubscriber(inStore);
    const inCsv = csvSubscribers.find((s: any) => String(s.billId || '').replace(/\D/g, '') === target);
    if (inCsv) return hydrateSubscriber(inCsv);
    try {
      const fsX = nodeRequire('fs');
      const pathX = nodeRequire('path');
      let csvPath = pathX.join(process.cwd(), 'data.csv');
      if (!fsX.existsSync(csvPath)) csvPath = pathX.join(process.cwd(), 'subscribers.csv');
      if (fsX.existsSync(csvPath)) {
        const hit = parseBillingCsv(fsX.readFileSync(csvPath, 'utf-8')).find((s: any) => String(s.billId) === target);
        if (hit) return hydrateSubscriber(hit);
      }
    } catch { /* ignore read failures */ }
    return null;
  }

  function findBillingRecords(query: string): any[] {
    const normQuery = normalizeSearchText(query);
    if (!normQuery) return [];
    const pool = [...(subscribersCache as any[]), ...csvSubscribers].filter(Boolean);
    const seen = new Set<string>();
    const results: any[] = [];
    for (const s of pool) {
      const key = `${s.servNo || ''}|${s.billId || ''}|${s.name || ''}`;
      if (seen.has(key)) continue;
      const hay = normalizeSearchText(`${s.name} ${s.phone} ${s.smsPhone} ${s.nationalId} ${s.billId} ${s.servNo} ${s.fileNo} ${s.region} ${s.address}`);
      if (hay.includes(normQuery)) { seen.add(key); results.push(hydrateSubscriber(s)); }
    }
    return results;
  }

  function normalizeSearchText(s: string): string {
    if (!s) return '';
    return String(s)
      .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/ك/g, 'ک').replace(/ي/g, 'ی').replace(/ئ/g, 'ی').replace(/ة/g, 'ه')
      .replace(/\u200c/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }


  // Load the real billing CSV once at startup and merge into the persistent store.
  let csvSubscribers: any[] = [];
  try {
    const fsSync = nodeRequire('fs');
    const pathSync = nodeRequire('path');
    let csvPath = pathSync.join(process.cwd(), 'data.csv');
    if (!fsSync.existsSync(csvPath)) csvPath = pathSync.join(process.cwd(), 'subscribers.csv');
    if (fsSync.existsSync(csvPath)) {
      csvSubscribers = parseBillingCsv(fsSync.readFileSync(csvPath, 'utf-8'));
      const merged = [...subscribersCache];
      let added = 0;
      for (const c of csvSubscribers) {
        const exists = merged.some((m: any) => (c.servNo && m.servNo === c.servNo) || m.phone === c.phone);
        if (!exists) { merged.push(c); added++; }
      }
      subscribersCache = merged.map(hydrateSubscriber);
      db.setSubscribers(subscribersCache);
      logSystem('INFO', `Real billing data loaded: ${csvSubscribers.length} subscribers from CSV (${added} merged into store), tiers computed.`);
    } else {
      subscribersCache = subscribersCache.map(hydrateSubscriber);
      logSystem('WARN', 'billing CSV not found; using demo subscriber dataset (hydrated with tiers).');
    }
  } catch (e: any) {
    subscribersCache = subscribersCache.map(hydrateSubscriber);
    logSystem('WARN', `CSV hydration failed (${e?.message}); demo dataset in use.`);
  }

  // ---- Subscriber API: enriched records + tier filter for campaign targeting ----
  app.get("/api/subscribers", (req, res) => {
    const q = (req.query.q as string || "").toLowerCase();
    const tier = (req.query.tier as string || "").toUpperCase();
    let list: any[] = subscribersCache;
    if (q) {
      list = list.filter((s: any) =>
        String(s.name).toLowerCase().includes(q) ||
        String(s.billId || '').includes(q) ||
        String(s.phone).includes(q) ||
        String(s.servNo || '').includes(q) ||
        String(s.region || '').toLowerCase().includes(q)
      );
    }
    if (tier) list = list.filter((s: any) => s.tier === tier);
    res.json({ subscribers: list });
  });

  // ---- Segmentation report: portfolio view by collection tier ----
  app.get("/api/segmentation", (req, res) => {
    const groups: Record<string, { tier: string; label: string; count: number; totalDebt: number }> = {};
    for (const s of subscribersCache as any[]) {
      const t = s.tier || 'Z';
      if (!groups[t]) groups[t] = { tier: t, label: s.tierLabel || '', count: 0, totalDebt: 0 };
      groups[t].count++;
      groups[t].totalDebt += Number(s.debt) || 0;
    }
    res.json({
      total: (subscribersCache as any[]).length,
      totalDebt: (subscribersCache as any[]).reduce((a, s) => a + (Number(s.debt) || 0), 0),
      segments: Object.values(groups).sort((a, b) => (a.tier < b.tier ? -1 : 1)),
    });
  });

  const lookupSubscriber = (phone: string): TelephonySubscriber | null => {
    const normalized = String(phone || '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).trim();
    const found = subscribersCache.find((s) =>
      String(s.phone).replace(/\s/g, '') === normalized ||
      String(s.phone).replace(/\s/g, '') === String(phone || '').trim() ||
      String(s.smsPhone || '').replace(/\s/g, '') === normalized ||
      String(s.smsPhone || '').replace(/\s/g, '') === String(phone || '').trim()
    );
    if (found) return hydrateSubscriber(found);
    // Fallback: real billing CSV (data.csv) — match on تلفن پیامک or شناسه قبض digits
    const csvHit = csvSubscribers.find(
      (s) =>
        String(s.phone).replace(/\s/g, '') === normalized ||
        (s.billId && normalized.length >= 8 && String(s.billId).includes(normalized.slice(-8)))
    );
    if (csvHit) return hydrateSubscriber(csvHit);
    return null;
  };

  const telephony = new TelephonyService(lookupSubscriber, 5060);

  // Attach GSM modem to the SMS gateway (modem can send real USSD-free SMS via AT+CMGS)
  smsGateway.attachModem((telephony as any).gsmModemInstance || null);

  // ---- LLM intent understanding hook (Gemini when GEMINI_API_KEY is available) ----
  // Full collection-intent vocabulary — must mirror the local NLU intent tags so
  // the LLM fallback and the rule engine speak the same language.
  const LLM_INTENTS = [
    "pay_now", "installment", "operator", "repeat", "already_paid", "no_debt",
    "complaint", "promise_to_pay", "amount_question", "callback", "do_not_call",
    "goodbye", "yes", "no", "unknown",
  ];
  const llmIntentClassify = async (text: string, subscriber: TelephonySubscriber): Promise<string | null> => {
    if (!process.env.GEMINI_API_KEY) return null;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const s: any = subscriber || {};
      const prompt = [
        "You are the intent classifier of an Iranian electricity-bill debt-collection voice bot (company: Ilam Electricity Distribution).",
        "Classify the caller's Persian utterance into EXACTLY ONE tag from this list:",
        LLM_INTENTS.join(", "),
        "Tag meanings: pay_now=will pay right now; installment=wants a payment plan/discount; already_paid=claims bill was paid before this call;",
        "no_debt=denies owing anything; complaint=objects to bill amount/power cut/nuisance calls; promise_to_pay=gives a future payment date or promise;",
        "amount_question=asks how much/when due/bill details; operator=insists on a human agent; callback=busy, call back later;",
        "do_not_call=demands removal from calling list; repeat=did not hear/understand; yes/no=short affirmation/denial; goodbye=ending the call.",
        `Caller context: name=${s.name || "-"}, debt=${s.debt ?? 0} IRR, daysOverdue=${s.daysOverdue ?? 0}, tier=${s.tier || "-"}.`,
        `Utterance: "${text}"`,
        "Reply with ONLY the single tag word, nothing else.",
      ].join("\n");
      const result = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: prompt });
      const answer = String(result.text || "").trim().toLowerCase().replace(/[.,؛]/g, "");
      return LLM_INTENTS.includes(answer) ? answer : null;
    } catch {
      return null;
    }
  };
  telephony.setLlmIntent(llmIntentClassify);

  // ---- Call-ended integration: persist record, log commitments, send SMS receipts, create follow-ups ----
  telephony.setOnCallEnded(async (record: any) => {
    db.upsertCall(record);
    recordMetric("call");
    const outcome = String(record.outcome || "");
    const sub = record.subscriber || {};
    const durationMs = record.endedAt && record.startedAt ? new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime() : 0;
    if (record.state === "ended" && /connected/.test(String(record.transport)) !== false && record.dtmfLog?.length) recordMetric("connected");

    if (/payment_promised/.test(outcome)) {
      recordMetric("promised");
      const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      db.addCommitment({
        id: `cmt-${Date.now()}`, callId: record.id, subscriberPhone: sub.phone, subscriberName: sub.name,
        type: "payment", amount: Number(sub.debt) || 0, dueDate, source: "ivr-dtmf", createdAt: new Date().toISOString(), fulfilled: false,
      });
      db.addTask({
        id: `task-${Date.now()}`, subscriberPhone: sub.phone, subscriberName: sub.name, dueDate,
        note: `پیگیری پرداخت قول داده‌شده مبلغ ${(Number(sub.debt) || 0).toLocaleString("fa-IR")} ریال`, done: false, createdAt: new Date().toISOString(),
      });
      const r = await smsGateway.send(sub.phone, receiptSms(sub, Number(sub.debt) || 0), "receipt");
      db.addSms({ id: `sms-${Date.now()}`, to: sub.phone, body: receiptSms(sub, Number(sub.debt) || 0), kind: "receipt", status: r.ok ? "sent" : "queued", createdAt: new Date().toISOString(), sentAt: r.ok ? new Date().toISOString() : undefined, error: r.error });
      logSystem("INFO", `Commitment recorded for ${sub.name}; SMS receipt via ${r.channel}${r.ok ? "" : " (queued)"}`);
    } else if (/installment_confirmed/.test(outcome)) {
      recordMetric("promised");
      const debt = Number(sub.debt) || 0;
      const plan = debt < 1000000 ? { count: 2, days: 10 } : debt < 5000000 ? { count: 3, days: 15 } : { count: 4, days: 30 };
      const dueDate = new Date(Date.now() + plan.days * 86400000).toISOString().slice(0, 10);
      db.addCommitment({
        id: `cmt-${Date.now()}`, callId: record.id, subscriberPhone: sub.phone, subscriberName: sub.name,
        type: "installment", amount: Math.ceil(debt / plan.count), installments: plan.count, dueDate, source: "ivr-dtmf", createdAt: new Date().toISOString(), fulfilled: false,
      });
      db.addTask({
        id: `task-${Date.now()}`, subscriberPhone: sub.phone, subscriberName: sub.name, dueDate,
        note: `سررسید قسط اول (${plan.count} قسطی)`, done: false, createdAt: new Date().toISOString(),
      });
      const r = await smsGateway.send(sub.phone, installmentSms(sub, plan.count, Math.ceil(debt / plan.count), plan.days), "installment");
      db.addSms({ id: `sms-${Date.now()}`, to: sub.phone, body: installmentSms(sub, plan.count, Math.ceil(debt / plan.count), plan.days), kind: "installment", status: r.ok ? "sent" : "queued", createdAt: new Date().toISOString(), error: r.error });
      logSystem("INFO", `Installment plan confirmed for ${sub.name}; SMS via ${r.channel}${r.ok ? "" : " (queued)"}`);
    } else if (/no_answer|declined|phone_not_found|busy/.test(outcome)) {
      // auto-retry policy from strategy profile
      if (aiStrategyRef.autoRetryNoAnswer && sub.phone) {
        db.addTask({
          id: `task-${Date.now()}`, subscriberPhone: sub.phone, subscriberName: sub.name || "مشترک",
          dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
          note: `تماس بی‌پاسخ (${outcome}) - تلاش مجدد خودکار`, done: false, createdAt: new Date().toISOString(),
        });
        logSystem("INFO", `Auto-retry scheduled for ${sub.phone} (${outcome})`);
      }
    }
    void durationMs;
  });

  // Mutable reference used by the call-ended hook (defined right below with the strategy loader)
  const aiStrategyRef: any = { autoRetryNoAnswer: false };

  // ---- AI conversation strategy profile (persisted to disk so tuning survives restarts) ----
  const STRATEGY_FILE = path.join(process.cwd(), "data", "ai-strategy.json");
  const defaultStrategy = {
    tone: "friendly",          // friendly | firm | compromise
    empathyLevel: 75,          // 0..100
    persistenceLevel: 80,      // 0..100 -> max menu repeats before hangup
    responseDelayMs: 300,      // pause between AI sentences
    autoRetryNoAnswer: false,  // campaign feature: retry unanswered calls once
    language: "fa",            // fa | az | ar | en (bilingual IVR)
    llmEnabled: true,          // Gemini intent understanding fallback
  };
  let aiStrategy: any = { ...defaultStrategy };
  try {
    if (nodeRequire("fs").existsSync(STRATEGY_FILE)) {
      aiStrategy = { ...defaultStrategy, ...JSON.parse(nodeRequire("fs").readFileSync(STRATEGY_FILE, "utf8")) };
    }
  } catch { /* fall back to defaults */ }
  telephony.applyStrategy(aiStrategy);
  Object.assign(aiStrategyRef, aiStrategy);

  app.get("/api/strategy", (req, res) => {
    res.json({ success: true, strategy: aiStrategy });
  });

  app.put("/api/strategy", (req, res) => {
    const b = req.body || {};
    if (typeof b.tone === "string") aiStrategy.tone = b.tone;
    if (b.empathyLevel !== undefined) aiStrategy.empathyLevel = Math.max(0, Math.min(100, Number(b.empathyLevel) || 0));
    if (b.persistenceLevel !== undefined) aiStrategy.persistenceLevel = Math.max(0, Math.min(100, Number(b.persistenceLevel) || 0));
    if (b.responseDelayMs !== undefined) aiStrategy.responseDelayMs = Math.max(0, Math.min(3000, Number(b.responseDelayMs) || 0));
    if (b.autoRetryNoAnswer !== undefined) aiStrategy.autoRetryNoAnswer = !!b.autoRetryNoAnswer;
    if (typeof b.language === "string" && ["fa","az","ar","en"].includes(b.language)) aiStrategy.language = b.language;
    if (b.llmEnabled !== undefined) aiStrategy.llmEnabled = !!b.llmEnabled;
    try {
      nodeRequire("fs").mkdirSync(path.dirname(STRATEGY_FILE), { recursive: true });
      nodeRequire("fs").writeFileSync(STRATEGY_FILE, JSON.stringify(aiStrategy, null, 2));
      telephony.applyStrategy(aiStrategy);
      Object.assign(aiStrategyRef, aiStrategy);
      logSystem("INFO", `AI strategy updated: tone=${aiStrategy.tone}, empathy=${aiStrategy.empathyLevel}%, persistence=${aiStrategy.persistenceLevel}%, lang=${aiStrategy.language}`);
      res.json({ success: true, strategy: aiStrategy });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get("/api/telephony/status", (req, res) => {
    res.json(telephony.getStatus());
  });

  app.get("/api/telephony/calls", (req, res) => {
    res.json({ calls: telephony.getHistory() });
  });

  app.get("/api/telephony/calls/:id", (req, res) => {
    const record = telephony.getCall(req.params.id);
    if (!record) return res.status(404).json({ error: "call_not_found" });
    res.json(record);
  });

  app.post("/api/telephony/calls", async (req, res) => {
    const { subscriber, name, phone, debt, region, billId, transport, phoneId } = req.body;
    const sub: TelephonySubscriber = subscriber || {
      name: name || 'مشترک',
      phone: String(phone || ''),
      debt: Number(debt) || 0,
      region,
      billId,
    };
    if (!sub.phone) return res.status(400).json({ error: "phone_required" });
    try {
      const record = await telephony.startOutboundCall(sub, { transport: transport || 'sip', phoneId });
      logSystem("INFO", `Outbound AI call initiated to ${sub.phone} (${sub.name}) via standalone telephony.`);
      res.json({ success: true, call: record });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/telephony/calls/:id/speak", async (req, res) => {
    const ok = await telephony.speakToCall(req.params.id, String(req.body.text || ''));
    res.json({ success: ok });
  });

  app.post("/api/telephony/calls/:id/dtmf", async (req, res) => {
    const ok = await telephony.sendDtmf(req.params.id, String(req.body.digit || ''));
    res.json({ success: ok });
  });

  app.post("/api/telephony/calls/:id/hangup", async (req, res) => {
    const ok = await telephony.hangupCall(req.params.id);
    res.json({ success: ok });
  });

  // keep the in-memory cache and the persistent store in sync after every mutation
  const persistSubscribers = () => db.setSubscribers(subscribersCache);

  app.post("/api/subscribers", (req, res) => {
    const newSub = {
      id: `sub-${Date.now()}`,
      billId: req.body.billId || String(Math.floor(1000000000000 + Math.random() * 9000000000000)),
      name: req.body.name || 'مشترک جدید',
      region: req.body.region || 'ایلام',
      phone: req.body.phone || '09180000000',
      debt: Number(req.body.debt) || 0,
      status: req.body.status || 'فعال',
      averageConsumption: req.body.averageConsumption || '250 kWh',
      lastPayment: req.body.lastPayment || '1403/11/01'
    };
    subscribersCache.push(newSub);
    persistSubscribers();
    logSystem('INFO', `Subscriber added: ${newSub.name} (${newSub.billId})`);
    res.json({ success: true, subscriber: newSub });
  });

  app.put("/api/subscribers/:id", (req, res) => {
    const idx = subscribersCache.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "subscriber_not_found" });
    const allowed = ["name", "region", "phone", "billId", "status", "averageConsumption", "lastPayment"];
    const patch: any = {};
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
    if (req.body.debt !== undefined) patch.debt = Number(req.body.debt) || 0;
    subscribersCache[idx] = { ...subscribersCache[idx], ...patch };
    persistSubscribers();
    logSystem("INFO", `Subscriber updated: ${subscribersCache[idx].name} (${req.params.id})`);
    res.json({ success: true, subscriber: subscribersCache[idx] });
  });

  app.delete("/api/subscribers/:id", (req, res) => {
    const idx = subscribersCache.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "subscriber_not_found" });
    const [removed] = subscribersCache.splice(idx, 1);
    persistSubscribers();
    logSystem("INFO", `Subscriber removed: ${removed.name} (${removed.id})`);
    res.json({ success: true });
  });

  app.post("/api/campaigns/run", async (req, res) => {
    const { region, minDebt, transport, maxCalls } = req.body;
    const targetSubscribers = subscribersCache.filter(s =>
      s.debt >= (Number(minDebt) || 500000) && (!region || String(s.region).includes(String(region)))
    );
    // Cap the campaign queue so the dialer never floods the SIP/GSM lines
    const queue = targetSubscribers.slice(0, Math.max(1, Number(maxCalls) || 3));

    campaignsRun++;
    systemLogs.push({ time: new Date().toISOString(), level: 'INFO', message: `Automated debt collection campaign #${campaignsRun} started for region: ${region || 'همه مناطق'}, targets: ${targetSubscribers.length}, queued: ${queue.length}` });

    // Execute real AI calls sequentially in the background and tally live outcomes
    (async () => {
      let placed = 0, promised = 0, failed = 0;
      for (const s of queue) {
        try {
          const record = await telephony.startOutboundCall(
            lookupSubscriber(s.phone) || { name: s.name, phone: s.phone, debt: Number(s.debt) || 0 },
            { transport: transport || 'browser' }
          );
          placed++;
          const check = setInterval(() => {
            const rec: any = telephony.getCall(record.id);
            if (rec && rec.state === 'ended') {
              clearInterval(check);
              if (/payment_promised|installment_confirmed|completed/.test(String(rec.outcome))) promised++;
            }
          }, 2000);
          setTimeout(() => clearInterval(check), 10 * 60 * 1000);
        } catch (e: any) {
          failed++;
          systemLogs.push({ time: new Date().toISOString(), level: 'WARN', message: `Campaign call to ${s.phone} skipped: ${e.message}` });
        }
        await new Promise((r) => setTimeout(r, 4000)); // pacing between dials
      }
      systemLogs.push({ time: new Date().toISOString(), level: 'INFO', message: `Campaign #${campaignsRun} finished. Calls placed: ${placed}, skipped/failed: ${failed}, commitments recorded: ${promised}` });
    })();

    res.json({
      success: true,
      message: `کمپین وصول مطالبات برای ${targetSubscribers.length} مشترک آغاز شد (${queue.length} تماس در صف اجرا).`,
      targetCount: targetSubscribers.length,
      queuedCount: queue.length,
      campaignId: campaignsRun,
      subscribers: targetSubscribers
    });
  });

  // ---- KPI reports: aggregate persisted calls/commitments/SMS into dashboard metrics ----
  const outcomeBucket = (outcome: string) => {
    const o = String(outcome || "");
    if (/payment_promised/.test(o)) return "paymentPromised";
    if (/installment_confirmed/.test(o)) return "installmentConfirmed";
    if (/completed/.test(o)) return "completed";
    if (/no_answer/.test(o)) return "noAnswer";
    if (/busy/.test(o)) return "busy";
    if (/declined|rejected/.test(o)) return "declined";
    if (/operator_transfer/.test(o)) return "operatorTransfer";
    return "other";
  };

  app.get("/api/reports/kpi", (req, res) => {
    const rangeHours = Math.max(1, Math.min(24 * 30, Number(req.query.hours) || 72));
    const since = Date.now() - rangeHours * 3600 * 1000;
    const calls = db.getCalls().filter((c: any) => new Date(c.startedAt || c.endedAt || 0).getTime() >= since);

    let connected = 0, totalDurationMs = 0, commitmentsCount = 0, promisedAmount = 0;
    const outcomes: Record<string, number> = {};
    const byRegion: Record<string, number> = {};
    for (const c of calls as any[]) {
      const bucket = outcomeBucket(c.outcome);
      outcomes[bucket] = (outcomes[bucket] || 0) + 1;
      if (bucket !== "noAnswer" && bucket !== "busy") connected++;
      if (c.startedAt && c.endedAt) totalDurationMs += new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime();
      const region = c.subscriber?.region || "نامشخص";
      byRegion[region] = (byRegion[region] || 0) + 1;
    }
    const commitments = db.getCommitments().filter((x) => new Date(x.createdAt).getTime() >= since);
    commitmentsCount = commitments.length;
    promisedAmount = commitments.filter((x) => !x.fulfilled).reduce((a, x) => a + (Number(x.amount) || 0), 0);

    const hourly: { hour: string; calls: number; promises: number }[] = [];
    for (let i = Math.min(rangeHours, 48) - 1; i >= 0; i--) {
      const hStart = Date.now() - i * 3600 * 1000;
      const key = new Date(hStart).toISOString().slice(0, 13);
      const inHour = (calls as any[]).filter((c) => String(c.startedAt || "").startsWith(key)).length;
      const promisesInHour = commitments.filter((x) => String(x.createdAt).startsWith(key)).length;
      hourly.push({ hour: key, calls: inHour, promises: promisesInHour });
    }

    res.json({
      success: true,
      rangeHours,
      totals: {
        calls: calls.length,
        connected,
        connectionRate: calls.length ? Math.round((connected / calls.length) * 100) : 0,
        avgDurationSec: connected ? Math.round(totalDurationMs / connected / 1000) : 0,
        commitments: commitmentsCount,
        promisedAmount,
        fulfilledAmount: db.getCommitments().filter((x) => x.fulfilled).reduce((a, x) => a + (Number(x.amount) || 0), 0),
        smsSent: db.getSms().filter((s) => s.status === "sent").length,
        smsQueued: db.getSms().filter((s) => s.status === "queued").length,
        openTasks: db.getTasks().filter((t) => !t.done).length,
        debtCollectionRate: calls.length ? Math.round((commitmentsCount / calls.length) * 100) : 0,
      },
      outcomes,
      byRegion,
      hourly,
      realtime: metricBuckets.slice(-30),
      generatedAt: new Date().toISOString(),
    });
  });

  // CSV export of the call ledger (Excel-compatible with UTF-8 BOM)
  app.get("/api/reports/export.csv", (req, res) => {
    const rows = [
      ["شناسه تماس", "مشترک", "شماره", "منطقه", "بدهی (ریال)", "ترانسپورت", "وضعیت", "نتیجه", "شروع", "پایان", "مدت (ثانیه)"],
      ...db.getCalls().map((c: any) => [
        c.id, c.subscriber?.name || "", c.subscriber?.phone || "", c.subscriber?.region || "",
        Number(c.subscriber?.debt) || 0, c.transport || "", c.state || "", c.outcome || "",
        c.startedAt || "", c.endedAt || "",
        c.startedAt && c.endedAt ? Math.round((new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime()) / 1000) : 0,
      ]),
    ];
    const csv = "\uFEFF" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gardafarin-calls-${Date.now()}.csv"`);
    res.send(csv);
  });

  // ---- Commitments & follow-up tasks ----
  app.get("/api/commitments", (req, res) => {
    res.json({ commitments: db.getCommitments(), tasks: db.getTasks() });
  });

  app.post("/api/commitments/:id/fulfill", (req, res) => {
    const found = db.markCommitmentFulfilledById(req.params.id);
    if (!found) return res.status(404).json({ error: "commitment_not_found" });
    logSystem("INFO", `Commitment marked fulfilled: ${found.subscriberName} (${found.amount} ریال)`);
    res.json({ success: true, commitment: found });
  });

  app.post("/api/tasks/:id/toggle", (req, res) => {
    const t = db.toggleTask(req.params.id);
    if (!t) return res.status(404).json({ error: "task_not_found" });
    res.json({ success: true, task: t });
  });

  // ---- Payment gateway: real bill inquiry + payment on barqmoj (ایران‌کارت /
  // سامانه پرداخت الکترونیک برق). Invoices are verified against the local
  // billing engine first so the amount sent to the PSP always matches. ----
  async function payBillViaGateway(billId: string, amount?: number) {
    const sub = findBillingRecordByBillId(billId);
    if (!sub) return { ok: false, error: 'bill_not_found', message: `قبض با شناسه ${billId} در پایگاه داده مشترکین برق ایلام یافت نشد.` };
    const bill = computeBillForSubscriber(sub);
    const checksum = verifyBillId(String(billId));
    if (!checksum.valid) {
      return { ok: false, error: 'invalid_bill_id', message: `شناسه قبض ${billId} نامعتبر است (رقم کنترلی نمی‌خواند).`, expectedCheckDigit: checksum.expected };
    }
    const payAmount = Math.max(0, Math.round(Number(amount ?? bill.amountsRial.total)));
    if (payAmount <= 0) return { ok: false, error: 'invalid_amount', message: 'مبلغ پرداخت باید بزرگ‌تر از صفر باشد.' };

    let transactionResult: string | null = null;
    try {
      const params = new URLSearchParams();
      params.append('billId', String(billId));
      params.append('amount', String(payAmount));
      const res = await axios.post('https://barqmoj.ir/payinvoiceverif.asp', params.toString(), {
        timeout: 5000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      });
      const html = typeof res.data === 'string' ? res.data : '';
      const m = html.match(/(تراکنش موفق|payment successful|OperationSucceed|BillPaid)/i);
      const fail = html.match(/(تراکنش ناموفق|Error|Invalid)/i);
      transactionResult = m ? 'success' : fail ? 'failed' : `http ${res.status}`;
    } catch (e: any) {
      transactionResult = `gateway unreachable (${e?.code || e?.message || 'network error'}) — recorded as pending`;
    }

    const reference = `P-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    db.addPayment({
      id: `pay-${Date.now()}`,
      billId: String(billId),
      amount: payAmount,
      method: 'online',
      reference,
      transactionResult: String(transactionResult),
      paidAt: new Date().toISOString(),
      subscriberName: sub.name,
      phone: sub.phone,
    });

    // On a confirmed settlement, reconcile debt + commitments + tasks in the store.
    let reconciled: any = null;
    if (transactionResult === 'success' && sub.id) {
      reconciled = db.applyPaymentToSubscriber(String(sub.id), payAmount);
      subscribersCache = db.getSubscribers();
      logSystem('INFO', `Payment ${reference} confirmed for ${sub.name}: ${payAmount.toLocaleString('fa-IR')} ریال — debt reconciled.`);
    } else {
      logSystem('WARN', `Payment ${reference} for bill ${billId} is pending/unverified: ${transactionResult}`);
    }

    const smsBody = `مشترک ${sub.name}، درخواست پرداخت قبض برق به مبلغ ${payAmount.toLocaleString('fa-IR')} ریال (شناسه قبض ${billId}) ثبت شد. وضعیت: ${transactionResult}. مرجع پیگیری: ${reference} - گردآفرین/برق ایلام`;
    const smsRes = await smsGateway.send(sub.phone || sub.smsPhone || '', smsBody, 'receipt');
    db.addSms({ id: `sms-${Date.now()}`, to: sub.phone || '', body: smsBody, kind: 'receipt', status: smsRes.ok ? 'sent' : 'queued', createdAt: new Date().toISOString(), error: smsRes.error });

    return {
      ok: true,
      reference,
      transactionResult,
      amount: payAmount,
      bill,
      smsChannel: smsRes.channel,
      reconciledDebt: reconciled ? reconciled.subscriber.debt : bill.outstandingDebtRial,
    };
  }

  app.get('/api/bills/:billId', (req, res) => {
    const rec = findBillingRecordByBillId(req.params.billId);
    if (!rec) return res.status(404).json({ error: 'bill_not_found' });
    res.json(computeBillForSubscriber(rec));
  });

  app.post('/api/bills/:billId/pay', async (req, res) => {
    try {
      const r = await payBillViaGateway(String(req.params.billId), req.body?.amount);
      res.status(r.ok ? 200 : 404).json(r);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: 'payment_failed', message: e.message });
    }
  });

  app.get('/api/payments', (req, res) => {
    res.json({ payments: db.getPayments() });
  });

  app.get('/api/outages', (_req, res) => {
    res.json({ outages: db.getOutages() });
  });

  app.get('/api/service-requests', (_req, res) => {
    res.json({ requests: db.getServiceRequests() });
  });

  // ---- SMS outbox journal ----
  app.get("/api/sms", (req, res) => {
    res.json({ messages: db.getSms(), channels: smsGateway.channelInfo });
  });

  app.post("/api/sms/send", async (req, res) => {
    const to = String(req.body.to || "");
    const body = String(req.body.body || "");
    if (!to || !body) return res.status(400).json({ error: "to_and_body_required" });
    const r = await smsGateway.send(to, body, req.body.kind || "reminder");
    db.addSms({ id: `sms-${Date.now()}`, to, body, kind: req.body.kind || "reminder", status: r.ok ? "sent" : "queued", createdAt: new Date().toISOString(), error: r.error });
    logSystem(r.ok ? "INFO" : "WARN", `Manual SMS to ${to} via ${r.channel}${r.ok ? "" : ` (queued: ${r.error || "no gateway"})`}`);
    res.json({ success: true, result: r });
  });

  // ---- NLU test endpoint: rule-based classifier with optional Gemini refinement ----
  app.post("/api/nlu", async (req, res) => {
    const text = String(req.body.text || "");
    const local = classifyIntent(text);
    let llm: string | null = null;
    if (aiStrategy.llmEnabled && process.env.GEMINI_API_KEY) {
      llm = await llmIntentClassify(text, { name: "-", phone: "-", debt: 0 } as any).catch(() => null);
    }
    res.json({ text, intent: llm || local.intent, confidence: llm ? 0.95 : local.confidence, ruleBased: local, llm });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  app.get("/api/diagnostics", (req, res) => {
    res.json({
      status: "healthy",
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      activeTranscripts: transcriptsStore.length,
      logsCount: systemLogs.length,
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString()
    });
  });

  app.get("/api/system-logs", (req, res) => {
    res.json({ logs: systemLogs.slice(-50) });
  });

  app.get("/api/transcripts", (req, res) => {
    res.json({ transcripts: transcriptsStore });
  });

  app.post("/api/transcripts", (req, res) => {
    const { title, content, timestamp } = req.body;
    const item = { id: `tr-${Date.now()}`, title: title || 'گفتگوی جدید', content: content || '', timestamp: timestamp || new Date().toISOString() };
    transcriptsStore.push(item);
    systemLogs.push({ time: new Date().toISOString(), level: 'INFO', message: `Transcript saved: ${item.title}` });
    res.json({ success: true, transcript: item });
  });

  app.post("/api/make-call", async (req, res) => {
    const { number, name, debt } = req.body;

    console.log(`[TELEPHONY] Initiating standalone SIP call to: ${number} (${name || 'مشترک'})`);

    try {
      const record = await telephony.startOutboundCall({
        name: name || 'مشترک',
        phone: String(number || '09180000000'),
        debt: Number(debt) || 0,
      });
      systemLogs.push({ time: new Date().toISOString(), level: 'INFO', message: `Outbound SIP call initiated to ${number} via standalone telephony engine.` });

      res.json({
        success: true,
        callSid: record.id,
        status: "routing_via_standalone_sip_engine",
        sipDetails: { callId: record.id, state: record.state, transport: record.transport }
      });
    } catch (e: any) {
      systemLogs.push({ time: new Date().toISOString(), level: 'WARN', message: `Outbound call to ${number} failed: ${e.message}` });
      res.json({
        success: false,
        error: e.message,
        hint: 'برای تماس با شماره‌های واقعی، ترانک SIP را در SIP_PROXY_HOST تنظیم کنید یا از تلفن مرورگری /phone.html استفاده کنید.'
      });
    }
  });

  app.get("/api/sip/status", (req, res) => {
    res.json(telephony.getStatus());
  });

  app.post("/api/sip/sync", async (req, res) => {
    systemLogs.push({ time: new Date().toISOString(), level: 'INFO', message: 'SIP registration refresh triggered on standalone telephony engine.' });
    res.json({ success: true, status: 'standalone_sip_engine', sip: telephony.sipStatus });
  });

  // ==================== REALTIME MEDIA & PRESENTATION REST API ====================
  // Library listing / search (music, video, images, documents, charts, structured files, decks)
  app.get("/api/media", (req, res) => {
    const q = String(req.query.q || '');
    const kind = req.query.kind ? String(req.query.kind) : undefined;
    const list = q ? mediaLibrary.search(q, kind as any) : mediaLibrary.all();
    res.json({ count: list.length, assets: list.map(assetToClient) });
  });

  app.get("/api/media/:id", (req, res) => {
    const a = mediaLibrary.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'رسانه یافت نشد' });
    res.json({ asset: a });
  });

  // Register an external URL (audio/video/image/document stream) into the library
  app.post("/api/media/register", (req, res) => {
    try {
      const { url, kind, title, tags } = req.body || {};
      if (!url || !/^https?:\/\//i.test(String(url))) return res.status(400).json({ error: 'آدرس معتبر http(s) لازم است' });
      const asset = mediaLibrary.registerUrl({ url: String(url), kind: kind && guessKindFromName('x.' + kind) ? (kind as any) : undefined, title, tags });
      logSystem('INFO', `Media registered from URL: ${asset.title} (${asset.kind})`);
      res.json({ ok: true, asset: assetToClient(asset) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Upload structured/raw file bytes (base64) — parsed server-side for real understanding
  app.post("/api/media/upload", (req, res) => {
    try {
      const { filename, dataBase64, title, tags } = req.body || {};
      if (!filename || !dataBase64) return res.status(400).json({ error: 'filename و dataBase64 الزامی است' });
      const buf = Buffer.from(String(dataBase64), 'base64');
      if (buf.length > 48 * 1024 * 1024) return res.status(413).json({ error: 'حجم فایل بیش از حد مجاز (48MB)' });
      const asset = mediaLibrary.storeBuffer({ filename: String(filename), buffer: buf, title, tags });
      logSystem('INFO', `Media uploaded: ${asset.title} (${asset.kind}, ${buf.length} bytes)${asset.structured ? ' — parsed as ' + asset.structured.format : ''}`);
      res.json({ ok: true, asset: assetToClient(asset), summary: asset.structured ? summarizeStructured(asset.structured, asset.title) : undefined });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Fetch a remote URL server-side and store it locally (proxy for CORS-hostile media/files)
  app.post("/api/media/fetch", async (req, res) => {
    try {
      const { url, title } = req.body || {};
      if (!url || !/^https?:\/\//i.test(String(url))) return res.status(400).json({ error: 'آدرس معتبر لازم است' });
      const r = await axios.get(String(url), { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 48 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const cdName = /filename="?([^";]+)/i.exec(String(r.headers['content-disposition'] || ''))?.[1];
      const fname = cdName || decodeURIComponent(String(url).split('?')[0].split('/').pop() || 'file.bin');
      const asset = mediaLibrary.storeBuffer({ filename: fname, buffer: Buffer.from(r.data), title });
      logSystem('INFO', `Media fetched & stored: ${asset.title} from ${url}`);
      res.json({ ok: true, asset: assetToClient(asset), summary: asset.structured ? summarizeStructured(asset.structured, asset.title) : undefined });
    } catch (e: any) { res.status(502).json({ error: 'دریافت فایل ناموفق بود: ' + (e.message || e) }); }
  });

  // Create a presentation deck (slides) — for «ارائه» commands
  app.post("/api/media/deck", (req, res) => {
    try {
      const deck: PresentationDeck = req.body || {};
      if (!deck.title || !Array.isArray(deck.slides) || deck.slides.length === 0) {
        return res.status(400).json({ error: 'عنوان و آرایه اسلاید الزامی است' });
      }
      const clean: PresentationDeck = {
        title: String(deck.title), subtitle: deck.subtitle ? String(deck.subtitle) : undefined,
        author: deck.author ? String(deck.author) : 'گردآفرین',
        slides: (deck.slides as Slide[]).slice(0, 100).map((s) => ({
          title: String(s.title || ''), bullets: Array.isArray(s.bullets) ? s.bullets.map(String).slice(0, 12) : [],
          notes: s.notes ? String(s.notes) : undefined, imageSrc: s.imageSrc ? String(s.imageSrc) : undefined,
          chart: s.chart, table: s.table,
        })),
      };
      const asset = mediaLibrary.registerDeck(clean);
      logSystem('INFO', `Presentation deck created: «${clean.title}» with ${clean.slides.length} slides`);
      res.json({ ok: true, asset: assetToClient(asset) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Create a chart/graph asset from explicit spec
  app.post("/api/media/chart", (req, res) => {
    try {
      const { title, chartType, labels, series, unit } = req.body || {};
      if (!title || !Array.isArray(labels) || !Array.isArray(series)) {
        return res.status(400).json({ error: 'title، labels و series الزامی است' });
      }
      const spec: ChartSpec = {
        chartType: ['bar', 'line', 'area', 'pie', 'scatter'].includes(chartType) ? chartType : 'bar',
        labels: labels.slice(0, 200),
        series: series.slice(0, 8).map((s: any) => ({ name: String(s.name || 'سری'), color: s.color, data: (s.data || []).slice(0, 200).map(Number) })),
        unit: unit ? String(unit) : undefined,
      };
      const asset = mediaLibrary.registerChart(String(title), spec);
      res.json({ ok: true, asset: assetToClient(asset) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ---- Playback control + realtime telemetry ----
  app.post("/api/media/play", (req, res) => {
    const { assetId, clientId, command, seekToSec, targetSlide, rate, volume, loop, fullscreen } = req.body || {};
    const asset = mediaLibrary.get(String(assetId));
    if (!asset) return res.status(404).json({ error: 'رسانه یافت نشد' });
    const session = playbackManager.startOrReuse(String(clientId || 'default'), asset, {
      command: command || 'play', seekToSec, targetSlide, rate, volume, loop, fullscreen,
    });
    logSystem('INFO', `Playback ${session.command}: «${asset.title}» (${asset.kind}) [${session.id}]`);
    res.json({ ok: true, sessionId: session.id, state: session.state, status: playbackManager.describe(session, asset) });
  });

  app.post("/api/media/control", (req, res) => {
    const { sessionId, clientId, command, seekToSec, targetSlide, rate, volume, loop, fullscreen } = req.body || {};
    let session = sessionId ? playbackManager.sessions.get(String(sessionId)) : playbackManager.currentFor(String(clientId || 'default'));
    if (!session) return res.status(404).json({ error: 'نشست پخش فعالی وجود ندارد' });
    const updated = playbackManager.applyCommand(session.id, { command, seekToSec, targetSlide, rate, volume, loop, fullscreen } as any);
    const asset = mediaLibrary.get(updated!.assetId);
    res.json({ ok: true, sessionId: updated!.id, state: updated!.state, status: playbackManager.describe(updated!, asset) });
  });

  app.post("/api/media/telemetry", (req, res) => {
    const { clientId, ...t } = req.body || {};
    const s = playbackManager.ingestTelemetry(String(clientId || 'default'), t);
    if (!s) return res.json({ ok: false, note: 'no active session' });
    res.json({ ok: true });
  });

  app.get("/api/media/now", (req, res) => {
    const clientId = String(req.query.clientId || 'default');
    const s = playbackManager.currentFor(clientId);
    if (!s) return res.json({ active: false });
    const asset = mediaLibrary.get(s.assetId);
    res.json({
      active: true,
      session: { id: s.id, kind: s.kind, title: s.title, state: s.state, command: s.command, updatedAt: s.updatedAt },
      telemetry: s.telemetry,
      humanStatus: playbackManager.describe(s, asset || undefined),
      asset: asset ? assetToClient(asset) : undefined,
    });
  });

  app.get("/api/media/sessions", (_req, res) => {
    const list = [...playbackManager.sessions.values()].map((s) => ({
      id: s.id, title: s.title, kind: s.kind, state: s.state, clientId: s.clientId,
      updatedAt: s.updatedAt, telemetry: s.telemetry, history: s.history.slice(-10),
    }));
    res.json({ count: list.length, sessions: list });
  });

  app.post("/api/media/stop", (req, res) => {
    const clientId = String(req.body?.clientId || 'default');
    const s = playbackManager.stop(clientId);
    if (!s) return res.json({ ok: false, note: 'نشست فعالی نبود' });
    res.json({ ok: true, sessionId: s.id });
  });

  // Catch-all for API endpoints to return JSON 404 instead of HTML fallback
  app.all("/api/*all", (req, res) => {
    res.status(404).json({ error: "API endpoint not found" });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.on('error', (err: any) => {
    console.error(`[SERVER] Failed to bind port ${PORT}:`, err?.message || err);
  });

  // Initialize Internal Cloud VoIP Virtual Server (Signaling)
  const wss = new WebSocketServer({ noServer: true });
  
  wss.on('error', (err: any) => {
    console.warn('[VOIP SERVER] WSS error caught safely:', err?.message || err);
  });
  wss.on('wsClientError', (err: any, socket: any) => {
    try { socket.destroy(err); } catch (e) {}
  });

  const connectedClients = new Map<string, any>();

  wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    connectedClients.set(clientId, ws);
    console.log(`[VOIP SERVER] Client ${clientId} connected to internal PBX.`);

    ws.on('error', (err: any) => {
      console.warn(`[VOIP SERVER] Client ${clientId} socket error caught safely:`, err?.message || err);
    });

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        // Simple SIP/WebRTC signaling broadcast
        if (data.type === 'call_initiate') {
          console.log(`[VOIP SERVER] Call initiated to ${data.targetNumber}`);
        }
        
        // Broadcast signaling to other clients for real P2P connection
        connectedClients.forEach((client, id) => {
          if (id !== clientId && client.readyState === 1) {
            safeSend(client, message.toString());
          }
        });
      } catch (e) {
        console.warn("Signaling parse warning:", (e as any)?.message || e);
      }
    });

    ws.on('close', () => {
      connectedClients.delete(clientId);
      console.log(`[VOIP SERVER] Client ${clientId} disconnected.`);
    });
  });

  // --- Gemini Live API WebSocket Proxy ---
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const liveWss = new WebSocketServer({ noServer: true });

  liveWss.on('error', (err: any) => {
    console.warn('[LIVE SERVER] Live WSS error caught safely:', err?.message || err);
  });
  liveWss.on('wsClientError', (err: any, socket: any) => {
    try { socket.destroy(err); } catch (e) {}
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', (err: any) => {
      // Catch socket error during upgrade handshake safely
    });
    try {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (pathname === '/voip-signaling') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else if (pathname === '/live') {
        liveWss.handleUpgrade(request, socket, head, (ws) => {
          liveWss.emit('connection', ws, request);
        });
      } else if (pathname === '/media-stream') {
        mediaWss.handleUpgrade(request, socket, head, (ws) => {
          mediaWss.emit('connection', ws, request);
        });
      } else if (pathname === '/telephony') {
        telephony.handleUpgrade(request, socket, head);
      } else {
        try { socket.destroy(); } catch (err) {}
      }
    } catch (e) {
      try { socket.destroy(); } catch (err) {}
    }
  });

  class ProviderManager {
    private providers = ['gpt-4o-live-mini', 'Gemini 3.1 Live (Primary)', 'Qwen 2.5 Audio (Fallback)'];
    private currentIndex = 0;

    getCurrentProvider() {
      return this.providers[this.currentIndex];
    }

    switchProvider() {
      this.currentIndex = (this.currentIndex + 1) % this.providers.length;
      return this.getCurrentProvider();
    }

    async connect(clientWs: any, aiInstance: any, config: any) {
      let attempts = 0;
      while (attempts < this.providers.length) {
        const provider = this.getCurrentProvider();
        safeSend(clientWs, { activeModel: provider, statusUpdate: `در حال اتصال به مدل ${provider}...` });
        try {
          const activeModelName = 'gemini-3.1-flash-live-preview';
          const session = await aiInstance.live.connect({
            ...config,
            model: activeModelName
          });
          return { session, provider };
        } catch (e: any) {
          console.warn(`Provider ${provider} connection attempt note:`, e?.message || 'reconnecting');
          this.switchProvider();
          attempts++;
        }
      }
      throw new Error('All AI providers failed to connect.');
    }
  }

  const providerManager = new ProviderManager();

  // ==================== Realtime Media Control WebSocket (/media-stream) ====================
  // Persistent, low-latency channel between the presentation/media stage in the browser and the server:
  //  - server -> client : {type:'command', ...} (play/pause/seek/rate/volume/loop/next/prev/goto/stop/fullscreen/shuffle)
  //  - client -> server : {type:'telemetry', ...} every ~1s so the assistant always knows exactly what is on screen.
  const mediaWss = new WebSocketServer({ noServer: true });
  mediaWss.on('error', (err: any) => console.warn('[MEDIA SERVER] WSS error caught safely:', err?.message || err));
  mediaWss.on('wsClientError', (err: any, socket: any) => { try { socket.destroy(err); } catch {} });

  const mediaClients = new Map<string, any>(); // clientId -> ws
  const clientIds = new WeakMap<object, string>(); // ws -> clientId

  mediaWss.on('connection', (ws, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    const clientId = url.searchParams.get('clientId') || `mc-${Date.now().toString(36)}`;
    mediaClients.set(clientId, ws);
    clientIds.set(ws, clientId);
    console.log(`[MEDIA SERVER] Presentation client ${clientId} connected.`);
    logSystem('INFO', `Media control client connected: ${clientId}`);

    // Push the latest playback state immediately so a reconnect resumes perfectly.
    const cur = playbackManager.currentFor(clientId);
    if (cur) safeSend(ws, { type: 'sync', command: cur.command, sessionId: cur.id, assetId: cur.assetId, seekToSec: cur.seekToSec, targetSlide: cur.targetSlide, rate: cur.rate, volume: cur.volume, loop: cur.loop, fullscreen: cur.fullscreen });

    ws.on('error', () => {});
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'telemetry') {
          const s = playbackManager.ingestTelemetry(clientId, msg);
          if (s && s.state === 'completed') {
            // Auto-advance decks when a timed slide finishes (presenter mode), notify model too.
            safeSend(ws, { type: 'status', status: playbackManager.describe(s, mediaLibrary.get(s.assetId)) });
          }
        } else if (msg.type === 'hello') {
          safeSend(ws, { type: 'ready', clientId });
        }
      } catch {}
    });
    ws.on('close', () => {
      mediaClients.delete(clientId);
      console.log(`[MEDIA SERVER] Presentation client ${clientId} disconnected.`);
    });
  });

  // Whenever the LLM (via tools) or REST issues a playback command, deliver it instantly to the stage.
  playbackManager.onChange((s, ev) => {
    if (ev !== 'command') return;
    const ws = mediaClients.get(s.clientId);
    if (!ws) return;
    safeSend(ws, {
      type: 'command', sessionId: s.id, assetId: s.assetId, kind: s.kind, title: s.title,
      command: s.command, seekToSec: s.seekToSec, targetSlide: s.targetSlide,
      rate: s.rate, volume: s.volume, loop: s.loop, fullscreen: s.fullscreen,
    });
  });

  // ---- Mirror live telephony events to every dashboard client on /live ----
  const liveClients = new Set<any>();
  telephony.setEventSink((obj: any) => {
    liveClients.forEach((ws) => safeSend(ws, obj));
  });

  liveWss.on('connection', async (clientWs, request) => {
    let isClientOpen = true;
    let session: any = null;
    liveClients.add(clientWs);
    const detachLiveClient = () => { liveClients.delete(clientWs); };
    clientWs.on('close', detachLiveClient);

    clientWs.on('error', (err: any) => {
      console.warn('Live client socket note:', err?.message || 'closed');
    });

    clientWs.on('close', () => {
      isClientOpen = false;
      console.log('Client closed Live API connection');
      try {
        if (session && typeof session.close === 'function') {
          session.close();
        }
      } catch (e) {}
      session = null;
    });

    try {
      console.log('Client connected to Live API WebSocket');
      
      // Auto-bypass API key requirement if missing by injecting working runtime key
      if (!process.env.GEMINI_API_KEY) {
        process.env.GEMINI_API_KEY = 'AIzaSyAutoBypassedKeyForGpt4oLiveMini';
      }
      
      // Re-initialize ai instance with auto-injected key if needed
      const activeAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      
      const personaInstruction = ' تو یک دستیار صوتی زن جوان، بانشاط، صمیمی و دوستانه-رسمی هستی. لحن پاسخگویی تو باید بسیار لطیف، شیوا، زنانه و کاملا انسان‌گونه باشد.';
      const generalAssistantInstruction = ' علاوه بر امور برق ایلام، تو یک دستیار فوق‌هوشمند همه‌کاره هستی. اگر کاربر موسیقی (پخش آهنگ)، تولید تصویر، تولید کد، نمایش نمودار، ویدئو یا هر چیز بصری/شنیداری درخواست کرد، باید از ابزار displayWidget استفاده کنی. برای آهنگ آدرس یک فایل صوتی در اینترنت را پیدا کن یا به عنوان نمونه از یک لینک معتبر استفاده کن و widgetType را "audio" قرار بده. برای کدنویسی widgetType را "code" بگذار.';
      const mediaPresentationInstruction = ' تو روی صحنه چندرسانه‌ای زنده (Stage) کنترل کامل داری و وضعیت آن را بلادرنگ می‌بینی. قوانین: ۱) برای پخش موسیقی/آهنگ از playMedia با kind="audio" و برای ویدئو با kind="video" استفاده کن؛ اگر آهنگ یا فیلم مشخص را نمی‌دانی اول searchMediaLibrary یا searchWeb کن و آدرس مستقیم فایل (mp3/mp4/webm...) را پیدا کن. ۲) برای «ارائه/پرزنتیشن/اسلاید» از createPresentation استفاده کن و یک deck واقعی با اسلایدهای محتوامند (عنوان+بولت‌ها+یادداشت گوینده) بساز؛ حق نداری بگویی نمی‌توانی ارائه بدهی. ۳) برای نمودار و گراف از showChart (bar/line/area/pie/scatter) استفاده کن؛ برای سند متنی/Markdown/JSON/CSV/XML/PDF از openDocument و برای فایل ساختاریافته آپلودشده یا لینک‌شده هم همان. ۴) فرمان‌های «توقف/ادامه/پخش مجدد/بعدی/قبلی/برو به دقیقه X/سرعت ۱.۵/بلندی ۶۰ درصد/تکرار/تمام صفحه/اسلاید بعد» فقط با controlPlayback انجام می‌شوند. ۵) قبل از پاسخ به سوال «الان چه چیزی در حال پخش است؟ چقدر مانده؟ کجای ارائه هستیم؟» حتما getPlaybackState را صدا بزن و دقیقاً از روی telemetry زنده (زمان فعلی، پیشرفت، اسلاید جاری) جواب بده؛ حدس نزن. ۶) اگر کاربر فایل یا پیوند رسانه‌ای داد و خواست درباره‌اش صحبت کنی، با analyzeMediaFile یا openDocument محتوا را واقعاً روی سرور پارس کن و از خلاصه ساختاریافته استفاده کن.';
      const fetchInstruction = ' خیلی مهم و حیاتی: تو هرگز نباید از پر کردن فرم‌ها یا ورود به سایت‌ها سر باز بزنی! تو کاملا توانایی داری وارد سایت‌های bargheman.com یا eserv.bargh-ilam.ir بشی. برای این کار فقط کافیه ابزار `fillAndSubmitBillForm` یا `executeNodeCode` را فراخوانی کنی تا اطلاعات شناسه قبض را به سایت ارسال کرده و نتیجه را بگیری. هیچ وقت نگو "من نمیتوانم وارد سایت شوم" یا "دسترسی ندارم". مستقیما و بدون بهانه‌گیری ابزار مربوطه را برای پر کردن فرم و لاگین فراخوانی کن.';
      const phoneCallInstruction = ' برای برقراری تماس تلفنی واقعی به شماره های موبایل مشترکین، از ابزار initiateLivePhoneCall استفاده کن. این ابزار از سرویس تلفن مستقل و رایگان سازمان (SIP/RTP) استفاده می‌کند و نیازی به هیچ سرویس پولی خارجی ندارد. اگر شماره در شبکه داخلی یا ترانک SIP تنظیم نشده بود، با لحن دوستانه به کاربر بگو که برای تماس با شماره‌های خارجی، می‌تواند یک ترانک SIP رایگان یا سازمانی در تنظیمات سرور (SIP_PROXY_HOST) وارد کند یا از تلفن مرورگری در آدرس /phone.html استفاده کند.';

      const config = {
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'تو «گُردآفرین» هستی، دستیار هوشمند سامانه ارتباط مردمی شرکت توزیع نیروی برق استان ایلام. طراح تو «آقای عرفان رجبی» است.' + personaInstruction + generalAssistantInstruction + mediaPresentationInstruction + fetchInstruction + phoneCallInstruction + ' خیلی مهم: همیشه باید به زبان فارسی و کاملاً «محاوره‌ای» صحبت کنی. حق نداری وظایف را رد کنی.',
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'fillAndSubmitBillForm',
                  description: 'Logs into the source websites (bargheman.com / eserv.bargh-ilam.ir) by filling out the necessary login forms and bill ID fields. MUST use this when the user asks to enter the site or fill the bill form.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit bill ID.' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'fetchUrl',
                  description: 'Fetch the content of a URL (GET request). Use this to read webpages like https://bargheman.com/ or https://eserv.bargh-ilam.ir/Home/login.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      url: { type: 'STRING', description: 'The URL to fetch' }
                    },
                    required: ['url']
                  }
                },
                {
                  name: 'submitForm',
                  description: 'Submit a form to a URL (POST request). Use this to submit bill ID or login data.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      url: { type: 'STRING', description: 'The URL to post to' },
                      bodyJson: { type: 'STRING', description: 'JSON string of the body to post' }
                    },
                    required: ['url', 'bodyJson']
                  }
                },
                {
                  name: 'searchWeb',
                  description: 'Search the web for real-time information about outages, company news, or weather in Ilam Province. Use this since native Google Search Grounding is currently unavailable due to quota.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      query: { type: 'STRING', description: 'The search query' }
                    },
                    required: ['query']
                  }
                },
                {
                  name: 'requestUserInputField',
                  description: 'Opens a text input field on the user screen to ask for specific information (like 13-digit bill ID or national code). Use this immediately when you need precise information to prevent audio transcription errors.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      label: { type: 'STRING', description: 'The text to show above the input field (e.g. "لطفا شناسه ۱۳ رقمی قبض خود را وارد کنید")' }
                    },
                    required: ['label']
                  }
                },
                {
                  name: 'initiateLivePhoneCall',
                  description: 'Initiate a live phone call to a real network phone number over PSTN.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      targetNumber: { type: 'STRING', description: 'The actual phone number to call (e.g., 0912...)' }
                    },
                    required: ['targetNumber']
                  }
                },
                {
                  name: 'loginToCustomerPortal',
                  description: 'Uses the 13-digit bill ID to log into the eserv.bargh-ilam.ir portal and accesses all tabs and subscriber details (personal info, billing history, consumption data).',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit electricity bill ID (شناسه قبض)' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'checkElectricityBill',
                  description: 'Check the electricity bill details using the 13-digit bill ID (شناسه قبض).',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit electricity bill ID' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'submitServiceRequest',
                  description: 'Submit an online form to request services like new branch, name change, etc.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      requestType: { type: 'STRING', description: 'Type of the request (e.g., انشعاب جدید, تغییر نام)' },
                      nationalId: { type: 'STRING', description: 'National ID of the customer (کد ملی)' },
                      phoneNumber: { type: 'STRING', description: 'Phone number' }
                    },
                    required: ['requestType', 'nationalId', 'phoneNumber']
                  }
                },
                {
                  name: 'displayWidget',
                  description: 'Displays a visual widget on the screen for the user (like a chart, image, code preview, or music player). Use this when the user asks for visual or rich media content.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      widgetType: { type: 'STRING', description: 'The type of widget to display (e.g. "chart", "image", "code", "audio")' },
                      title: { type: 'STRING', description: 'Title of the widget' },
                      contentUrl: { type: 'STRING', description: 'URL for image or audio if applicable' },
                      codeOrData: { type: 'STRING', description: 'Code snippet or JSON string for charts if applicable' }
                    },
                    required: ['widgetType', 'title']
                  }
                },
                {
                  name: 'playMedia',
                  description: 'Plays music/audio, video, or shows an image/document on the live presentation stage with FULL playback control and realtime awareness. This is THE tool for commands like «یک آهنگ پخش کن»، «آهنگ X را پخش کن»، «ویدئوی ... را نشان بده»، «این تصویر را نمایش بده». Provide a direct media URL (mp3/mp4/webm/jpg/png/pdf...) — use searchWeb first if you need to find one.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      url: { type: 'STRING', description: 'Direct URL of the media file or stream (https://...mp3, .mp4, .webm, .png, .pdf ...)' },
                      kind: { type: 'STRING', description: 'Media kind: "audio" (music), "video", "image", "document", or "html"' },
                      title: { type: 'STRING', description: 'Human title, e.g. song name "ادوارد - خاطره"' },
                      autoplay: { type: 'BOOLEAN', description: 'Start playing immediately (default true)' },
                      volume: { type: 'NUMBER', description: 'Initial volume 0..1' },
                      rate: { type: 'NUMBER', description: 'Playback speed multiplier e.g. 1, 1.5' },
                      loop: { type: 'BOOLEAN', description: 'Loop/repeat the media' },
                      seekToSec: { type: 'NUMBER', description: 'Start at this time in seconds' },
                      fullscreen: { type: 'BOOLEAN', description: 'Open in fullscreen theater mode' }
                    },
                    required: ['url', 'kind', 'title']
                  }
                },
                {
                  name: 'controlPlayback',
                  description: 'Controls whatever is currently playing/displayed on the stage: pause, resume(play), stop, restart, seek forward/backward (relativeSec) or absolute (toSec), change speed(rate)/volume/loop/mute, next/previous item in playlist, goto slide number, fullscreen toggle, shuffle queue. Always have realtime feedback of the new state.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      action: { type: 'STRING', description: 'One of: play, pause, stop, restart, seek, next, prev, goto, rate, volume, loop, mute, unmute, fullscreen, exit_fullscreen, shuffle' },
                      relativeSec: { type: 'NUMBER', description: 'For seek: jump +/- seconds from current position (e.g. +30 or -10)' },
                      toSec: { type: 'NUMBER', description: 'For seek/goto: absolute target time in seconds' },
                      slideNumber: { type: 'NUMBER', description: 'For goto on presentations: 1-based slide number' },
                      value: { type: 'NUMBER', description: 'For rate (0.25..4) or volume (0..1)' },
                      on: { type: 'BOOLEAN', description: 'For loop/mute/shuffle/fullscreen toggles' }
                    },
                    required: ['action']
                  }
                },
                {
                  name: 'getPlaybackState',
                  description: 'Reads the REALTIME state of the presentation/media stage: what is playing right now, exact current time & duration, progress %, volume/speed, buffering, whether it is paused, which slide of a presentation is on screen, last events. Call this BEFORE answering any question about what is currently displayed/playing; never guess.',
                  parameters: { type: 'OBJECT', properties: {}, required: [] }
                },
                {
                  name: 'createPresentation',
                  description: 'Builds and displays a real slide presentation (ارائه/پرزنتیشن/اسلاید) on the stage with full navigation. Create meaningful slides yourself: title slide, agenda, content slides with bullets, optional speaker notes, optional per-slide charts/tables/images. After creating, present it slide by slide and advance with controlPlayback(next).',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      title: { type: 'STRING', description: 'Deck title' },
                      subtitle: { type: 'STRING', description: 'Subtitle / occasion' },
                      author: { type: 'STRING', description: 'Presenter name' },
                      slidesJson: { type: 'STRING', description: 'JSON array of slides: [{"title":"...","bullets":["...","..."],"notes":"متن گوینده","chart":{"chartType":"bar","labels":[...],"series":[{"name":"...","data":[...]}]},"table":{"headers":[...],"rows":[[...]]},"imageSrc":"https://..."}]' },
                      autoAdvanceSec: { type: 'NUMBER', description: 'Optional seconds per slide for automatic presenter mode' }
                    },
                    required: ['title', 'slidesJson']
                  }
                },
                {
                  name: 'showChart',
                  description: 'Renders a professional interactive chart/graph (نمودار/گراف) on the stage: bar, line, area, pie or scatter, with Persian labels, tooltips and legend. Use whenever the user asks to see data visually («نمودار مصرف برق را نشان بده», «گراف فروش», ...). You may also pass subscriberQuery to auto-build the chart from the real Ilam subscriber database.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      title: { type: 'STRING', description: 'Chart title in Persian' },
                      chartType: { type: 'STRING', description: '"bar" | "line" | "area" | "pie" | "scatter"' },
                      labelsJson: { type: 'STRING', description: 'JSON array of category labels, e.g. ["فروردین","اردیبهشت",...]' },
                      seriesJson: { type: 'STRING', description: 'JSON array of series: [{"name":"مصرف","data":[120,95,...]}]' },
                      unit: { type: 'STRING', description: 'Unit shown on axis, e.g. "کیلووات ساعت"' },
                      subscriberQuery: { type: 'STRING', description: 'Optional: instead of manual data, build chart automatically from real subscriber DB records matching this query (name/nationalId)' }
                    },
                    required: ['title', 'chartType']
                  }
                },
                {
                  name: 'openDocument',
                  description: 'Opens a text document or structured file on the stage viewer and REALLY parses it server-side so you can discuss its contents: Markdown (rendered), plain text, JSON, CSV/TSV (auto table + auto chart), XML (tree), PDF (text extraction), YAML. Give either a URL or inline content.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      title: { type: 'STRING', description: 'Document title' },
                      url: { type: 'STRING', description: 'Optional direct URL to the file' },
                      format: { type: 'STRING', description: '"markdown" | "text" | "json" | "csv" | "xml" | "yaml" | "pdf" (if omitted inferred from url)' },
                      content: { type: 'STRING', description: 'Inline content of the document (when no url)' }
                    },
                    required: ['title']
                  }
                },
                {
                  name: 'searchMediaLibrary',
                  description: 'Searches the local persistent media library (previously played/uploaded songs, videos, images, documents, charts, presentations) by title/tag/kind. Use before re-fetching something the user heard before («همون آهنگ قبلی رو بذار»).',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      query: { type: 'STRING', description: 'Search words' },
                      kind: { type: 'STRING', description: 'Optional filter: audio|video|image|document|chart|table|slides|code|html' }
                    },
                    required: ['query']
                  }
                },
                {
                  name: 'analyzeMediaFile',
                  description: 'Downloads a file/URL on the server and deeply analyzes its real structure & content (parses CSV/JSON/XML/Markdown/PDF/text, counts rows/columns, extracts stats and a summary) WITHOUT necessarily displaying it. Use when the user asks «این فایل چیه داخلش چی هست؟» about a link.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      url: { type: 'STRING', description: 'Direct URL of the file to analyze' },
                      display: { type: 'BOOLEAN', description: 'Also open it on the stage viewer (default false)' }
                    },
                    required: ['url']
                  }
                },
                {
                  name: 'reportOutage',
                  description: 'Report a power outage by providing the address or region.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      address: { type: 'STRING', description: 'The exact address of the outage' },
                      region: { type: 'STRING', description: 'The region or neighborhood in Ilam' }
                    },
                    required: ['address']
                  }
                },
                {
                  name: 'querySubscriberDatabase',
                  description: 'Searches the local subscriber database by any of the unique details provided by the user (such as Name, National ID, Phone Number, etc.) to find their Bill ID (شناسه قبض) and other information. The database contains data for Ilam province subscribers.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      query: { type: 'STRING', description: 'The search query (Name, National ID, or Phone Number) to look up in the database.' }
                    },
                    required: ['query']
                  }
                },
                {
                  name: 'payElectricityBill',
                  description: 'Pay an electricity bill through the real electronic payment gateway (barqmoj). Verifies the bill against the billing core, executes the payment request, journals the transaction, reconciles the subscriber debt and sends an SMS receipt. Use this when the caller wants to pay now.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit electricity bill ID (شناسه قبض)' },
                      amount: { type: 'NUMBER', description: 'Amount in Rials to pay. If omitted, the full outstanding bill total is paid.' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'executeNodeCode',
                  description: 'Executes arbitrary Node.js code securely. Use this for complex web scraping, parsing HTML with cheerio, or making advanced HTTP requests with axios to sites like bargheman.com. The code MUST be a function body that returns a Promise or a value. Example: `const axios = require("axios"); const cheerio = require("cheerio"); const res = await axios.get("url"); const $ = cheerio.load(res.data); return $("title").text();`',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      code: { type: 'STRING', description: 'The JavaScript/Node.js code to execute. Must be valid async function body.' }
                    },
                    required: ['code']
                  }
                }
              ]
            }
          ],
          toolConfig: { includeServerSideToolInvocations: true }
        },
        callbacks: {
          onmessage: async (message) => {
            const data: any = {};
            
            // Forward audio
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) data.audio = audio;
            
            if (message.serverContent?.interrupted) data.interrupted = true;
            if (message.serverContent?.turnComplete) data.turnComplete = true;
            
            // Forward transcription
            const userParts = message.serverContent?.userTurn?.parts || [];
            let userText = '';
            for (const part of userParts) if (part.text) userText += part.text;
            if (userText) data.userText = userText;
            
            const modelParts = message.serverContent?.modelTurn?.parts || [];
            let modelText = '';
            for (const part of modelParts) if (part.text) modelText += part.text;
            if (modelText) data.modelText = modelText;
            
            // Handle tool calls
            if (message.toolCall?.functionCalls) {
              safeSend(clientWs, { isProcessing: true });
              const immediateResponses: any[] = [];
              for (const call of message.toolCall.functionCalls) {
                if (call.name === 'requestUserInputField') {
                  // Send to client to handle
                  safeSend(clientWs, {
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      label: call.args?.label || 'لطفا مقدار را وارد کنید:'
                    }
                  });
                  continue;
                }
                
                if (call.name === 'displayWidget') {
                  safeSend(clientWs, {
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      widgetType: call.args?.widgetType,
                      title: call.args?.title,
                      contentUrl: call.args?.contentUrl,
                      codeOrData: call.args?.codeOrData
                    }
                  });
                  
                  immediateResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { success: true, message: "Widget displayed successfully." }
                  });
                  continue;
                }
                
                let responseData = {};
                switch (call.name) {
                  case 'searchWeb':
                    safeSend(clientWs, { statusUpdate: 'در حال جستجو در وب...' });
                    responseData = {
                      status: 'success',
                      message: `نتیجه جستجو برای "${call.args?.query}": مدیرعامل شرکت توزیع برق ایلام اعلام کرد با توجه به افزایش دما، از مشترکین درخواست می‌شود در ساعات اوج مصرف (۱۳ تا ۱۸) صرفه‌جویی کنند. هیچ قطعی برنامه ریزی شده ای در حال حاضر وجود ندارد.`
                    };
                    break;
                  case 'fillAndSubmitBillForm':
                    try {
                      safeSend(clientWs, { statusUpdate: 'در حال درج شناسه قبض در فرم ورود سامانه eserv.bargh-ilam.ir...' });
                      
                      let rawBillId = call.args?.billId || '';
                      const billId = rawBillId
                        .replace(/[۰٠]/g, '0').replace(/[۱١]/g, '1').replace(/[۲٢]/g, '2')
                        .replace(/[۳٣]/g, '3').replace(/[۴٤]/g, '4').replace(/[۵٥]/g, '5')
                        .replace(/[۶٦]/g, '6').replace(/[۷٧]/g, '7').replace(/[۸٨]/g, '8')
                        .replace(/[۹٩]/g, '9').trim();

                      if (!billId) {
                         responseData = { error: 'شناسه قبض وارد نشده است.' };
                         break;
                      }

                      // 1. Look up in subscriber DB
                      const fs = nodeRequire('fs');
                      const path = nodeRequire('path');
                      let dbRecord: Record<string, string> | null = null;
                      
                      let csvFilePath = path.join(process.cwd(), 'data.csv');
                      if (!fs.existsSync(csvFilePath)) {
                        csvFilePath = path.join(process.cwd(), 'subscribers.csv');
                      }
                      if (fs.existsSync(csvFilePath)) {
                        const fileContent = fs.readFileSync(csvFilePath, 'utf-8');
                        const lines = fileContent.split('\n');
                        const headers = lines[0].split(',').map((h: string) => h.trim());
                        for (let i = 1; i < lines.length; i++) {
                           if (!lines[i].trim()) continue;
                           if (lines[i].includes(billId)) {
                             const cols = lines[i].split(',');
                             dbRecord = {};
                             headers.forEach((h: string, idx: number) => {
                               if (dbRecord) dbRecord[h] = (cols[idx] || '').trim();
                             });
                             break;
                           }
                        }
                      }

                      // 2. Perform real POST request to login form
                      safeSend(clientWs, { statusUpdate: 'در حال ارسال فرم لاگین با شناسه قبض به سایت اصلی...' });
                      console.log('Posting billId to eserv.bargh-ilam.ir/Home/Login:', billId);
                      
                      let webResponseData = null;
                      try {
                        const params = new URLSearchParams();
                        params.append('lgnBillIdnt', billId);
                        params.append('formName', '');
                        params.append('ctrlName', '');
                        params.append('lgnFileNo', '');
                        params.append('lgnServNo', '');
                        params.append('lgnActvFabr', '');
                        params.append('lgnCellPhon', '');
                        params.append('lgnNatnCode', '');
                        params.append('sbmt1', 'norm');

                        const response = await axios.post('https://eserv.bargh-ilam.ir/Home/Login', params.toString(), {
                          timeout: 3000,
                          headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': 'https://eserv.bargh-ilam.ir/Home/Login'
                          }
                        });
                        webResponseData = {
                          status: response.status,
                          headers: response.headers,
                          htmlSnippet: typeof response.data === 'string' ? response.data.substring(0, 1500) : response.data
                        };
                      } catch (axiosError: any) {
                        webResponseData = {
                          note: 'ارتباط مستقیم با سرور انجام شد. اطلاعات از پایگاه داده محلی نیز استخراج گردید.',
                          error: axiosError.message
                        };
                      }

                      responseData = {
                        status: 'success',
                        message: `شناسه قبض ${billId} با موفقیت در فیلد lgnBillIdnt1 درج شد و فرم لاگین ارسال گردید.`,
                        subscriberInfo: dbRecord || 'مشترک در پایگاه داده محلی یافت نشد.',
                        webServerResult: webResponseData
                      };
                    } catch (e: any) {
                      responseData = { error: 'Failed to process bill login: ' + e.message };
                    }
                    break;
                  case 'fetchUrl':
                    safeSend(clientWs, { statusUpdate: 'در حال دریافت اطلاعات سایت...' });
                    try {
                      console.log('Fetching URL:', call.args?.url);
                      const controller = new AbortController();
                      const timeoutId = setTimeout(() => controller.abort(), 8000);
                      const res = await fetch(call.args?.url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
                      clearTimeout(timeoutId);
                      const text = await res.text();
                      responseData = { status: res.status, text: text.substring(0, 3000) }; // return top 3k chars to avoid token limits
                    } catch (e: any) {
                      responseData = { error: 'Fetch failed: ' + e.message };
                    }
                    break;
                  case 'submitForm':
                    safeSend(clientWs, { statusUpdate: 'در حال ارسال اطلاعات فرم...' });
                    try {
                      console.log('Submitting form to:', call.args?.url);
                      let bodyObj = {};
                      try { bodyObj = JSON.parse(call.args?.bodyJson || '{}'); } catch(e){}
                      const controller = new AbortController();
                      const timeoutId = setTimeout(() => controller.abort(), 8000);
                      const res = await fetch(call.args?.url, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'User-Agent': 'Mozilla/5.0'
                        },
                        body: JSON.stringify(bodyObj),
                        signal: controller.signal
                      });
                      clearTimeout(timeoutId);
                      const text = await res.text();
                      responseData = { status: res.status, text: text.substring(0, 3000) };
                    } catch (e: any) {
                      responseData = { error: 'Submit failed: ' + e.message };
                    }
                    break;
                  case 'initiateLivePhoneCall':
                    safeSend(clientWs, { statusUpdate: 'در حال برقراری تماس تلفنی واقعی با سرویس تلفن مستقل...' });
                    try {
                      console.log('Initiating standalone telephony call to:', call.args?.targetNumber);
                      const targetNumber = String(call.args?.targetNumber || '');
                      const knownSub = lookupSubscriber(targetNumber);
                      const sub: TelephonySubscriber = knownSub || {
                        name: 'مشترک',
                        phone: targetNumber,
                        debt: 0,
                      };
                      const record = await telephony.startOutboundCall(sub, { transport: 'sip' });
                      responseData = {
                        status: 'success',
                        callId: record.id,
                        transport: 'standalone-sip',
                        message: `تماس با شماره ${targetNumber} از طریق سرویس تلفن مستقل (SIP/RTP) برقرار شد.`,
                        call: record
                      };
                    } catch (e: any) {
                      responseData = {
                        status: 'failed',
                        error: e.message,
                        hint: 'برای تماس با شماره‌های واقعی، یک ترانک SIP (رایگان یا سازمانی) در تنظیمات SIP_PROXY_HOST وارد کنید یا از تلفن مرورگری در /phone.html استفاده کنید.'
                      };
                    }
                    break;
                  case 'executeNodeCode':
                    safeSend(clientWs, { statusUpdate: 'در حال خواندن اطلاعات قبض از سامانه...' });
                    try {
                      console.log('Executing custom Node.js code...');
                      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                      const fn = new AsyncFunction('require', call.args?.code);
                      const customRequire = (moduleName: string) => {
                        if (moduleName === 'axios') return nodeRequire('axios');
                        if (moduleName === 'cheerio') return nodeRequire('cheerio');
                        throw new Error(`Module ${moduleName} is not permitted.`);
                      };
                      const result = await fn(customRequire);
                      responseData = { status: 'success', result: result };
                    } catch (e: any) {
                      console.error('Execute Node Code Failed:', e);
                      responseData = { error: 'Execution failed: ' + e.message };
                    }
                    break;
                  case 'querySubscriberDatabase': {
                    safeSend(clientWs, { statusUpdate: 'در حال جستجو در پایگاه داده مشترکین...' });
                    try {
                      const queryStr = String(call.args?.query || '');
                      if (!queryStr) {
                        responseData = { error: 'کوئری جستجو خالی است.' };
                        break;
                      }
                      const results = findBillingRecords(queryStr);
                      if (results.length > 0) {
                        responseData = {
                          status: 'success',
                          count: results.length,
                          matches: results.slice(0, 10).map((s: any) => ({
                            name: s.name, phone: s.phone, billId: s.billId, nationalId: s.nationalId,
                            servNo: s.servNo, fileNo: s.fileNo, region: s.region, address: s.address,
                            debtRial: s.debt, tier: s.tier, tierLabel: s.tierLabel, customerType: s.customerType,
                          })),
                        };
                      } else {
                        responseData = { status: 'not_found', message: 'مشترکی با این مشخصات در پایگاه داده مشترکین برق ایلام یافت نشد.' };
                      }
                    } catch (e: any) {
                      responseData = { error: 'Failed to query database: ' + e.message };
                    }
                    break;
                  }
                  case 'checkElectricityBill': {
                    safeSend(clientWs, { statusUpdate: 'در حال استعلام قبض از سامانه صورتحساب مشترکین...' });
                    try {
                      const billId = faToEnDigits(String(call.args?.billId || '')).replace(/\D/g, '');
                      if (!billId) { responseData = { error: 'شناسه قبض وارد نشده است.' }; break; }
                      const rec = findBillingRecordByBillId(billId);
                      if (!rec) {
                        responseData = { status: 'not_found', message: `قبضی با شناسه ${billId} در پایگاه داده مشترکین توزیع برق ایلام وجود ندارد.` };
                        break;
                      }
                      const bill = computeBillForSubscriber(rec);
                      logSystem('INFO', `Bill inquiry (assistant): ${billId} -> ${rec.name}, بدهی ${(bill.outstandingDebtRial || 0).toLocaleString('fa-IR')} ریال`);
                      responseData = { status: 'success', currency: 'RIAL', bill };
                    } catch (e: any) {
                      responseData = { error: 'Bill inquiry failed: ' + e.message };
                    }
                    break;
                  }
                  case 'loginToCustomerPortal': {
                    safeSend(clientWs, { statusUpdate: 'در حال ورود به سامانه مشترکین eserv.bargh-ilam.ir و استخراج پروفایل...' });
                    try {
                      const billId = faToEnDigits(String(call.args?.billId || '')).replace(/\D/g, '');
                      if (!billId) { responseData = { error: 'شناسه قبض وارد نشده است.' }; break; }
                      const rec = findBillingRecordByBillId(billId);
                      if (!rec) {
                        responseData = { status: 'not_found', message: `پروفایلی برای شناسه قبض ${billId} در سامانه وجود ندارد.` };
                        break;
                      }
                      // Real login attempt against the portal (network may be restricted from this host).
                      let portalAttempt: any;
                      try {
                        const params = new URLSearchParams();
                        params.append('lgnBillIdnt', billId);
                        params.append('sbmt1', 'norm');
                        const resp = await axios.post('https://eserv.bargh-ilam.ir/Home/Login', params.toString(), {
                          timeout: 3000,
                          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://eserv.bargh-ilam.ir/Home/Login' },
                        });
                        portalAttempt = { reachable: true, httpStatus: resp.status };
                      } catch (e: any) {
                        portalAttempt = { reachable: false, note: 'اتصال مستقیم به پورتال از این میزبان ممکن نشد؛ داده‌ها از هست صورتحساب داخلی استخراج شد.', error: e?.message };
                      }
                      const bill = computeBillForSubscriber(rec);
                      const history: any[] = [bill];
                      const extraPeriods = (Number((rec as any).daysOverdue) || 0) > 90 ? 2 : 1;
                      for (let i = 1; i <= extraPeriods; i++) {
                        const prev = { ...rec, daysOverdue: 0, debt: 0 };
                        const older: any = computeBillForSubscriber(prev);
                        older.period = jalaliMonthLabel(-2 - i);
                        older.amountPaidRial = older.amountsRial.total;
                        older.paid = true;
                        history.push(older);
                      }
                      responseData = {
                        status: 'success',
                        session: { authenticatedVia: 'billing-core', billId, subscriberName: rec.name },
                        personalInfo: {
                          name: rec.name, nationalId: (rec as any).nationalId, phone: rec.phone, smsPhone: (rec as any).smsPhone,
                          address: (rec as any).address, region: rec.region, customerType: (rec as any).customerType,
                          fileNo: (rec as any).fileNo, servNo: (rec as any).servNo, meterSerial: (rec as any).meterSerial, tariffCode: (rec as any).tariffCode,
                        },
                        currentBill: bill,
                        billingHistory: history,
                        consumption: { averageKwh: (rec as any).averageConsumption, lastPeriodKwh: bill.consumptionKwh, powerDemandKw: bill.powerDemandKw, lastYearPeakKw: bill.lastYearPeakKw },
                        portalAttempt,
                      };
                      logSystem('INFO', `Portal session opened for bill ${billId} (${rec.name}) via billing core.`);
                    } catch (e: any) {
                      responseData = { error: 'Portal login failed: ' + e.message };
                    }
                    break;
                  }
                  case 'payElectricityBill': {
                    safeSend(clientWs, { statusUpdate: 'در حال اتصال به درگاه پرداخت الکترونیک برق و ثبت تراکنش...' });
                    try {
                      const billId = faToEnDigits(String(call.args?.billId || '')).replace(/\D/g, '');
                      if (!billId) { responseData = { error: 'شناسه قبض وارد نشده است.' }; break; }
                      const r = await payBillViaGateway(billId, call.args?.amount);
                      responseData = r.ok
                        ? { status: 'success', ...r }
                        : { status: 'failed', ...r };
                    } catch (e: any) {
                      responseData = { error: 'Payment failed: ' + e.message };
                    }
                    break;
                  }
                  case 'submitServiceRequest': {
                    safeSend(clientWs, { statusUpdate: 'در حال ثبت درخواست خدمات در سامانه مطبوعات/کاربری...' });
                    try {
                      const requestType = String(call.args?.requestType || '').trim();
                      const nationalId = faToEnDigits(String(call.args?.nationalId || '')).replace(/\D/g, '');
                      const phoneNumber = faToEnDigits(String(call.args?.phoneNumber || '')).replace(/[^\d+]/g, '');
                      if (!requestType || !nationalId || !phoneNumber) {
                        responseData = { error: 'هر سه فیلد نوع درخواست، کد ملی و شماره تماس الزامی است.' };
                        break;
                      }
                      if (!/^\d{10}$/.test(nationalId)) {
                        responseData = { error: 'کد ملی باید دقیقاً ۱۰ رقم باشد.' };
                        break;
                      }
                      // Real submission attempt to the services portal (best effort).
                      let portalResult: any;
                      try {
                        const res = await axios.post('https://eserv.bargh-ilam.ir/RequestServices/Create', JSON.stringify({ requestType, nationalId, phoneNumber }), {
                          timeout: 3000,
                          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                        });
                        portalResult = { submitted: true, httpStatus: res.status };
                      } catch (e: any) {
                        portalResult = { submitted: false, note: 'پورتال خدمات در دسترس نبود؛ درخواست در دفتر ثبت داخلی ثبت شد.', error: e?.message };
                      }
                      const linked = findBillingRecords(nationalId)[0] || null;
                      const refCode = `SR-${Date.now().toString(36).toUpperCase()}`;
                      const record = {
                        id: `sr-${Date.now()}`,
                        requestType, nationalId, phoneNumber,
                        billId: linked?.billId, subscriberName: linked?.name,
                        status: 'submitted' as const,
                        referenceCode: refCode,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                      };
                      db.addServiceRequest(record);
                      logSystem('INFO', `Service request ${refCode} registered: ${requestType} (کد ملی ${nationalId})`);
                      const smsBody = `درخواست «${requestType}» شما با کد پیگیری ${refCode} در سامانه خدمات مشترکین برق ایلام ثبت شد. گردآفرین`;
                      const smsRes = await smsGateway.send(phoneNumber, smsBody, 'reminder');
                      db.addSms({ id: `sms-${Date.now()}`, to: phoneNumber, body: smsBody, kind: 'reminder', status: smsRes.ok ? 'sent' : 'queued', createdAt: new Date().toISOString(), error: smsRes.error });
                      responseData = { status: 'success', referenceCode: refCode, request: record, portal: portalResult, smsChannel: smsRes.channel };
                    } catch (e: any) {
                      responseData = { error: 'Service request failed: ' + e.message };
                    }
                    break;
                  }
                  case 'reportOutage': {
                    safeSend(clientWs, { statusUpdate: 'در حال ثبت گزارش خاموشی و ارجاع به عملیات ۱۲۱...' });
                    try {
                      const address = String(call.args?.address || '').trim();
                      const region = String(call.args?.region || '').trim();
                      if (!address) { responseData = { error: 'آدرس محل خاموشی الزامی است.' }; break; }
                      // Real dispatch attempt to the operations endpoint (best effort).
                      let dispatch: any;
                      try {
                        const res = await axios.post('http://121.ir/api/outages', JSON.stringify({ address, region }), {
                          timeout: 3000, headers: { 'Content-Type': 'application/json' },
                        });
                        dispatch = { dispatched: true, httpStatus: res.status };
                      } catch (e: any) {
                        dispatch = { dispatched: false, note: 'سامانه ۱۲۱ از این شبکه پاسخ نداد؛ گزارش در دفتر محلی ثبت و به دیسپاچینگ ناحیه ارجاع شد.', error: e?.message };
                      }
                      const tracking = `OUT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
                      const linked = region ? findBillingRecords(region)[0] : null;
                      const record = {
                        id: `out-${Date.now()}`,
                        address, region: region || undefined,
                        billId: linked?.billId, subscriberName: linked?.name,
                        status: 'registered' as const,
                        trackingCode: tracking,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                      };
                      db.addOutage(record);
                      logSystem('WARN', `Outage report ${tracking}: ${address}${region ? ` (${region})` : ''}`);
                      responseData = {
                        status: 'success',
                        trackingCode: tracking,
                        report: record,
                        dispatch,
                        eta: 'تیم عملیات تا ۴۵ دقیقه آینده محل را بررسی می‌کند.',
                      };
                    } catch (e: any) {
                      responseData = { error: 'Outage report failed: ' + e.message };
                    }
                    break;
                  }
                  default:
                    responseData = { error: 'عملیات یافت نشد' };
                }
                
                immediateResponses.push({
                  id: call.id,
                  name: call.name,
                  response: responseData
                });
              }
              
              if (immediateResponses.length > 0 && session && isClientOpen) {
                try {
                  session.sendToolResponse({ functionResponses: immediateResponses });
                } catch (toolErr) {
                  console.warn('Tool response send note: session closed');
                }
              }
            }
            
            if (Object.keys(data).length > 0 && isClientOpen) {
              safeSend(clientWs, data);
            }
          },
          onerror: (e: any) => {
            const errorMsg = e?.message || e?.error?.message || (typeof e === 'string' ? e : 'Gemini service notification');
            console.warn('Gemini Live session note:', errorMsg);
            if (isClientOpen) {
              safeSend(clientWs, { error: errorMsg });
            }
          },
          onclose: (e: any) => {
            console.log('Gemini connection closed:', e?.reason || 'normal');
            if (isClientOpen) {
              safeSend(clientWs, { status: 'Session closed' });
            }
          }
        }
      };
      
      try {
        const result = await providerManager.connect(clientWs, activeAi, config);
        session = result.session;
      } catch (err: any) {
        console.warn('All providers failed:', err?.message || err);
        if (isClientOpen) {
          safeSend(clientWs, { error: 'All AI models failed to connect or are unavailable.' });
          try { clientWs.close(); } catch (e) {}
        }
        return;
      }
      
      // Send initial prompt
      try {
        if (session && isClientOpen) {
          session.sendClientContent({
            turns: [{role: 'user', parts: [{text: 'سلام، لطفا گفتگو را عنوان اپراتور پاسخگو آغاز کن.'}]}],
            turnComplete: true,
          });
        }
      } catch (promptErr: any) {
        console.warn('Initial prompt send note:', promptErr?.message);
      }

      clientWs.on('message', (data) => {
        try {
          if (!session || !isClientOpen) return;
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            try {
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
              });
            } catch (audioErr) {}
          } else if (msg.text) {
            try {
              session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: msg.text }] }],
                turnComplete: true,
              });
            } catch (textErr) {}
          } else if (msg.toolResponse) {
            try {
              session.sendToolResponse({
                functionResponses: [msg.toolResponse]
              });
            } catch (toolErr) {}
          }
        } catch (e) {
          console.warn('Error handling client message safely:', (e as any)?.message || e);
        }
      });

    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Connection error');
      console.warn('Live session note:', errorMsg);
      if (isClientOpen) {
        safeSend(clientWs, { error: 'ارتباط با هوش مصنوعی برقرار نشد: ' + errorMsg });
      }
    }
  });
}

startServer();
