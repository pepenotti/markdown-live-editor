import { foldable } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { Mode } from '../../src/shared/protocol';
import { blockField, protectedAt } from '../../src/webview/decorations/blocks';
import { afterLeadingAtoms, collectInline, lineAtoms } from '../../src/webview/decorations/inline';
import { editGuard } from '../../src/webview/guard';
import { externalChange, modeField } from '../../src/webview/modes';
import { show, stateOf } from './helpers';

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |';

function editor(marked: string, mode: Mode): EditorState {
  return stateOf(marked, [modeField.init(() => mode), blockField, editGuard]);
}

/** Types `text` at the cursor (or over the selection) and returns the marked result. */
function type(marked: string, text: string, mode: Mode = 'full'): string {
  const state = editor(marked, mode);
  const { from, to } = state.selection.main;
  return show(state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' }).state);
}

function remove(marked: string, from: number, to: number, mode: Mode = 'full'): string {
  const state = editor(marked, mode);
  return state.update({ changes: { from, to }, userEvent: 'delete.backward' }).state.doc.toString();
}

describe('atoms (hidden syntax the cursor skips in full preview)', () => {
  it('marks heading, quote and list prefixes as line-start atoms', () => {
    expect(lineAtoms(editor('## Title', 'full'), 0)).toEqual([{ from: 0, to: 3, kind: 'leading' }]);
    expect(lineAtoms(editor('> quote', 'full'), 0)).toEqual([{ from: 0, to: 2, kind: 'leading' }]);
    expect(lineAtoms(editor('- item', 'full'), 0)).toEqual([{ from: 0, to: 2, kind: 'leading' }]);
    expect(lineAtoms(editor('- [ ] task', 'full'), 0)).toEqual([{ from: 0, to: 6, kind: 'leading' }]);
    expect(lineAtoms(editor('  10. deep', 'full'), 0)).toEqual([{ from: 0, to: 6, kind: 'leading' }]);
  });

  it('chains a quote marker and a heading marker', () => {
    const atoms = lineAtoms(editor('> ## Title', 'full'), 0);
    expect(afterLeadingAtoms(atoms, 0)).toBe(5);
    expect(afterLeadingAtoms(atoms, 7)).toBe(7);
  });

  it('marks inline markers and whole links', () => {
    expect(lineAtoms(editor('a **b** c', 'full'), 0)).toEqual([
      { from: 2, to: 4, kind: 'inline' },
      { from: 5, to: 7, kind: 'inline' },
    ]);
    expect(lineAtoms(editor('[text](http://x.y)', 'full'), 0)).toEqual([
      { from: 0, to: 1, kind: 'inline' },
      { from: 5, to: 18, kind: 'inline' },
    ]);
    expect(lineAtoms(editor('![alt](p.png)', 'full'), 0)).toEqual([{ from: 0, to: 13, kind: 'inline' }]);
  });

  it('leaves brackets alone when they are not a link', () => {
    expect(lineAtoms(editor('array[0] and [note]', 'full'), 0)).toEqual([]);
    expect(lineAtoms(editor('[note]\n\n[note]: http://x.y', 'full'), 0)).toEqual([
      { from: 0, to: 1, kind: 'inline' },
      { from: 5, to: 6, kind: 'inline' },
    ]);
  });

  it('has no atoms outside full preview', () => {
    expect(lineAtoms(editor('## **Title**', 'half'), 0)).toEqual([]);
    expect(lineAtoms(editor('## **Title**', 'raw'), 0)).toEqual([]);
  });

  it('shows the markers of the element under the cursor in half preview only', () => {
    const hidden = (marked: string, mode: Mode) => {
      const state = editor(marked, mode);
      return collectInline(state, [{ from: 0, to: state.doc.length }])
        .decorations.filter((d) => d.to > d.from && d.value.spec.class === undefined && !d.value.spec.widget)
        .map((d) => [d.from, d.to]);
    };
    expect(hidden('a **b** c¦', 'half')).toEqual([[2, 4], [5, 7]]);
    expect(hidden('a **b¦** c', 'half')).toEqual([]);
    expect(hidden('a **b¦** c', 'full')).toEqual([[2, 4], [5, 7]]);
    expect(hidden('a **b¦** c', 'raw')).toEqual([]);
  });
});

describe('rendered blocks', () => {
  it('renders tables in half and full preview and protects their lines', () => {
    for (const mode of ['half', 'full'] as const) {
      const state = editor(`intro\n\n${TABLE}\n\nend`, mode);
      const p = protectedAt(state, 10);
      expect(p && [p.from, p.to, p.value.kind]).toEqual([7, 7 + TABLE.length, 'table']);
    }
    expect(protectedAt(editor(`intro\n\n${TABLE}`, 'raw'), 10)).toBeNull();
  });

  it('protects code fences and front matter only in full preview', () => {
    const doc = '---\ntitle: x\n---\n\n```js\ncode\n```';
    const full = editor(doc, 'full');
    expect(protectedAt(full, 0)?.value.kind).toBe('frontmatter');
    expect(protectedAt(full, 18)?.value.kind).toBe('fence-open');
    expect(protectedAt(full, 24)).toBeNull();
    expect(protectedAt(full, 30)?.value.kind).toBe('fence-close');
    const half = editor(doc, 'half');
    expect(protectedAt(half, 0)).toBeNull();
    expect(protectedAt(half, 18)).toBeNull();
  });

  it('does not render a table that is nested or indented', () => {
    expect(protectedAt(editor(`> ${TABLE.replace(/\n/g, '\n> ')}`, 'half'), 4)).toBeNull();
  });
});

describe('edit guard', () => {
  it('moves text typed at the top edge of a table onto its own line', () => {
    expect(type(`¦${TABLE}`, 'x', 'half')).toBe(`x¦\n\n${TABLE}`);
  });

  it('moves text typed at the bottom edge of a table below it', () => {
    expect(type(`${TABLE}¦`, 'x', 'half')).toBe(`${TABLE}\n\nx¦`);
  });

  it('keeps the blank lines around a table', () => {
    expect(type(`${TABLE}\n¦`, 'x', 'half')).toBe(`${TABLE}\n\nx¦`);
    expect(type(`¦\n${TABLE}`, 'x', 'half')).toBe(`x¦\n\n${TABLE}`);
    const doc = `para\n\n${TABLE}\n\nend`;
    expect(remove(doc, 5, 6, 'half')).toBe(doc);
    const after = 6 + TABLE.length;
    expect(remove(doc, after, after + 1, 'half')).toBe(doc);
  });

  it('refuses edits that would cut into a table but allows deleting it whole', () => {
    const doc = `para\n\n${TABLE}\n\nend`;
    expect(remove(doc, 8, 12, 'half')).toBe(doc);
    expect(remove(doc, 6, 6 + TABLE.length, 'half')).toBe('para\n\n\n\nend');
    expect(remove(doc, 0, doc.length, 'half')).toBe('');
  });

  it('lets changes from the document itself through untouched', () => {
    const state = editor(`${TABLE}`, 'half');
    const next = state.update({ changes: { from: 2, to: 3, insert: 'changed' }, annotations: externalChange.of(true) }).state;
    expect(next.doc.toString()).toBe(TABLE.replace('| a |', '| changed |'));
  });

  it('does nothing in raw mode', () => {
    expect(type(`¦${TABLE}`, 'x', 'raw')).toBe(`x¦${TABLE}`);
  });

  it('keeps code fences intact in full preview', () => {
    const doc = 'a\n\n```js\ncode\n```\n\nb';
    // Joining the first code line onto the opening fence, or the closing fence onto the code.
    expect(remove(doc, 8, 9)).toBe(doc);
    expect(remove(doc, 13, 14)).toBe(doc);
    // The same edits are fine in half preview, where the fences are visible.
    expect(remove(doc, 8, 9, 'half')).toBe('a\n\n```jscode\n```\n\nb');
  });

  it('turns typing on a hidden fence line into a new line of code or a paragraph', () => {
    expect(type('```js\ncode\n¦```', 'x')).toBe('```js\ncode\nx¦\n```');
    expect(type('```js\ncode\n```¦', 'x')).toBe('```js\ncode\n```\nx¦');
    expect(type('```js¦\ncode\n```', 'x')).toBe('```js\nx¦code\n```');
    expect(type('¦```js\ncode\n```', 'x')).toBe('x¦\n\n```js\ncode\n```');
  });

  it('keeps a heading or list marker when its whole text is replaced', () => {
    expect(type('⟦## Title⟧', 'N')).toBe('## N¦');
    expect(type('⟦- item⟧', 'N')).toBe('- N¦');
    expect(type('## ⟦Title⟧', 'N')).toBe('## N¦');
    // Half preview shows the marker, so replacing it is what the user asked for.
    expect(type('⟦## Title⟧', 'N', 'half')).toBe('N¦');
  });

  it('removes empty markers when all the text inside them is deleted', () => {
    expect(remove('a **bold** c', 4, 8)).toBe('a  c');
    expect(remove('a `code` c', 3, 7)).toBe('a  c');
    expect(remove('a ***both*** c', 5, 9)).toBe('a  c');
    expect(remove('a [text](http://x.y) c', 3, 7)).toBe('a  c');
    // Deleting only part of the text keeps the formatting.
    expect(remove('a **bold** c', 4, 7)).toBe('a **d** c');
    // Half preview shows the markers, so they are left for the user.
    expect(remove('a **bold** c', 4, 8, 'half')).toBe('a **** c');
  });
});

describe('folding', () => {
  it('folds the section under a heading up to the next heading of the same or a higher level', () => {
    const state = editor('# One\n\ntext\n\n## Sub\n\nmore\n\n# Two\n\nend', 'half');
    expect(foldable(state, 0, 5)).toEqual({ from: 5, to: 25 });
    expect(foldable(state, 13, 19)).toEqual({ from: 19, to: 25 });
    expect(foldable(state, 7, 11)).toBeNull();
  });

  it('adds a fold arrow only to headings that have something to fold', () => {
    const arrows = (marked: string) => {
      const state = editor(marked, 'half');
      return collectInline(state, [{ from: 0, to: state.doc.length }]).decorations.filter((d) => d.value.spec.widget?.constructor.name === 'FoldWidget').map((d) => d.from);
    };
    expect(arrows('# One\n\ntext\n\n# Empty\n# Two\n\nend¦')).toEqual([0, 21]);
  });
});
