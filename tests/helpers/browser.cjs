// Shared helpers for the real-browser tests. Playwright is a development dependency only: the app itself needs no
// packages. When Playwright or its Chromium is missing, every browser test reports a skip with the reason.
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const APP_URL = 'file://' + path.join(ROOT, 'Qwen_Map_Console.html');
const ARTIFACT_DIR = process.env.META_TRACE_ARTIFACTS || '';

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const id of candidates) {try {return require(id);} catch {/* try the next */}}
  return null;
}

let launching = null, skipReason = null;
/** One shared Chromium for the whole file. Resolves to null (and records why) when it cannot start. */
function getBrowser() {
  if (launching) return launching;
  launching = (async () => {
    const pw = loadPlaywright();
    if (!pw) {skipReason = 'Playwright is not installed (npm install, then npx playwright install chromium).'; return null;}
    try {
      return await pw.chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
    } catch (error) {skipReason = 'Chromium could not be started: ' + String(error.message).split('\n')[0]; return null;}
  })();
  return launching;
}
async function closeBrowser() {const b = await launching; if (b) await b.close(); launching = null;}
const reason = () => skipReason;

/**
 * Opens the built app in a fresh context. Records console problems, page errors and every request the page makes,
 * so tests can assert there were none outside the local file, blob and data schemes.
 */
async function openApp(browser, {viewport = {width: 1440, height: 900}, url = APP_URL, init = [], contextOptions = {}, motion} = {}) {
  const context = await browser.newContext({viewport, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'], ...contextOptions});
  const page = await context.newPage();
  const problems = [], requests = [], dialogs = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => {if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text());});
  page.on('request', r => requests.push(r.url()));
  page.on('dialog', d => {dialogs.push(d.message()); d.dismiss();});
  // A passive recorder of presentation state changes, installed before any page script runs.
  await page.addInitScript(() => {
    window.__sequence = [];
    window.__revoked = 0;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = u => {window.__revoked++; return revoke(u);};
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const s = document.body.dataset.presentation, last = window.__sequence[window.__sequence.length - 1];
        if (!last || last.state !== s) window.__sequence.push({state: s, at: performance.now()});
      }).observe(document.body, {attributes: true, attributeFilter: ['data-presentation']});
    });
  });
  for (const script of init) await page.addInitScript(script);
  if (motion) await page.addInitScript(m => {try {localStorage.setItem('metatrace.settings.v1', JSON.stringify({sound: true, volume: 35, motion: m}));} catch {}}, motion);
  await page.goto(url);
  await page.waitForFunction(() => window.MetaTrace && document.body.dataset.presentation);
  return {context, page, problems, requests, dialogs, close: () => context.close()};
}

const snapshot = page => page.evaluate(() => window.MetaTrace.snapshot());
const fixture = name => path.join(FIXTURES, name);
const sha256 = name => crypto.createHash('sha256').update(fs.readFileSync(fixture(name))).digest('hex');
const text = (page, id) => page.locator('#' + id).innerText();
const content = (page, id) => page.locator('#' + id).textContent();

/** Select a file and wait until the app has either accepted it (Image ready) or rejected it with an error. */
async function choose(page, name, {path: filePath} = {}) {
  await page.setInputFiles('#fileInput', filePath || fixture(name));
  await page.waitForFunction(() => {
    const status = document.getElementById('status');
    return document.getElementById('statusTitle').textContent === 'Image ready' || status.dataset.kind === 'error';
  });
}
const waitDone = (page, timeout = 20000) => page.waitForFunction(() => {const s = window.MetaTrace.snapshot(); return !s.running && (s.presentation === 'settled' || s.presentation === 'error');}, null, {timeout});
/** Select a fixture, press Analyze and wait for the presentation to finish. */
async function analyze(page, name, {wait = true} = {}) {
  await choose(page, name);
  await page.click('#analyze');
  if (wait) await waitDone(page);
}
async function save(page, name) {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, {recursive: true});
  await page.screenshot({path: path.join(ARTIFACT_DIR, name)});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {ROOT, FIXTURES, APP_URL, getBrowser, closeBrowser, reason, openApp, snapshot, fixture, sha256, text, content, choose, analyze, waitDone, save, sleep};
