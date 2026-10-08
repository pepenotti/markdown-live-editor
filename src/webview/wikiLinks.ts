// Wiki links in the editor: where their parts are, and which of them lead to a note.
// The parser only produces WikiLink nodes while the setting is on, so everything here
// is idle otherwise.
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, StateEffect, StateField, type Text } from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { ResolveNotesResult } from '../shared/protocol';
import { type NoteStatus, parseWikiLink, type WikiLinkParts } from '../shared/wikiLinks';
import type { HostBridge } from './host';

export interface WikiLinkInfo extends WikiLinkParts {
  from: number;
  to: number;
  /** Range of the text that stays visible: the shown text, or the target when there is none. */
  shownFrom: number;
  shownTo: number;
}

/** Takes apart the wiki link that spans `from`..`to`, brackets included. */
export function wikiLinkInfo(doc: Text, from: number, to: number): WikiLinkInfo {
  const inner = doc.sliceString(from + 2, to - 2);
  const parts = parseWikiLink(inner);
  const bar = inner.indexOf('|');
  let shownFrom = from + 2;
  let shownTo = to - 2;
  if (bar >= 0 && parts.alias) shownFrom += bar + 1;
  else if (bar >= 0) shownTo = shownFrom + bar;
  return { ...parts, from, to, shownFrom, shownTo };
}

/** The wiki link at or next to a position. */
export function wikiLinkAt(state: EditorState, pos: number): WikiLinkInfo | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'WikiLink') return wikiLinkInfo(state.doc, n.from, n.to);
    }
  }
  return null;
}

const setNoteStatus = StateEffect.define<Record<string, NoteStatus>>();
/** Asks the host again about every link, after notes were added or removed. */
export const refreshNotes = StateEffect.define<null>();

/** What the host said about the targets of the wiki links seen so far. */
export const noteStatus = StateField.define<ReadonlyMap<string, NoteStatus>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, NoteStatus> | undefined;
    for (const e of tr.effects) {
      if (!e.is(setNoteStatus)) continue;
      for (const [name, status] of Object.entries(e.value)) {
        if ((next ?? value).get(name) !== status) (next ??= new Map(value)).set(name, status);
      }
    }
    return next ?? value;
  },
});

/** Asks the host, in batches, whether the notes linked from the visible text exist. */
export function wikiResolver(host: HostBridge): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private readonly asked = new Set<string>();
      private stale = false;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(u: ViewUpdate): void {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshNotes)));
        if (refresh) this.stale = true;
        if (refresh || u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.schedule();
      }

      private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), 120);
      }

      private run(): void {
        const state = this.view.state;
        const known = state.field(noteStatus);
        const all = this.stale;
        this.stale = false;
        const names = new Set<string>();
        for (const range of this.view.visibleRanges) {
          syntaxTree(state).iterate({
            from: range.from,
            to: range.to,
            enter: (node) => {
              if (node.name !== 'WikiLink') return true;
              const target = wikiLinkInfo(state.doc, node.from, node.to).target;
              if (target && (all || (!known.has(target) && !this.asked.has(target)))) names.add(target);
              return false;
            },
          });
        }
        if (!names.size) return;
        for (const name of names) this.asked.add(name);
        host
          .request<ResolveNotesResult>('resolveNotes', { names: [...names] })
          .then((result) => this.view.dispatch({ effects: setNoteStatus.of(result.notes) }))
          .catch(() => {})
          .finally(() => {
            for (const name of names) this.asked.delete(name);
          });
      }

      destroy(): void {
        clearTimeout(this.timer);
      }
    },
  );
  return [noteStatus, plugin];
}
