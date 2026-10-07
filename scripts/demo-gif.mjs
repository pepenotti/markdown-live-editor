// Records images/demo.gif: typing, editing a table and switching modes in the browser harness.
// Needs a built dist/ (npm run build) and an installed Chrome or Edge.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const PORT = 5180;
const WIDTH = 880;
const HEIGHT = 540;
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
const frames = [];

try {
  await sleep(600);
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/harness/index.html?doc=demo.md&mode=half`);
  await page.waitForFunction(() => window.__mdl?.view && [...document.images].every((i) => i.complete));

  /** Captures the page as one frame shown for `ms` milliseconds. An unchanged page extends the last frame. */
  const shot = async (ms) => {
    const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
    const last = frames[frames.length - 1];
    if (last && Buffer.compare(last.data, png.data) === 0) last.delay += ms;
    else frames.push({ data: png.data, delay: ms });
  };
  const type = async (text, perKey = 70) => {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await shot(perKey);
    }
  };
  const cursorAfter = (text) =>
    page.evaluate((t) => {
      const view = window.__mdl.view;
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(t) + t.length } });
    }, text);
  const mode = async (n, hold) => {
    await page.click(`.mdl-modes button:nth-child(${n})`);
    await sleep(250);
    await shot(hold);
  };

  await cursorAfter('Publish');
  await shot(1200);

  // Type Markdown; it renders as soon as the cursor leaves it.
  await cursorAfter('separate preview.');
  await shot(500);
  await type(' Just **type Markdown** and keep going.');
  await shot(900);

  // Edit a table cell in place.
  await page.click('.cm-md-cell[data-r="1"][data-c="1"]');
  await page.keyboard.press('End');
  await shot(600);
  await type(' today', 90);
  await page.keyboard.press('Tab');
  await shot(500);
  await type(' M.', 110);
  await shot(900);

  // Tick a task, then walk through the three modes.
  await (await page.$$('.cm-md-checkbox input'))[1].click();
  await sleep(150);
  await shot(900);
  await cursorAfter('Publish');
  await mode(3, 1800);
  await mode(1, 2000);
  await mode(2, 1600);

  const gif = GIFEncoder();
  for (const frame of frames) {
    const palette = quantize(frame.data, 256);
    gif.writeFrame(applyPalette(frame.data, palette), WIDTH, HEIGHT, { palette, delay: frame.delay });
  }
  gif.finish();
  writeFileSync('images/demo.gif', gif.bytes());
  console.log(`wrote images/demo.gif: ${frames.length} frames, ${(gif.bytes().length / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
  server.kill();
}
