// Underlines broken links in every mode. The findings live in their own decoration layer:
// it adds a class and a tooltip and never hides or replaces anything, so the rendering
// in decorations/inline.ts and its atoms are left alone.
//
// The document is only scanned after typing pauses; between scans the underlines are
// moved along with the text.
import { ensureSyntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import { analyse, type Finding, type LinkIssue, scanDocument, type Target, withIssues } from '../shared/linkCheck';

const EDIT_DELAY_MS = 600;
const PARSE_BUDGET_MS = 60;
const PARSE_RETRY_MS = 400;
const MAX_PARSE_RETRIES = 40;
const BROKEN = 'cm-md-broken-link';

interface FindingSet {
  decorations: DecorationSet;
  /** Messages by link target as written, for links drawn by widgets (table cells). */
  byHref: ReadonlyMap<string, string>;
}

const NONE: FindingSet = { decorations: Decoration.none, byHref: new Map() };

const setFindings = StateEffect.define<{ findings: readonly Finding[]; byHref: ReadonlyMap<string, string> }>();

const findingField = StateField.define<FindingSet>({
  create: () => NONE,
  update(value, tr) {
    if (tr.docChanged && value.decorations.size) value = { ...value, decorations: value.decorations.map(tr.changes) };
    for (const e of tr.effects) {
      if (!e.is(setFindings)) continue;
      const marks = e.value.findings
        .filter((f) => f.to > f.from && f.to <= tr.newDoc.length)
        .map((f) => Decoration.mark({ class: BROKEN, attributes: { title: f.message }, message: f.message }).range(f.from, f.to));
      value = marks.length || e.value.byHref.size ? { decorations: Decoration.set(marks, true), byHref: e.value.byHref } : NONE;
    }
    return value;
  },
  // Highest precedence makes this the innermost element, so its tooltip wins over the link's own.
  provide: (field) => Prec.highest(EditorView.decorations.from(field, (value) => value.decorations)),
});

/** Reasons of the links currently underlined, in document order. */
export function brokenLinkMessages(state: EditorState): string[] {
  const out: string[] = [];
  const set = state.field(findingField, false)?.decorations;
  if (!set) return out;
  for (let cursor = set.iter(); cursor.value; cursor.next()) out.push(String(cursor.value.spec.message));
  return out;
}

export interface LinkCheckOptions {
  /** Asks the host which of the targets do not exist; one entry per target, null when it is fine. */
  check(targets: Target[]): Promise<(LinkIssue | null)[]>;
  onError(message: string): void;
}

export interface LinkCheck {
  extension: Extension;
  setEnabled(enabled: boolean): void;
  /** Checks again now, for example after files were created or deleted. */
  recheck(): void;
}

export function linkCheck(options: LinkCheckOptions): LinkCheck {
  let enabled = true;
  let view: EditorView | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let cellFrame = 0;
  let cellsMarked = false;
  let runs = 0;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void pass(), delay);
  };

  const publish = (v: EditorView, findings: readonly Finding[], byHref: ReadonlyMap<string, string>) => {
    const current = v.state.field(findingField);
    if (current === NONE && !findings.length && !byHref.size) return;
    v.dispatch({ effects: setFindings.of({ findings, byHref }) });
    markCells();
  };

  async function pass(): Promise<void> {
    const v = view;
    if (!v || !enabled) return;
    const run = ++runs;
    const state = v.state;
    const doc = state.doc;
    // The editor parses lazily. Finish the tree in small slices rather than blocking on a huge file.
    const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS);
    if (!tree) {
      if (retries++ < MAX_PARSE_RETRIES) schedule(PARSE_RETRY_MS);
      return;
    }
    retries = 0;
    const text = doc.toString();
    const scan = scanDocument(tree, (from, to) => text.slice(from, to));
    const analysis = analyse(scan);
    let issues: (LinkIssue | null)[] = [];
    if (analysis.targets.length) {
      try {
        issues = await options.check(analysis.targets);
      } catch (err) {
        options.onError(`Could not check the links: ${String(err)}`);
        return;
      }
    }
    // An edit or a newer pass made meanwhile takes over; these positions belong to the old text.
    if (view !== v || !enabled || run !== runs || v.state.doc !== doc) return;
    const findings = withIssues(analysis, issues);
    const byHref = new Map<string, string>();
    const messageAt = new Map(findings.map((f) => [`${f.from}:${f.to}`, f.message]));
    for (const link of scan.links) {
      const message = link.href === null || link.label !== undefined ? undefined : messageAt.get(`${link.from}:${link.to}`);
      if (message) byHref.set(link.href!, message);
    }
    publish(v, findings, byHref);
  }

  /** Links inside rendered tables are drawn by a widget, so they are marked in the DOM. */
  function markCells(): void {
    if (cellFrame) return;
    cellFrame = requestAnimationFrame(() => {
      cellFrame = 0;
      const v = view;
      if (!v) return;
      const byHref = v.state.field(findingField, false)?.byHref ?? NONE.byHref;
      if (!byHref.size && !cellsMarked) return;
      cellsMarked = byHref.size > 0;
      for (const el of v.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table-wrap .cm-md-link[data-href]')) {
        const href = el.dataset.href ?? '';
        const message = byHref.get(href);
        el.classList.toggle(BROKEN, !!message);
        const title = message ?? href;
        if (el.title !== title) el.title = title;
      }
    });
  }

  const plugin = ViewPlugin.define((v) => {
    view = v;
    schedule(0);
    return {
      update(update) {
        if (update.docChanged && enabled) schedule(EDIT_DELAY_MS);
        if (cellsMarked || update.state.field(findingField).byHref.size) markCells();
      },
      destroy() {
        clearTimeout(timer);
        if (cellFrame) cancelAnimationFrame(cellFrame);
        cellFrame = 0;
        if (view === v) view = undefined;
      },
    };
  });

  return {
    extension: [findingField, plugin],
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      clearTimeout(timer);
      if (!view) return;
      if (enabled) schedule(0);
      else publish(view, [], NONE.byHref);
    },
    recheck() {
      if (view && enabled) schedule(0);
    },
  };
}
