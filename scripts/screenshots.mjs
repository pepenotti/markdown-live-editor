// Regenerates images/icon.png and the README screenshots from the browser harness.
// Needs a built dist/ (npm run build) and an installed Chrome or Edge.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const PORT = 5179;
const BASE = `http://127.0.0.1:${PORT}/harness`;
const browserPath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('No Chrome or Edge found. Set CHROME_PATH.');

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });

/** Waits until the editor in a page or frame has loaded its document and images. */
const ready = (target) =>
  target.waitForFunction(() => window.__mdl?.view && [...document.images].every((i) => i.complete), { timeout: 15000 });
/** Puts the cursor just after the first occurrence of `text`. */
const cursorAfter = (target, text) =>
  target.evaluate((t) => {
    const view = window.__mdl.view;
    const pos = view.state.doc.toString().indexOf(t) + t.length;
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  }, text);

try {
  await sleep(600);
  const page = await browser.newPage();

  // Icon
  await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${readFileSync('images/icon.svg', 'utf8')}</body>`);
  await page.screenshot({ path: 'images/icon.png', omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });

  // The same document in all three modes
  await page.setViewport({ width: 1560, height: 640, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/trio.html`);
  for (const frame of page.frames().filter((f) => f.name())) await ready(frame);
  await cursorAfter(page.frames().find((f) => f.name() === 'half'), '**bol');
  await sleep(400);
  await page.screenshot({ path: 'images/modes.png' });

  // Half preview: the link under the cursor shows its syntax, the image stays visible
  await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/index.html?doc=demo.md&mode=half`);
  await ready(page);
  await cursorAfter(page, '![Hills at dusk](assets/photo');
  await sleep(400);
  await page.screenshot({ path: 'images/half-preview.png' });

  // Editing a table cell
  await page.goto(`${BASE}/index.html?doc=demo.md&mode=half`);
  await ready(page);
  await cursorAfter(page, 'Publish');
  await page.click('.cm-md-cell[data-r="1"][data-c="1"]');
  await page.keyboard.press('End');
  await page.keyboard.type(' soon');
  await sleep(400);
  await page.screenshot({ path: 'images/table.png' });

  // Full preview in a dark theme, with the link popover
  await page.goto(`${BASE}/index.html?doc=demo.md&mode=full&theme=dark`);
  await ready(page);
  await cursorAfter(page, '[lin');
  await sleep(500);
  await page.screenshot({ path: 'images/full-preview-dark.png' });

  console.log('wrote images/icon.png, modes.png, half-preview.png, table.png, full-preview-dark.png');
} finally {
  await browser.close();
  server.kill();
}
