// Keeps one webview in step with one text document.
//
// The document is the source of truth. `mirror` is the text this webview is believed
// to hold. Edits from the webview are applied in order through a queue; anything else
// that changes the document (undo, another editor, git, format on save) is detected by
// comparing the document with the mirror and is forwarded as a patch. Every message
// sent to the webview bumps `epoch`; an edit stamped with an older epoch was made
// before the webview saw that message and is answered with a full resync.
//
// This file has no dependency on the vscode module so it can be unit tested.
import type { HostMessage, TextChange } from '../shared/protocol';
import { applyChanges, changeIsConsistent, minimalDiff, toLF } from '../shared/textUtil';

export interface SyncTarget {
  getText(): string;
  /** Applies the changes to the document. Resolves to false when the edit was refused. */
  applyChanges(changes: readonly TextChange[]): Thenable<boolean>;
  post(message: HostMessage): void;
  isVisible(): boolean;
  log?(message: string): void;
}

export class DocumentSync {
  private mirror = '';
  private epoch = 0;
  private started = false;
  private stale = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly target: SyncTarget) {}

  /** Called when the webview reports it is ready. Returns the text and epoch to start from. */
  start(): { text: string; epoch: number } {
    this.mirror = toLF(this.target.getText());
    this.epoch++;
    this.started = true;
    this.stale = false;
    return { text: this.mirror, epoch: this.epoch };
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  /** Queues an edit that came from the webview. */
  receiveEdit(epoch: number, changes: readonly TextChange[]): Promise<void> {
    return this.enqueue(() => this.processEdit(epoch, changes));
  }

  /** Resolves once every edit received so far has been applied. */
  drain(): Promise<void> {
    return this.queue;
  }

  /** Call for every change event of the document. */
  documentChanged(reason?: 'undo' | 'redo'): void {
    if (this.started) this.reconcile(reason);
  }

  /** Messages cannot reach a hidden webview, so it is brought up to date when shown again. */
  becameVisible(): void {
    if (this.started && this.stale) this.fullSync();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch((err) => {
      this.target.log?.(`sync error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      this.fullSync();
    });
    return this.queue;
  }

  private async processEdit(epoch: number, changes: readonly TextChange[]): Promise<void> {
    if (!this.started) return;
    if (epoch !== this.epoch) {
      this.target.log?.(`stale edit (epoch ${epoch}, current ${this.epoch}); resyncing`);
      this.fullSync();
      return;
    }
    if (!changes.every((c) => changeIsConsistent(this.mirror, c))) {
      this.target.log?.('edit positions do not match the document; resyncing');
      this.fullSync();
      return;
    }
    const next = applyChanges(this.mirror, changes);
    if (next === null) {
      this.target.log?.('edit out of range; resyncing');
      this.fullSync();
      return;
    }
    if (toLF(this.target.getText()) !== this.mirror) {
      // The document moved on before this edit could be applied.
      this.fullSync();
      return;
    }
    this.mirror = next;
    const ok = await this.target.applyChanges(changes);
    if (!ok) {
      this.target.log?.('document refused the edit; resyncing');
      this.fullSync();
      return;
    }
    this.reconcile();
  }

  /** Sends whatever differs between the document and the mirror as one patch. */
  private reconcile(reason?: 'undo' | 'redo'): void {
    const text = toLF(this.target.getText());
    const diff = minimalDiff(this.mirror, text);
    if (!diff) return;
    this.epoch++;
    this.mirror = text;
    if (!this.target.isVisible()) {
      this.stale = true;
      return;
    }
    this.target.post({
      type: 'patch',
      from: diff.from,
      to: diff.toA,
      insert: text.slice(diff.from, diff.toB),
      epoch: this.epoch,
      reason,
    });
  }

  private fullSync(): void {
    this.mirror = toLF(this.target.getText());
    this.epoch++;
    if (!this.target.isVisible()) {
      this.stale = true;
      return;
    }
    this.stale = false;
    this.target.post({ type: 'sync', text: this.mirror, epoch: this.epoch });
  }
}
