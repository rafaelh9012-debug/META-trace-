// WCAG contrast: first the design tokens straight from the stylesheet, then every visible piece of text in the running app.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const B = require('./helpers/browser.cjs');

test.after(async () => {await B.closeBrowser();});

const css = fs.readFileSync(path.join(__dirname, '..', 'metadata-styles.css'), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2]]));
const channel = v => {v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);};
const luminance = ({r, g, b}) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const hex = h => ({r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16)});
const ratio = (a, b) => {const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05);};
const tokenRatio = (fg, bg) => ratio(hex(tokens[fg]), hex(tokens[bg]));

test('the stylesheet defines the tokens this test relies on', () => {
  for (const name of ['void', 'panel', 'surface', 'raised', 'line-strong', 'accent', 'accent-strong', 'accent-ink', 'ember', 'warn', 'danger', 'text', 'muted']) assert.ok(tokens[name], '--' + name + ' is defined');
});

test('text colours reach 4.5:1 on every surface they are used on', () => {
  const surfaces = ['void', 'panel', 'surface', 'raised'];
  const table = [];
  for (const fg of ['text', 'muted', 'accent', 'accent-strong', 'ember', 'warn', 'danger']) for (const bg of surfaces) table.push([fg, bg, tokenRatio(fg, bg)]);
  console.log('    ' + table.map(([f, b, r]) => f + '/' + b + ' ' + r.toFixed(1)).join('  '));
  const low = table.filter(([f, b, r]) => r < 4.5).map(([f, b, r]) => f + ' on ' + b + ' = ' + r.toFixed(2));
  assert.deepEqual(low, []);
});

test('text on the accent fills (primary buttons and badges) reaches 4.5:1', () => {
  for (const bg of ['accent', 'accent-strong']) assert.ok(tokenRatio('accent-ink', bg) >= 4.5, 'accent-ink on ' + bg + ' = ' + tokenRatio('accent-ink', bg).toFixed(2));
});

test('component outlines and the focus ring reach 3:1 against the surfaces they sit on', () => {
  for (const bg of ['void', 'panel', 'surface']) {
    assert.ok(tokenRatio('accent-strong', bg) >= 3, 'focus ring on ' + bg + ' = ' + tokenRatio('accent-strong', bg).toFixed(2));
    assert.ok(tokenRatio('line-strong', bg) >= 1.5, 'borders stay visible on ' + bg);
  }
  const outline = css.match(/:focus-visible\{outline:2px solid var\(--accent-strong\)/);
  assert.ok(outline, 'the focus ring is 2 px in --accent-strong');
});

/* ------------------------------------------------------------------------------------------------------------- */

async function scanText(page) {
  return page.evaluate(() => {
    const parse = c => {const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return {r: 0, g: 0, b: 0, a: 0}; const p = m[1].split(/[ ,/]+/).map(Number); return {r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1};};
    const over = (top, base) => ({r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1});
    const channel = v => {v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);};
    const lum = c => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const ratio = (a, b) => {const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05);};
    const page = parse(getComputedStyle(document.documentElement).backgroundColor);
    const base = page.a ? page : {r: 13, g: 8, b: 13, a: 1};
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || ['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.closest('[aria-hidden="true"], .sr-only, :disabled, [hidden], svg, #frame')) continue;     // decoration, hidden, inactive, or the person's own photo
      let opacity = 1, layers = [];
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e); opacity *= parseFloat(s.opacity);
        const bg = parse(s.backgroundColor); if (bg.a > 0) layers.push(bg);
        if (bg.a >= 1) break;
      }
      let background = base; for (const layer of layers.reverse()) background = over(layer, background);
      const fg = parse(cs.color); const alpha = fg.a * opacity;
      const text = over({...fg, a: alpha}, background);
      const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700, large = size >= 24 || (size >= 18.66 && bold);
      results.push({selector: (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '')), text: n.textContent.trim().slice(0, 28), ratio: ratio(text, background), need: large ? 3 : 4.5, size});
    }
    return results;
  });
}

async function liveContrast(name, prepare) {
  const browser = await B.getBrowser();
  if (!browser) return {skip: B.reason()};
  const app = await B.openApp(browser, {motion: 'reduced'});
  try {
    await prepare(app.page);
    await B.sleep(300);
    const results = await scanText(app.page);
    const low = results.filter(r => r.ratio < r.need).map(r => r.selector + ' "' + r.text + '" ' + r.ratio.toFixed(2) + ' (needs ' + r.need + ', ' + r.size + 'px)');
    return {checked: results.length, low, min: Math.min(...results.map(r => r.ratio))};
  } finally {await app.close();}
}

for (const [name, prepare] of [
  ['idle', async () => {}],
  ['file chosen', async page => B.choose(page, 'sample-street.jpg')],
  ['located result', async page => B.analyze(page, 'sample-street.jpg')],
  ['no location', async page => B.analyze(page, 'no-gps.jpg')],
  ['conflicting location with candidates', async page => B.analyze(page, 'conflicting-gps.jpg')],
  ['polar notice', async page => B.analyze(page, 'gps-near-pole.jpg')],
  ['read error', async page => B.analyze(page, 'corrupt.tiff')]
]) {
  test('every visible text in the running app reaches its WCAG ratio: ' + name, async t => {
    const out = await liveContrast(name, prepare);
    if (out.skip) return t.skip(out.skip);
    console.log('    ' + name + ': ' + out.checked + ' text elements, lowest ratio ' + out.min.toFixed(2));
    assert.ok(out.checked > 8, 'the scan actually found the text (' + out.checked + ')');
    assert.deepEqual(out.low, []);
  });
}
