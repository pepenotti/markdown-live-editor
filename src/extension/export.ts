// Export to HTML and PDF. The rendering is in src/shared/exportHtml.ts; this file reads
// images, asks where to save, and drives a browser for the PDF.
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { imageMime, localImageSources, renderDocument, sourceToPath } from '../shared/exportHtml';
import { installedBrowser, printToPdf } from './pdf';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface Built {
  html: string;
  /** Local images that could not be embedded. */
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

/** Reads the local images of a document as data URIs, keyed by their source. */
async function embedImages(document: vscode.TextDocument, text: string): Promise<{ images: Map<string, string>; missing: string[] }> {
  const images = new Map<string, string>();
  const missing: string[] = [];
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
  await Promise.all(
    localImageSources(text).map(async (src) => {
      const file = sourceToPath(src);
      const mime = imageMime(file);
      // Like in the editor, a leading slash means the project folder.
      const base = file.startsWith('/') ? root : vscode.Uri.joinPath(document.uri, '..');
      try {
        if (!mime || !base || document.uri.scheme === 'untitled') throw new Error('not an image file that can be read');
        const uri = vscode.Uri.joinPath(base, file);
        if ((await vscode.workspace.fs.stat(uri)).size > MAX_IMAGE_BYTES) throw new Error('too large');
        const bytes = await vscode.workspace.fs.readFile(uri);
        images.set(src, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
      } catch {
        missing.push(src);
      }
    }),
  );
  return { images, missing: missing.sort() };
}

async function build(document: vscode.TextDocument, options: { print: boolean; embed: boolean }): Promise<Built> {
  const text = document.getText();
  const { images, missing } = options.embed ? await embedImages(document, text) : { images: new Map<string, string>(), missing: [] };
  const { html, hasMermaid } = renderDocument(text, {
    images,
    mermaid: settings(document).get<boolean>('mermaidFromCdn', false),
    fallbackTitle: stemOf(document),
    print: options.print,
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
export async function exportHtml(document: vscode.TextDocument, target?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const asked = target === undefined;
  target ??= await vscode.window.showSaveDialog({
    defaultUri: defaultTarget(document, 'html'),
    filters: { HTML: ['html', 'htm'] },
    title: 'Export as HTML',
    saveLabel: 'Export',
  });
  if (!target) return undefined;
  const { html, missing } = await build(document, { print: false, embed: settings(document).get<boolean>('embedImages', true) });
  await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
  if (asked) {
    const saved = target;
    void vscode.window.showInformationMessage(`Exported ${nameOf(saved)}.${missingNote(missing)}`, 'Open in Browser').then((choice) => {
      if (choice) void vscode.env.openExternal(saved);
    });
  }
  return target;
}

/** The browser that can print to PDF: the configured one, or the first found at a well-known path. */
function findBrowser(document: vscode.TextDocument): string | undefined {
  const configured = settings(document).get<string>('browserPath', '').trim();
  if (!configured) return installedBrowser();
  if (existsSync(configured)) return configured;
  void vscode.window.showWarningMessage(`The browser set in seamlessMarkdown.export.browserPath does not exist: ${configured}`);
  return undefined;
}

async function createPdf(document: vscode.TextDocument, browser: string, htmlFile: string, waitForScripts: boolean): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultTarget(document, 'pdf'),
    filters: { PDF: ['pdf'] },
    title: 'Export as PDF',
    saveLabel: 'Export',
  });
  if (!target) return;
  // The browser writes to a temporary file, so the target can be on any file system.
  const pdfFile = htmlFile.replace(/\.html$/, '.pdf');
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${nameOf(target)}…` }, async () => {
      await printToPdf(browser, htmlFile, pdfFile, waitForScripts);
      await vscode.workspace.fs.writeFile(target, await fs.readFile(pdfFile));
    });
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `The PDF could not be created: ${err instanceof Error ? err.message : String(err)}`,
      'Open in Browser',
    );
    if (choice) await vscode.env.openExternal(vscode.Uri.file(htmlFile));
    return;
  } finally {
    await fs.rm(pdfFile, { force: true }).catch(() => undefined);
  }
  const choice = await vscode.window.showInformationMessage(`Exported ${nameOf(target)}.`, 'Open');
  if (choice) await vscode.env.openExternal(target);
}

/**
 * Writes a print version of the document to a temporary HTML file. The browser turns it
 * into a PDF: the user's own through Print, or a Chrome, Edge or Chromium found on this machine, headless.
 */
export async function exportPdf(document: vscode.TextDocument): Promise<void> {
  // The temporary file is not next to the document, so images are always embedded.
  const { html, missing, hasMermaid } = await build(document, { print: true, embed: true });
  const dir = path.join(os.tmpdir(), 'seamless-markdown-export');
  await fs.mkdir(dir, { recursive: true });
  const htmlFile = path.join(dir, `${stemOf(document).replace(/[^\p{L}\p{N}._ -]/gu, '_')}.html`);
  await fs.writeFile(htmlFile, html, 'utf8');

  const openInBrowser = () => vscode.env.openExternal(vscode.Uri.file(htmlFile));
  const hint = "Use your browser's Print → Save as PDF.";
  const browser = findBrowser(document);
  if (!browser) {
    await openInBrowser();
    void vscode.window.showInformationMessage(`The print version is open in your browser. ${hint}${missingNote(missing)}`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `The print version of ${nameOf(document.uri)} is ready. Open it in your browser and ${hint.replace(/^Use/, 'use')}${missingNote(missing)}`,
    'Open in Browser',
    'Create PDF now',
  );
  if (choice === 'Open in Browser') await openInBrowser();
  else if (choice === 'Create PDF now') {
    const waitForScripts = hasMermaid && settings(document).get<boolean>('mermaidFromCdn', false);
    await createPdf(document, browser, htmlFile, waitForScripts);
  }
}
