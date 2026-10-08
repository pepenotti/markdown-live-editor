// Printing an HTML file to PDF with a Chrome, Edge or Chromium that is already installed.
// Nothing is downloaded; without such a browser the caller falls back to the user's own Print dialog.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCandidates, isCompletePdf, printToPdfArgs } from '../shared/browsers';

const TIMEOUT_MS = 60_000;
const POLL_MS = 250;

/** The first browser found at a well-known path of this platform. */
export function installedBrowser(): string | undefined {
  return browserCandidates(process.platform, process.env, os.homedir()).find((candidate) => existsSync(candidate));
}

async function finishedPdf(file: string): Promise<boolean> {
  try {
    return isCompletePdf(await fs.readFile(file));
  } catch {
    return false;
  }
}

/**
 * Runs the browser headless and resolves once `pdfFile` is written.
 * `waitForScripts` gives the page time to load and run scripts (Mermaid from the CDN) first.
 */
export async function printToPdf(browser: string, htmlFile: string, pdfFile: string, waitForScripts: boolean, timeout = TIMEOUT_MS): Promise<void> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'seamless-markdown-profile-'));
  await fs.rm(pdfFile, { force: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const args = printToPdfArgs(pathToFileURL(htmlFile).href, pdfFile, profile, waitForScripts);
      const child = execFile(browser, args, { timeout, windowsHide: true }, (error, _stdout, stderr) => {
        clearInterval(watch);
        if (done) return;
        done = true;
        if (!error) resolve();
        else if (error.killed) reject(new Error('The browser did not finish in time.'));
        else reject(new Error(String(stderr).trim().split('\n').pop() || `The browser stopped with ${error.code ?? error.signal ?? 'an error'}.`));
      });
      // On some machines the browser writes the file and then never exits, so the file
      // is watched as well, and the browser is stopped once the PDF is complete.
      let busy = false;
      const watch = setInterval(() => {
        if (busy || done) return;
        busy = true;
        void finishedPdf(pdfFile).then((complete) => {
          busy = false;
          if (!complete || done) return;
          done = true;
          clearInterval(watch);
          child.kill();
          resolve();
        });
      }, POLL_MS);
    });
    if (!(await finishedPdf(pdfFile))) throw new Error('The browser did not write a PDF.');
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
