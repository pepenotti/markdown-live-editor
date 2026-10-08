// Markdown language configuration: CommonMark + GFM + YAML front matter.
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { GFM } from '@lezer/markdown';
import { frontMatter, math } from '../shared/markdownSyntax';

export { math };

/** The TeX inside a math node's text. */
export function texOf(source: string): string {
  const width = source.startsWith('$$') ? 2 : 1;
  const end = source.endsWith('$'.repeat(width)) && source.length >= width * 2 ? source.length - width : source.length;
  return source.slice(width, end).trim();
}

export function markdownSupport() {
  return markdown({
    base: commonmarkLanguage,
    extensions: [GFM, frontMatter, math],
    codeLanguages: languages,
    addKeymap: false,
    completeHTMLTags: false,
    pasteURLAsLink: false,
  });
}
