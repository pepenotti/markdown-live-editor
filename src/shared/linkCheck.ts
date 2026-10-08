// Broken link checking, the part that needs neither an editor nor a file system:
// finding the links and headings of a document, resolving what can be resolved inside
// the document, and wording the findings. Used by the webview and the extension host.
import { IterMode, type SyntaxNode, type Tree } from '@lezer/common';
import { markdownParser, wikiMarkdownParser } from './markdownSyntax';
import { extractHeadings, headingSlugs, slugify } from './textUtil';
import { parseWikiLink } from './wikiLinks';

export interface LinkOccurrence {
  /** What gets underlined: the whole link or image, or the URL of a definition. */
  from: number;
  to: number;
  /** wiki: a `[[Note#Heading]]` link, which only exists while wiki links are turned on. */
  kind: 'link' | 'image' | 'definition' | 'wiki';
  /**
   * Target as written, or null for a reference link whose label has no definition.
   * For a wiki link: what stands before the `|`, a note name and perhaps a heading.
   */
  href: string | null;
  /** Where `href` is written. -1 when there is none. */
  hrefFrom: number;
  /** Label of a reference link without a definition, as written. */
  label?: string;
}

export interface HeadingAnchor {
  /** Start of the heading in the document. */
  from: number;
  text: string;
  /** GitHub-style slug from `headingSlugs`, numbered when the heading repeats. */
  slug: string;
}

export interface DocumentScan {
  links: LinkOccurrence[];
  headings: HeadingAnchor[];
  /** `id` and `name` attributes of raw HTML, which are anchors too. */
  htmlIds: string[];
  /**
   * Slugs as the table of contents numbers them (`extractHeadings`, which reads lines and
   * so skips headings inside quotes and lists). Accepted as well, so a generated table of
   * contents is never reported even where the two ways of counting repeats differ.
   */
  lineSlugs: string[];
}

/** The part of a scan that says which anchors a document has. */
export type Anchors = Pick<DocumentScan, 'headings' | 'htmlIds' | 'lineSlugs'>;

/** A link target that points at a file, split and decoded. */
export interface Target {
  /** Empty for a link to a heading of the same document. For a wiki link, the note name. */
  path: string;
  anchor: string;
  /** Set for the target of a wiki link: `path` is a note name to look up, not a file path. */
  wiki?: boolean;
}

/** note: no note has that name. ambiguous: several have, and nothing settles which is meant. */
export type LinkIssue = { reason: 'file' } | { reason: 'anchor'; suggestion?: string } | { reason: 'note' } | { reason: 'ambiguous' };

export interface Fix {
  from: number;
  to: number;
  insert: string;
  title: string;
}

export interface Finding {
  from: number;
  to: number;
  message: string;
  reason: 'file' | 'anchor' | 'definition' | 'note' | 'ambiguous';
  fix?: Fix;
}

export interface Analysis {
  /** Findings that need no file system: missing definitions and headings of this document. */
  local: Finding[];
  /** Distinct targets whose files have to be looked at. */
  targets: Target[];
  /** For every link that points at a file, the index of its target in `targets`. */
  pending: { link: LinkOccurrence; target: number }[];
}

export const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i;

/** @param wikiLinks parse `[[Note]]` as a wiki link, as the editor does while that setting is on. */
export function parseMarkdown(text: string, wikiLinks = false): Tree {
  return (wikiLinks ? wikiMarkdownParser() : markdownParser).parse(text);
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Splits a link target into file path and anchor. Returns null for what is not checked:
 * web and mail links, any other scheme, empty targets and template placeholders.
 */
export function splitTarget(href: string): Target | null {
  const h = href.trim();
  if (h === '' || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null;
  if (/\{\{|\{%|\$\{|<%/.test(h)) return null;
  const hash = h.indexOf('#');
  let path = hash >= 0 ? h.slice(0, hash) : h;
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  const anchor = hash >= 0 ? h.slice(hash + 1) : '';
  if (path === '' && anchor === '') return null;
  return { path: decode(path), anchor: decode(anchor) };
}

function headingText(node: SyntaxNode, slice: (from: number, to: number) => string): string {
  const marks = node.getChildren('HeaderMark');
  if (node.name.startsWith('Setext')) {
    const end = marks.length ? marks[marks.length - 1].from : node.to;
    return slice(node.from, end).replace(/\s+/g, ' ').trim();
  }
  if (!marks.length) return slice(node.from, node.to).trim();
  const from = marks[0].to;
  const to = marks.length > 1 && marks[marks.length - 1].to === node.to ? marks[marks.length - 1].from : node.to;
  return slice(from, Math.max(from, to)).trim();
}

const HTML_ID = /\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;

/**
 * Collects the links, images, reference definitions and headings of a document in one
 * walk over its syntax tree. Code, math, front matter and raw HTML are not looked into.
 */
export function scanDocument(tree: Tree, text: string): DocumentScan {
  const slice = (from: number, to: number) => text.slice(from, to);
  const links: LinkOccurrence[] = [];
  const headings: HeadingAnchor[] = [];
  const htmlIds: string[] = [];
  const definitions = new Map<string, { href: string; hrefFrom: number }>();
  const references: { from: number; to: number; kind: 'link' | 'image'; key: string; label: string }[] = [];

  const hrefOf = (url: SyntaxNode): { href: string; hrefFrom: number } => {
    const raw = slice(url.from, url.to);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const bracketed = trimmed.startsWith('<') && trimmed.endsWith('>');
    return { href: bracketed ? trimmed.slice(1, -1) : trimmed, hrefFrom: url.from + lead + (bracketed ? 1 : 0) };
  };

  tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter(ref) {
      const name = ref.name;
      switch (name) {
        case 'FencedCode':
        case 'CodeBlock':
        case 'InlineCode':
        case 'FrontMatter':
        case 'BlockMath':
        case 'InlineMath':
        case 'CommentBlock':
        case 'Comment':
        case 'Autolink':
        case 'FootnoteReference':
        case 'FootnoteLabel':
          return false;

        case 'HTMLBlock':
        case 'HTMLTag': {
          const html = slice(ref.from, ref.to);
          HTML_ID.lastIndex = 0;
          for (let m = HTML_ID.exec(html); m; m = HTML_ID.exec(html)) htmlIds.push(m[1] ?? m[2] ?? m[3]);
          return false;
        }

        // Only in the tree while wiki links are turned on.
        case 'WikiLink': {
          const inner = slice(ref.from + 2, ref.to - 2);
          const bar = inner.indexOf('|');
          links.push({ from: ref.from, to: ref.to, kind: 'wiki', href: bar < 0 ? inner : inner.slice(0, bar), hrefFrom: ref.from + 2 });
          return false;
        }

        case 'LinkReference': {
          const label = ref.node.getChild('LinkLabel');
          const url = ref.node.getChild('URL');
          if (label && url) {
            const target = hrefOf(url);
            const key = normalizeLabel(slice(label.from + 1, label.to - 1));
            if (!definitions.has(key)) definitions.set(key, target);
            links.push({ from: url.from, to: url.to, kind: 'definition', ...target });
          }
          return false;
        }

        case 'Link':
        case 'Image': {
          const node = ref.node;
          const marks = node.getChildren('LinkMark');
          if (marks.length < 2) return true;
          const kind = name === 'Image' ? 'image' : 'link';
          if (marks.length >= 3) {
            const url = node.getChild('URL');
            if (url) links.push({ from: ref.from, to: ref.to, kind, ...hrefOf(url) });
          } else {
            // "[text]" on its own is only a link when a definition exists; otherwise it is plain text.
            // So is "matrix[i][j]": brackets glued to a word are indexing, not a reference.
            const labelNode = node.getChild('LinkLabel');
            if (labelNode && !(ref.from > 0 && /[\p{L}\p{N}_)\]]/u.test(text[ref.from - 1]))) {
              const written = slice(labelNode.from + 1, labelNode.to - 1);
              // "[text][^1]" is bracketed text followed by a footnote.
              if (written.startsWith('^')) return true;
              const label = written.trim() ? written : slice(marks[0].to, marks[1].from);
              references.push({ from: ref.from, to: ref.to, kind, key: normalizeLabel(label), label });
            }
          }
          return true;
        }

        default:
          if (/^(?:ATX|Setext)Heading[1-6]$/.test(name)) headings.push({ from: ref.from, text: headingText(ref.node, slice), slug: '' });
          return true;
      }
    },
  });

  // A reference link with a definition is not listed: its target is checked once, where it is written.
  for (const r of references) {
    if (!definitions.has(r.key)) links.push({ from: r.from, to: r.to, kind: r.kind, href: null, hrefFrom: -1, label: r.label });
  }
  links.sort((a, b) => a.from - b.from || a.to - b.to);
  headingSlugs(headings).forEach((slug, i) => (headings[i].slug = slug));
  return { links, headings, htmlIds, lineSlugs: headingSlugs(extractHeadings(text)) };
}

/** `scanDocument` for text that has no syntax tree yet. Expects LF line breaks. */
export function scanText(text: string, wikiLinks = false): DocumentScan {
  return scanDocument(parseMarkdown(text, wikiLinks), text);
}

/** Every anchor a link can point at in the scanned document. */
export function anchorSet(scan: Anchors): Set<string> {
  const out = new Set<string>([...scan.htmlIds, ...scan.lineSlugs]);
  for (const h of scan.headings) out.add(h.slug);
  return out;
}

function suggestable(scan: Anchors): string[] {
  return [...new Set([...scan.lineSlugs, ...scan.headings.map((h) => h.slug)])];
}

export function hasAnchor(anchors: ReadonlySet<string>, anchor: string): boolean {
  return anchor === '' || anchors.has(anchor) || anchors.has(slugify(anchor));
}

/** The heading a link to `anchor` points at, by the same rules as `hasAnchor`. */
export function findHeading(headings: readonly HeadingAnchor[], anchor: string): HeadingAnchor | undefined {
  const wanted = slugify(anchor);
  return headings.find((h) => h.slug === wanted || h.slug === anchor);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** The existing slug a mistyped anchor most likely meant, if one is close enough. */
export function closestSlug(anchor: string, slugs: readonly string[]): string | undefined {
  const wanted = slugify(anchor);
  if (wanted === '') return undefined;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const slug of slugs) {
    if (slug === '' || slug === wanted) continue;
    const longer = Math.max(slug.length, wanted.length);
    const shorter = Math.min(slug.length, wanted.length);
    // Cheap bound first: the distance is at least the difference in length.
    const limit = Math.max(2, Math.floor(longer * 0.34));
    const prefix = shorter >= 3 && (slug.startsWith(wanted) || wanted.startsWith(slug));
    if (!prefix && longer - shorter > limit) continue;
    const distance = editDistance(wanted, slug);
    if (!prefix && (distance > limit || distance >= shorter)) continue;
    // A prefix match is a weaker hint than a near-identical slug.
    const score = prefix ? Math.min(distance, limit + 0.5) : distance;
    if (score < bestScore) {
      bestScore = score;
      best = slug;
    }
  }
  return best;
}

function anchorFix(link: LinkOccurrence, suggestion: string | undefined): Fix | undefined {
  if (!suggestion || link.href === null || link.hrefFrom < 0) return undefined;
  const hash = link.href.indexOf('#');
  if (hash < 0) return undefined;
  return { from: link.hrefFrom + hash + 1, to: link.hrefFrom + link.href.length, insert: suggestion, title: `Change to "#${suggestion}"` };
}

export function issueMessage(target: Target, issue: LinkIssue): string {
  if (issue.reason === 'file') return `File not found: ${target.path}`;
  if (issue.reason === 'note') return `No note called "${target.path}"`;
  if (issue.reason === 'ambiguous') return `Several notes are called "${target.path}"`;
  return `No heading "${target.anchor}" in ${target.path || 'this document'}`;
}

/** Works out what is wrong inside the document itself and which files have to be checked. */
export function analyse(scan: DocumentScan): Analysis {
  const local: Finding[] = [];
  const targets: Target[] = [];
  const pending: Analysis['pending'] = [];
  const index = new Map<string, number>();
  let anchors: Set<string> | undefined;
  let slugs: string[] | undefined;
  for (const link of scan.links) {
    if (link.href === null) {
      local.push({ from: link.from, to: link.to, message: `No definition for [${link.label ?? ''}]`, reason: 'definition' });
      continue;
    }
    let target: Target | null;
    if (link.kind === 'wiki') {
      const parts = parseWikiLink(link.href);
      target = { path: parts.target, anchor: parts.heading, wiki: true };
      // "[[#Heading]]" is checked below like "[x](#heading)"; "[[Note]]" is looked up by the host.
      if (target.path === '' && target.anchor === '') continue;
    } else {
      target = splitTarget(link.href);
    }
    if (!target) continue;
    if (target.path === '') {
      anchors ??= anchorSet(scan);
      if (hasAnchor(anchors, target.anchor)) continue;
      slugs ??= suggestable(scan);
      const issue: LinkIssue = { reason: 'anchor', suggestion: closestSlug(target.anchor, slugs) };
      local.push({ from: link.from, to: link.to, message: issueMessage(target, issue), reason: 'anchor', fix: anchorFix(link, issue.suggestion) });
      continue;
    }
    const key = `${target.wiki ? 'wiki' : ''}\n${target.path}\n${target.anchor}`;
    let at = index.get(key);
    if (at === undefined) {
      at = targets.length;
      targets.push(target);
      index.set(key, at);
    }
    pending.push({ link, target: at });
  }
  return { local, targets, pending };
}

/** All findings of a document, once the files have been looked at. `issues` runs parallel to `analysis.targets`. */
export function withIssues(analysis: Analysis, issues: readonly (LinkIssue | null | undefined)[]): Finding[] {
  const out = [...analysis.local];
  for (const { link, target } of analysis.pending) {
    const issue = issues[target];
    if (!issue) continue;
    out.push({
      from: link.from,
      to: link.to,
      message: issueMessage(analysis.targets[target], issue),
      reason: issue.reason,
      fix: issue.reason === 'anchor' ? anchorFix(link, issue.suggestion) : undefined,
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Checks an anchor against the text of the Markdown file a link points at. */
export function checkAnchor(scan: Anchors, anchor: string): LinkIssue | null {
  if (hasAnchor(anchorSet(scan), anchor)) return null;
  return {
    reason: 'anchor',
    suggestion: closestSlug(anchor, suggestable(scan)),
  };
}

/** Offsets of the line starts of LF text, for turning offsets into line and character. */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

export function positionIn(starts: readonly number[], offset: number): { line: number; ch: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, ch: offset - starts[low] };
}
