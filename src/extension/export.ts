// Export to HTML and PDF. The rendering is in src/shared/exportHtml.ts (loaded on demand);
// this file reads images, asks where to save, and uses an installed browser to draw the
// diagrams and to print the PDF. Both exports are made from the same rendered HTML.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { imageTarget, looksLikeImage, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../shared/embed';
import type { WikiHref } from '../shared/wikiLinkPlugin';
import { scanNote, stripNoteExtension } from '../shared/wikiLinks';
import { relativePath } from './images';
import { BrowserSession, installedBrowser } from './browser';
import { type NoteIndex, wikiLinksEnabled } from './notes';
import { renderer } from './renderer';
import { ui } from './ui';

const TEMP_PREFIX = 'seamless-markdown-export-';
const STALE_MS = 24 * 60 * 60 * 1000;


function settings(document: vscode.TextDocument): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('seamlessMarkdown.export', document.uri);
}

function stemOf(document: vscode.TextDocument): string {
  const name = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);
  return name.replace(/\.[^.]+$/, '') || 'document';
}

/** Where the save dialog starts: next to the document. */
function defaultTarget(document: vscode.TextDocument, extension: string): vscode.Uri {
  const name = `${stemOf(document)}.${extension}`;
  if (document.uri.scheme !== 'untitled') return vscode.Uri.joinPath(document.uri, '..', name);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  return vscode.Uri.joinPath(folder, name);
}

/** The path with every link in it followed; the path itself when that cannot be done. */
async function realPath(file: string): Promise<string> {
  const real = await fs.realpath(file).catch(() => file);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Reads the local images of a document as data URIs, keyed by their source.
 *
 * Only what the editor itself may show is read: image files in the folder of the document
 * or, when the document is part of a workspace, in a workspace folder. Anything else — a
 * file that is not an image, a path that leads elsewhere, a link to another place, a file
 * that is too large — keeps its path and is reported.
 */
async function embedImages(document: vscode.TextDocument, text: string): Promise<{ images: Map<string, string>; missing: string[] }> {
  const images = new Map<string, string>();
  const missing: string[] = [];
  const sources = renderer().localImageSources(text);
  if (document.uri.scheme === 'untitled') return { images, missing: sources.sort() };

  const sameFileSystem = (uri: vscode.Uri) => uri.scheme === document.uri.scheme && uri.authority === document.uri.authority;
  const project = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
  const documentFolder = vscode.Uri.joinPath(document.uri, '..').path;
  const roots = [documentFolder];
  if (project) for (const folder of vscode.workspace.workspaceFolders ?? []) if (sameFileSystem(folder.uri)) roots.push(folder.uri.path);

  // Where the folders really are, so a link inside the project that leads out of it is noticed.
  const local = document.uri.scheme === 'file';
  const realRoots = local ? await Promise.all(roots.map((root) => realPath(document.uri.with({ path: root }).fsPath))) : [];

  let total = 0;
  // One at a time, so the size limit for the whole document is exact.
  for (const src of sources) {
    try {
      const target = imageTarget(src, documentFolder, project?.path ?? null, roots, process.platform === 'win32');
      if ('skip' in target) throw new Error(target.skip);
      const uri = document.uri.with({ path: target.path, query: '', fragment: '' });
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) throw new Error('not a plain file');
      if (local) {
        const real = await realPath(uri.fsPath);
        if (!realRoots.some((root) => real === root || real.startsWith(root + path.sep))) throw new Error('outside the document folder and the project');
      }
      if (stat.size > MAX_IMAGE_BYTES || total + stat.size > MAX_TOTAL_IMAGE_BYTES) throw new Error('too large');
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_TOTAL_IMAGE_BYTES) throw new Error('too large');
      if (!looksLikeImage(bytes, target.mime)) throw new Error('not an image');
      total += bytes.length;
      images.set(src, `data:${target.mime};base64,${Buffer.from(bytes).toString('base64')}`);
    } catch {
      missing.push(src);
    }
  }
  return { images, missing: missing.sort() };
}

/**
 * How wiki links are exported, or undefined while they are turned off (double brackets
 * are then left as the text they are).
 *
 * A link to a note becomes a relative link to that note's own export: the same path with
 * `.html` for the extension, as **Export as HTML** names a file by default. A note that
 * does not exist, or whose name fits several, is exported as its text. So is every note
 * when `linked` is false: a PDF or a copied fragment has no folder to be relative to.
 */
export async function wikiHrefs(document: vscode.TextDocument, text: string, notes: NoteIndex | undefined, linked: boolean): Promise<WikiHref | undefined> {
  if (!notes || !wikiLinksEnabled(document.uri)) return undefined;
  const hrefs = new Map<string, string>();
  if (linked) {
    const folder = vscode.Uri.joinPath(document.uri, '..').path;
    for (const link of scanNote(text).links) {
      if (link.kind !== 'wiki' || hrefs.has(link.target)) continue;
      const found = await notes.resolve(document.uri, link.target);
      if (found.status !== 'found') continue;
      const path = stripNoteExtension(relativePath(folder, found.uri.path)) + '.html';
      hrefs.set(link.target, path.split('/').map(encodeURIComponent).join('/'));
    }
  }
  return (target) => hrefs.get(target) ?? null;
}

/* ---------- the browser ---------- */

export const BROWSERS = 'Chrome, Edge, Chromium or Brave';
const BROWSER_SETTING = 'seamlessMarkdown.export.browserPath';

/** The browser the export can use, or why there is none. */
export type BrowserInfo = { path: string; reason?: undefined } | { path?: undefined; reason: string };

/**
 * Looks for the browser: the one set in `seamlessMarkdown.export.browserPath` (a machine
 * setting, so a workspace cannot choose the program that is run), or the first found at a
 * well-known path. Cheap enough to run at activation: it only checks that files exist.
 */
export function detectBrowser(): BrowserInfo {
  const configured = vscode.workspace.getConfiguration('seamlessMarkdown.export').get<string>('browserPath', '').trim();
  if (configured) return existsSync(configured) ? { path: configured } : { reason: `The browser set in ${BROWSER_SETTING} does not exist.` };
  const found = installedBrowser();
  return found ? { path: found } : { reason: `Needs ${BROWSERS} to be installed.` };
}

/* ---------- temporary files ---------- */

/** Folders in use right now. Each holds the pages of one export, readable by this user only. */
const tempFolders = new Set<string>();

function removeTempFolder(folder: string): void {
  tempFolders.delete(folder);
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {
    // Still in use; the next sweep takes it.
  }
}

/** Removes what an export in progress has written. Called when the extension is deactivated. */
export function removeTempFiles(): void {
  for (const folder of [...tempFolders]) removeTempFolder(folder);
}

/** Removes folders that a session which did not end normally left behind. */
function sweepStaleTempFolders(): void {
  try {
    const root = os.tmpdir();
    for (const name of readdirSync(root)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const folder = path.join(root, name);
      if (!tempFolders.has(folder) && Date.now() - statSync(folder).mtimeMs > STALE_MS) rmSync(folder, { recursive: true, force: true });
    }
  } catch {
    // Housekeeping only.
  }
}

/** Runs `work` with a private temporary folder that is gone afterwards, whatever happens. */
async function withTempFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  sweepStaleTempFolders();
  // mkdtemp makes the folder for this user only: its files hold the whole document.
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  tempFolders.add(folder);
  try {
    return await work(folder);
  } finally {
    removeTempFolder(folder);
  }
}

/* ---------- rendering ---------- */

export interface ExportContext {
  /** The `dist` folder of the extension: the diagram renderer, the math style sheet and its fonts. */
  dist: string;
  browser(): BrowserInfo;
  /** The notes of the workspace, for wiki links while they are turned on. */
  notes?: NoteIndex;
}

/** What the last export rendered. Kept only when the integration tests ask for it. */
export const lastExport: { keep: boolean; html?: string } = { keep: false };

let katexCss: string | undefined;

/** The KaTeX style sheet and fonts that ship with the extension, for math in exported files. */
function mathAssets(dist: string): { css: string; font: (name: string) => string | undefined } | undefined {
  try {
    katexCss ??= readFileSync(path.join(dist, 'katex.css'), 'utf8');
  } catch {
    // Without the style sheet math is exported as MathML.
    return undefined;
  }
  return {
    css: katexCss,
    font: (name) => {
      if (!/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+$/.test(name)) return undefined;
      try {
        return readFileSync(path.join(dist, 'fonts', `${name}.woff2`)).toString('base64');
      } catch {
        return undefined;
      }
    },
  };
}

/** The page the browser draws diagrams in: the extension's own Mermaid from disk and nothing else. */
async function diagramPage(folder: string, dist: string): Promise<string> {
  const file = path.join(folder, 'diagrams.html');
  const script = pathToFileURL(path.join(dist, 'mermaid.js')).href.replace(/["<>&]/g, encodeURIComponent);
  await fs.writeFile(file, `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><script src="${script}"></script></body></html>\n`, { mode: 0o600 });
  return file;
}

interface Produced {
  html: string;
  pdf?: Buffer;
  /** Local images that were not embedded. */
  missing: string[];
  diagrams: number;
  diagramsDrawn: number;
  /** Why the browser could not draw the diagrams, when it was tried and failed as a whole. */
  diagramError?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Renders the document once, for either format. With a browser the Mermaid diagrams are
 * drawn first and put into the HTML as static SVG; for a PDF that same HTML is then printed
 * by the same browser. Without a browser diagrams stay as their source.
 */
async function produce(document: vscode.TextDocument, context: ExportContext, format: 'html' | 'pdf'): Promise<Produced> {
  const text = document.getText();
  const render = renderer();
  const sources = render.mermaidSources(text);
  const browser = context.browser().path;
  // A PDF has no folder next to it that images could be loaded from, so they are always embedded.
  const embed = format === 'pdf' || settings(document).get<boolean>('embedImages', true);
  const { images, missing } = embed ? await embedImages(document, text) : { images: new Map<string, string>(), missing: [] };
  const wikiLinks = await wikiHrefs(document, text, context.notes, format === 'html');
  const katex = mathAssets(context.dist);

  let diagramError: string | undefined;
  const html = (diagrams?: (string | null)[]) =>
    render.renderDocument(text, { images, diagrams, katex, fallbackTitle: stemOf(document), print: format === 'pdf', wikiLinks });
  const draw = async (session: BrowserSession, folder: string) => {
    if (!sources.length) return undefined;
    try {
      return await session.drawDiagrams(await diagramPage(folder, context.dist), sources);
    } catch (err) {
      // The document is still exported, with its diagrams as source.
      diagramError = message(err);
      return undefined;
    }
  };

  let out: ReturnType<typeof html>;
  let pdf: Buffer | undefined;
  if (format === 'pdf') {
    if (!browser) throw new Error(`Export as PDF needs ${BROWSERS}.`);
    [out, pdf] = await withTempFolder((folder) =>
      BrowserSession.use(browser, async (session) => {
        const rendered = html(await draw(session, folder));
        const page = path.join(folder, 'document.html');
        await fs.writeFile(page, rendered.html, { encoding: 'utf8', mode: 0o600 });
        return [rendered, await session.printPdf(page)] as const;
      }),
    );
  } else if (browser && sources.length) {
    const diagrams = await withTempFolder((folder) => BrowserSession.use(browser, (session) => draw(session, folder))).catch((err) => {
      diagramError = message(err);
      return undefined;
    });
    out = html(diagrams);
  } else {
    out = html();
  }
  if (lastExport.keep) lastExport.html = out.html;
  return { html: out.html, pdf, missing, diagrams: out.diagrams, diagramsDrawn: out.diagramsDrawn, diagramError };
}

/* ---------- the two commands ---------- */

const nameOf = (uri: vscode.Uri) => uri.path.slice(uri.path.lastIndexOf('/') + 1);

const REVEAL = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Reveal in File Explorer' : 'Open Containing Folder';

function notes(produced: Produced, browser: BrowserInfo): string {
  let text = '';
  if (produced.missing.length) {
    const names = produced.missing.slice(0, 3).join(', ') + (produced.missing.length > 3 ? '…' : '');
    text += ` ${produced.missing.length === 1 ? '1 image was' : `${produced.missing.length} images were`} not embedded (${names}).`;
  }
  const left = produced.diagrams - produced.diagramsDrawn;
  if (left > 0) {
    const what = produced.diagrams === 1 ? 'Its diagram was' : left === produced.diagrams ? `Its ${left} diagrams were` : `${left} of its ${produced.diagrams} diagrams ${left === 1 ? 'was' : 'were'}`;
    const why = !browser.path
      ? `drawing diagrams needs ${BROWSERS}`
      : produced.diagramError
        ? `the browser could not draw ${left === 1 ? 'it' : 'them'} (${produced.diagramError})`
        : `${left === 1 ? 'it has' : 'they have'} an error`;
    text += ` ${what} exported as source code: ${why}.`;
  }
  return text;
}

/** Says that the file is there, with buttons to open it and to show it in its folder. */
function announce(target: vscode.Uri, extra: string): void {
  void ui.info(`Exported ${nameOf(target)}.${extra}`, 'Open', REVEAL).then((choice) => {
    if (choice === 'Open') void vscode.env.openExternal(target);
    else if (choice === REVEAL) void vscode.commands.executeCommand('revealFileInOS', target);
  });
}

/**
 * Asks where to save and writes the document as one self-contained HTML file. Returns the
 * file, or undefined when the dialog was cancelled. Anything that goes wrong is thrown.
 */
export async function exportHtml(document: vscode.TextDocument, context: ExportContext): Promise<vscode.Uri | undefined> {
  const target = await ui.save({ defaultUri: defaultTarget(document, 'html'), filters: { HTML: ['html', 'htm'] }, title: 'Export as HTML', saveLabel: 'Export' });
  if (!target) return undefined;
  const produced = await ui.progress(`Exporting ${nameOf(target)}…`, async () => {
    const result = await produce(document, context, 'html');
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.html, 'utf8'));
    return result;
  });
  announce(target, notes(produced, context.browser()));
  return target;
}

/**
 * Asks where to save and writes the document as a PDF, printed by an installed browser.
 * Without one it says so and offers the setting; it never falls back to anything else.
 */
export async function exportPdf(document: vscode.TextDocument, context: ExportContext): Promise<vscode.Uri | undefined> {
  const browser = context.browser();
  if (!browser.path) {
    const choice = await ui.error(
      `Export as PDF needs a Chromium-based browser (${BROWSERS}). Install one, or set the path of yours in ${BROWSER_SETTING}. ${browser.reason}`,
      'Open Setting',
    );
    if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', BROWSER_SETTING);
    return undefined;
  }
  const target = await ui.save({ defaultUri: defaultTarget(document, 'pdf'), filters: { PDF: ['pdf'] }, title: 'Export as PDF', saveLabel: 'Export' });
  if (!target) return undefined;
  const produced = await ui.progress(`Creating ${nameOf(target)}…`, async () => {
    const result = await produce(document, context, 'pdf');
    // The browser hands the PDF over in memory, so the target can be on any file system.
    await vscode.workspace.fs.writeFile(target, result.pdf!);
    return result;
  });
  announce(target, notes(produced, browser));
  return target;
}
