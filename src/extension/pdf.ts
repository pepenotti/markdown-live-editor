// Printing an HTML file to PDF with a Chrome, Edge or Chromium that is already installed.
// Nothing is downloaded; without such a browser the caller falls back to the user's own Print dialog.
import { type ChildProcess, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserCandidates, isCompletePdf, printToPdfArgs } from '../shared/browsers';

const TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const EXIT_GRACE_MS = 3000;

/** The first browser found at a well-known path of this platform. */
export function installedBrowser(): string | undefined {
  return browserCandidates(process.platform, process.env, os.homedir()).find((candidate) => existsSync(candidate));
}

/** Size of the file when it is a whole PDF, otherwise -1. */
async function completeSize(file: string): Promise<number> {
  try {
    const bytes = await fs.readFile(file);
    return isCompletePdf(bytes) ? bytes.length : -1;
  } catch {
    return -1;
  }
}

/** Resolves when the process is gone, killing it hard if it ignores the first signal. */
function stopped(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // A browser that never started has no process to wait for.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
    const hard = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS);
    // Whatever happens, the export itself must come to an end.
    const giveUp = setTimeout(resolve, EXIT_GRACE_MS * 2);
    child.once('exit', () => {
      clearTimeout(hard);
      clearTimeout(giveUp);
      resolve();
    });
    child.kill();
  });
}

/**
 * Runs the browser headless and resolves once `pdfFile` is written and the browser is gone.
 * `waitForScripts` gives the page time to load and run scripts (Mermaid from the CDN) first.
 *
 * The browser is started without a shell, the page is passed as a file URL and the output
 * path inside one `--print-to-pdf=` argument, so no path can be read as another option.
 */
export async function printToPdf(browser: string, htmlFile: string, pdfFile: string, waitForScripts: boolean, timeout = TIMEOUT_MS): Promise<void> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'seamless-markdown-profile-'));
  await fs.rm(pdfFile, { force: true });
  let child: ChildProcess | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const args = printToPdfArgs(pathToFileURL(htmlFile).href, pdfFile, profile, waitForScripts);
      child = execFile(browser, args, { timeout, windowsHide: true }, (error, _stdout, stderr) => {
        clearInterval(watch);
        if (done) return;
        done = true;
        if (!error) resolve();
        else if (error.killed) reject(new Error('The browser did not finish in time.'));
        else reject(new Error(String(stderr).trim().split('\n').pop() || `The browser stopped with ${error.code ?? error.signal ?? 'an error'}.`));
      });
      // On some machines the browser writes the file and then never exits. So the file is
      // watched too: once it is a whole PDF and has stopped growing, the wait is over.
      let busy = false;
      let lastSize = -1;
      const watch = setInterval(() => {
        if (busy || done) return;
        busy = true;
        void completeSize(pdfFile).then((size) => {
          busy = false;
          if (done) return;
          const settled = size > 0 && size === lastSize;
          lastSize = size;
          if (!settled) return;
          done = true;
          clearInterval(watch);
          resolve();
        });
      }, POLL_MS);
    });
    if ((await completeSize(pdfFile)) <= 0) throw new Error('The browser did not write a PDF.');
  } finally {
    // Never leave the browser behind, and remove its profile only once it has let go of it.
    if (child) await stopped(child);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
