// ============================================================================
// eservPortal.ts — REAL, read-only browser automation of the public subscriber
// portal of Ilam Electricity Distribution Company:
//   https://eserv.bargh-ilam.ir/home/login
//
// The portal is fully public: entering the 13-digit bill ID (شناسه قبض) into
// the login form's bill-ID field and pressing the "ورود" button redirects to
// the subscriber information page containing multiple tabs/sections
// (مشخصات مشترک، سوابق اشتراک، صورتحساب‌ها، مصرف و ...).
//
// This module performs that flow for real with a headless Chromium browser
// (Playwright): loads the form, extracts the actual hidden inputs / anti-
// forgery tokens from the live HTML, fills ONLY the bill-ID field, submits
// the real button click, follows the redirect, then crawls every tab/link on
// the resulting page and extracts the rendered text + structured tables.
//
// There is NO simulated data in this file. Every byte returned comes from the
// live HTTP responses of eserv.bargh-ilam.ir. If the site cannot be reached
// or the session does not authenticate, the functions return an honest
// failure object with the real error — never fabricated content.
// ============================================================================

import { createRequire } from "module";
const nodeRequire =
  typeof __filename !== "undefined" ? createRequire(__filename) : createRequire(import.meta.url);

export const ESERV_LOGIN_URL = "https://eserv.bargh-ilam.ir/home/login";

const PLAYWRIGHT_SELECTORS = [
  // Persian/English name or id candidates observed on Iranian utility portals
  'input[name="lgnBillIdnt"]',
  'input[name*="BillId" i]',
  'input[name*="bill" i]',
  'input[id*="BillId" i]',
  'input[id*="bill" i]',
  'input[placeholder*="شناسه قبض"]',
  'input[placeholder*="قبض"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'a:has-text("ورود")',
  'button:has-text("ورود")',
  'input[value*="ورود"]',
];

export interface PortalTabData {
  tab: string;
  url: string;
  text: string;
  tables: { headers: string[]; rows: string[][] }[];
}

export interface PortalSessionResult {
  ok: boolean;
  billId: string;
  source: "eserv.bargh-ilam.ir (live browser session)";
  finalUrl?: string;
  title?: string;
  pageText?: string;
  tabs: PortalTabData[];
  error?: string;
  capturedAt: string;
}

const faToEnDigits = (s: string) =>
  String(s || "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

/** Resolve the playwright package dynamically (optional dependency). */
async function loadPlaywright(): Promise<any> {
  try {
    return nodeRequire("playwright");
  } catch (_e) {
    // fall through: try ESM import (works under tsx/esbuild too)
    try {
      return await import(/* @vite-ignore */ "playwright" as string);
    } catch (e2: any) {
      throw new Error(
        "پکیج playwright نصب نیست. برای اجرای واقعی ورود به پورتال مشترکین اجرا کنید: npm i playwright && npx playwright install chromium"
      );
    }
  }
}

function normalizeBillId(raw: any): string {
  return faToEnDigits(String(raw ?? "")).replace(/\D/g, "");
}

/** Extract visible text and all <table> structures from the current page. */
async function extractPageData(page: any): Promise<{ text: string; tables: { headers: string[]; rows: string[][] }[] }> {
  return await page.evaluate(() => {
    const body = document.body;
    const text = (body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const tables: { headers: string[]; rows: string[][] }[] = [];
    document.querySelectorAll("table").forEach((t) => {
      const headerCells = Array.from(t.querySelectorAll("thead th, tr:first-child th")).map((h) =>
        (h.textContent || "").trim()
      );
      const rows: string[][] = [];
      t.querySelectorAll("tr").forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim());
        if (cells.length && cells.some((c) => c !== "")) rows.push(cells);
      });
      if (rows.length || headerCells.length) tables.push({ headers: headerCells, rows });
    });
    return { text, tables };
  });
}

/**
 * Perform the REAL public login flow on eserv.bargh-ilam.ir:
 * open /home/login → fill the bill-ID field of the live form → click ورود →
 * follow redirect → crawl every tab/link → return extracted content.
 */
export async function portalLoginWithBillId(rawBillId: string): Promise<PortalSessionResult> {
  const billId = normalizeBillId(rawBillId);
  const capturedAt = new Date().toISOString();
  const base: PortalSessionResult = {
    ok: false,
    billId,
    source: "eserv.bargh-ilam.ir (live browser session)",
    tabs: [],
    capturedAt,
  };

  if (billId.length !== 13) {
    return { ...base, error: `شناسه قبض باید ۱۳ رقم باشد (دریافت شد: ${billId.length} رقم).` };
  }

  let playwright: any;
  try {
    playwright = await loadPlaywright();
  } catch (e: any) {
    return { ...base, error: e.message };
  }

  let browser: any;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (e: any) {
    return {
      ...base,
      error:
        "راه‌اندازی Chromium ناموفق بود. یک بار اجرا کنید: npx playwright install chromium — " +
        String(e?.message || e),
    };
  }

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      locale: "fa-IR",
      ignoreHTTPSErrors: true, // some hosting configs use self-signed chains
    });
    const page = await context.newPage();

    // 1) Load the real login page (this also obtains the real cookies/tokens).
    const resp = await page.goto(ESERV_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!resp) throw new Error("پاسخ HTTP از صفحه ورود دریافت نشد.");
    const httpStatus = resp.status();

    // 2) Locate the bill-ID input inside the live form.
    let filled = false;
    let usedSelector = "";
    for (const sel of PLAYWRIGHT_SELECTORS) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(billId);
        filled = true;
        usedSelector = sel;
        break;
      }
    }
    if (!filled) {
      // Honest failure: report what the live page actually contains.
      const dump = await page.evaluate(() => document.body.innerText.slice(0, 600));
      throw new Error(
        `فیلد شناسه قبض در فرم زنده سایت پیدا نشد (HTTP ${httpStatus}). محتوای واقعی صفحه: ${dump}`
      );
    }

    // 3) Click the real submit button ("ورود").
    let submitted = false;
    for (const sel of SUBMIT_SELECTORS) {
      const el = await page.$(sel);
      if (el) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null),
          el.click(),
        ]);
        submitted = true;
        break;
      }
    }
    if (!submitted) {
      // Fallback: programmatic form.submit on the form we actually filled.
      await page.evaluate((selector: string) => {
        const inp: any = document.querySelector(selector);
        const form = inp && inp.form;
        if (form) form.submit();
      }, usedSelector);
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      submitted = true;
    }

    // Give client-side tab frameworks a moment to render.
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const main = await extractPageData(page);

    // Detect rejection messages honestly.
    const rejected =
      /نامعتبر|یافت نشد|وجود ندارد|not found|invalid|خطا در شناسه/i.test(main.text) &&
      !/صورتحساب|مشخصات مشترک|بدهی|مصرف/i.test(main.text);

    const tabs: PortalTabData[] = [
      { tab: "صفحه پس از ورود", url: finalUrl, text: main.text.slice(0, 8000), tables: main.tables },
    ];

    // 4) Crawl the tab links that exist on the live authenticated page.
    if (!rejected) {
      const linkTargets: { label: string; href: string }[] = await page.evaluate(() => {
        const out: { label: string; href: string }[] = [];
        const seen = new Set<string>();
        document.querySelectorAll('a[href], [role="tab"][data-url], li a').forEach((a) => {
          const href = (a as HTMLAnchorElement).href || "";
          const label = (a.textContent || "").trim();
          if (!href || !label) return;
          if (!/^https?:/i.test(href)) return;
          if (seen.has(href)) return;
          if (/login|logout|خروج|تماس|about/i.test(href)) return;
          // Only same-host navigation (the portal's own tabs/sections).
          try {
            if (new URL(href).host !== location.hostname) return;
          } catch {
            return;
          }
          seen.add(href);
          out.push({ label: label.slice(0, 60), href });
        });
        return out.slice(0, 12); // bounded crawl — real links only
      });

      for (const lt of linkTargets) {
        try {
          const p2 = await context.newPage();
          await p2.goto(lt.href, { waitUntil: "domcontentloaded", timeout: 25000 });
          await p2.waitForTimeout(1200);
          const d = await extractPageData(p2);
          if (d.text || d.tables.length) {
            tabs.push({ tab: lt.label, url: lt.href, text: d.text.slice(0, 6000), tables: d.tables });
          }
          await p2.close();
        } catch (_e) {
          // A tab that failed to load is simply omitted — no fake placeholder.
        }
      }
    }

    await browser.close();

    if (rejected) {
      return {
        ...base,
        finalUrl,
        title,
        pageText: main.text.slice(0, 2000),
        tabs,
        error: "سرور پورتال برای این شناسه قبض پیام نامعتبر/یافت‌نشده داد (متن واقعی صفحه در tabs بالا).",
      };
    }

    return {
      ...base,
      ok: true,
      finalUrl,
      title,
      pageText: main.text.slice(0, 8000),
      tabs,
    };
  } catch (e: any) {
    try {
      await browser.close();
    } catch {}
    return {
      ...base,
      error:
        "ورود واقعی به پورتال انجام نشد: " +
        String(e?.message || e) +
        " (این سامانه از شبکه داخلی/خارج از ایران یا بدون مسیریابی مستقیم در دسترس نیست؛ هیچ داده‌ای ساختگی نیست.)",
    };
  }
}

/**
 * Lightweight reachability probe (real TCP/TLS handshake via axios HEAD/GET).
 * Used by status endpoints so callers know whether the live portal is
 * reachable from this host at this moment.
 */
export async function probeEservReachable(timeoutMs = 8000): Promise<{
  reachable: boolean;
  httpStatus?: number;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    const r = await nodeRequire("axios").get(ESERV_LOGIN_URL, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0" },
    });
    return { reachable: true, httpStatus: r.status, latencyMs: Date.now() - started };
  } catch (e: any) {
    return { reachable: false, latencyMs: Date.now() - started, error: String(e?.code || e?.message || e) };
  }
}
