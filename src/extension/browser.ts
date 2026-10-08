// A headless Chrome, Edge, Chromium or Brave that is already installed, driven over the
// DevTools pipe. It does two jobs for the export: it draws Mermaid diagrams with the
// extension's own dist/mermaid.js, and it prints the finished HTML to PDF.
//
// Nothing is downloaded. The browser is started without a shell and with fixed arguments;
// pages are handed over as file URLs through the protocol, never on the command line. Every
// step has a deadline, and whatever happens the browser is stopped and its profile removed.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { browserArgs, browserCandidates, isCompletePdf } from '../shared/browsers';

const EXIT_GRACE_MS = 3000;
/** Everything one export asks of the browser has to fit in this. */
export const SESSION_TIMEOUT_MS = 90_000;

/** The first browser found at a well-known path of this platform. */
export function installedBrowser(): string | undefined {
  return browserCandidates(process.platform, process.env, os.homedir()).find((candidate) => existsSync(candidate));
}

interface Reply {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

type Listener = { method: string; sessionId: string; resolve: () => void; reject: (error: Error) => void };

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

export class BrowserSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  /** Events that arrived before anybody waited for them. */
  private readonly seen = new Set<string>();
  private failure: Error | undefined;
  private stderr = '';
  private buffer = '';

  private constructor(
    private readonly child: ChildProcess,
    private readonly deadline: NodeJS.Timeout,
  ) {}

  /**
   * Starts the browser and runs `work` with it. The browser is gone and its profile removed
   * when this returns or throws, and it never takes longer than `timeout`.
   */
  static async use<T>(executable: string, work: (browser: BrowserSession) => Promise<T>, timeout = SESSION_TIMEOUT_MS): Promise<T> {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'seamless-markdown-profile-'));
    let child: ChildProcess | undefined;
    let session: BrowserSession | undefined;
    try {
      // No shell; stdin and stdout unused; the protocol runs over two extra pipes (3 in, 4 out).
      child = spawn(executable, browserArgs(profile), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
      const deadline = setTimeout(() => session?.fail(new Error('The browser did not finish in time.')), timeout);
      session = new BrowserSession(child, deadline);
      session.listen();
      return await work(session);
    } finally {
      if (session) clearTimeout(session.deadline);
      session?.fail(new Error('The browser was closed.'));
      // Never leave the browser behind, and remove its profile only once it has let go of it.
      // Closing the pipe tells the browser and its helper processes to go; the signal makes sure.
      (child?.stdio[3] as Writable | null | undefined)?.end();
      if (child) await stopped(child);
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  }

  private listen(): void {
    const { child } = this;
    child.once('error', (err) => this.fail(new Error(`The browser could not be started: ${err.message}`)));
    child.once('exit', (code, signal) => {
      const last = this.stderr.trim().split('\n').pop()?.slice(0, 300);
      this.fail(new Error(last || `The browser stopped unexpectedly (${signal ?? `code ${code}`}).`));
    });
    child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });
    const input = child.stdio[3] as Writable | null;
    const output = child.stdio[4] as Readable | null;
    // A browser that dies mid-message must not take the extension host with it.
    input?.on('error', () => undefined);
    output?.on('error', () => undefined);
    output?.setEncoding('utf8');
    output?.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf('\0'); end >= 0; end = this.buffer.indexOf('\0')) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(text) as Reply);
        } catch {
          // Not a message of the protocol.
        }
      }
    });
  }

  private receive(message: Reply): void {
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message || 'The browser refused a request.'));
      else waiting?.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const key = `${message.sessionId ?? ''}:${message.method}`;
    this.seen.add(key);
    for (const listener of [...this.listeners]) {
      if (`${listener.sessionId}:${listener.method}` !== key) continue;
      this.listeners.delete(listener);
      listener.resolve();
    }
  }

  /** Ends every wait with this error. The first reason given is the one reported. */
  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiting of this.pending.values()) waiting.reject(this.failure);
    this.pending.clear();
    for (const listener of this.listeners) listener.reject(this.failure);
    this.listeners.clear();
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.child.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  /** Resolves once the event has happened in that page (also when it already has). */
  private event(method: string, sessionId: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const key = `${sessionId}:${method}`;
    if (this.seen.delete(key)) return Promise.resolve();
    const waiting = new Promise<void>((resolve, reject) => {
      this.listeners.add({ method, sessionId, resolve, reject });
    });
    // A wait that is abandoned (the step before it failed) must not surface as an unhandled rejection.
    waiting.catch(() => undefined);
    return waiting;
  }

  /** Opens a page on a local file and waits until it has loaded. Returns the page to talk to. */
  private async open(file: string): Promise<string> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    if (typeof sessionId !== 'string') throw new Error('The browser did not open a page.');
    await this.send('Page.enable', {}, sessionId);
    this.seen.delete(`${sessionId}:Page.loadEventFired`);
    const loaded = this.event('Page.loadEventFired', sessionId);
    const { errorText } = await this.send('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
    if (errorText) throw new Error(`The browser could not open the page: ${String(errorText)}`);
    await loaded;
    return sessionId;
  }

  /** Runs an expression in a page and returns its value; a promise is awaited. */
  private async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const problem = reply.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    if (problem) throw new Error(problem.exception?.description?.split('\n')[0] || problem.text || 'The page reported an error.');
    return (reply.result as { value?: unknown } | undefined)?.value;
  }

  /**
   * Draws Mermaid diagrams. `page` is an HTML file that loads the extension's dist/mermaid.js
   * and nothing else. Returns one SVG per source, or null where the source has an error.
   * The page works offline: a diagram cannot make the browser fetch anything.
   */
  async drawDiagrams(page: string, sources: readonly string[]): Promise<(string | null)[]> {
    if (!sources.length) return [];
    const sessionId = await this.open(page);
    await this.send('Network.enable', {}, sessionId).catch(() => undefined);
    await this.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId).catch(() => undefined);
    const value = await this.evaluate(sessionId, `(${DRAW})(${JSON.stringify(sources)})`);
    const drawn = JSON.parse(String(value)) as unknown[];
    return sources.map((_, i) => (typeof drawn[i] === 'string' ? (drawn[i] as string) : null));
  }

  /** Prints an HTML file to PDF, with the page size and margins of its own style sheet. */
  async printPdf(file: string): Promise<Buffer> {
    const sessionId = await this.open(file);
    // Embedded fonts are decoded after the load event; printing before that would fall back to others.
    await this.evaluate(sessionId, 'document.fonts.ready.then(() => true)').catch(() => undefined);
    const { data } = await this.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false }, sessionId);
    const pdf = Buffer.from(String(data ?? ''), 'base64');
    if (!isCompletePdf(pdf)) throw new Error('The browser did not return a complete PDF.');
    return pdf;
  }
}

/**
 * Runs in the page. Each diagram is drawn on its own, so one with an error does not stop
 * the others; `securityLevel: 'strict'` keeps scripts and click handlers out of the result.
 */
const DRAW = `async (sources) => {
  const mermaid = globalThis.__mdlMermaid;
  if (!mermaid) throw new Error('The diagram renderer did not load.');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  const out = [];
  for (let i = 0; i < sources.length; i++) {
    const id = 'mdl-diagram-' + (i + 1);
    try {
      out.push((await mermaid.render(id, sources[i])).svg);
    } catch (err) {
      out.push(null);
    }
    document.getElementById(id)?.remove();
    document.getElementById('d' + id)?.remove();
  }
  return JSON.stringify(out);
}`;
