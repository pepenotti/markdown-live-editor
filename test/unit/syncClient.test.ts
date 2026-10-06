import { EditorState, Text, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextChange } from '../../src/shared/protocol';
import { applyChanges, changeIsConsistent } from '../../src/shared/textUtil';
import { externalChange } from '../../src/webview/modes';
import { SyncClient, toTextChanges } from '../../src/webview/syncClient';

/** A minimal stand-in for the editor view: just a state and dispatch. */
function fakeEditor(doc: string) {
  const sent: { epoch: number; changes: TextChange[] }[] = [];
  let hostText = doc;
  const editor = {
    state: EditorState.create({ doc }),
    dispatch(spec: TransactionSpec) {
      const tr = editor.state.update(spec);
      editor.state = tr.state;
      if (tr.docChanged && !tr.annotation(externalChange)) client.localChange(tr);
    },
  };
  const client = new SyncClient(editor.state, (epoch, changes) => {
    for (const c of changes) expect(changeIsConsistent(hostText, c)).toBe(true);
    hostText = applyChanges(hostText, changes)!;
    sent.push({ epoch, changes });
  });
  const type = (from: number, insert: string, to = from) =>
    editor.dispatch({ changes: { from, to, insert }, annotations: Transaction.userEvent.of('input.type') });
  return { editor, client, sent, type, view: editor as unknown as EditorView, host: () => hostText, setHost: (t: string) => (hostText = t) };
}

describe('SyncClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a burst of typing as one edit after a pause', () => {
    const { type, sent, host } = fakeEditor('');
    type(0, 'h');
    type(1, 'i');
    type(2, '!');
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(sent).toHaveLength(1);
    expect(sent[0].changes).toEqual([{ from: 0, to: 0, fromLine: 0, fromCh: 0, toLine: 0, toCh: 0, insert: 'hi!' }]);
    expect(host()).toBe('hi!');
  });

  it('sends non-typing edits at once and as their own step', () => {
    const { editor, type, sent, host } = fakeEditor('abc');
    type(3, 'd');
    editor.dispatch({ changes: { from: 0, insert: '# ' }, annotations: Transaction.userEvent.of('input.format') });
    expect(sent).toHaveLength(2);
    expect(host()).toBe('# abcd');
  });

  it('does not let one burst grow for ever', () => {
    const { type, sent } = fakeEditor('');
    for (let i = 0; i < 30; i++) {
      type(i, 'x');
      vi.advanceTimersByTime(200);
    }
    expect(sent.length).toBeGreaterThan(1);
  });

  it('rebases unsent typing over a change from the host', () => {
    const { editor, client, type, sent, view, host, setHost } = fakeEditor('one two');
    type(7, '!');
    // The host replaces "one" with "1" before it has seen the "!".
    setHost('1 two');
    client.applyPatch(view, 0, 3, '1', 5);
    expect(editor.state.doc.toString()).toBe('1 two!');
    client.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].epoch).toBe(5);
    expect(host()).toBe('1 two!');
  });

  it('follows a full sync and keeps unsent typing', () => {
    const { editor, client, type, view, host, setHost } = fakeEditor('alpha\nbeta');
    type(0, '> ');
    setHost('alpha\nBETA\ngamma');
    client.applySync(view, 'alpha\nBETA\ngamma', 9);
    expect(editor.state.doc.toString()).toBe('> alpha\nBETA\ngamma');
    client.flush();
    expect(host()).toBe('> alpha\nBETA\ngamma');
  });

  it('ignores a patch that does not fit and waits for the sync', () => {
    const { editor, client, view } = fakeEditor('abc');
    client.applyPatch(view, 10, 12, 'x', 2);
    expect(editor.state.doc.toString()).toBe('abc');
    expect(client.epoch).toBe(2);
  });

  it('reports line positions for multi-line documents', () => {
    const base = Text.of(['ab', 'cd', 'ef']);
    const state = EditorState.create({ doc: base });
    const tr = state.update({ changes: [{ from: 1, to: 4, insert: 'X' }, { from: 7, insert: '\nZ' }] });
    expect(toTextChanges(base, tr.changes)).toEqual([
      { from: 1, to: 4, fromLine: 0, fromCh: 1, toLine: 1, toCh: 1, insert: 'X' },
      { from: 7, to: 7, fromLine: 2, fromCh: 1, toLine: 2, toCh: 1, insert: '\nZ' },
    ]);
  });
});
