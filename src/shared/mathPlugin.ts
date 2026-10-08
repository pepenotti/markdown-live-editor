// Math for markdown-it, with the same dollar rules as the editor (the `math` extension in
// src/webview/markdown.ts): `$x$` and `$$x$$` inline, and a `$$` block. A dollar sign
// followed by a space, or a closing one followed by a digit, stays plain text, so prices are not math.
import type { MarkdownIt } from 'markdown-it';
import { texOf } from './markdownSyntax';

const DOLLAR = 36;
const BACKSLASH = 92;

/**
 * End of the inline math that starts at `pos` (just past its closing dollars), or -1.
 * `end` is the end of the inline content being parsed.
 */
export function inlineMathEnd(src: string, pos: number, end: number): number {
  if (src.charCodeAt(pos) !== DOLLAR) return -1;
  const width = pos + 1 < end && src.charCodeAt(pos + 1) === DOLLAR ? 2 : 1;
  if (pos + width >= end) return -1;
  const first = src.charCodeAt(pos + width);
  if (first === 32 || first === 9 || first === 10 || first === DOLLAR) return -1;
  for (let i = pos + width; i < end; i++) {
    const ch = src.charCodeAt(i);
    if (ch === BACKSLASH) {
      i++;
      continue;
    }
    if (ch === 10 && src.charCodeAt(i + 1) === 10) return -1;
    if (ch !== DOLLAR) continue;
    if (width === 2 && !(i + 1 < end && src.charCodeAt(i + 1) === DOLLAR)) continue;
    const before = src.charCodeAt(i - 1);
    if (before === 32 || before === 9) continue;
    if (width === 1 && i + 1 < end) {
      const after = src.charCodeAt(i + 1);
      if (after >= 48 && after <= 57) continue;
    }
    return i + width;
  }
  return -1;
}

const closes = (text: string) => /\$\$[ \t]*$/.test(text);

/**
 * Adds `math_inline` and `math_block` tokens. Their `content` is the TeX; an inline token
 * has `meta.display` set when it was written with two dollars.
 */
export function mathPlugin(md: MarkdownIt, render: (tex: string, display: boolean, env: unknown) => string): void {
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const end = inlineMathEnd(state.src, state.pos, state.posMax);
    if (end < 0) return false;
    if (!silent) {
      const source = state.src.slice(state.pos, end);
      const token = state.push('math_inline', 'math', 0);
      token.markup = source.startsWith('$$') ? '$$' : '$';
      token.content = texOf(source);
      token.meta = { display: token.markup === '$$' };
    }
    state.pos = end;
    return true;
  });

  // Not listed as able to interrupt a paragraph, like in the editor.
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (pos + 2 > max || state.src.charCodeAt(pos) !== DOLLAR || state.src.charCodeAt(pos + 1) !== DOLLAR) return false;
    const rest = state.src.slice(pos + 2, max);
    let last = startLine;
    if (!(rest.trim().length > 2 && closes(rest))) {
      if (rest.trim() !== '' && rest.includes('$$')) return false;
      // Without a closing line the block runs to the end of its container.
      last = endLine - 1;
      for (let line = startLine + 1; line < endLine; line++) {
        if (state.sCount[line] < state.blkIndent && !state.isEmpty(line)) {
          last = line - 1;
          break;
        }
        if (closes(state.src.slice(state.bMarks[line], state.eMarks[line]))) {
          last = line;
          break;
        }
      }
    }
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.markup = '$$';
    token.content = texOf(state.getLines(startLine, last + 1, state.sCount[startLine], false).trim());
    token.map = [startLine, last + 1];
    state.line = last + 1;
    return true;
  });

  md.renderer.rules.math_inline = (tokens, idx, _options, env) => render(tokens[idx].content, tokens[idx].meta?.display === true, env);
  md.renderer.rules.math_block = (tokens, idx, _options, env) => `<div class="math-block">${render(tokens[idx].content, true, env)}</div>\n`;
}
