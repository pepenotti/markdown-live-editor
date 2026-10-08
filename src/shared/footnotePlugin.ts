// Footnotes for markdown-it, with the syntax of the editor (the `footnotes` extension in
// src/shared/markdownSyntax.ts): `[^id]` references and `[^id]: text` definitions. Notes are
// numbered in the order they are first referenced; a reference without a definition stays
// text, and a definition nobody refers to is left out, as on GitHub.
import type { MarkdownIt, Token } from 'markdown-it';
import { BLOCK_START, FOOTNOTE_DEF } from './markdownSyntax';

export interface FootnoteState {
  /** Text of each definition, by lower-case id. The first definition of an id wins. */
  defs: Map<string, string>;
  /** Number of each note that is referenced and defined, in the order of first reference. */
  numbers: Map<string, number>;
  /** How often each note has been referenced so far. */
  uses: Map<string, number>;
  /** Tokens already numbered, so a second pass over the same tokens changes nothing. */
  done: WeakSet<Token>;
}

type Env = { footnotes?: FootnoteState } | undefined;

function stateOf(env: unknown): FootnoteState {
  const holder = env as NonNullable<Env>;
  return (holder.footnotes ??= { defs: new Map(), numbers: new Map(), uses: new Map(), done: new WeakSet() });
}

/** The notes of a rendered document in the order of their numbers. Grows while their own text is rendered. */
export function footnoteList(env: unknown): { id: string; number: number; text: string; uses: number }[] {
  const notes = stateOf(env);
  return [...notes.numbers].map(([id, number]) => ({ id, number, text: notes.defs.get(id) ?? '', uses: notes.uses.get(id) ?? 0 }));
}

/** Anchor of the nth reference to a note. */
export function referenceAnchor(number: number, use: number): string {
  return use > 1 ? `fnref-${number}-${use}` : `fnref-${number}`;
}

export function footnotePlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'reference',
    'footnote_def',
    (state, startLine, endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
      const m = FOOTNOTE_DEF.exec(first);
      if (!m) return false;
      if (silent) return true;
      let text = first.slice(m[1].length + 4);
      let line = startLine + 1;
      // Inside a quote or list item a definition is one line, as in the editor.
      if (state.level === 0) {
        for (; line < endLine; line++) {
          const rest = state.src.slice(state.bMarks[line], state.eMarks[line]);
          if (rest.trim() === '' || BLOCK_START.test(rest.trimStart())) break;
          text += '\n' + rest;
        }
      }
      const notes = stateOf(state.env);
      const id = m[1].toLowerCase();
      if (!notes.defs.has(id)) notes.defs.set(id, text.trim());
      const token = state.push('footnote_def', '', 0);
      token.hidden = true;
      token.meta = { id };
      token.map = [startLine, line];
      state.line = line;
      return true;
    },
    { alt: ['paragraph', 'reference'] },
  );

  md.inline.ruler.before('link', 'footnote_ref', (state, silent) => {
    const { src, pos, posMax } = state;
    if (src.charCodeAt(pos) !== 91 || src.charCodeAt(pos + 1) !== 94) return false;
    let end = -1;
    for (let i = pos + 2; i < posMax; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 93) {
        end = i;
        break;
      }
      if (ch === 91 || ch === 32 || ch === 9 || ch === 10) return false;
    }
    if (end <= pos + 2) return false;
    const id = src.slice(pos + 2, end).toLowerCase();
    if (!stateOf(state.env).defs.has(id)) return false;
    if (!silent) state.push('footnote_ref', '', 0).meta = { id };
    state.pos = end + 1;
    return true;
  });

  // Numbers are given in document order once everything is parsed.
  md.core.ruler.push('footnote_numbers', (state) => {
    const notes = stateOf(state.env);
    const visit = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.children) visit(token.children);
        if (token.type !== 'footnote_ref' || notes.done.has(token)) continue;
        notes.done.add(token);
        const id = (token.meta as { id: string }).id;
        const number = notes.numbers.get(id) ?? notes.numbers.size + 1;
        notes.numbers.set(id, number);
        const use = (notes.uses.get(id) ?? 0) + 1;
        notes.uses.set(id, use);
        token.meta = { id, number, use };
      }
    };
    visit(state.tokens);
  });

  md.renderer.rules.footnote_ref = (tokens, idx) => {
    const { number, use } = tokens[idx].meta as { number: number; use: number };
    return `<sup class="footnote-ref"><a href="#fn-${number}" id="${referenceAnchor(number, use)}">${number}</a></sup>`;
  };
}
