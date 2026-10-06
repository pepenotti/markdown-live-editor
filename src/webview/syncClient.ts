// Webview side of document sync.
//
// Typing is collected into short bursts before it is sent, so that one burst becomes
// one undo step in VS Code instead of one step per key. `base` is the document as the
// host knows it; `pending` is what has been typed since. A change arriving from the
// host is rebased over the pending burst, so neither side loses text.
import { ChangeSet, type EditorState, type Text, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { TextChange } from '../shared/protocol';
import { minimalDiff } from '../shared/textUtil';
import { externalChange } from './modes';

const IDLE_MS = 350;
const MAX_BURST_MS = 2500;

function isTyping(tr: Transaction): boolean {
  return tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward') || tr.isUserEvent('delete.forward');
}

export function toTextChanges(base: Text, changes: ChangeSet): TextChange[] {
  const out: TextChange[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const a = base.lineAt(fromA);
    const b = base.lineAt(toA);
    out.push({
      from: fromA,
      to: toA,
      fromLine: a.number - 1,
      fromCh: fromA - a.from,
      toLine: b.number - 1,
      toCh: toA - b.from,
      insert: inserted.toString(),
    });
  });
  return out;
}

export class SyncClient {
  epoch = 0;
  private base: Text;
  private pending: ChangeSet | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private burstStart = 0;

  constructor(
    state: EditorState,
    private readonly send: (epoch: number, changes: TextChange[]) => void,
  ) {
    this.base = state.doc;
  }

  /** Call for every local transaction that changed the document. */
  localChange(tr: Transaction): void {
    if (!isTyping(tr)) {
      // Anything that is not plain typing is its own undo step.
      this.flush();
      this.pending = tr.changes;
      this.flush();
      return;
    }
    this.pending = this.pending ? this.pending.compose(tr.changes) : tr.changes;
    const now = Date.now();
    if (!this.burstStart) this.burstStart = now;
    clearTimeout(this.timer);
    if (now - this.burstStart >= MAX_BURST_MS) this.flush();
    else this.timer = setTimeout(() => this.flush(), IDLE_MS);
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.burstStart = 0;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.empty) return;
    const changes = toTextChanges(this.base, pending);
    this.base = pending.apply(this.base);
    this.send(this.epoch, changes);
  }

  /** Applies a change the host made to its copy of the document. */
  applyPatch(view: EditorView, from: number, to: number, insert: string, epoch: number, reason?: 'undo' | 'redo'): void {
    this.epoch = epoch;
    if (from > to || to > this.base.length) return; // Out of step; the host follows up with a full sync.
    this.applyRemote(view, ChangeSet.of({ from, to, insert }, this.base.length), reason !== undefined);
  }

  /** Makes the editor match the host's full text. */
  applySync(view: EditorView, text: string, epoch: number): void {
    this.epoch = epoch;
    const diff = minimalDiff(this.base.toString(), text);
    if (!diff) return;
    this.applyRemote(view, ChangeSet.of({ from: diff.from, to: diff.toA, insert: text.slice(diff.from, diff.toB) }, this.base.length), false);
  }

  private applyRemote(view: EditorView, remote: ChangeSet, moveCursor: boolean): void {
    const onCurrent = this.pending ? remote.map(this.pending) : remote;
    if (this.pending) this.pending = this.pending.map(remote, true);
    this.base = remote.apply(this.base);
    let end = -1;
    onCurrent.iterChangedRanges((_fromA, _toA, _fromB, toB) => (end = toB));
    view.dispatch({
      changes: onCurrent,
      annotations: externalChange.of(true),
      selection: moveCursor && end >= 0 ? { anchor: end } : undefined,
      scrollIntoView: moveCursor && end >= 0,
    });
  }

  /** Starts over from a fresh document. */
  reset(state: EditorState, epoch: number): void {
    clearTimeout(this.timer);
    this.pending = null;
    this.burstStart = 0;
    this.base = state.doc;
    this.epoch = epoch;
  }
}
