// The real RUN_CONSOLE.py launcher, started as the Windows batch file would start it, serving the built page over
// http://127.0.0.1 to a real browser. webbrowser.open is stubbed so the test never opens a window on anyone's desktop.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {spawn} = require('node:child_process');
const B = require('./helpers/browser.cjs');

test.after(async () => {await B.closeBrowser();});

const python = process.platform === 'win32' ? 'python' : 'python3';
function startLauncher() {
  const stub = "import webbrowser, runpy, sys; webbrowser.open = lambda u: (print('URL ' + u, flush=True), True)[1]; sys.argv = ['RUN_CONSOLE.py']; runpy.run_path('RUN_CONSOLE.py', run_name='__main__')";
  const child = spawn(python, ['-I', '-c', stub], {cwd: B.ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => {child.kill(); reject(new Error('launcher did not report a URL in 8 s. stdout: ' + out + ' stderr: ' + err));}, 8000);
    child.stderr.on('data', d => {err += d;});
    child.stdout.on('data', d => {out += d; const m = out.match(/URL (http:\/\/127\.0\.0\.1:\d+\/META_trace_Console\.html)/); if (m) {clearTimeout(timer); resolve({child, url: m[1], out});}});
    child.on('error', e => {clearTimeout(timer); reject(e);});
  });
}

test('the launcher serves the built page on loopback and a complete analysis works over http, with no outside request', async t => {
  const browser = await B.getBrowser();
  if (!browser) return t.skip(B.reason());
  let launcher;
  try {launcher = await startLauncher();} catch (error) {if (/ENOENT/.test(String(error.message))) return t.skip('Python is not available to run the launcher'); throw error;}
  const origin = new URL(launcher.url).origin;
  const app = await B.openApp(browser, {url: launcher.url, motion: 'fast'});
  try {
    assert.match(launcher.out, /Crimson Image Metadata is open in your browser/);
    await B.analyze(app.page, 'sample-street.jpg');
    const s = await B.snapshot(app.page);
    assert.equal(await B.text(app.page, 'statusTitle'), 'GPS coordinates found');
    assert.ok(Math.abs(s.pin.lat - (29 + 38 / 60 + 55.87 / 3600)) < 1e-9);
    await B.expectFrame(app.page, 29 + 38 / 60 + 55.87 / 3600, -(82 + 20 / 60 + 16.4 / 3600), 'over http: ', {renderer: 'map'});
    assert.equal(await B.content(app.page, 'fileHash'), B.sha256('sample-street.jpg'));
    const outside = app.requests.filter(u => !/^(blob:|data:|about:)/.test(u) && !u.startsWith(origin + '/'));
    assert.deepEqual(outside, [], 'requests to anywhere but the launcher itself');
    assert.ok(app.requests.filter(u => u.startsWith(origin + '/')).length <= 2, 'the page is one request (plus nothing else the page asked for): ' + app.requests.join(' '));
    assert.deepEqual(app.problems, [], 'console errors or warnings over http');
    assert.equal(await app.page.evaluate(() => location.hostname), '127.0.0.1');
  } finally {
    await app.close();
    launcher.child.kill();
  }
});
