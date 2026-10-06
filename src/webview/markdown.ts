// Markdown language configuration: CommonMark + GFM + YAML front matter.
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';
import { GFM, type MarkdownConfig } from '@lezer/markdown';

const FRONT_MATTER_NEXT = /^\s*(?:[A-Za-z_][\w .-]*:|#|-\s|---\s*$|\.\.\.\s*$)/;

/** A `---` block at the very start of the document is YAML front matter, not a rule. */
const frontMatter: MarkdownConfig = {
  defineNodes: [{ name: 'FrontMatter', block: true, style: t.meta }],
  parseBlock: [
    {
      name: 'FrontMatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        if (!FRONT_MATTER_NEXT.test(cx.peekLine())) return false;
        const start = cx.lineStart;
        while (cx.nextLine()) {
          if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) {
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt('FrontMatter', start, end));
            return true;
          }
        }
        cx.addElement(cx.elt('FrontMatter', start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

export function markdownSupport() {
  return markdown({
    base: commonmarkLanguage,
    extensions: [GFM, frontMatter],
    codeLanguages: languages,
    addKeymap: false,
    completeHTMLTags: false,
    pasteURLAsLink: false,
  });
}
