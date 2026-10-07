// Renders the inline Markdown of a table cell to DOM nodes.
import type { SyntaxNode } from '@lezer/common';
import { GFM, parser as baseParser } from '@lezer/markdown';
import type { RenderConfig } from './config';
import { math, texOf } from './markdown';
import { escapeCell } from './table/model';
import { renderMath } from './widgets/rendered';

const parser = baseParser.configure([GFM, math]);

export function stripUrl(raw: string): string {
  const s = raw.trim();
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

export function renderInline(cellText: string, cfg: RenderConfig): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (cellText === '') return frag;
  // Parsing the text as a one-cell table keeps block syntax such as "# " or "- " literal.
  const src = `|${escapeCell(cellText)}|\n|-|`;
  const tree = parser.parse(src);
  const cell = tree.topNode.getChild('Table')?.getChild('TableHeader')?.getChild('TableCell');
  if (!cell) {
    frag.append(cellText);
    return frag;
  }
  frag.append(...children(cell, src, cell.from, cell.to, cfg));
  return frag;
}

function children(node: SyntaxNode, src: string, from: number, to: number, cfg: RenderConfig): Node[] {
  const out: Node[] = [];
  let pos = from;
  const text = (a: number, b: number) => {
    if (b > a) out.push(document.createTextNode(src.slice(a, b)));
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from < pos || child.to > to) continue;
    text(pos, child.from);
    pos = child.to;
    if (child.name.endsWith('Mark')) continue;
    out.push(...render(child, src, cfg));
  }
  text(pos, to);
  return out;
}

function el(tag: string, kids: Node[], className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...kids);
  return e;
}

function render(node: SyntaxNode, src: string, cfg: RenderConfig): Node[] {
  const raw = src.slice(node.from, node.to);
  switch (node.name) {
    case 'Emphasis':
      return [el('em', children(node, src, node.from, node.to, cfg))];
    case 'StrongEmphasis':
      return [el('strong', children(node, src, node.from, node.to, cfg))];
    case 'Strikethrough':
      return [el('del', children(node, src, node.from, node.to, cfg))];
    case 'InlineCode': {
      const marks = node.getChildren('CodeMark');
      const inner = marks.length >= 2 ? src.slice(marks[0].to, marks[marks.length - 1].from) : raw;
      return [el('code', [document.createTextNode(inner)], 'cm-md-code')];
    }
    case 'Link': {
      const marks = node.getChildren('LinkMark');
      if (marks.length < 3) return [document.createTextNode(raw)];
      const a = el('span', children(node, src, marks[0].to, marks[1].from, cfg), 'cm-md-link');
      const url = node.getChild('URL');
      if (url) a.title = stripUrl(src.slice(url.from, url.to));
      return [a];
    }
    case 'Image': {
      const marks = node.getChildren('LinkMark');
      const url = node.getChild('URL');
      if (marks.length < 3 || !url) return [document.createTextNode(raw)];
      const img = document.createElement('img');
      img.className = 'cm-md-cell-image';
      img.alt = src.slice(marks[0].to, marks[1].from);
      img.draggable = false;
      img.src = cfg.resolveUrl(stripUrl(src.slice(url.from, url.to)));
      return [img];
    }
    case 'Autolink':
    case 'URL': {
      const url = node.name === 'Autolink' ? node.getChild('URL') : node;
      const t = url ? src.slice(url.from, url.to) : raw;
      const a = el('span', [document.createTextNode(t)], 'cm-md-link');
      a.title = t;
      return [a];
    }
    case 'InlineMath': {
      const span = el('span', [], 'cm-md-math');
      renderMath(span, texOf(raw), raw.startsWith('$$'));
      return [span];
    }
    case 'Escape':
      return [document.createTextNode(raw.slice(1))];
    case 'HTMLTag':
      return /^<br\s*\/?>$/i.test(raw) ? [document.createElement('br')] : [document.createTextNode(raw)];
    default:
      return [document.createTextNode(raw)];
  }
}
