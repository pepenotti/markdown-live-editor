// The Markdown extensions of this editor as plain Lezer configuration, so the extension
// host can parse a document exactly like the webview does.
import { tags as t } from '@lezer/highlight';
import { GFM, type MarkdownConfig, parser as baseParser } from '@lezer/markdown';

export const FRONT_MATTER_NEXT = /^\s*(?:[A-Za-z_][\w .-]*:|#|-\s|---\s*$|\.\.\.\s*$)/;

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

/** The TeX inside the source of a math node. */
export function texOf(source: string): string {
  const width = source.startsWith('$$') ? 2 : 1;
  const end = source.endsWith('$'.repeat(width)) && source.length >= width * 2 ? source.length - width : source.length;
  return source.slice(width, end).trim();
}

export const FOOTNOTE_DEF = /^\[\^([^\s\[\]]+)\]:(?:[ \t]|$)/;
/** Lines that start a block of their own and so never continue a footnote's text. */
export const BLOCK_START = /^(?:\[\^|#{1,6}(?:\s|$)|>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|```|~~~|\$\$|\||<|(?:[-*_][ \t]*){3,}$)/;

/**
 * Footnotes: `[^id]` references and `[^id]: text` definitions. A definition runs to
 * the next blank line; its text is parsed as inline Markdown.
 */
export const footnotes: MarkdownConfig = {
  defineNodes: [{ name: 'FootnoteDefinition', block: true }, { name: 'FootnoteLabel', style: t.labelName }, { name: 'FootnoteReference', style: t.labelName }],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse(cx, line) {
        const first = line.text.slice(line.pos);
        const m = FOOTNOTE_DEF.exec(first);
        if (!m) return false;
        const start = cx.lineStart + line.pos;
        const labelEnd = start + m[1].length + 4;
        let end = cx.lineStart + line.text.length;
        let text = first;
        // Inside a quote or list item the following lines carry that block's markers, so stop after one line.
        const nested = cx.depth > 1;
        while (cx.nextLine()) {
          if (nested) break;
          const rest = line.text;
          if (rest.trim() === '' || BLOCK_START.test(rest.trimStart())) break;
          text += '\n' + rest;
          end = cx.lineStart + rest.length;
        }
        const inline = cx.parser.parseInline(text.slice(labelEnd - start), labelEnd);
        cx.addElement(cx.elt('FootnoteDefinition', start, end, [cx.elt('FootnoteLabel', start, labelEnd), ...inline]));
        return true;
      },
      endLeaf: (_cx, line) => FOOTNOTE_DEF.test(line.text.slice(line.pos)),
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 93) return i > pos + 2 ? cx.addElement(cx.elt('FootnoteReference', pos, i + 1)) : -1;
          if (ch === 91 || ch === 32 || ch === 9 || ch === 10) return -1;
        }
        return -1;
      },
    },
  ],
};

/** CommonMark + GFM + front matter + math + footnotes, without any editor around it. */
export const markdownParser = baseParser.configure([GFM, frontMatter, math, footnotes]);
