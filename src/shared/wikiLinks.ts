// Wiki links (`[[Note]]`, `[[Note#Heading|shown text]]`): parsing, resolving a note name
// to a file, and finding the links of a note. Pure, so the extension host, the webview
// and the tests share it. Paths are absolute POSIX paths (the `path` of a URI).

export const NOTE_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'];
const NOTE_EXTENSION = /\.(?:md|markdown|mdown|mkd)$/i;

export function isNotePath(path: string): boolean {
  return NOTE_EXTENSION.test(path);
}

export function stripNoteExtension(path: string): string {
  return path.replace(NOTE_EXTENSION, '');
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Joins a relative path onto a folder and resolves `.` and `..`. */
export function joinPath(dir: string, relative: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${relative}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

export interface WikiLinkParts {
  /** Note name or path. Empty for a link to a heading of the same note (`[[#Heading]]`). */
  target: string;
  heading: string;
  /** Text shown instead of the target. Empty when the link has none. */
  alias: string;
}

/** Splits the text between `[[` and `]]`. */
export function parseWikiLink(inner: string): WikiLinkParts {
  const bar = inner.indexOf('|');
  const left = bar < 0 ? inner : inner.slice(0, bar);
  const hash = left.indexOf('#');
  return {
    target: (hash < 0 ? left : left.slice(0, hash)).trim(),
    heading: hash < 0 ? '' : left.slice(hash + 1).trim(),
    alias: bar < 0 ? '' : inner.slice(bar + 1).trim(),
  };
}

/** Writes a wiki link, dropping characters that would end it early. */
export function formatWikiLink(parts: WikiLinkParts): string {
  const clean = (s: string, extra: RegExp) => s.replace(/[\[\]\r\n]/g, ' ').replace(extra, ' ').trim();
  const target = clean(parts.target, /[|#]/g);
  const heading = clean(parts.heading, /\|/g);
  const alias = clean(parts.alias, /$^/g);
  return `[[${target}${heading ? '#' + heading : ''}${alias ? '|' + alias : ''}]]`;
}

export type NoteStatus = 'found' | 'missing' | 'ambiguous';

export type Resolution = { status: 'found'; path: string } | { status: 'missing' } | { status: 'ambiguous'; paths: string[] };

/** The Markdown files that note names are resolved against. */
export class NoteSet {
  private readonly paths = new Set<string>();
  /** Lower-case file name without extension → paths. */
  private readonly byName = new Map<string, Set<string>>();

  private static key(path: string): string {
    return stripNoteExtension(baseName(path)).toLowerCase();
  }

  get size(): number {
    return this.paths.size;
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  all(): IterableIterator<string> {
    return this.paths.values();
  }

  /** Returns true when the path was not known yet. */
  add(path: string): boolean {
    if (this.paths.has(path)) return false;
    this.paths.add(path);
    const key = NoteSet.key(path);
    let same = this.byName.get(key);
    if (!same) this.byName.set(key, (same = new Set()));
    same.add(path);
    return true;
  }

  delete(path: string): boolean {
    if (!this.paths.delete(path)) return false;
    const key = NoteSet.key(path);
    const same = this.byName.get(key);
    same?.delete(path);
    if (same?.size === 0) this.byName.delete(key);
    return true;
  }

  clear(): void {
    this.paths.clear();
    this.byName.clear();
  }

  /**
   * Finds the file a note name stands for, seen from the note at `fromPath`:
   * an exact relative path first (from the note's folder, then from a root folder),
   * then the only file with that name, compared without case and extension. When
   * several files share the name, the one in the note's own folder wins.
   */
  resolve(name: string, fromPath: string, roots: readonly string[]): Resolution {
    const wanted = name.trim().replace(/\\/g, '/');
    const relative = wanted.replace(/^\/+/, '');
    if (!relative) return { status: 'missing' };
    const fromDir = dirName(fromPath);
    const hasExtension = isNotePath(relative);

    for (const base of wanted.startsWith('/') ? roots : [fromDir, ...roots]) {
      const exact = joinPath(base, relative);
      if (hasExtension) {
        if (this.paths.has(exact)) return { status: 'found', path: exact };
      } else {
        for (const ext of NOTE_EXTENSIONS) if (this.paths.has(`${exact}.${ext}`)) return { status: 'found', path: `${exact}.${ext}` };
      }
    }

    const stem = stripNoteExtension(relative).toLowerCase();
    const extension = hasExtension ? relative.slice(relative.lastIndexOf('.')).toLowerCase() : '';
    let candidates = [...(this.byName.get(baseName(stem)) ?? [])];
    if (stem.includes('/')) candidates = candidates.filter((p) => stripNoteExtension(p).toLowerCase().endsWith('/' + stem));
    if (extension) candidates = candidates.filter((p) => p.toLowerCase().endsWith(extension));
    if (candidates.length === 0) return { status: 'missing' };
    if (candidates.length === 1) return { status: 'found', path: candidates[0] };
    const beside = candidates.filter((p) => dirName(p) === fromDir);
    if (beside.length === 1) return { status: 'found', path: beside[0] };
    return { status: 'ambiguous', paths: candidates.sort() };
  }

  /** The shortest name that leads to this note: its file name, or its path when the name is taken twice. */
  nameOf(path: string, root: string): string {
    const stem = stripNoteExtension(path);
    if ((this.byName.get(NoteSet.key(path))?.size ?? 0) <= 1) return baseName(stem);
    const prefix = root.replace(/\/+$/, '') + '/';
    return stem.startsWith(prefix) ? stem.slice(prefix.length) : baseName(stem);
  }
}

export interface NoteLink {
  /** Zero-based line of the link. */
  line: number;
  /** wiki: a note name. path: the target of a standard Markdown link to a Markdown file. */
  kind: 'wiki' | 'path';
  target: string;
}

export interface ScannedNote {
  links: NoteLink[];
  /** Text of every line that has a link, trimmed, for showing in a list. */
  lines: Map<number, string>;
  headings: string[];
}

const WIKI = /\[\[([^\[\]\n]+)\]\]/g;
const INLINE_TARGET = /\]\(\s*(<[^>\n]*>|[^)\s]+)/g;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** A link target as a path to a Markdown file, or null for web links, anchors and other files. */
function notePathOf(href: string): string | null {
  let path = href.startsWith('<') && href.endsWith('>') ? href.slice(1, -1) : href;
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(path)) return null;
  path = path.replace(/[?#].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the path as written.
  }
  return isNotePath(path) ? path : null;
}

/** Links to other notes and the headings of a Markdown text. Code and front matter are skipped. */
export function scanNote(text: string): ScannedNote {
  const out: ScannedNote = { links: [], lines: new Map(), headings: [] };
  const lines = text.split(/\r\n?|\n/);
  let fence: string | null = null;
  let i = 0;
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j])) {
        i = j + 1;
        break;
      }
    }
  }
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(raw)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = HEADING.exec(raw);
    if (h) out.headings.push(h[2].replace(/[*_`~]/g, '').trim());
    if (!raw.includes('[')) continue;
    // Inline code is blanked out so links inside it do not count.
    const line = raw.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
    const before = out.links.length;
    for (const m of line.matchAll(WIKI)) {
      const target = parseWikiLink(m[1]).target;
      if (target) out.links.push({ line: i, kind: 'wiki', target });
    }
    const definition = DEFINITION.exec(line);
    const hrefs = [...line.matchAll(INLINE_TARGET)].map((m) => m[1]);
    if (definition) hrefs.push(definition[1]);
    for (const href of hrefs) {
      const target = notePathOf(href);
      if (target) out.links.push({ line: i, kind: 'path', target });
    }
    if (out.links.length > before) out.lines.set(i, raw.trim().slice(0, 240));
  }
  return out;
}

/** True when a link written in the note at `fromPath` leads to `targetPath`. */
export function linkLeadsTo(link: NoteLink, fromPath: string, targetPath: string, notes: NoteSet, roots: readonly string[]): boolean {
  if (link.kind === 'wiki') {
    const found = notes.resolve(link.target, fromPath, roots);
    return found.status === 'found' && found.path === targetPath;
  }
  if (link.target.startsWith('/')) return roots.some((root) => joinPath(root, link.target) === targetPath);
  return joinPath(dirName(fromPath), link.target) === targetPath;
}

/** Cheap test that rules out most links before they are resolved. */
export function mayLeadTo(link: NoteLink, targetPath: string): boolean {
  const last = baseName(link.target.replace(/\\/g, '/')).toLowerCase();
  const file = baseName(targetPath).toLowerCase();
  return last === file || (link.kind === 'wiki' && last === stripNoteExtension(file));
}
