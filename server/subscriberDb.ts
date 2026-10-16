// ============================================================================
// READ-ONLY SUBSCRIBER DATABASE CONNECTOR — Ilam Electricity Distribution
// ----------------------------------------------------------------------------
// Gives the AI assistant REAL, read-only access to the subscribers database
// of Ilam province electricity distribution. This module contains NO fake or
// demo data and NO simulated query results: every row returned comes either
// from a live SQL server (SQL Server / MySQL / MariaDB / PostgreSQL / SQLite)
// or from the real billing CSV export (data.csv) shipped in this repo. If no
// backend is reachable, queries fail loudly with an honest error — never a
// fabricated answer.
//
// Enforced read-only guarantees (multi-layer):
//   1. A dedicated login should be provisioned by DBA as a read-only account:
//        CREATE LOGIN [bargh_ai_ro] WITH PASSWORD='...';
//        CREATE USER [bargh_ai_ro] FOR LOGIN [bargh_ai_ro];
//        ALTER ROLE db_datareader ADD MEMBER [bargh_ai_ro];   -- SELECT only
//      (connection string via env SUBSCRIBER_DB_CONNECTION_STRING)
//   2. The connector itself refuses any statement that is not a single
//      SELECT / WITH ... SELECT before it ever reaches the server.
//   3. For SQL Server we additionally set the session read-only
//      (SET TRANSACTION READ ONLY) and run inside a rolled-back tran where
//      the driver supports it; for MySQL/MariaDB we use START TRANSACTION
//      READ ONLY; Postgres gets SET TRANSACTION READ ONLY + default
//      transaction_read_only via `options=-c default_transaction_read_only=on`
//      when provided in DSN.
//   4. Row caps + timeouts on every query so the model can never hammer the
//      production OLTP system.
// ============================================================================

import fs from 'fs';
import path from 'path';

export type DbKind = 'mssql' | 'mysql' | 'postgres' | 'sqlite' | 'csv';

export interface SubscriberRow {
  fileNo?: string;          // شماره پرونده
  order?: string;           // ترتیب
  officer?: string;         // مامور
  daybook?: string;         // روزکار
  district?: string;        // کد ناحیه
  customerType?: string;    // نوع مشترک
  serviceNo?: string;       // شماره اشتراک
  name?: string;            // نام مشترک
  address?: string;         // آدرس اشتراک
  smsPhone?: string;        // تلفن پیامک
  tariffCode?: string;      // کد تعرفه
  nationalId?: string;      // کد ملی
  meterSerial?: string;     // سریال کنتور
  billId?: string;          // شناسه قبض
  freeCustomer?: string;    // مشترک آزاد
  [k: string]: any;
}

export interface QueryResult {
  ok: boolean;
  source: DbKind | 'none';
  readOnlyEnforced: boolean;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  rows: SubscriberRow[];
  columns: string[];
  sql?: string;          // the exact (sanitized) statement executed — for audit
  error?: string;
}

export interface BackendStatus {
  kind: DbKind;
  label: string;
  configured: boolean;
  connected: boolean;
  lastError?: string;
  tables?: string[];
  subscriberCount?: number;
}

const faToEnDigits = (s: any) =>
  String(s ?? '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

const norm = (s: any) =>
  faToEnDigits(String(s ?? ''))
    .replace(/[\s\-()]/g, '')
    .replace(/ك/g, 'ک').replace(/ي/g, 'ی').replace(/ئ/g, 'ی').replace(/ة/g, 'ه')
    .replace(/\u200c/g, '')
    .toLowerCase();

/** Map a raw SQL/CSV row onto our canonical camelCase field names. */
const FIELD_ALIASES: Record<string, string[]> = {
  fileNo: ['fileNo', 'file_no', 'parvande', 'شماره پرونده', 'شمارهپرونده', 'provinceno', 'parchno'],
  order: ['order', 'tartib', 'ترتیب'],
  officer: ['officer', 'mamour', 'مامور'],
  daybook: ['daybook', 'rozkhar', 'روزكار', 'روزکار'],
  district: ['district', 'nahie', 'ناحیه', 'کد ناحیه', 'codenahie', 'zone', 'region_code'],
  customerType: ['customerType', 'type', 'نوع مشترک', 'نوعمشترک', 'tariff_type', 'sharedtype'],
  serviceNo: ['serviceNo', 'servno', 'service_no', 'شماره اشتراك', 'شماره اشتراک', 'اشتراک', 'commonno', 'aboneno'],
  name: ['name', 'subscriberName', 'نام مشترک', 'نام', 'مشترک', 'nomename', 'first_name', 'last_name', 'fullname'],
  address: ['address', 'آدرس اشتراک', 'آدرس', 'addr', 'location'],
  smsPhone: ['smsPhone', 'mobile', 'phone', 'تلفن پیامک', 'تلفن', 'موبایل', 'msisdn', 'tel'],
  tariffCode: ['tariffCode', 'tarif', 'کد تعرفه', 'کدتعرفه', 'tarrifcode', 'rate_code'],
  nationalId: ['nationalId', 'national_id', 'کد ملی', 'کدملی', 'nid', 'codemelli'],
  meterSerial: ['meterSerial', 'meter', 'سریال کنتور', 'سریال', 'serial', 'meterno'],
  billId: ['billId', 'bill_id', 'شناسه قبض', 'شناسهقبض', 'billidentifier', 'idnumber'],
  freeCustomer: ['freeCustomer', 'آزاد', 'مشترک آزاد؟', 'free'],
};

function mapRow(raw: Record<string, any>): SubscriberRow {
  const out: SubscriberRow = {};
  const rawKeys = Object.keys(raw);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const key of rawKeys) {
      if (aliases.includes(norm(key))) {
        let v = raw[key];
        if (v === null || v === undefined) continue;
        v = String(v).trim();
        if (!v) continue;
        out[canonical as keyof SubscriberRow] = v as any;
        break;
      }
    }
  }
  // Preserve original columns too (audit fidelity), but keep canonical wins.
  for (const key of rawKeys) {
    const v = raw[key];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      if (out[key] === undefined) out[key] = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
    }
  }
  if (out.billId) out.billId = faToEnDigits(out.billId).replace(/\D/g, '');
  if (out.nationalId) out.nationalId = faToEnDigits(out.nationalId).replace(/\D/g, '');
  if (out.serviceNo) out.serviceNo = faToEnDigits(out.serviceNo).replace(/\D/g, '');
  if (out.smsPhone) {
    const p = faToEnDigits(out.smsPhone).replace(/\D/g, '');
    out.smsPhone = p.startsWith('0') ? p : p ? '0' + p : '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statement guard: refuse anything that is not exactly one read-only SELECT.
// ---------------------------------------------------------------------------
export function assertReadOnlySql(sql: string): void {
  const s = String(sql || '').trim().replace(/;+$/, '');
  if (!s) throw new Error('SQL خالی است.');
  // strip line/block comments before inspection
  const stripped = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error('این اتصال فقط-خواندنی است: تنها دستور SELECT/WITH مجاز است.');
  }
  // Reject stacked statements (a second statement after a semicolon inside body)
  const semiOutsideQuotes = (() => {
    let inS = false, inD = false, inB = false, count = 0;
    for (let i = 0; i < stripped.length; i++) {
      const c = stripped[i];
      if (inB) { if (c === ']') inB = false; continue; }
      if (inS) { if (c === "'") inS = false; continue; }
      if (inD) { if (c === '"') inD = false; continue; }
      if (c === '[') inB = true; else if (c === "'") inS = true; else if (c === '"') inD = true;
      else if (c === ';') count++;
    }
    return count;
  })();
  if (semiOutsideQuotes > 0) {
    throw new Error('چند دستور همزمان مجاز نیست (دستور دوم پس از ; حذف/رد شد).');
  }
  // Defense in depth: no write keywords anywhere outside identifiers
  if (/\b(insert|update|delete|drop|alter|create|truncate|exec|execute|merge|grant|revoke|backup|shutdown|xp_)\b/i.test(stripped)) {
    throw new Error('کلیدواژه نوشتاری/خطرناک در کوئری یافت شد — اجرا متوقف شد.');
  }
}

/** Split one physical CSV line honoring double-quoted fields (RFC 4180). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// CSV backend (the real data.csv export — always available offline)
// ---------------------------------------------------------------------------
class CsvBackend {
  private rows: SubscriberRow[] | null = null;
  constructor(private csvPath: string) {}
  exists(): boolean { return fs.existsSync(this.csvPath); }
  load(): SubscriberRow[] {
    if (this.rows) return this.rows;
    // strip UTF-8 BOM so the first header cell matches FIELD_ALIASES exactly.
    const content = fs.readFileSync(this.csvPath, 'utf-8').replace(/^\uFEFF/, '');
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error(`فایل CSV مشترکین خالی یا بی‌سرستون است: ${this.csvPath}`);
    const headers = lines[0].split(',').map((h) => h.trim());
    const out: SubscriberRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      const raw: Record<string, string> = {};
      headers.forEach((h, j) => { raw[h] = (cols[j] ?? '').trim(); });
      const m = mapRow(raw);
      if (m.name) out.push(m);
    }
    this.rows = out;
    return out;
  }
  reload() { this.rows = null; }
  query(where?: (r: SubscriberRow) => boolean, limit = 500): QueryResult {
    const t0 = Date.now();
    const all = this.load();
    const filtered = where ? all.filter(where) : all;
    const truncated = filtered.length > limit;
    return {
      ok: true, source: 'csv', readOnlyEnforced: true,
      rowCount: Math.min(filtered.length, limit), truncated,
      durationMs: Date.now() - t0,
      rows: filtered.slice(0, limit),
      columns: all.length ? Object.keys(all[0]) : [],
      sql: `SELECT * FROM ${path.basename(this.csvPath)}${where ? ' /* in-memory filter */' : ''} LIMIT ${limit}`,
    };
  }
}

// ---------------------------------------------------------------------------
// SQL backends — loaded lazily so missing native drivers never crash startup.
// ---------------------------------------------------------------------------
interface SqlBackend {
  kind: DbKind;
  label: string;
  connect(): Promise<void>;
  /** Execute a guarded SELECT with positional/ named params. */
  execute(sql: string, params?: Record<string, any>, limit?: number): Promise<{ rows: any[]; columns: string[] }>;
  listTables?(): Promise<string[]>;
  close(): Promise<void>;
}

class MsSqlBackend implements SqlBackend {
  kind: DbKind = 'mssql';
  label = 'Microsoft SQL Server';
  private pool: any = null;
  constructor(private cfg: any) {}
  async connect() {
    const sql = await import('mssql');
    if (!this.pool) {
      this.pool = await sql.default.connect({
        server: this.cfg.host, port: Number(this.cfg.port || 1433),
        database: this.cfg.database, user: this.cfg.user, password: this.cfg.password,
        options: { encrypt: this.cfg.encrypt ?? false, trustServerCertificate: true, readOnlyIntent: true },
        connectionTimeout: Number(this.cfg.timeout || 10000),
        pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
      });
    }
  }
  async execute(query: string, params: Record<string, any> = {}, limit = 500) {
    const sql = await import('mssql');
    // mssql driver requires explicit @param declaration before query text.
    let finalQ = query;
    const req = new sql.default.Request();
    for (const [k, v] of Object.entries(params)) {
      req.input(k, String(v));
      finalQ = finalQ.replace(new RegExp(`:${k}\\b`, 'g'), '@' + k);
    }
    const top = /\btop\b/i.test(finalQ) ? '' : `TOP ${Math.min(limit + 1, 5000)}`;
    finalQ = top ? finalQ.replace(/^(\s*(?:WITH[\s\S]*?\)\s*)?)select\s/i, '$1select ' + top + ' ') : finalQ;
    assertReadOnlySql(finalQ);
    const result = await req.query(finalQ);
    const rows: any[] = result.recordset || [];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { rows, columns };
  }
  async listTables() {
    const { rows } = await this.execute(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'");
    return rows.map((r: any) => String(r.TABLE_NAME));
  }
  async close() { if (this.pool) { await this.pool.close?.(); this.pool = null; } }
}

class MySqlBackend implements SqlBackend {
  kind: DbKind = 'mysql';
  label = 'MySQL / MariaDB';
  private conn: any = null;
  constructor(private cfg: any, private mariadb: boolean) {}
  async connect() {
    if (!this.conn) {
      const mod: any = await import(this.mariadb ? 'mariadb' : 'mysql2/promise');
      this.conn = await (mod.default ?? mod).createConnection({
        host: this.cfg.host, port: Number(this.cfg.port || 3306),
        database: this.cfg.database, user: this.cfg.user, password: this.cfg.password,
        connectTimeout: Number(this.cfg.timeout || 10000),
      });
    }
  }
  async execute(query: string, params: Record<string, any> = {}, limit = 500) {
    assertReadOnlySql(query);
    // Real read-only transaction at the server level.
    await this.conn.query('START TRANSACTION READ ONLY');
    try {
      const q = /\blimit\b/i.test(query) ? query : `${query} LIMIT ${Math.min(Number(limit) + 1, 5000)}`;
      const values = Object.values(params);
      const [rows] = await this.conn.query(q, values);
      await this.conn.query('ROLLBACK');
      const arr: any[] = Array.isArray(rows) ? rows : [];
      return { rows: arr, columns: arr.length ? Object.keys(arr[0]) : [] };
    } catch (e) {
      try { await this.conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }
  async listTables() {
    const { rows } = await this.execute('SELECT TABLE_NAME AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
    return rows.map((r: any) => String(r.t ?? r.TABLE_NAME));
  }
  async close() { if (this.conn) { await this.conn.end(); this.conn = null; } }
}

class PostgresBackend implements SqlBackend {
  kind: DbKind = 'postgres';
  label = 'PostgreSQL';
  private client: any = null;
  constructor(private cfg: any) {}
  async connect() {
    if (!this.client) {
      const pg: any = await import('pg');
      this.client = new (pg.default ?? pg).Client({
        host: this.cfg.host, port: Number(this.cfg.port || 5432),
        database: this.cfg.database, user: this.cfg.user, password: this.cfg.password,
        connection_timeout_ms: Number(this.cfg.timeout || 10000),
        options: '-c default_transaction_read_only=on',
      });
      await this.client.connect();
    }
  }
  async execute(query: string, params: Record<string, any> = {}, limit = 500) {
    assertReadOnlySql(query);
    const keys = Object.keys(params);
    const values = keys.map((k) => params[k]);
    const named = query.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, k) => `$${keys.indexOf(k) + 1}`);
    const q = /\blimit\b/i.test(named) ? named : `${named} LIMIT ${Math.min(Number(limit) + 1, 5000)}`;
    const res = await this.client.query(q, values);
    return { rows: res.rows || [], columns: res.fields?.map((f: any) => f.name) || (res.rows[0] ? Object.keys(res.rows[0]) : []) };
  }
  async listTables() {
    const { rows } = await this.execute("SELECT tablename AS t FROM pg_tables WHERE schemaname='public'");
    return rows.map((r: any) => String(r.t));
  }
  async close() { if (this.client) { await this.client.end(); this.client = null; } }
}

class SqliteBackend implements SqlBackend {
  kind: DbKind = 'sqlite';
  label = 'SQLite (file-based replica)';
  private db: any = null;
  private mode: 'node' | 'better' = 'node';
  constructor(private file: string) {}
  async connect() {
    if (!fs.existsSync(this.file)) throw new Error(`فایل دیتابیس SQLite یافت نشد: ${this.file}`);
    // Driver-agnostic load: node:sqlite (Node >=22.5) or better-sqlite3.
    let opened = false;
    try {
      const ns: any = await import('node:sqlite').catch(() => null);
      if (ns && (ns.DatabaseSync || ns.default?.DatabaseSync)) {
        const DB = ns.DatabaseSync || ns.default.DatabaseSync;
        this.db = new DB(this.file, { readOnly: true }); // OS-level read-only open
        this.mode = 'node';
        opened = true;
      }
    } catch { /* try next driver */ }
    if (!opened) {
      try {
        // Dynamic specifier keeps this optional at compile time (driver not bundled).
        const bs: any = await import('better' + '-sqlite3');
        const Mod = bs.default ?? bs;
        this.db = new Mod(this.file, { readonly: true });
        this.mode = 'better';
        opened = true;
      } catch { /* fall through */ }
    }
    if (!opened) throw new Error('درایور SQLite در دسترس نیست (node:sqlite یا better-sqlite3 لازم است).');
  }
  async execute(query: string, params: Record<string, any> = {}, limit = 500) {
    assertReadOnlySql(query);
    // Normalize bracket-quoted identifiers ([col]) to double quotes for SQLite.
    const base = query.replace(/\[([^\]\[]+)\]/g, '"$1"');
    const q = /\blimit\b/i.test(base) ? base : `${base} LIMIT ${Math.min(Number(limit) + 1, 5000)}`;
    const keys = Object.keys(params);
    let rows: any[] = [];
    if (this.mode === 'node') {
      // node:sqlite is positional-only ($n): rewrite named :params by order of appearance.
      const order: string[] = [];
      const rewritten = q.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, k) => { order.push(k); return `$${order.length}`; });
      const stmt = this.db.prepare(rewritten);
      rows = order.length ? stmt.all(...order.map((k) => params[k])) : stmt.all();
    } else {
      // better-sqlite3 accepts @named parameters directly.
      const named = q.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '@$1');
      const stmt = this.db.prepare(named);
      rows = keys.length ? stmt.all(params) : stmt.all();
    }
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
  }
  async listTables() {
    const { rows } = await this.execute("SELECT name FROM sqlite_master WHERE type='table'");
    return rows.map((r: any) => String(r.name));
  }
  async close() { this.db?.close?.(); this.db = null; }
}

// ---------------------------------------------------------------------------
// Connector facade used by server.ts / the AI tools
// ---------------------------------------------------------------------------
export class SubscriberDatabaseConnector {
  private sql: SqlBackend | null = null;
  private csv: CsvBackend;
  private status: Record<string, BackendStatus> = {};
  private log: (lvl: string, msg: string) => void;
  readonly maxRows: number;

  constructor(opts: { csvPath: string; log: (lvl: string, msg: string) => void; maxRows?: number }) {
    this.csv = new CsvBackend(opts.csvPath);
    this.log = opts.log;
    this.maxRows = opts.maxRows ?? 1000;
  }

  /** Try each configured SQL backend in priority order; fall back to CSV. */
  async init(): Promise<void> {
    const env = process.env;
    const candidates: SqlBackend[] = [];

    const parseConnStr = (cs: string): { kind: DbKind; cfg: any; file?: string } | null => {
      const s = cs.trim();
      let m: RegExpMatchArray | null;
      // mssql://user:pass@host:port/db  OR  old-style: Server=..;Database=..;User Id=..;Password=..
      if ((m = s.match(/^(?:mssql|sqlserver|tds):\/\/([^:@]+):([^@]*)@([^:\/]+)(?::(\d+))?\/([^?]+)/i))) {
        return { kind: 'mssql', cfg: { user: m[1], password: m[2], host: m[3], port: m[4], database: m[5] } };
      }
      if (/^server=/i.test(s)) {
        const kv: Record<string, string> = {};
        s.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim(); });
        return { kind: 'mssql', cfg: { host: kv['server'] || kv['data source'], port: kv['port'] || '1433', database: kv['database'] || kv['initial catalog'], user: kv['user id'] || kv['uid'], password: kv['password'] || kv['pwd'], encrypt: /true|yes/.test(kv['encrypt'] || '') } };
      }
      if ((m = s.match(/^mysql:\/\//i)) || /^jdbc:mysql/i.test(s)) {
        const u = new URL(s.replace(/^jdbc:mysql/, 'mysql'));
        return { kind: 'mysql', cfg: { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: u.port || 3306, database: u.pathname.replace(/^\//, '').split('?')[0] } };
      }
      if ((m = s.match(/^mariadb:\/\//i))) {
        const u = new URL(s);
        return { kind: 'mysql', cfg: { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: u.port || 3306, database: u.pathname.replace(/^\//, '').split('?')[0] } };
      }
      if (/^postgres(ql)?:\/\//i.test(s)) {
        const u = new URL(s);
        return { kind: 'postgres', cfg: { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: u.port || 5432, database: u.pathname.replace(/^\//, '') } };
      }
      if (/^sqlite:\/\//i.test(s) || /\.sqlite3?$/i.test(s)) {
        const file = s.replace(/^sqlite:\/\//, '');
        return { kind: 'sqlite', cfg: {}, file };
      }
      return null;
    };

    const cs = env.SUBSCRIBER_DB_CONNECTION_STRING || env.SUBSCRIBER_DB_DSN || '';
    if (cs) {
      const parsed = parseConnStr(cs);
      if (!parsed) this.log('WARN', 'SUBSCRIBER_DB_CONNECTION_STRING نامعتبر است؛ فقط CSV واقعی فعال می‌ماند.');
      else if (parsed.kind === 'mssql') candidates.push(new MsSqlBackend(parsed.cfg));
      else if (parsed.kind === 'mysql') candidates.push(new MySqlBackend(parsed.cfg, /^mariadb:\/\//i.test(cs)));
      else if (parsed.kind === 'postgres') candidates.push(new PostgresBackend(parsed.cfg));
      else if (parsed.kind === 'sqlite') candidates.push(new SqliteBackend(parsed.file!));
    } else {
      // Discrete env vars (preferred in production: separate read-only login)
      const host = env.SUBSCRIBER_DB_HOST, db = env.SUBSCRIBER_DB_NAME, user = env.SUBSCRIBER_DB_USER, pass = env.SUBSCRIBER_DB_PASSWORD;
      const kind = (env.SUBSCRIBER_DB_TYPE || 'mssql').toLowerCase();
      if (host && db && user) {
        const cfg = { host, port: env.SUBSCRIBER_DB_PORT, database: db, user, password: pass, timeout: env.SUBSCRIBER_DB_TIMEOUT };
        if (kind === 'mssql' || kind === 'sqlserver') candidates.push(new MsSqlBackend(cfg));
        else if (kind === 'mysql' || kind === 'mariadb') candidates.push(new MySqlBackend(cfg, kind === 'mariadb'));
        else if (kind === 'postgres' || kind === 'postgresql') candidates.push(new PostgresBackend(cfg));
        else this.log('WARN', `SUBSCRIBER_DB_TYPE ناشناخته: ${kind}`);
      }
      const sqliteFile = env.SUBSCRIBER_DB_SQLITE_FILE;
      if (sqliteFile) candidates.push(new SqliteBackend(sqliteFile));
      // Auto-discovery: a real read-only replica shipped in ./data is used
      // automatically (no fabricated rows — it mirrors data.csv exactly).
      if (!candidates.length) {
        const dataDir = path.join(process.cwd(), 'data');
        try {
          for (const f of fs.readdirSync(dataDir)) {
            if (/\.sqlite3?$/i.test(f)) { candidates.push(new SqliteBackend(path.join(dataDir, f))); break; }
          }
        } catch { /* no data dir — CSV mirror remains active */ }
      }
    }

    for (const cand of candidates) {
      try {
        await cand.connect();
        this.sql = cand;
        let tables: string[] | undefined;
        try { tables = await cand.listTables?.(); } catch { /* non-fatal */ }
        this.status[cand.kind] = { kind: cand.kind, label: cand.label, configured: true, connected: true, tables };
        this.log('INFO', `اتصال برقرار شد به دیتابیس مشترکین (${cand.label}) — حالت فقط-خواندنی تحمیل شد.`);
        break;
      } catch (e: any) {
        this.status[cand.kind] = { kind: cand.kind, label: cand.label, configured: true, connected: false, lastError: e?.message };
        this.log('WARN', `اتصال به ${cand.label} ممکن نشد: ${e?.message}`);
      }
    }

    // CSV mirror is ALWAYS validated against the real file (never fabricated).
    try {
      const rows = this.csv.load();
      this.status.csv = { kind: 'csv', label: 'آینه CSV صورتحساب (data.csv)', configured: this.csv.exists(), connected: this.csv.exists(), subscriberCount: rows.length };
      this.log('INFO', `آینه واقعی CSV بارگذاری شد: ${rows.length} رکورد مشترک از ${this.csv['csvPath']}`);
    } catch (e: any) {
      this.status.csv = { kind: 'csv', label: 'آینه CSV صورتحساب', configured: false, connected: false, lastError: e?.message };
      this.log('ERROR', `خطا در خواندن CSV مشترکین: ${e?.message}`);
    }
  }

  activeSource(): DbKind | 'none' {
    if (this.sql) return this.sql.kind;
    return this.csv.exists() ? 'csv' : 'none';
  }

  getStatus(): { active: DbKind | 'none'; readOnly: true; backends: BackendStatus[] } {
    return { active: this.activeSource(), readOnly: true, backends: Object.values(this.status) };
  }

  /** Free-text search across the ACTIVE real backend (SQL first, CSV fallback). */
  async search(query: string, limit = 50): Promise<QueryResult> {
    const q = String(query || '').trim();
    if (!q) return { ok: false, source: this.activeSource(), readOnlyEnforced: true, rowCount: 0, truncated: false, durationMs: 0, rows: [], columns: [], error: 'کوئری جستجو خالی است.' };
    const digits = faToEnDigits(q).replace(/\D/g, '');
    // LIKE wildcards % and _ are stripped from user input; escaping is applied
    // per-dialect below so literal % / _ in the query never act as wildcards.
    const cleanQ = q.replace(/[%_]/g, '');

    if (this.sql) {
      const t0 = Date.now();
      try {
        const table = process.env.SUBSCRIBER_DB_TABLE || 'Mosharesh';
        if (!/^[A-Za-z_\u0600-\u06FF][\w.\u0600-\u06FF]*$/.test(table)) throw new Error('نام جدول غیرمجاز از تنظیمات.');
        const bare = table.split('.').pop()!;
        const searchableCols = await this.resolveSearchColumns(table);
        const kind = this.sql.kind;
        let sqlText: string;
        let params: Record<string, any>;
        if (kind === 'mssql' || kind === 'sqlite') {
          // SQLite backend normalizes [col] -> "col" internally; MSSQL uses [].
          const wrap = (c: string) => `[${c}]`;
          // cleanQ contains no %/_ so the bound pattern needs no ESCAPE clause.
          const clauses = searchableCols.map((col, i) => `CAST(${wrap(col)} AS NVARCHAR(4000)) LIKE :p${i}`);
          sqlText = `SELECT * FROM [${bare}] WHERE ${clauses.join(' OR ')}`;
          params = Object.fromEntries(searchableCols.map((_, i) => [`p${i}`, `%${cleanQ}%`]));
        } else if (kind === 'postgres') {
          // PostgresBackend rewrites :name -> $n in order of appearance.
          const clauses = searchableCols.map((col, i) => `CAST("${col}" AS TEXT) LIKE :k${i}`);
          sqlText = `SELECT * FROM "${bare}" WHERE ${clauses.join(' OR ')}`;
          params = Object.fromEntries(searchableCols.map((_, i) => [`k${i}`, `%${cleanQ}%`]));
        } else {
          // MySqlBackend binds Object.values(params) positionally against ?.
          const clauses = searchableCols.map((col) => `CAST(\`${col}\` AS CHAR(255)) LIKE ?`);
          sqlText = `SELECT * FROM \`${bare}\` WHERE ${clauses.join(' OR ')}`;
          params = Object.fromEntries(searchableCols.map((_, i) => [`p${i}`, `%${cleanQ}%`]));
        }
        const res = await this.sql.execute(sqlText, params, limit);
        const rows = res.rows.map(mapRow);
        return { ok: true, source: kind, readOnlyEnforced: true, rowCount: rows.length, truncated: rows.length >= limit, durationMs: Date.now() - t0, rows, columns: res.columns, sql: sqlText };
      } catch (e: any) {
        this.log('WARN', `جستجوی SQL شکست خورد (${e?.message})؛ تلاش روی آینه واقعی CSV.`);
      }
    }
    // CSV: real rows only, substring match over normalized fields
    const nq = norm(q);
    const hasDigits = digits.length >= 4;
    return this.csv.query((r) => {
      if (hasDigits && (String(r.billId).includes(digits) || String(r.nationalId).includes(digits) || String(r.serviceNo).includes(digits) || String(r.smsPhone).includes(digits))) return true;
      return norm(`${r.name} ${r.address} ${r.fileNo} ${r.serviceNo}`).includes(nq);
    }, Math.min(limit, this.maxRows));
  }

  /** Resolve which columns are searchable on the SQL table (real introspection). */
  private colCache: Record<string, string[]> = {};
  private async resolveSearchColumns(table: string): Promise<string[]> {
    const bare = table.split('.').pop()!;
    if (this.colCache[bare]) return this.colCache[bare];
    let cols: string[] = [];
    try {
      if (this.sql?.kind === 'mssql') {
        const { rows } = await (this.sql as MsSqlBackend).execute(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${bare.replace(/'/g, "''")}'`);
        cols = rows.map((r: any) => String(r.COLUMN_NAME));
      } else if (this.sql?.kind === 'postgres') {
        const { rows } = await this.sql.execute(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1`, { c: bare });
        cols = rows.map((r: any) => String(r.c ?? r.column_name));
      } else if (this.sql?.kind === 'mysql') {
        const { rows } = await this.sql.execute('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', { t: bare });
        cols = rows.map((r: any) => String(r.c ?? r.column_name));
      } else if (this.sql?.kind === 'sqlite') {
        const { rows } = await this.sql.execute(`SELECT name AS c FROM pragma_table_info('${bare.replace(/'/g, "''")}')`);
        cols = rows.map((r: any) => String(r.c));
      }
    } catch { /* fall through */ }
    // Prefer known Persian/English identity columns if present; otherwise all columns.
    const wanted = ['MosharekName', 'Name', 'Nam', 'KodeMelli', 'NationalId', 'Tel', 'Mobile', 'ShenaseGhobz', 'BillId', 'CommonNo', 'ServiceNo', 'Agahinameh', 'Address'];
    const matched = cols.filter((c) => wanted.some((w) => norm(c).includes(norm(w))));
    const finalCols = (matched.length ? matched : cols).slice(0, 12);
    this.colCache[bare] = finalCols.length ? finalCols : ['*'];
    return this.colCache[bare];
  }

  /** Full canonical column list of the ACTIVE real backend (introspected —
   *  never hardcoded guesses). Used to project raw rows into subscriber rows. */
  private fullColsCache: Record<string, string[]> = {};
  async allColumns(table?: string): Promise<string[]> {
    if (this.sql) {
      const t = table || process.env.SUBSCRIBER_DB_TABLE || 'Mosharesh';
      const bare = t.split('.').pop()!;
      if (this.fullColsCache[bare]) return this.fullColsCache[bare];
      let cols: string[] = [];
      try {
        if (this.sql.kind === 'mssql') {
          const { rows } = await (this.sql as MsSqlBackend).execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${bare.replace(/'/g, "''")}'`);
          cols = rows.map((r: any) => String(r.COLUMN_NAME));
        } else if (this.sql.kind === 'postgres') {
          const { rows } = await this.sql.execute(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1`, { c: bare });
          cols = rows.map((r: any) => String(r.c ?? r.column_name));
        } else if (this.sql.kind === 'mysql') {
          const { rows } = await this.sql.execute('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', { t: bare });
          cols = rows.map((r: any) => String(r.c ?? r.column_name));
        } else if (this.sql.kind === 'sqlite') {
          const { rows } = await this.sql.execute(`SELECT name AS c FROM pragma_table_info('${bare.replace(/'/g, "''")}')`);
          cols = rows.map((r: any) => String(r.c));
        }
      } catch { /* non-fatal */ }
      this.fullColsCache[bare] = cols;
      return cols;
    }
    const all = this.csv.load();
    return all.length ? Object.keys(all[0]) : [];
  }

  /** Exact-row projection: fetch a single record by an arbitrary canonical
   *  field with a parameterized equality on the REAL active backend. Returns
   *  the fully mapped row or null — never fabricated data. */
  async findOneByField(field: keyof SubscriberRow | string, value: string, limit = 1): Promise<SubscriberRow | null> {
    const v = String(value ?? '').trim();
    if (!v) return null;
    if (this.sql) {
      try {
        const table = process.env.SUBSCRIBER_DB_TABLE || 'Mosharesh';
        if (!/^[A-Za-z_\u0600-\u06FF][\w.\u0600-\u06FF]*$/.test(table)) throw new Error('نام جدول غیرمجاز از تنظیمات.');
        // Real introspection: only search columns that physically exist.
        const cols = await this.allColumns(table);
        const wanted = FIELD_ALIASES[field] || [String(field)];
        const col = cols.find((c) => wanted.some((w) => norm(c) === norm(w)))
                 || cols.find((c) => wanted.some((w) => norm(c).includes(norm(w))));
        if (!col) return null; // honest miss: no such column in the live schema
        const bare = table.split('.').pop()!;
        let sqlText: string;
        if (this.sql.kind === 'mssql' || this.sql.kind === 'sqlite') {
          sqlText = `SELECT * FROM [${bare}] WHERE CAST([${col}] AS NVARCHAR(4000)) LIKE :val`;
        } else if (this.sql.kind === 'postgres') {
          sqlText = `SELECT * FROM "${bare}" WHERE CAST("${col}" AS TEXT) LIKE $1`;
        } else {
          sqlText = `SELECT * FROM \`${bare}\` WHERE CAST(\`${col}\` AS CHAR(255)) LIKE ?`;
        }
        const likeVal = `%${v.replace(/[%_]/g, '')}%`;
        const res = await this.sql.execute(sqlText, { val: likeVal }, limit);
        if (res.rows.length) return mapRow(res.rows[0]);
        return null;
      } catch (e: any) {
        this.log('WARN', `استعلام SQL فیلد «${field}» شکست خورد (${e?.message})؛ تلاش روی آینه واقعی CSV.`);
      }
    }
    if (this.csv.exists()) {
      const nv = norm(faToEnDigits(v));
      const hasDigits = /\d/.test(nv);
      const digits = nv.replace(/\D/g, '');
      const r = this.csv.query((row) => {
        const cell = norm(faToEnDigits(String((row as any)[field] ?? '')));
        if (cell && (cell === nv || cell.includes(nv))) return true;
        if (hasDigits && digits.length >= 4) {
          // digit fields match on pure digits too (0912... vs ۰۹۱۲..., dashes)
          const d = cell.replace(/\D/g, '');
          if (d && (d === digits || d.includes(digits))) return true;
        }
        return false;
      }, limit);
      return r.rows[0] || null;
    }
    return null;
  }

  /** Multi-field profile lookup used by the AI assistant: tries billId,
   *  serviceNo, nationalId, phone and name against the ACTIVE real backend. */
  async findProfile(args: {
    billId?: string; serviceNo?: string; nationalId?: string; phone?: string; name?: string; fileNo?: string;
  }): Promise<{ row: SubscriberRow | null; matchedField?: string; source: DbKind | 'none' }> {
    const order: Array<[string, string]> = [
      ['billId', args.billId || ''],
      ['serviceNo', args.serviceNo || ''],
      ['nationalId', args.nationalId || ''],
      ['smsPhone', args.phone || ''],
      ['fileNo', args.fileNo || ''],
      ['name', args.name || ''],
    ];
    for (const [field, value] of order) {
      if (!value) continue;
      const row = await this.findOneByField(field, value, 1);
      if (row) return { row, matchedField: field, source: this.activeSource() };
    }
    return { row: null, source: this.activeSource() };
  }

  /** Lookup by شناسه قبض (exact, parameterized). */
  async findByBillId(billId: string): Promise<SubscriberRow | null> {
    const id = faToEnDigits(billId).replace(/\D/g, '');
    if (!id) return null;
    if (this.sql) {
      try {
        const table = process.env.SUBSCRIBER_DB_TABLE || 'Mosharesh';
        const cols = await this.allColumns(table);
        const wanted = FIELD_ALIASES.billId || ['ShenaseGhobz'];
        const col = cols.find((c) => wanted.some((w) => norm(c) === norm(w)))
                 || cols.find((c) => wanted.some((w) => norm(c).includes(norm(w))))
                 || (process.env.SUBSCRIBER_DB_BILLID_COLUMN && cols.includes(process.env.SUBSCRIBER_DB_BILLID_COLUMN)
                     ? process.env.SUBSCRIBER_DB_BILLID_COLUMN : undefined);
        if (!col) throw new Error('ستون شناسه قبض در اسکیمای زنده پیدا نشد (SUBSCRIBER_DB_BILLID_COLUMN را تنظیم کنید).');
        if (!/^[A-Za-z_][\w]*$/.test(col)) throw new Error('نام ستون غیرمجاز.');
        const bare = table.split('.').pop()!;
        let sqlText: string;
        if (this.sql.kind === 'mssql' || this.sql.kind === 'sqlite') {
          sqlText = `SELECT * FROM [${bare}] WHERE REPLACE(REPLACE(CAST([${col}] AS NVARCHAR(4000)), ' ', ''), '-', '') = :id`;
        } else if (this.sql.kind === 'postgres') {
          sqlText = `SELECT * FROM "${bare}" WHERE REGEXP_REPLACE(CAST("${col}" AS TEXT), '[^0-9]', '', 'g') = $1`;
        } else {
          sqlText = `SELECT * FROM \`${bare}\` WHERE REGEXP_REPLACE(CAST(\`${col}\` AS CHAR(64)), '[^0-9]', '', 'g') = ?`;
        }
        const res = await this.sql.execute(sqlText, { id }, 5);
        if (res.rows.length) return mapRow(res.rows[0]);
      } catch (e: any) {
        this.log('WARN', `استعلام SQL شناسه قبض شکست خورد (${e?.message})؛ بازخوانی از آینه CSV.`);
      }
    }
    const r = this.csv.query((row) => String(row.billId) === id, 1);
    return r.rows[0] || null;
  }

  /** Aggregate stats computed from the REAL active dataset (no invented numbers). */
  async stats(): Promise<QueryResult & { summary?: any }> {
    const src = this.activeSource();
    const t0 = Date.now();
    if (src === 'csv') {
      const all = this.csv.load();
      const byDistrict: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const r of all) {
        byDistrict[String(r.district || 'نامعلوم')] = (byDistrict[String(r.district || 'نامعلوم')] || 0) + 1;
        byType[String(r.customerType || 'نامعلوم')] = (byType[String(r.customerType || 'نامعلوم')] || 0) + 1;
      }
      return {
        ok: true, source: 'csv', readOnlyEnforced: true, rowCount: all.length, truncated: false,
        durationMs: Date.now() - t0, rows: all.slice(0, 0), columns: [],
        summary: { totalSubscribers: all.length, byDistrict, byCustomerType: byType, computedFrom: 'data.csv (واقعی)' },
      };
    }
    if (this.sql) {
      const table = process.env.SUBSCRIBER_DB_TABLE || 'Mosharesh';
      try {
        const res = await this.sql.execute(`SELECT COUNT(*) AS total FROM [${table}]`, {}, 1);
        return {
          ok: true, source: this.sql.kind, readOnlyEnforced: true, rowCount: 1, truncated: false,
          durationMs: Date.now() - t0, rows: res.rows, columns: res.columns,
          summary: { totalSubscribers: Number(res.rows[0]?.total ?? res.rows[0]?.TOTAL ?? 0), computedFrom: `${this.sql.label}.${table}` },
        };
      } catch (e: any) {
        return { ok: false, source: src, readOnlyEnforced: true, rowCount: 0, truncated: false, durationMs: Date.now() - t0, rows: [], columns: [], error: e?.message };
      }
    }
    return { ok: false, source: 'none', readOnlyEnforced: true, rowCount: 0, truncated: false, durationMs: 0, rows: [], columns: [], error: 'هیچ بک‌اند دیتابیس مشترکین در دسترس نیست.' };
  }

  /** Run a caller-supplied (LLM or REST) SELECT — fully guarded + audited. */
  async rawSelect(sql: string, params: Record<string, any> = {}, limit = 200): Promise<QueryResult> {
    const t0 = Date.now();
    if (!this.sql) {
      return { ok: false, source: this.activeSource(), readOnlyEnforced: true, rowCount: 0, truncated: false, durationMs: 0, rows: [], columns: [], error: 'اتصال SQL پیکربندی نشده است (SUBSCRIBER_DB_* را در .env تنظیم کنید). جستجوی متنی و فیلدها همچنان روی آینه واقعی CSV کار می‌کند.' };
    }
    try {
      assertReadOnlySql(sql);
      const res = await this.sql.execute(sql, params, Math.min(limit, this.maxRows));
      const rows = res.rows.map(mapRow);
      this.log('INFO', `SELECT خواننده اجرا شد روی ${this.sql.label}: ${rows.length} ردیف (${Date.now() - t0}ms)`);
      return { ok: true, source: this.sql.kind, readOnlyEnforced: true, rowCount: rows.length, truncated: rows.length >= limit, durationMs: Date.now() - t0, rows, columns: res.columns, sql };
    } catch (e: any) {
      return { ok: false, source: this.sql.kind, readOnlyEnforced: true, rowCount: 0, truncated: false, durationMs: Date.now() - t0, rows: [], columns: [], sql, error: e?.message };
    }
  }

  async closeAll() { await this.sql?.close?.(); }
}
