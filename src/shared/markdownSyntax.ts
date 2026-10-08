// The Markdown extensions of this editor as plain Lezer configuration, so the extension
// host can parse a document exactly like the webview does.
import { tags as t } from '@lezer/highlight';
import { GFM, type MarkdownConfig, parser as baseParser } from '@lezer/markdown';

const FRONT_MATTER_NEXT = /^\s*(?:[A-Za-z_][\w .-]*:|#|-\s|---\s*$|\.\.\.\s*$)/;

/** A `---` block at the very start of the document is YAML front matter, not a rule. */
export const frontMatter: MarkdownConfig = {
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

/**
 * Math: `$x$` and `$$x$$` inline, and a `$$` block. A dollar sign followed by a space,
 * or a closing one followed by a digit, is left as plain text so prices are not math.
 */
export const math: MarkdownConfig = {
  defineNodes: [{ name: 'BlockMath', block: true }, { name: 'InlineMath' }],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse(cx, line) {
        if (line.next !== 36 || line.text.charCodeAt(line.pos + 1) !== 36) return false;
        const start = cx.lineStart + line.pos;
        const rest = line.text.slice(line.pos + 2);
        const closes = (text: string) => /\$\$[ \t]*$/.test(text);
        if (rest.trim().length > 2 && closes(rest)) {
          const end = cx.lineStart + line.text.trimEnd().length;
          cx.nextLine();
          cx.addElement(cx.elt('BlockMath', start, end));
          return true;
        }
        if (rest.trim() !== '' && rest.includes('$$')) return false;
        while (cx.nextLine()) {
          if (closes(line.text)) {
            const end = cx.lineStart + line.text.trimEnd().length;
            cx.nextLine();
            cx.addElement(cx.elt('BlockMath', start, end));
            return true;
          }
        }
        cx.addElement(cx.elt('BlockMath', start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const width = cx.char(pos + 1) === 36 ? 2 : 1;
        const first = cx.char(pos + width);
        if (first < 0 || first === 32 || first === 9 || first === 10 || first === 36) return -1;
        for (let i = pos + width; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 92) {
            i++;
            continue;
          }
          if (ch === 10 && cx.char(i + 1) === 10) return -1;
          if (ch !== 36) continue;
          if (width === 2 && cx.char(i + 1) !== 36) continue;
          const before = cx.char(i - 1);
          const after = cx.char(i + width);
          if (before === 32 || before === 9) continue;
          if (width === 1 && after >= 48 && after <= 57) continue;
          return cx.addElement(cx.elt('InlineMath', pos, i + width));
        }
        return -1;
      },
    },
  ],
};

/** CommonMark + GFM + front matter + math, without any editor around it. */
export const markdownParser = baseParser.configure([GFM, frontMatter, math]);
