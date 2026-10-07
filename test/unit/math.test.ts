import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import type { Mode } from '../../src/shared/protocol';
import { buildOutline, extractHeadings } from '../../src/shared/textUtil';
import { blockField, protectedAt } from '../../src/webview/decorations/blocks';
import { lineAtoms } from '../../src/webview/decorations/inline';
import { texOf } from '../../src/webview/markdown';
import { modeField, revealBlock } from '../../src/webview/modes';
import { stateOf } from './helpers';

function nodes(doc: string, wanted = /Math/): string[] {
  const state = stateOf(doc);
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (wanted.test(n.name)) out.push(`${n.name}:${state.doc.sliceString(n.from, n.to)}`);
    },
  });
  return out;
}

const editor = (doc: string, mode: Mode) => stateOf(doc, [modeField.init(() => mode), blockField]);

describe('math syntax', () => {
  it('parses inline math', () => {
    expect(nodes('Euler: $e^{i\\pi}+1=0$ done')).toEqual(['InlineMath:$e^{i\\pi}+1=0$']);
    expect(nodes('display $$x^2$$ inline')).toEqual(['InlineMath:$$x^2$$']);
    expect(nodes('$a*b*c$ and *em*', /Math|Emphasis$/)).toEqual(['InlineMath:$a*b*c$', 'Emphasis:*em*']);
  });

  it('leaves prices and stray dollar signs alone', () => {
    expect(nodes('It costs $5 or $10 today')).toEqual([]);
    expect(nodes('a $ b $ c')).toEqual([]);
    expect(nodes('escaped \\$x$ here')).toEqual([]);
    expect(nodes('`$x$` in code')).toEqual([]);
  });

  it('parses block math over one or several lines', () => {
    expect(nodes('$$\nx = 1\n$$\n\nafter')).toEqual(['BlockMath:$$\nx = 1\n$$']);
    expect(nodes('$$ x = 1 $$')).toEqual(['BlockMath:$$ x = 1 $$']);
  });

  it('extracts the TeX', () => {
    expect(texOf('$x$')).toBe('x');
    expect(texOf('$$\n a \n$$')).toBe('a');
    expect(texOf('$$ x')).toBe('x');
  });

  it('hides inline math source in full preview', () => {
    expect(lineAtoms(stateOf('a $x$ b', [modeField.init(() => 'full'), blockField]), 0)).toEqual([{ from: 2, to: 5, kind: 'inline' }]);
  });
});

describe('rendered blocks', () => {
  const DIAGRAM = '```mermaid\nflowchart LR\n  A --> B\n```';

  it('draws diagrams and block math in place of their source in the preview modes', () => {
    for (const mode of ['half', 'full'] as const) {
      expect(protectedAt(editor(`a\n\n${DIAGRAM}\n\nb`, mode), 5)?.value.kind).toBe('rendered');
      expect(protectedAt(editor('a\n\n$$\nx\n$$\n\nb', mode), 5)?.value.kind).toBe('rendered');
    }
    expect(protectedAt(editor(`a\n\n${DIAGRAM}`, 'raw'), 5)).toBeNull();
  });

  it('leaves other code blocks and unfinished diagrams as code', () => {
    expect(protectedAt(editor('```js\nlet a\n```', 'half'), 2)).toBeNull();
    expect(protectedAt(editor('```mermaid\nflowchart LR', 'half'), 2)).toBeNull();
  });

  it('shows the source again while the cursor is inside', () => {
    const state = editor(`${DIAGRAM}\n\nb`, 'half');
    const open = state.update({ effects: revealBlock.of(0), selection: { anchor: 12 } }).state;
    expect(protectedAt(open, 5)).toBeNull();
    const left = open.update({ selection: { anchor: open.doc.length } }).state;
    expect(protectedAt(left, 5)?.value.kind).toBe('rendered');
  });
});

describe('outline', () => {
  it('nests headings by level and strips inline markers', () => {
    const tree = buildOutline(extractHeadings('# A\n## B *x*\n### C\n## D\n# E'));
    const shape = (n: ReturnType<typeof buildOutline>): unknown => n.map((x) => [x.text, shape(x.children)]);
    expect(shape(tree)).toEqual([
      ['A', [['B x', [['C', []]]], ['D', []]]],
      ['E', []],
    ]);
  });
});
