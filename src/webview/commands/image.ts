// Giving an image a width. Markdown has no syntax for that, so the image becomes an
// `<img>` tag; an image that already is one only has its `width` attribute changed.
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { escapeAttr, imgTags, setAttr } from '../htmlTag';
import { linkInfo } from '../links';

export const MIN_IMAGE_WIDTH = 24;

export interface ImageSource {
  from: number;
  to: number;
  /** The Markdown image node, or null for an `<img>` tag. */
  node: SyntaxNode | null;
}

/** The image whose source ends at `pos`, which is where its picture is drawn. */
export function imageSourceEndingAt(state: EditorState, pos: number): ImageSource | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Image' && n.to === pos) return { from: n.from, to: n.to, node: n };
    if (n.name === 'HTMLTag' || n.name === 'HTMLBlock') {
      const text = state.doc.sliceString(n.from, n.to);
      const re = imgTags();
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const from = n.from + m.index;
        if (from + m[0].length === pos) return { from, to: pos, node: null };
      }
    }
  }
  return null;
}

function markdownImageAsTag(state: EditorState, node: SyntaxNode, width: number): string | null {
  const info = linkInfo(state, node);
  if (!info || info.href === null) return null;
  const doc = state.doc;
  const plain = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const titleNode = node.getChild('LinkTitle');
  const title = titleNode ? plain(doc.sliceString(titleNode.from + 1, titleNode.to - 1)) : '';
  let tag = `<img src="${escapeAttr(info.href)}" alt="${escapeAttr(plain(doc.sliceString(info.textFrom, info.textTo)))}"`;
  if (title) tag += ` title="${escapeAttr(title)}"`;
  return `${tag} width="${width}">`;
}

/** The change that gives the image ending at `pos` a width in pixels. */
export function resizeImage(state: EditorState, pos: number, width: number): { from: number; to: number; insert: string } | null {
  const source = imageSourceEndingAt(state, pos);
  if (!source) return null;
  const px = Math.max(MIN_IMAGE_WIDTH, Math.round(width));
  const doc = state.doc;
  if (!source.node) {
    const tag = doc.sliceString(source.from, source.to);
    const insert = setAttr(tag, 'width', String(px));
    return insert === tag ? null : { from: source.from, to: source.to, insert };
  }
  let insert = markdownImageAsTag(state, source.node, px);
  if (insert === null) return null;
  // A tag alone on the first line of a paragraph starts an HTML block that runs to the next
  // blank line. A blank line after it keeps the following lines Markdown.
  const line = doc.lineAt(source.from);
  const paragraph = source.node.parent;
  const startsBlock = paragraph?.name === 'Paragraph' && paragraph.from === source.from && paragraph.to > line.to;
  const alone = source.to <= line.to && line.text.slice(0, source.from - line.from).trim() === '' && line.text.slice(source.to - line.from).trim() === '';
  if (startsBlock && alone) insert += '\n';
  return { from: source.from, to: source.to, insert };
}
