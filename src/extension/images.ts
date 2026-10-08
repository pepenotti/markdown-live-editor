// File handling for links and images: saving pasted pictures, choosing files,
// turning dropped URIs into relative paths, and listing files for completion.
import * as vscode from 'vscode';
import { IMAGE_EXTENSIONS, isImagePath, type LinkedFile } from '../shared/protocol';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const EXCLUDE ='**/{node_modules,.git,dist,out,build,.next,.venv,target}/**';

function dirOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

/** Relative POSIX path from one folder to a file on the same file system. */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Encodes a relative path so it can be written between the parentheses of a link. */
export function encodeForLink(path: string): string {
  return encodeURI(path).replace(/[()#?]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function linked(document: vscode.TextDocument, target: vscode.Uri): LinkedFile {
  const name = baseName(target);
  return { path: encodeForLink(relativePath(dirOf(document.uri).path, target.path)), isImage: isImagePath(name), name };
}

function imageFolder(document: vscode.TextDocument): vscode.Uri {
  const setting = vscode.workspace.getConfiguration('seamlessMarkdown', document.uri).get<string>('imageFolder', 'assets');
  const stem = baseName(document.uri).replace(/\.[^.]+$/, '');
  const folder = setting
    .replace(/\$\{fileBasenameNoExtension\}/g, stem)
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..');
  return vscode.Uri.joinPath(dirOf(document.uri), ...folder);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function uniqueTarget(folder: vscode.Uri, name: string): Promise<vscode.Uri> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = vscode.Uri.joinPath(folder, name);
  for (let n = 1; await exists(candidate); n++) candidate = vscode.Uri.joinPath(folder, `${stem}-${n}${ext}`);
  return candidate;
}

function cleanName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/[^\w.\- ]+/g, '-').trim();
  const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase();
  const safeExt = ext && IMAGE_EXTENSIONS.includes(ext) ? ext : 'png';
  const stem = base.replace(/\.[^.]*$/, '');
  // Clipboard images arrive with a generic name; give them a dated one.
  if (!stem || /^image$/i.test(stem)) {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    return `image-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.${safeExt}`;
  }
  return `${stem}.${safeExt}`;
}

/** Writes a pasted or dropped image into the image folder next to the document. */
export async function saveImage(document: vscode.TextDocument, name: string, base64: string): Promise<LinkedFile> {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error('The image is empty.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The image is larger than 25 MB.');
  const folder = imageFolder(document);
  await vscode.workspace.fs.createDirectory(folder);
  const target = await uniqueTarget(folder, cleanName(name));
  await vscode.workspace.fs.writeFile(target, bytes);
  return linked(document, target);
}

/** True when a relative link from the document to `target` stays inside the project. */
function reachable(document: vscode.TextDocument, target: vscode.Uri): boolean {
  if (target.scheme !== document.uri.scheme || target.authority !== document.uri.authority) return false;
  const docFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const targetFolder = vscode.workspace.getWorkspaceFolder(target);
  if (docFolder && targetFolder && docFolder.uri.toString() === targetFolder.uri.toString()) return true;
  return target.path.startsWith(dirOf(document.uri).path + '/');
}

/** Links a file in place when it is inside the project, otherwise copies images next to the document. */
async function linkOrCopy(document: vscode.TextDocument, uri: vscode.Uri): Promise<LinkedFile> {
  if (reachable(document, uri) || !isImagePath(uri.path)) return linked(document, uri);
  const folder = imageFolder(document);
  await vscode.workspace.fs.createDirectory(folder);
  const target = await uniqueTarget(folder, cleanName(baseName(uri)));
  await vscode.workspace.fs.copy(uri, target, { overwrite: false });
  return linked(document, target);
}

export async function pickImages(document: vscode.TextDocument): Promise<LinkedFile[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    defaultUri: dirOf(document.uri),
    filters: { Images: IMAGE_EXTENSIONS },
    openLabel: 'Insert',
    title: 'Insert image',
  });
  if (!picked) return [];
  return Promise.all(picked.map((uri) => linkOrCopy(document, uri)));
}

export async function resolveUris(document: vscode.TextDocument, uris: readonly string[]): Promise<LinkedFile[]> {
  const out: LinkedFile[] = [];
  for (const text of uris.slice(0, 50)) {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(text, true);
    } catch {
      continue;
    }
    if (uri.scheme === 'http' || uri.scheme === 'https') {
      out.push({ path: text, isImage: isImagePath(uri.path), name: baseName(uri) || text });
    } else if (uri.scheme === document.uri.scheme) {
      out.push(await linkOrCopy(document, uri));
    }
  }
  return out;
}

/** Files the user is likely to link to, as paths relative to the document. */
export async function listFiles(document: vscode.TextDocument, imagesOnly: boolean): Promise<string[]> {
  const extensions = imagesOnly ? IMAGE_EXTENSIONS : ['md', 'markdown', 'pdf', ...IMAGE_EXTENSIONS];
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  let uris: vscode.Uri[];
  if (folder) {
    uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/*.{${extensions.join(',')}}`), EXCLUDE, 3000);
  } else {
    uris = [];
    const dir = dirOf(document.uri);
    const wanted = (name: string) => extensions.includes(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
        if (type === vscode.FileType.File && wanted(name)) uris.push(vscode.Uri.joinPath(dir, name));
        if (type === vscode.FileType.Directory && !name.startsWith('.') && name !== 'node_modules') {
          const sub = vscode.Uri.joinPath(dir, name);
          for (const [child, childType] of await vscode.workspace.fs.readDirectory(sub)) {
            if (childType === vscode.FileType.File && wanted(child)) uris.push(vscode.Uri.joinPath(sub, child));
          }
        }
      }
    } catch {
      // The folder cannot be listed; completion simply offers nothing.
    }
  }
  const self = document.uri.toString();
  const docDir = dirOf(document.uri).path;
  return uris
    .filter((uri) => uri.toString() !== self)
    .map((uri) => relativePath(docDir, uri.path))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map(encodeForLink);
}
