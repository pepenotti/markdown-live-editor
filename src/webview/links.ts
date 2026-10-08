// What links, images and footnotes in the document point at.
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { stripUrl } from './inlineRender';
import { footnoteId } from './markdown';

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface LinkDefinition {
  href: string;
  /** Range of the URL as written in the definition. */
  from: number;
  to: number;
}

const definitionCache = new WeakMap<Tree, Map<string, LinkDefinition>>();

/** Reference definitions (`[label]: url`) of the document. */
export function linkDefinitions(state: EditorState): Map<string, LinkDefinition> {
  const tree = syntaxTree(state);
  let defs = definitionCache.get(tree);
  if (defs) return defs;
  defs = new Map();
  const found = defs;
  tree.iterate({
    enter(node) {
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel');
        const url = node.node.getChild('URL');
        if (label && url) {
          const key = normalizeLabel(state.doc.sliceString(label.from + 1, label.to - 1));
          if (!found.has(key)) found.set(key, { href: stripUrl(state.doc.sliceString(url.from, url.to)), from: url.from, to: url.to });
        }
        return false;
      }
      return node.name === 'Document' || node.name === 'Blockquote' || node.name.endsWith('List') || node.name === 'ListItem';
    },
  });
  definitionCache.set(tree, defs);
  return defs;
}

export interface LinkInfo {
  /** Target, or null when the brackets are not a link at all. */
  href: string | null;
  /** Range of the visible text between the brackets. */
  textFrom: number;
  textTo: number;
  url: SyntaxNode | null;
  /** True for `[text](url)`, false for reference links. */
  inline: boolean;
  /** For reference links: the `[label]: url` definition the target comes from. */
  definition: LinkDefinition | null;
}

export interface Footnotes {
  /** Number of each footnote that is both referenced and defined, in the order of first reference. */
  numbers: Map<string, number>;
  /** Start of the text of each definition. */
  definitions: Map<string, number>;
  /** Position of the first reference to each footnote. */
  references: Map<string, number>;
}

const footnoteCache = new WeakMap<Tree, Footnotes>();

/** The footnotes of the document. */
export function footnotes(state: EditorState): Footnotes {
  const tree = syntaxTree(state);
  let notes = footnoteCache.get(tree);
  if (notes) return notes;
  const found: Footnotes = { numbers: new Map(), definitions: new Map(), references: new Map() };
  const doc = state.doc;
  tree.iterate({
    enter(node) {
      if (node.name === 'FootnoteReference') {
        const id = footnoteId(doc.sliceString(node.from, node.to));
        if (!found.references.has(id)) found.references.set(id, node.from);
        return false;
      }
      if (node.name === 'FootnoteLabel') {
        const id = footnoteId(doc.sliceString(node.from, node.to));
        if (!found.definitions.has(id)) found.definitions.set(id, Math.min(doc.lineAt(node.to).to, node.to + 1));
        return false;
      }
      return node.name !== 'FencedCode' && node.name !== 'CodeBlock' && node.name !== 'InlineCode';
    },
  });
  for (const id of found.references.keys()) if (found.definitions.has(id)) found.numbers.set(id, found.numbers.size + 1);
  notes = found;
  footnoteCache.set(tree, notes);
  return notes;
}

/** The footnote reference or definition label that contains or touches `pos`. */
export function footnoteAt(state: EditorState, pos: number): { id: string; reference: boolean } | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'FootnoteReference' || n.name === 'FootnoteLabel') {
        return { id: footnoteId(state.doc.sliceString(n.from, n.to)), reference: n.name === 'FootnoteReference' };
      }
    }
  }
  return null;
}

/** Works out the target of a Link or Image node. */
export function linkInfo(state: EditorState, node: SyntaxNode): LinkInfo | null {
  const marks = node.getChildren('LinkMark');
  if (marks.length < 2) return null;
  const doc = state.doc;
  const url = node.getChild('URL');
  const inline = marks.length >= 3;
  const textFrom = marks[0].to;
  const textTo = marks[1].from;
  let href: string | null;
  let definition: LinkDefinition | null = null;
  if (inline) {
    href = url ? stripUrl(doc.sliceString(url.from, url.to)) : '';
  } else {
    const label = node.getChild('LinkLabel');
    const explicit = label ? doc.sliceString(label.from + 1, label.to - 1) : '';
    const key = normalizeLabel(explicit || doc.sliceString(textFrom, textTo));
    definition = linkDefinitions(state).get(key) ?? null;
    href = definition ? definition.href : null;
  }
  return { href, textFrom, textTo, url, inline, definition };
}
