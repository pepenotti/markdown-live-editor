// Wiki links in the editor: where their parts are. The parser only produces WikiLink
// nodes while the setting is on, so nothing here finds anything otherwise. Whether a
// note exists is the link checker's business (linkCheck.ts).
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { parseWikiLink, type WikiLinkParts } from '../shared/wikiLinks';

export interface WikiLinkInfo extends WikiLinkParts {
  from: number;
  to: number;
  /** Range of the text that stays visible: the shown text, or the target when there is none. */
  shownFrom: number;
  shownTo: number;
}

/** Takes apart the wiki link that spans `from`..`to`, brackets included. */
export function wikiLinkInfo(doc: Text, from: number, to: number): WikiLinkInfo {
  const inner = doc.sliceString(from + 2, to - 2);
  const parts = parseWikiLink(inner);
  const bar = inner.indexOf('|');
  let shownFrom = from + 2;
  let shownTo = to - 2;
  if (bar >= 0 && parts.alias) shownFrom += bar + 1;
  else if (bar >= 0) shownTo = shownFrom + bar;
  return { ...parts, from, to, shownFrom, shownTo };
}

/** The wiki link at or next to a position. */
export function wikiLinkAt(state: EditorState, pos: number): WikiLinkInfo | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'WikiLink') return wikiLinkInfo(state.doc, n.from, n.to);
    }
  }
  return null;
}
