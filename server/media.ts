/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * گردآفرین — موتور چندرسانه‌ای و ارائه‌گر بلادرنگ (Realtime Media & Presentation Engine)
 *
 * این ماژول پشتیبانی سمت سرور را برای فرمان‌های صوتی «پخش موسیقی / ویدئو / تصویر / سند متنی /
 * نمودار و گراف / فایل ساختاریافته (CSV, JSON, XML, Markdown, PDF...)» و همچنین «ارائه (Presentation)»
 * با کنترل کامل (پخش/توقف/پیش‌روی/عقب‌روی/پرش/سرعت/بلندی/حلقه/تغییر اسلاید) فراهم می‌کند.
 *
 * اصول طراحی:
 *  - هر منبع رسانه یک "MediaAsset" است که با شناسه پایدار در کتابخانه محلی (data/media) نگهداری می‌شود.
 *  - هر "PlaybackSession" وضعیت زنده پخش را نگه می‌دارد؛ مرورگر کلاینت هر ~۱ ثانیه telemetry
 *    (زمان فعلی، پیشرفت، حجم بافر، سرعت، بلندی) را گزارش می‌کند تا مدل زبانی بتواند در هر لحظه
 *    بگوید «الان کجای آهنگ/اسلاید هستیم» و فرمان بعدی را دقیق بدهد (درک زنده و بلادرنگ).
 *  - فایل‌های ساختاریافته روی سرور پارس می‌شوند (JSON/CSV/XML/Markdown/text/PDF-lite) تا هم
 *    خلاصه معنایی برای گفتگو تولید شود و هم رندر دقیق در کلاینت ممکن گردد.
 */

import fs from 'fs';
import path from 'path';

// ----------------------------- Types -----------------------------

export type MediaKind =
  | 'audio' | 'video' | 'image' | 'document' | 'chart' | 'table' | 'slides' | 'code' | 'html';

export interface ChartSeries { name: string; color?: string; data: number[] }
export interface ChartSpec {
  chartType: 'bar' | 'line' | 'area' | 'pie' | 'scatter';
  labels: (string | number)[];
  series: ChartSeries[];
  unit?: string;
}

export interface StructuredData {
  format: 'json' | 'csv' | 'xml' | 'markdown' | 'text' | 'pdf-text' | 'table';
  headers?: string[];
  rows?: any[][];
  recordCount?: number;
  chartSpec?: ChartSpec;
  markdownHtml?: string;
  rawPreview?: string;
  summary?: string;
}

export interface Slide {
  title: string;
  bullets?: string[];
  notes?: string;
  imageSrc?: string;
  chart?: ChartSpec;
  table?: { headers: string[]; rows: any[][] };
}

export interface PresentationDeck {
  title: string;
  subtitle?: string;
  author?: string;
  slides: Slide[];
}

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  title: string;
  sourceUrl?: string;      // external URL if proxied/streamed
  localPath?: string;      // served under /media/<file>
  mimeType?: string;
  sizeBytes?: number;
  structured?: StructuredData;
  deck?: PresentationDeck;
  codeLang?: string;
  createdAt: string;
  tags?: string[];
}

export interface PlaybackTelemetry {
  at: string;              // ISO timestamp of last client report
  currentTimeSec: number;
  durationSec: number;
  bufferedSec: number;
  volume: number;
  rate: number;
  loop: boolean;
  muted: boolean;
  paused: boolean;
  ended: boolean;
  error?: string;
  slideIndex?: number;     // for decks/charts paging
  totalSlides?: number;
}

export interface PlaybackSession {
  id: string;
  assetId: string;
  kind: MediaKind;
  title: string;
  clientId: string;
  startedAt: string;
  updatedAt: string;
  command: 'play' | 'pause' | 'seek' | 'rate' | 'volume' | 'loop' | 'next' | 'prev' | 'goto' | 'stop' | 'fullscreen' | 'shuffle';
  seekToSec?: number;
  targetSlide?: number;
  rate?: number;
  volume?: number;
  loop?: boolean;
  fullscreen?: boolean;
  state: 'playing' | 'paused' | 'stopped' | 'completed' | 'error';
  telemetry: PlaybackTelemetry;
  history: { at: string; event: string; detail?: string }[];
}

// ----------------------------- Helpers -----------------------------

const faDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
const norm = (s: string) =>
  faDigits(String(s || ''))
    .toLowerCase()
    .replace(/\u200c/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e5).toString(36)}`;
}

const EXT_KIND: Record<string, MediaKind> = {
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  pdf: 'document', docx: 'document', txt: 'document', md: 'document', rtf: 'document', odt: 'document',
  csv: 'table', tsv: 'table', xls: 'table', xlsx: 'table', json: 'document', xml: 'document', yaml: 'document', yml: 'document',
  html: 'html', htm: 'html',
};

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8', html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function guessKindFromName(name: string): MediaKind {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_KIND[ext] || 'document';
}
export function guessMimeFromName(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ----------------------------- Structured parsing -----------------------------

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseTable(text: string, maxRows = 500): { headers: string[]; rows: any[][]; delimiter: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [], delimiter: ',' };
  const first = lines[0];
  const counts: [string, number][] = [[',', (first.match(/,/g) || []).length], ['\t', (first.match(/\t/g) || []).length], [';', (first.match(/;/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  const delimiter = counts[0][1] > 0 ? counts[0][0] : ',';
  const headerCells = splitCsvLine(lines[0], delimiter);
  const looksLikeHeader = headerCells.every((c) => isNaN(Number(c.replace(/[^\d.-]/g, ''))) || c.length > 0);
  const headers = looksLikeHeader ? headerCells : headerCells.map((_, i) => `ستون ${i + 1}`);
  const bodyStart = looksLikeHeader ? 1 : 0;
  const rows = lines.slice(bodyStart, bodyStart + maxRows).map((l) => {
    const cells = splitCsvLine(l, delimiter);
    return cells.map((c) => {
      const n = Number(c.replace(/[,٬ ]/g, ''));
      return isFinite(n) && c !== '' ? n : c;
    });
  });
  return { headers, rows, delimiter };
}

/** Auto-detect a numeric column and build a chart spec from a parsed table. */
export function autoChartFromTable(headers: string[], rows: any[][]): ChartSpec | undefined {
  if (!rows.length) return undefined;
  const numCols: number[] = [];
  for (let c = 0; c < headers.length; c++) {
    const vals = rows.map((r) => r[c]).filter((v) => typeof v === 'number');
    if (vals.length >= Math.max(2, rows.length * 0.5)) numCols.push(c);
  }
  if (!numCols.length) return undefined;
  const labelCol = numCols.length > 1 ? -1 : 0; // if only one numeric col, use first text col as labels
  const seriesCols = numCols.length > 1 ? numCols : numCols;
  let labels: (string | number)[];
  if (labelCol === -1 && headers.length > numCols.length) {
    const textCol = headers.findIndex((_, i) => !numCols.includes(i));
    labels = rows.map((r) => String(r[textCol] ?? ''));
  } else if (headers.length > numCols.length) {
    const textCol = headers.findIndex((_, i) => !numCols.includes(i));
    labels = textCol >= 0 ? rows.map((r) => String(r[textCol] ?? '')) : rows.map((_, i) => i + 1);
  } else {
    labels = rows.map((_, i) => i + 1);
  }
  const palette = ['#00e5ff', '#7c5cff', '#4ade80', '#fbbf24', '#fb7185'];
  const series = seriesCols.map((ci, idx) => ({
    name: headers[ci] || `سری ${idx + 1}`,
    color: palette[idx % palette.length],
    data: rows.map((r) => (typeof r[ci] === 'number' ? r[ci] : Number(r[ci]) || 0)),
  }));
  return { chartType: 'bar', labels, series };
}

/** Very small PDF text extractor (best-effort, no deps): pulls uncompressed + FlateDecode-less text ops. */
export function extractPdfTextLite(buf: Buffer, maxChars = 20000): string {
  try {
    const raw = buf.toString('latin1');
    const chunks: string[] = [];
    // Match text-showing operators: (string) Tj or [(s1)(s2)] TJ within BT..ET blocks
    const blockRe = /BT([\s\S]*?)ET/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(raw)) && chunks.join('').length < maxChars) {
      const inner = m[1];
      const strRe = /\((?:\\.|[^\\()])*\)/g;
      let s: RegExpExecArray | null;
      while ((s = strRe.exec(inner))) {
        let txt = s[0].slice(1, -1)
          .replace(/\\(\d{1,3})/g, (_all, oct) => String.fromCharCode(parseInt(oct, 8)))
          .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t')
          .replace(/\\([()\\])/g, '$1');
        chunks.push(txt);
      }
      chunks.push('\n');
    }
    return chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  } catch {
    return '';
  }
}

/** Minimal markdown → HTML (safe subset: headings, bold/italic/code, lists, links, tables, hr). */
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%"/>');
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false, inCode = false, inTable = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table></div>'); inTable = false; } };
  for (const lnRaw of lines) {
    const ln = lnRaw.replace(/\s+$/, '');
    if (/^```/.test(ln)) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { closeList(); closeTable(); out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(lnRaw)); continue; }
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      const cells = ln.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (/^[\s|:-]+$/.test(ln)) continue; // separator row
      if (!inTable) {
        closeList();
        out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
      } else {
        out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }
    closeTable();
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(ln)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(ln.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    if (/^\s*(---|___|\*\*\*)\s*$/.test(ln)) { out.push('<hr/>'); continue; }
    if (ln.trim() === '') { out.push('<br/>'); continue; }
    out.push(`<p>${inline(ln)}</p>`);
  }
  closeList(); closeTable();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

/** Tiny XML parser into objects (attributes + text + nesting), for structured rendering. */
export function parseXmlLite(xml: string): any {
  const tokens = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').match(/<\/?[a-zA-Z_][^>]*>|[^<]+/g) || [];
  const root: any = { name: '#root', children: [], attrs: {} };
  const stack: any[] = [root];
  for (const tk of tokens) {
    if (tk.startsWith('<')) {
      const closing = tk.startsWith('</');
      const selfClose = tk.endsWith('/>');
      const nameMatch = tk.match(/^<\/?\s*([a-zA-Z_:][\w:.-]*)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === name) { stack.length = i; break; }
        }
      } else {
        const attrs: Record<string, string> = {};
        const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(tk))) attrs[am[1] || am[3]] = am[2] ?? am[4];
        const node = { name, attrs, children: [] as any[], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) stack.push(node);
      }
    } else {
      const t = tk.trim();
      if (t) stack[stack.length - 1].text = (stack[stack.length - 1].text + ' ' + t).trim();
    }
  }
  return root.children[0] || null;
}

export function summarizeStructured(s: StructuredData, title: string): string {
  if (s.format === 'csv' || s.format === 'table') {
    return `جدول «${title}» با ${s.headers?.length || 0} ستون (${(s.headers || []).join('، ')}) و ${s.recordCount} رکورد. ${s.chartSpec ? 'نمودار خودکار از ستون‌های عددی قابل نمایش است.' : ''}`;
  }
  if (s.format === 'json') return `ساختار JSON «${title}» با ${s.recordCount} رکورد/کلید.`;
  if (s.format === 'xml') return `سند XML «${title}» با ریشه ${s.summary || ''}.`;
  if (s.format === 'markdown') return `سند Markdown «${title}»؛ بخش‌ها: ${s.summary}`;
  if (s.format === 'pdf-text') return `متن استخراج‌شده PDF «${title}»: ${(s.rawPreview || '').slice(0, 300)}`;
  return `سند متنی «${title}»: ${(s.rawPreview || '').slice(0, 300)}`;
}

/** Parse raw bytes of a structured file into a renderable StructuredData. */
export function parseStructured(kindHint: MediaKind, name: string, mime: string, buf: Buffer): StructuredData | undefined {
  const ext = path.extname(name).slice(1).toLowerCase();
  try {
    if (ext === 'json' || mime.includes('json')) {
      const obj = JSON.parse(buf.toString('utf-8'));
      let headers: string[] | undefined, rows: any[][] | undefined, count = 0;
      const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.data) ? obj.data : Array.isArray(obj?.rows) ? obj.rows : null;
      if (arr && arr.length && typeof arr[0] === 'object' && arr[0] !== null) {
        const keys = new Set<string>();
        for (const it of arr.slice(0, 200)) Object.keys(it).forEach((k) => keys.add(k));
        headers = [...keys];
        rows = arr.slice(0, 500).map((it: any) => headers!.map((h) => (typeof it[h] === 'object' ? JSON.stringify(it[h]) : it[h])));
        count = arr.length;
        const chart = autoChartFromTable(headers, rows);
        return { format: 'json', headers, rows, recordCount: count, chartSpec: chart, summary: chart ? 'آرایه شیء با قابلیت نمودار' : 'آرایه شیء' };
      }
      const flat = Object.entries(obj).map(([k, v]) => ({ [k]: v }));
      return { format: 'json', recordCount: Object.keys(obj).length, rawPreview: JSON.stringify(obj, null, 2).slice(0, 4000), headers: ['کلید', 'مقدار'], rows: flat.slice(0, 200).map((e) => Object.entries(e)[0] as any), summary: 'شیء ساده' };
    }
    if (ext === 'csv' || ext === 'tsv' || mime.includes('csv') || mime.includes('tab-separated')) {
      const { headers, rows } = parseTable(buf.toString('utf-8'));
      const chart = autoChartFromTable(headers, rows);
      return { format: 'csv', headers, rows, recordCount: rows.length, chartSpec: chart, summary: chart ? 'جدول عددی — نمودار خودکار ساخته شد' : 'جدول متنی' };
    }
    if (ext === 'xml' || mime.includes('xml')) {
      const tree = parseXmlLite(buf.toString('utf-8'));
      const flatten = (node: any, prefix = ''): any[][] => {
        const rowsOut: any[][] = [];
        if (!node) return rowsOut;
        rowsOut.push([prefix + node.name, Object.entries(node.attrs || {}).map(([k, v]) => `${k}=${v}`).join(' '), (node.text || '').slice(0, 120)]);
        for (const ch of node.children || []) rowsOut.push(...flatten(ch, prefix + '  '));
        return rowsOut;
      };
      return { format: 'xml', headers: ['برگه (Element)', 'ویژگی‌ها (Attributes)', 'محتوا'], rows: flatten(tree).slice(0, 300), recordCount: flatten(tree).length, summary: tree?.name || '', rawPreview: buf.toString('utf-8').slice(0, 3000) };
    }
    if (ext === 'md' || mime.includes('markdown')) {
      const md = buf.toString('utf-8');
      const heads = (md.match(/^#{1,6}\s+.*/gm) || []).slice(0, 30).map((h) => h.replace(/^#+\s*/, ''));
      return { format: 'markdown', markdownHtml: markdownToHtml(md), recordCount: heads.length, summary: heads.join('، ') || 'بدون سرفصل', rawPreview: md.slice(0, 3000) };
    }
    if (ext === 'pdf' || mime === 'application/pdf') {
      const text = extractPdfTextLite(buf);
      return { format: 'pdf-text', rawPreview: text || '(متن قابل استخراج نبود — فایل به‌صورت اصلی در viewer نمایش داده می‌شود)', recordCount: (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, summary: text ? `حدود ${text.length} کاراکتر متن` : 'PDF بدون لایه متن' };
    }
    if (ext === 'yaml' || ext === 'yml') {
      const txt = buf.toString('utf-8');
      const rowsY = txt.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).slice(0, 300).map((l) => {
        const kv = l.match(/^\s*-?\s*([\w.\u0600-\u06FF_-]+)\s*:\s*(.*)$/);
        return kv ? [kv[1], kv[2]] : [l.trim(), ''];
      });
      return { format: 'text', headers: ['کلید', 'مقدار'], rows: rowsY, recordCount: rowsY.length, rawPreview: txt.slice(0, 3000), summary: 'فایل YAML' };
    }
    // generic text
    const txt = buf.toString('utf-8');
    if (!/\x00/.test(txt.slice(0, 1024))) {
      return { format: 'text', rawPreview: txt.slice(0, 20000), recordCount: txt.split(/\r?\n/).length, summary: `${txt.length} کاراکتر` };
    }
  } catch {
    /* fall through: not parseable */
  }
  return undefined;
}

// ----------------------------- Library + Sessions -----------------------------

export class MediaLibrary {
  private assets = new Map<string, MediaAsset>();
  private byName = new Map<string, string[]>();
  dir: string;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'data', 'media');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    this.loadPersisted();
  }

  private get indexFile() { return path.join(this.dir, 'library.json'); }

  private loadPersisted() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const list: MediaAsset[] = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
        for (const a of list) {
          this.assets.set(a.id, a);
          this.indexName(a);
        }
      }
    } catch {}
  }

  private persist() {
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify([...this.assets.values()], null, 2));
    } catch {}
  }

  private indexName(a: MediaAsset) {
    const key = norm(a.title);
    const arr = this.byName.get(key) || [];
    if (!arr.includes(a.id)) arr.push(a.id);
    this.byName.set(key, arr);
    if (a.sourceUrl) {
      const k2 = norm(a.sourceUrl);
      const arr2 = this.byName.get(k2) || [];
      if (!arr2.includes(a.id)) arr2.push(a.id);
      this.byName.set(k2, arr2);
    }
  }

  /** Register (or reuse) an external URL asset. */
  registerUrl(opts: { url: string; kind?: MediaKind; title?: string; tags?: string[] }): MediaAsset {
    const existing = this.findByUrl(opts.url);
    if (existing) return existing;
    const kind = opts.kind || guessKindFromName(opts.url);
    const asset: MediaAsset = {
      id: uid('md'),
      kind,
      title: opts.title || path.basename(opts.url.split('?')[0]) || 'رسانه',
      sourceUrl: opts.url,
      mimeType: guessMimeFromName(opts.url),
      createdAt: new Date().toISOString(),
      tags: opts.tags || [],
    };
    this.assets.set(asset.id, asset);
    this.indexName(asset);
    this.persist();
    return asset;
  }

  /** Store uploaded bytes locally under /media/. Parses structured formats. */
  storeBuffer(opts: { filename: string; buffer: Buffer; title?: string; tags?: string[] }): MediaAsset {
    const safeBase = (opts.filename || 'file').replace(/[^\w\u0600-\u06FF.\- ]+/g, '_').slice(-90) || 'file';
    const fname = `${Date.now().toString(36)}_${safeBase}`;
    const fpath = path.join(this.dir, fname);
    fs.writeFileSync(fpath, opts.buffer);
    const kind = guessKindFromName(safeBase);
    const mime = guessMimeFromName(safeBase);
    const structured = (['document', 'table', 'html'].includes(kind) || /\.(json|csv|tsv|xml|md|pdf|ya?ml|txt)$/i.test(safeBase))
      ? parseStructured(kind, safeBase, mime, opts.buffer)
      : undefined;
    const asset: MediaAsset = {
      id: uid('md'),
      kind,
      title: opts.title || safeBase.replace(/\.[^.]+$/, ''),
      localPath: `/media/${fname}`,
      mimeType: mime,
      sizeBytes: opts.buffer.length,
      structured,
      createdAt: new Date().toISOString(),
      tags: opts.tags || [],
    };
    this.assets.set(asset.id, asset);
    this.indexName(asset);
    this.persist();
    return asset;
  }

  /** Register a generated presentation deck (slides). */
  registerDeck(deck: PresentationDeck): MediaAsset {
    const asset: MediaAsset = {
      id: uid('deck'),
      kind: 'slides',
      title: deck.title,
      deck,
      createdAt: new Date().toISOString(),
      tags: ['presentation', 'ارائه'],
    };
    this.assets.set(asset.id, asset);
    this.indexName(asset);
    this.persist();
    return asset;
  }

  /** Register a generated chart (from model-provided data). */
  registerChart(title: string, spec: ChartSpec): MediaAsset {
    const asset: MediaAsset = {
      id: uid('chart'),
      kind: 'chart',
      title,
      structured: { format: 'table', chartSpec: spec, recordCount: spec.labels.length },
      createdAt: new Date().toISOString(),
      tags: ['chart', 'نمودار'],
    };
    this.assets.set(asset.id, asset);
    this.indexName(asset);
    this.persist();
    return asset;
  }

  /** Register a code snippet widget. */
  registerCode(title: string, code: string, lang: string): MediaAsset {
    const asset: MediaAsset = {
      id: uid('code'),
      kind: 'code',
      title,
      structured: { format: 'text', rawPreview: code, recordCount: code.split('\n').length },
      codeLang: lang || 'plaintext',
      createdAt: new Date().toISOString(),
      tags: ['code'],
    };
    this.assets.set(asset.id, asset);
    this.indexName(asset);
    this.persist();
    return asset;
  }

  get(id: string) { return this.assets.get(id); }
  all(): MediaAsset[] { return [...this.assets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  findByUrl(url: string) { const ids = this.byName.get(norm(url)); return ids?.length ? this.assets.get(ids[0]) : undefined; }

  search(query: string, kind?: MediaKind): MediaAsset[] {
    const q = norm(query);
    const pool = kind ? this.all().filter((a) => a.kind === kind) : this.all();
    if (!q) return pool;
    const exact = this.byName.get(q) || [];
    const scored = pool.map((a) => {
      const t = norm(a.title);
      let score = 0;
      if (exact.includes(a.id)) score += 100;
      if (t === q) score += 50;
      else if (t.includes(q) || q.includes(t)) score += 20;
      for (const w of q.split(' ').filter((x) => x.length > 2)) if (t.includes(w)) score += 5;
      if ((a.tags || []).some((tag) => norm(tag).includes(q))) score += 8;
      return { a, score };
    });
    return scored.filter((s) => s.score > 0).sort((x, y) => y.score - x.score).map((s) => s.a);
  }
}

export class PlaybackManager {
  sessions = new Map<string, PlaybackSession>();
  byClient = new Map<string, string>(); // clientId -> sessionId
  private listeners = new Set<(s: PlaybackSession, ev: string) => void>();

  onChange(fn: (s: PlaybackSession, ev: string) => void) { this.listeners.add(fn); }
  private emit(s: PlaybackSession, ev: string) {
    for (const fn of this.listeners) { try { fn(s, ev); } catch {} }
  }

  startOrReuse(clientId: string, asset: MediaAsset, cmd: Partial<PlaybackSession>): PlaybackSession {
    const prevId = this.byClient.get(clientId);
    const prev = prevId ? this.sessions.get(prevId) : undefined;
    const now = new Date().toISOString();
    const fresh: PlaybackSession = {
      id: prev?.id || uid('pb'),
      assetId: asset.id,
      kind: asset.kind,
      title: asset.title,
      clientId,
      startedAt: prev && prev.assetId === asset.id ? prev.startedAt : now,
      updatedAt: now,
      command: (cmd.command as any) || 'play',
      seekToSec: cmd.seekToSec,
      targetSlide: cmd.targetSlide,
      rate: cmd.rate ?? 1,
      volume: cmd.volume ?? 1,
      loop: cmd.loop ?? false,
      fullscreen: cmd.fullscreen ?? false,
      state: cmd.command === 'pause' ? 'paused' : 'playing',
      telemetry: prev?.telemetry || {
        at: now, currentTimeSec: 0, durationSec: 0, bufferedSec: 0,
        volume: 1, rate: 1, loop: false, muted: false, paused: false, ended: false,
      },
      history: prev?.history?.slice(-30) || [],
    };
    fresh.history.push({ at: now, event: cmd.command || 'play', detail: asset.title });
    this.sessions.set(fresh.id, fresh);
    this.byClient.set(clientId, fresh.id);
    this.emit(fresh, 'command');
    return fresh;
  }

  applyCommand(sessionId: string, patch: Partial<PlaybackSession> & { command: PlaybackSession['command'] }): PlaybackSession | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const now = new Date().toISOString();
    Object.assign(s, patch, { updatedAt: now });
    if (patch.command === 'stop') s.state = 'stopped';
    else if (patch.command === 'pause') s.state = 'paused';
    else s.state = 'playing';
    s.history.push({ at: now, event: patch.command, detail: patch.seekToSec != null ? `${patch.seekToSec}s` : (patch.targetSlide != null ? `اسلاید ${patch.targetSlide}` : undefined) });
    if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
    this.emit(s, 'command');
    return s;
  }

  ingestTelemetry(clientId: string, t: Partial<PlaybackTelemetry>): PlaybackSession | null {
    const sid = this.byClient.get(clientId);
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    s.telemetry = { ...s.telemetry, ...t, at: new Date().toISOString() } as PlaybackTelemetry;
    s.updatedAt = s.telemetry.at;
    if (t.ended) s.state = 'completed';
    if (t.error) s.state = 'error';
    else if (!t.paused && s.state !== 'stopped') s.state = 'playing';
    else if (t.paused && s.state === 'playing') s.state = 'paused';
    this.emit(s, 'telemetry');
    return s;
  }

  currentFor(clientId: string): PlaybackSession | null {
    const sid = this.byClient.get(clientId);
    return sid ? this.sessions.get(sid) || null : null;
  }

  stop(clientId: string): PlaybackSession | null {
    const s = this.currentFor(clientId);
    if (!s) return null;
    return this.applyCommand(s.id, { command: 'stop' });
  }

  /** Human-readable realtime status (fed back to the LLM so it truly "knows" what's on screen). */
  describe(s: PlaybackSession, asset?: MediaAsset): string {
    const t = s.telemetry;
    const fmt = (sec: number) => {
      sec = Math.max(0, Math.round(sec || 0));
      const m = Math.floor(sec / 60), ss = sec % 60;
      return `${m}:${String(ss).padStart(2, '0')}`;
    };
    const parts: string[] = [`«${s.title}» (${s.kind})`];
    if (s.kind === 'audio' || s.kind === 'video') {
      parts.push(`وضعیت: ${s.state === 'playing' ? 'در حال پخش' : s.state}`);
      parts.push(`زمان: ${fmt(t.currentTimeSec)} از ${fmt(t.durationSec)}`);
      if (t.durationSec > 0) parts.push(`پیشرفت: ${Math.round((t.currentTimeSec / t.durationSec) * 100)}٪`);
      parts.push(`بلندی: ${Math.round((t.muted ? 0 : t.volume) * 100)}٪${t.muted ? ' (بی‌صدا)' : ''}، سرعت: ${t.rate}x${t.loop ? '، تکرار فعال' : ''}`);
      if (t.bufferedSec > 0) parts.push(`بافر: ${fmt(t.bufferedSec)}`);
    } else if (s.kind === 'slides') {
      const total = asset?.deck?.slides.length || t.totalSlides || 0;
      parts.push(`اسلاید ${(t.slideIndex ?? 0) + 1} از ${total}: ${asset?.deck?.slides[t.slideIndex ?? 0]?.title || ''}`);
    } else {
      parts.push(`وضعیت: ${s.state === 'playing' ? 'در حال نمایش' : s.state}`);
    }
    if (t.error) parts.push(`خطا: ${t.error}`);
    parts.push(`آخرین به‌روزرسانی زنده: ${t.at}`);
    return parts.join(' | ');
  }
}
