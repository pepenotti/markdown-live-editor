import { Annotation, StateEffect, StateField } from '@codemirror/state';
import type { Mode } from '../shared/protocol';

export const setMode = StateEffect.define<Mode>();

export const modeField = StateField.define<Mode>({
  create: () => 'half',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMode)) value = e.value;
    return value;
  },
});

/** Marks a transaction that applies a change coming from the VS Code document. */
export const externalChange = Annotation.define<boolean>();
/** Marks a transaction that may rewrite protected source such as a rendered table. */
export const bypassGuard = Annotation.define<boolean>();
/** Marks a cursor correction made by the editor itself. */
export const cursorFix = Annotation.define<boolean>();
/** Forces decorations to be rebuilt, for example after a font change. */
export const refreshDecorations = StateEffect.define<null>();
/**
 * Shows the Markdown source of the rendered block (table, front matter) at this
 * position until the cursor leaves it. `null` renders it again.
 */
export const revealBlock = StateEffect.define<number | null>({
  map: (value, changes) => (value === null ? null : changes.mapPos(value)),
});
