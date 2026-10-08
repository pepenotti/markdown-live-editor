// Markdown language configuration: CommonMark + GFM + YAML front matter.
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { GFM } from '@lezer/markdown';
import { footnotes, frontMatter, math, wikiLink } from '../shared/markdownSyntax';

export { footnotes, math };

/** The id of a footnote reference (`[^id]`) or label (`[^id]:`). */
export function footnoteId(source: string): string {
  return source.slice(2, source.indexOf(']')).toLowerCase();
}

export { texOf } from '../shared/markdownSyntax';

/** The source of a math node with its TeX replaced, or null when the TeX would not stay one formula. */
export function withTex(source: string, tex: string): string | null {
  const body = tex.replace(/\s*\n\s*/g, ' ').trim();
  if (body === '') return null;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$') return null;
    // A backslash at the very end would escape the closing dollar sign.
    if (body[i] === '\\' && ++i === body.length) return null;
  }
  const mark = source.startsWith('$$') ? '$$' : '$';
  return mark + body + mark;
}

export function markdownSupport(options: { wikiLinks?: boolean } = {}) {
  return markdown({
    base: commonmarkLanguage,
    extensions: [GFM, frontMatter, math, footnotes, ...(options.wikiLinks ? [wikiLink] : [])],
    codeLanguages: languages,
    addKeymap: false,
    completeHTMLTags: false,
    pasteURLAsLink: false,
  });
}
