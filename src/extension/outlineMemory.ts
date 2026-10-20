// What the host remembers about the outline panel inside the editor: whether it was left open and
// how wide it was made. Kept for the user (globalState), not the workspace, so it follows them
// across files and windows; sent to each editor with `init`.
import type * as vscode from 'vscode';
import { normalizeOutlineWidth } from '../shared/outlineWidth';

/** Keys in `globalState`. */
export const OUTLINE_OPEN_KEY = 'outlineOpen';
export const OUTLINE_WIDTH_KEY = 'outlineWidth';

export class OutlineMemory {
  // Read back from here rather than from globalState, which can briefly hand back an earlier
  // value when the panel is toggled or resized quickly.
  private openState: boolean | undefined;
  private widthState: { value: number | undefined } | undefined;

  constructor(private readonly store: Pick<vscode.Memento, 'get' | 'update'>) {}

  /** Whether the panel starts open. Closed until the user opens it. */
  get open(): boolean {
    return (this.openState ??= this.store.get<boolean>(OUTLINE_OPEN_KEY) === true);
  }

  /** The width the user gave the panel, or undefined for the default. */
  get width(): number | undefined {
    return (this.widthState ??= { value: normalizeOutlineWidth(this.store.get<unknown>(OUTLINE_WIDTH_KEY)) }).value;
  }

  /** `undefined` forgets the choice, as for a first-time user. */
  rememberOpen(open: boolean | undefined): Thenable<void> {
    this.openState = open;
    return this.store.update(OUTLINE_OPEN_KEY, open);
  }

  /** Remembers a width; `undefined`, or something that is not a width, forgets it. */
  rememberWidth(width: unknown): Thenable<void> {
    const value = normalizeOutlineWidth(width);
    this.widthState = { value };
    return this.store.update(OUTLINE_WIDTH_KEY, value);
  }
}
