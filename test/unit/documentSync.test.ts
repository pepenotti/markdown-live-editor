import { describe, expect, it } from 'vitest';
import { DocumentSync, type SyncTarget } from '../../src/extension/documentSync';
import type { HostMessage, TextChange } from '../../src/shared/protocol';
import { applyChanges, positionAt, toLF } from '../../src/shared/textUtil';

/** A stand-in for a VS Code document plus the webview on the other side. */
class FakeDoc implements SyncTarget {
  posted: HostMessage[] = [];
  visible = true;
  refuseNext = false;
  onChange: (() => void) | undefined;
  constructor(public text: string, private readonly eol = '\n') {}

  getText() {
    return this.text;
  }
  isVisible() {
    return this.visible;
  }
  post(m: HostMessage) {
    this.posted.push(m);
  }
  async applyChanges(changes: readonly TextChange[]) {
    if (this.refuseNext) {
      this.refuseNext = false;
      return false;
    }
    const lf = applyChanges(toLF(this.text), changes)!;
    this.text = this.eol === '\n' ? lf : lf.replace(/\n/g, this.eol);
    this.onChange?.();
    return true;
  }
  /** Something other than the webview edits the document. */
  external(text: string) {
    this.text = text;
    this.onChange?.();
  }
}

function change(text: string, from: number, to: number, insert: string): TextChange {
  const a = positionAt(text, from);
  const b = positionAt(text, to);
  return { from, to, insert, fromLine: a.line, fromCh: a.ch, toLine: b.line, toCh: b.ch };
}

function setup(text: string, eol = '\n') {
  const doc = new FakeDoc(text, eol);
  const sync = new DocumentSync(doc);
  doc.onChange = () => sync.documentChanged();
  const init = sync.start();
  return { doc, sync, init };
}

describe('DocumentSync', () => {
  it('applies webview edits without echoing them back', async () => {
    const { doc, sync, init } = setup('hello world');
    await sync.receiveEdit(init.epoch, [change('hello world', 5, 5, ',')]);
    expect(doc.text).toBe('hello, world');
    expect(doc.posted).toEqual([]);
  });

  it('applies queued edits in order', async () => {
    const { doc, sync, init } = setup('ab');
    sync.receiveEdit(init.epoch, [change('ab', 2, 2, 'c')]);
    sync.receiveEdit(init.epoch, [change('abc', 3, 3, 'd')]);
    await sync.drain();
    expect(doc.text).toBe('abcd');
    expect(doc.posted).toEqual([]);
  });

  it('forwards external changes as a minimal patch', () => {
    const { doc, sync, init } = setup('one two three');
    doc.external('one 2 three');
    expect(doc.posted).toEqual([{ type: 'patch', from: 4, to: 7, insert: '2', epoch: init.epoch + 1, reason: undefined }]);
    expect(sync.currentEpoch).toBe(init.epoch + 1);
  });

  it('rejects an edit made before an external change was seen and resyncs', async () => {
    const { doc, sync, init } = setup('abc');
    doc.external('abcX');
    doc.posted.length = 0;
    await sync.receiveEdit(init.epoch, [change('abc', 0, 0, 'Y')]);
    expect(doc.text).toBe('abcX');
    expect(doc.posted).toEqual([{ type: 'sync', text: 'abcX', epoch: sync.currentEpoch }]);
  });

  it('resyncs when the document refuses an edit', async () => {
    const { doc, sync, init } = setup('abc');
    doc.refuseNext = true;
    await sync.receiveEdit(init.epoch, [change('abc', 3, 3, 'd')]);
    expect(doc.text).toBe('abc');
    expect(doc.posted.at(-1)).toEqual({ type: 'sync', text: 'abc', epoch: sync.currentEpoch });
  });

  it('keeps CRLF documents in CRLF and talks LF to the webview', async () => {
    const { doc, sync, init } = setup('a\r\nb\r\n', '\r\n');
    expect(init.text).toBe('a\nb\n');
    await sync.receiveEdit(init.epoch, [change('a\nb\n', 3, 3, '\nc')]);
    expect(doc.text).toBe('a\r\nb\r\nc\r\n');
    expect(doc.posted).toEqual([]);
    doc.external('a\r\nB\r\nc\r\n');
    expect(doc.posted).toEqual([{ type: 'patch', from: 2, to: 3, insert: 'B', epoch: sync.currentEpoch, reason: undefined }]);
  });

  it('does not post to a hidden webview and resyncs when it is shown', () => {
    const { doc, sync } = setup('abc');
    doc.visible = false;
    doc.external('abcd');
    expect(doc.posted).toEqual([]);
    doc.visible = true;
    sync.becameVisible();
    expect(doc.posted).toEqual([{ type: 'sync', text: 'abcd', epoch: sync.currentEpoch }]);
  });

  it('rejects edits whose line positions disagree with their offsets', async () => {
    const { doc, sync, init } = setup('a\nb');
    const bad = { ...change('a\nb', 2, 2, 'x'), fromLine: 0, toLine: 0 };
    await sync.receiveEdit(init.epoch, [bad]);
    expect(doc.text).toBe('a\nb');
    expect(doc.posted.at(-1)?.type).toBe('sync');
  });
});
