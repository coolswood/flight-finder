// Standalone diagnostic runner for flight-finder issue #297.
// Drives the app's REAL scraper modules (v0.15.0, identical to the image source)
// inside the production container, with Playwright tracing around each property
// capture. Mirrors captureHotelSource()/searchHotelSource() from
// apps/web/src/lib/hotels/providers.ts without booking-specific code.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launchBrowser, createStealthContext, buildBrowserArgs } from '/app/apps/web/src/lib/scraper/browser.ts';
import { COUNTRY_PROFILES } from '/app/apps/web/src/lib/scraper/country-profiles.ts';
import { googleSearchUrl, selectGoogleTotal } from '/app/apps/web/src/lib/hotels/google.ts';
import { navigateHotelPage } from '/app/apps/web/src/lib/hotels/navigation.ts';
import { captureHotelLinks } from '/app/apps/web/src/lib/hotels/link-capture.ts';
import { DEFAULT_HOTEL_FILTERS } from '/app/apps/web/src/lib/hotels/types.ts';

const appRequire = createRequire('/app/apps/web/src/lib/scraper/browser.ts');
const PLAYWRIGHT_VERSION = appRequire('playwright/package.json').version;

const OUT = process.env.TRACE_OUT ?? '/tmp/ff-traces';
const PROPERTY_LIMIT = Number(process.env.PROPERTY_LIMIT ?? '8');
const RUN_LABEL = process.env.RUN_LABEL ?? 'run';
mkdirSync(OUT, { recursive: true });

const search = {
  destination: 'Tbilisi',
  dateMode: 'fixed',
  checkIn: '2026-11-24',
  checkOut: '2026-11-27',
  flexibility: 0,
  minNights: 3,
  maxNights: 3,
  rooms: [{ adults: 2, children: [] }],
  currency: 'EUR',
  sources: ['google_hotels'],
  filters: { ...DEFAULT_HOTEL_FILTERS },
};
const stay = { checkIn: search.checkIn, checkOut: search.checkOut };
const report = {
  runLabel: RUN_LABEL,
  startedAt: new Date().toISOString(),
  env: {
    BROWSER_SINGLE_PROCESS: process.env.BROWSER_SINGLE_PROCESS ?? '(unset)',
    CHROME_PATH: process.env.CHROME_PATH ?? '(unset)',
    launchArgs: buildBrowserArgs(),
  },
  versions: {
    node: process.version,
    playwright: PLAYWRIGHT_VERSION,
  },
  search,
  phases: [],
};

const CAPTCHA_RE = /verify (?:that )?you(?:'re| are) human|unusual traffic|captcha|access denied/i;

async function pageEnvironment(page) {
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    viewport: [window.innerWidth, window.innerHeight],
    screen: [window.screen.width, window.screen.height],
    devicePixelRatio: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
    languages: navigator.languages,
    geolocationPermission: 'requested via context permissions',
  })).catch(error => ({ evaluateError: String(error) }));
}

async function postMortem(page) {
  return page.evaluate(() => {
    const triggers = [...document.querySelectorAll('button')]
      .filter(button => /^(Price displayed|Price, Not selected)/.test(button.getAttribute('aria-label') ?? ''))
      .map(button => ({
        ariaLabel: button.getAttribute('aria-label'),
        visible: button.checkVisibility?.() ?? null,
        expanded: button.getAttribute('aria-expanded'),
        rect: button.getBoundingClientRect().toJSON(),
      }));
    const stayTotal = [...document.querySelectorAll('body *')]
      .find(element => element.childElementCount === 0 && element.textContent?.trim() === 'Stay total');
    const overlays = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]')]
      .map(element => ({
        role: element.getAttribute('role'),
        visible: element.checkVisibility?.() ?? null,
        text: (element.textContent ?? '').slice(0, 100),
      }));
    return {
      triggers,
      stayTotalInDom: Boolean(stayTotal),
      stayTotalVisible: stayTotal ? (stayTotal.checkVisibility?.() ?? null) : null,
      stayTotalRect: stayTotal ? stayTotal.getBoundingClientRect().toJSON() : null,
      overlays,
      scrollY: window.scrollY,
      bodyChildren: document.body?.children.length ?? 0,
    };
  }).catch(error => ({ postMortemError: String(error) }));
}

// ---------- Phase A: search-results page, discover "View prices" links ----------
const discovery = { phase: 'discovery', startedAt: new Date().toISOString(), searchPageBasis: null, error: null, captcha: false, links: 0, candidates: [] };
{
  const browser = await launchBrowser();
  report.versions.chromium = browser.version();
  try {
    const context = await createStealthContext(browser, { countryProfile: COUNTRY_PROFILES.GB });
    const page = await context.newPage();
    await navigateHotelPage(page, googleSearchUrl(search, stay), 'google_hotels');
    try {
      discovery.searchPageBasis = await selectGoogleTotal(page);
    } catch (error) {
      discovery.error = String(error?.message ?? error);
      discovery.postMortem = await postMortem(page);
    }
    // captureHotelSource waits 1500ms before harvesting links; retry the whole
    // capture when Google renders progressively and no property links appear,
    // the way an operator would simply rerun the search.
    for (let round = 0; round < 4 && !discovery.candidates.length; round += 1) {
      await page.waitForTimeout(1500);
      if (round) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).then(() => page.waitForTimeout(5000)).catch(() => {});
      discovery.captcha = CAPTCHA_RE.test(await page.locator('body').innerText().catch(() => ''));
      discovery.finalUrl = page.url();
      const links = await captureHotelLinks(page, 'google_hotels');
      const candidates = links.filter(link => {
        try {
          const url = new URL(link.url);
          return url.hostname === 'www.google.com' && link.text.trim() === 'View prices' && url.pathname.startsWith('/travel/');
        } catch { return false; }
      });
      const seen = new Set();
      discovery.candidates = candidates.filter(link => {
        const url = new URL(link.url);
        const key = url.searchParams.get('qs') ?? url.pathname;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, PROPERTY_LIMIT).map(link => link.url);
      discovery.links = candidates.length;
      if (process.env.DUMP_LINKS === '1') {
        const all = await captureHotelLinks(page, 'google_hotels');
        discovery.allLinks = all.slice(0, 60).map(link => `${link.text.trim().slice(0, 40).replace(/\s+/g, ' ')} | ${new URL(link.url).pathname.slice(0, 60)}`);
        discovery.title = await page.title().catch(() => null);
      }
      console.error(`[discovery round ${round}] links=${discovery.links} candidates=${discovery.candidates.length}`);
    }
  } catch (error) {
    discovery.error = String(error?.message ?? error);
  } finally {
    await browser.close().catch(() => {});
  }
  report.phases.push(discovery);
  console.error(`[discovery] links=${discovery.links} candidates=${discovery.candidates.length} basis=${JSON.stringify(discovery.searchPageBasis)} captcha=${discovery.captcha} error=${discovery.error ?? 'none'}`);
}

// ---------- Phase B: one traced capture per property (as captureHotelSource does) ----------
let failures = 0;
for (const [index, propertyUrl] of discovery.candidates.entries()) {
  const attempt = {
    phase: 'property', index, propertyUrl,
    startedAt: new Date().toISOString(),
    requestedUrl: null, finalUrl: null, basis: null, error: null, captcha: false,
    durationMs: null,
  };
  attempt.requestedUrl = googleSearchUrl(search, stay, {
    propertyId: '', source: 'google_hotels', hotelName: search.destination,
    propertyUrl, roomName: null, rateName: null, seller: '', refundable: null, breakfast: null,
  });
  const browser = await launchBrowser();
  const started = Date.now();
  try {
    const context = await createStealthContext(browser, { countryProfile: COUNTRY_PROFILES.GB });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    const consoleLines = [];
    page.on('console', message => consoleLines.push(`[${message.type()}] ${message.text().slice(0, 300)}`));
    page.on('pageerror', error => consoleLines.push(`[pageerror] ${String(error).slice(0, 300)}`));
    try {
      await navigateHotelPage(page, attempt.requestedUrl, 'google_hotels');
      await page.waitForTimeout(1500);
      attempt.captcha = CAPTCHA_RE.test(await page.locator('body').innerText().catch(() => ''));
      attempt.basis = await selectGoogleTotal(page);
    } catch (error) {
      attempt.error = String(error?.message ?? error);
      attempt.postMortem = await postMortem(page);
    }
    attempt.finalUrl = page.url();
    attempt.environment = await pageEnvironment(page);
    if (attempt.error) attempt.consoleTail = consoleLines.slice(-30);
    const outcome = attempt.error ? 'FAIL' : 'OK';
    const tracePath = `${OUT}/trace-${String(index).padStart(2, '0')}-${outcome}.zip`;
    await context.tracing.stop({ path: tracePath }).catch(stopError => { attempt.traceStopError = String(stopError); });
    attempt.tracePath = tracePath;
  } catch (outer) {
    attempt.error = attempt.error ?? String(outer?.message ?? outer);
  } finally {
    attempt.durationMs = Date.now() - started;
    await browser.close().catch(() => {});
  }
  if (attempt.error) failures += 1;
  report.phases.push(attempt);
  console.error(`[property ${index}] ${attempt.error ? 'FAIL' : 'OK'} basis=${JSON.stringify(attempt.basis)} ${attempt.durationMs}ms ${attempt.error ? `\n  error: ${attempt.error.split('\n')[0]}\n  env: ${JSON.stringify(attempt.environment?.viewport ?? attempt.environment)}` : ''}`);
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
}

report.finishedAt = new Date().toISOString();
report.failures = failures;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ failures, total: report.phases.filter(p => p.phase === 'property').length, out: OUT }, null, 2));
