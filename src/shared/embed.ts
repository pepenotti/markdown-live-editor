// Decisions about embedding images in an exported file. Pure code, so every rule can be tested:
// which sources name a local file, where that file is, whether it may be read, and whether
// what was read really is an image.

/** One image is embedded up to this size; larger ones keep their path. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** All embedded images of one document together. */
export const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;

/** True for an image source that names a file rather than a URL. */
export function isLocalSource(src: string): boolean {
  const s = src.trim();
  return s !== '' && !s.startsWith('#') && !s.startsWith('//') && !s.startsWith('\\\\') && !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

/** File path an image source points at: relative to the document, or to the project when it starts with a slash. */
export function sourceToPath(src: string): string {
  const path = src.trim().replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

export function imageMime(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext && Object.hasOwn(MIME, ext) ? MIME[ext] : undefined;
}

/** Resolves `.` and `..` in a slash-separated absolute path. Returns null when it climbs above the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return '/' + out.join('/');
}

/** True when `path` is `folder` or lies inside it. Both are normalized absolute paths. */
export function isInside(folder: string, path: string): boolean {
  const base = folder.replace(/\/+$/, '');
  return path === base || path.startsWith(base + '/');
}

export type ImageTarget = { path: string; mime: string } | { skip: 'not an image' | 'outside the document folder and the project' | 'no project folder' };

/**
 * Where the file of an image source is, or why it must not be read.
 *
 * A source is relative to the folder of the document, or to the project folder when it
 * starts with a slash, as in the editor. Only files with an image extension are read, and
 * only inside `roots` (the folder of the document and the workspace folders: the same
 * places the editor may show images from), so `../../.ssh/id_rsa` or an image elsewhere
 * on the disk is never embedded.
 */
export function imageTarget(src: string, documentFolder: string, projectFolder: string | null, roots: readonly string[], ignoreCase = false): ImageTarget {
  const file = sourceToPath(src);
  const mime = imageMime(file);
  if (!mime) return { skip: 'not an image' };
  const base = /^[\\/]/.test(file) ? projectFolder : documentFolder;
  if (base === null) return { skip: 'no project folder' };
  const path = normalizePath(base + '/' + file);
  const fold = (p: string) => (ignoreCase ? p.toLowerCase() : p);
  if (path === null || !roots.some((root) => isInside(fold(normalizePath(root) ?? root), fold(path)))) return { skip: 'outside the document folder and the project' };
  return { path, mime };
}

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));

/** True when the bytes are an image of the given type: a file is not embedded just because of its name. */
export function looksLikeImage(bytes: Uint8Array, mime: string): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (mime) {
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/gif':
      return ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a';
    case 'image/webp':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
    case 'image/avif':
      return ascii(bytes, 4, 8) === 'ftyp' && /avif|avis|mif1|msf1/.test(ascii(bytes, 8, 32));
    case 'image/bmp':
      return ascii(bytes, 0, 2) === 'BM';
    case 'image/x-icon':
      return starts(0, 0, 1, 0) || starts(0, 0, 2, 0);
    case 'image/svg+xml': {
      // Text that opens with an <svg> element, after an optional BOM, XML declaration, doctype and comments.
      let head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).replace(/^﻿/, '');
      for (let before = ''; before !== head; ) {
        before = head;
        head = head.replace(/^\s+|^<\?[\s\S]*?\?>|^<!--[\s\S]*?-->|^<!DOCTYPE[^>]*>/i, '');
      }
      return /^<svg[\s>]/i.test(head);
    }
    default:
      return false;
  }
}
