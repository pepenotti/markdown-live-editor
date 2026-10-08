// Export to HTML and PDF. The rendering is in src/shared/exportHtml.ts (loaded on demand);
// this file reads images, asks where to save, and drives a browser for the PDF.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { imageTarget, looksLikeImage, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from '../shared/embed';
import type { WikiHref } from '../shared/wikiLinkPlugin';
import { scanNote, stripNoteExtension } from '../shared/wikiLinks';
import { relativePath } from './images';
import { type NoteIndex, wikiLinksEnabled } from './notes';
import { installedBrowser, printToPdf } from './pdf';
import { renderer } from './renderer';

const TEMP_PREFIX = 'seamless-markdown-export-';
const STALE_MS = 24 * 60 * 60 * 1000;

interface Built {
  html: string;
  /** Local images that were not embedded. */
  missing: string[];
  hasMermaid: boolean;
}

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

async function build(document: vscode.TextDocument, options: { print: boolean; embed: boolean; notes?: NoteIndex }): Promise<Built> {
  const text = document.getText();
  const { images, missing } = options.embed ? await embedImages(document, text) : { images: new Map<string, string>(), missing: [] };
  const { html, hasMermaid } = renderer().renderDocument(text, {
    images,
    mermaid: settings(document).get<boolean>('mermaidFromCdn', false),
    fallbackTitle: stemOf(document),
    print: options.print,
    wikiLinks: await wikiHrefs(document, text, options.notes, !options.print),
  });
  return { html, missing, hasMermaid };
}

function missingNote(missing: readonly string[]): string {
  if (!missing.length) return '';
  const names = missing.slice(0, 3).join(', ') + (missing.length > 3 ? '…' : '');
  return ` ${missing.length === 1 ? '1 image was' : `${missing.length} images were`} not embedded (${names}).`;
}

const nameOf = (uri: vscode.Uri) => uri.path.slice(uri.path.lastIndexOf('/') + 1);

/** Writes the document as one self-contained HTML file. Without a target the user is asked for one. */
export async function exportHtml(document: vscode.TextDocument, target?: vscode.Uri, notes?: NoteIndex): Promise<vscode.Uri | undefined> {
  const asked = target === undefined;
  target ??= await vscode.window.showSaveDialog({
    defaultUri: defaultTarget(document, 'html'),
    filters: { HTML: ['html', 'htm'] },
    title: 'Export as HTML',
    saveLabel: 'Export',
  });
  if (!target) return undefined;
  const { html, missing } = await build(document, { print: false, embed: settings(document).get<boolean>('embedImages', true), notes });
  await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
  if (asked) {
    const saved = target;
    void vscode.window.showInformationMessage(`Exported ${nameOf(saved)}.${missingNote(missing)}`, 'Open in Browser').then((choice) => {
      if (choice) void vscode.env.openExternal(saved);
    });
  }
  return target;
}

/* ---------- temporary files of the PDF export ---------- */

/** Folders made in this session. Each holds one print version, readable by this user only. */
const tempFolders = new Set<string>();

function removeTempFolder(folder: string): void {
  tempFolders.delete(folder);
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {
    // Still in use; the next sweep takes it.
  }
}

/** Removes the print versions of this session. Called when the extension is deactivated. */
export function removeTempFiles(): void {
  for (const folder of [...tempFolders]) removeTempFolder(folder);
}

/** Removes print versions that an earlier session left behind (a browser may still have had them open). */
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

/* ---------- PDF ---------- */

/** The browser that can print to PDF: the configured one, or the first found at a well-known path. */
function findBrowser(document: vscode.TextDocument): string | undefined {
  const configured = settings(document).get<string>('browserPath', '').trim();
  if (!configured) return installedBrowser();
  if (existsSync(configured)) return configured;
  void vscode.window.showWarningMessage(`The browser set in seamlessMarkdown.export.browserPath does not exist: ${configured}`);
  return undefined;
}

/** Returns true when the PDF was written. */
async function createPdf(document: vscode.TextDocument, browser: string, htmlFile: string, waitForScripts: boolean, open: Opener): Promise<boolean> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultTarget(document, 'pdf'),
    filters: { PDF: ['pdf'] },
    title: 'Export as PDF',
    saveLabel: 'Export',
  });
  if (!target) return true;
  // The browser writes to a temporary file, so the target can be on any file system.
  const pdfFile = htmlFile.replace(/\.html$/, '.pdf');
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${nameOf(target)}…` }, async () => {
      await printToPdf(browser, htmlFile, pdfFile, waitForScripts);
      await vscode.workspace.fs.writeFile(target, await fs.readFile(pdfFile));
    });
  } catch (err) {
    // For example a browser that does not start, or a target that is open elsewhere or cannot be written.
    const choice = await vscode.window.showErrorMessage(
      `The PDF could not be created: ${err instanceof Error ? err.message : String(err)}`,
      'Open in Browser',
    );
    if (!choice) return true;
    await open(vscode.Uri.file(htmlFile));
    return false;
  } finally {
    await fs.rm(pdfFile, { force: true }).catch(() => undefined);
  }
  void vscode.window.showInformationMessage(`Exported ${nameOf(target)}.`, 'Open').then((choice) => {
    if (choice) void open(target);
  });
  return true;
}

type Opener = (uri: vscode.Uri) => Thenable<unknown>;

export interface PdfOptions {
  /** Path of the browser that prints, or null for none. Left out, it is looked for. */
  browser?: string | null;
  /** Opens a file in the user's browser. */
  open?: Opener;
  /** The notes of the workspace, so wiki links are exported as their text while they are turned on. */
  notes?: NoteIndex;
}

/**
 * Writes a print version of the document to a temporary HTML file. The browser turns it
 * into a PDF: the user's own through Print, or a Chrome, Edge or Chromium found on this machine, headless.
 * Returns the path of the print version when it was handed to the browser.
 */
export async function exportPdf(document: vscode.TextDocument, options: PdfOptions = {}): Promise<string | undefined> {
  const open = options.open ?? ((uri: vscode.Uri) => vscode.env.openExternal(uri));
  sweepStaleTempFolders();
  // The temporary file is not next to the document, so images are always embedded.
  const { html, missing, hasMermaid } = await build(document, { print: true, embed: true, notes: options.notes });
  // A folder of its own that only this user can read: the file holds the whole document.
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  tempFolders.add(folder);
  const htmlFile = path.join(folder, `${stemOf(document).replace(/[^\p{L}\p{N}._ -]/gu, '_')}.html`);
  await fs.writeFile(htmlFile, html, { encoding: 'utf8', mode: 0o600 });

  const hint = "Use your browser's Print → Save as PDF.";
  const browser = options.browser === undefined ? findBrowser(document) : options.browser;
  if (!browser) {
    await open(vscode.Uri.file(htmlFile));
    void vscode.window.showInformationMessage(`The print version is open in your browser. ${hint}${missingNote(missing)}`);
    return htmlFile;
  }
  const choice = await vscode.window.showInformationMessage(
    `The print version of ${nameOf(document.uri)} is ready. Open it in your browser and ${hint.replace(/^Use/, 'use')}${missingNote(missing)}`,
    'Open in Browser',
    'Create PDF now',
  );
  if (choice === 'Open in Browser') {
    await open(vscode.Uri.file(htmlFile));
    return htmlFile;
  }
  let finished = true;
  if (choice === 'Create PDF now') {
    const waitForScripts = hasMermaid && settings(document).get<boolean>('mermaidFromCdn', false);
    finished = await createPdf(document, browser, htmlFile, waitForScripts, open);
  }
  // Nothing has the print version open, so it does not stay behind.
  if (finished) removeTempFolder(folder);
  return finished ? undefined : htmlFile;
}
