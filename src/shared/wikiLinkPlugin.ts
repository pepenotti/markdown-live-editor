// Wiki links for markdown-it, with the syntax of the editor (the `wikiLink` extension in
// src/shared/markdownSyntax.ts). The rule does nothing unless the caller says where the
// links lead, which it only does while `seamlessMarkdown.wikiLinks` is on; without that,
// `[[Note]]` is rendered exactly as before.
import type { MarkdownIt } from 'markdown-it';
import { slugify } from './textUtil';
import { parseWikiLink } from './wikiLinks';

/** Where a note name leads in the exported file: a URL, or null when the note is only named, not linked. */
export type WikiHref = (target: string) => string | null;

export function wikiLinkPlugin(md: MarkdownIt, hrefOf: (env: unknown) => WikiHref | undefined): void {
  md.inline.ruler.before('link', 'wiki_link', (state, silent) => {
    const href = hrefOf(state.env);
    if (!href) return false;
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 91 || src.charCodeAt(start + 1) !== 91 || src.charCodeAt(start + 2) === 94) return false;
    let end = -1;
    for (let i = start + 2; i < state.posMax; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 10 || ch === 91) return false;
      if (ch === 93) {
        if (src.charCodeAt(i + 1) !== 93) return false;
        end = i;
        break;
      }
    }
    const inner = end < 0 ? '' : src.slice(start + 2, end);
    if (inner.trim() === '') return false;
    if (!silent) {
      const { target, heading, alias } = parseWikiLink(inner);
      const anchor = heading ? '#' + encodeURIComponent(slugify(heading)) : '';
      // A link to a heading of the same document needs no file.
      const base = target ? href(target) : '';
      if (base !== null && base + anchor !== '') {
        const open = state.push('link_open', 'a', 1);
        open.attrSet('href', base + anchor);
        open.attrSet('class', 'wikilink');
      }
      state.push('text', '', 0).content = alias || (inner.includes('|') ? target : inner.trim());
      if (base !== null && base + anchor !== '') state.push('link_close', 'a', -1);
    }
    state.pos = end + 2;
    return true;
  });
}
