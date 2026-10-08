// Autocomplete: a slash menu for inserting blocks and file paths inside links.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { CommandId, ListNotesResult } from '../../shared/protocol';
import {
  type FormatCommand,
  insertCodeBlock,
  insertLink,
  insertRule,
  setHeading,
  toggleList,
  toggleQuote,
} from '../commands/format';
import type { HostBridge } from '../host';

export function insideCode(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode' || n.name === 'FrontMatter') return true;
  }
  return false;
}

/** Removes the typed "/word" and applies a formatting command as one change. */
function replaceWith(view: EditorView, from: number, to: number, command: FormatCommand): void {
  const first = view.state.update({ changes: { from, to } });
  const spec = command(first.state);
  if (!spec) {
    view.dispatch({ changes: { from, to }, userEvent: 'input.format' });
    return;
  }
  const second = first.state.update(spec);
  view.dispatch({
    changes: first.changes.compose(second.changes),
    selection: second.state.selection,
    scrollIntoView: true,
    userEvent: 'input.format',
  });
}

interface SlashItem {
  name: string;
  label: string;
  detail: string;
  command?: FormatCommand;
  action?: CommandId;
}

const SLASH: SlashItem[] = [
  { name: 'h1', label: 'Heading 1', detail: '#', command: setHeading(1) },
  { name: 'h2', label: 'Heading 2', detail: '##', command: setHeading(2) },
  { name: 'h3', label: 'Heading 3', detail: '###', command: setHeading(3) },
  { name: 'bullet', label: 'Bullet list', detail: '-', command: toggleList('bullet') },
  { name: 'numbered', label: 'Numbered list', detail: '1.', command: toggleList('ordered') },
  { name: 'todo', label: 'Task list', detail: '- [ ]', command: toggleList('task') },
  { name: 'quote', label: 'Quote', detail: '>', command: toggleQuote },
  { name: 'code', label: 'Code block', detail: '```', command: insertCodeBlock },
  { name: 'table', label: 'Table', detail: '3 × 3', action: 'table' },
  { name: 'image', label: 'Image', detail: 'choose a file', action: 'image' },
  { name: 'link', label: 'Link', detail: '[text](url)', command: insertLink },
  { name: 'divider', label: 'Divider', detail: '---', command: insertRule },
  { name: 'toc', label: 'Table of contents', detail: 'links to the headings', action: 'toc' },
];

function slashSource(run: (id: CommandId) => void) {
  const options: Completion[] = SLASH.map((item, i) => ({
    label: '/' + item.name,
    displayLabel: item.label,
    detail: item.detail,
    boost: -i,
    apply(view, _completion, from, to) {
      if (item.command) {
        replaceWith(view, from, to, item.command);
      } else if (item.action) {
        view.dispatch({ changes: { from, to }, userEvent: 'input.format' });
        run(item.action);
      }
    },
  }));
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = /^\s*(\/\w*)$/.exec(line.text.slice(0, ctx.pos - line.from));
    if (!m || insideCode(ctx.state, ctx.pos)) return null;
    return { from: ctx.pos - m[1].length, options, validFor: /^\/\w*$/ };
  };
}

function pathSource(host: HostBridge) {
  const cache = new Map<boolean, { at: number; files: Promise<string[]> }>();
  const list = (imagesOnly: boolean): Promise<string[]> => {
    const hit = cache.get(imagesOnly);
    if (hit && Date.now() - hit.at < 5000) return hit.files;
    const files = host
      .request<{ files: string[] }>('listFiles', { imagesOnly })
      .then((r) => r.files)
      .catch(() => [] as string[]);
    cache.set(imagesOnly, { at: Date.now(), files });
    return files;
  };
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = /(!?)\[[^\]]*\]\(<?([^)\s>]*)$/.exec(line.text.slice(0, ctx.pos - line.from));
    if (!m || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(m[2])) return null;
    const files = await list(m[1] === '!');
    if (ctx.aborted || !files.length) return null;
    return {
      from: ctx.pos - m[2].length,
      options: files.map((path) => ({ label: path, type: 'file' })),
      validFor: /^[^)\s>]*$/,
    };
  };
}

/** Completes a wiki link and leaves the cursor after its closing brackets. */
function applyWikiName(view: EditorView, text: string, from: number, to: number): void {
  const line = view.state.doc.lineAt(to);
  const rest = line.text.slice(to - line.from);
  let insert = text;
  let cursor = from + text.length;
  if (rest.startsWith(']]')) cursor += 2;
  else if (!/^[^\[\]]*\]\]/.test(rest)) {
    insert += ']]';
    cursor += 2;
  }
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: cursor }, scrollIntoView: true, userEvent: 'input.complete' });
}

/** After `[[`: the notes of the workspace, and after `[[Note#` the headings of that note. */
export function wikiSource(host: Pick<HostBridge, 'request'>, enabled: () => boolean) {
  const cache = new Map<string, { at: number; items: Promise<{ label: string; detail?: string }[]> }>();
  const cached = (key: string, load: () => Promise<{ label: string; detail?: string }[]>) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.items;
    const items = load().catch(() => []);
    if (cache.size > 50) cache.clear();
    cache.set(key, { at: Date.now(), items });
    return items;
  };
  const notes = () =>
    cached('', async () =>
      (await host.request<ListNotesResult>('listNotes')).notes.map((n) => ({ label: n.name, detail: n.path === `${n.name}.md` ? undefined : n.path })),
    );
  const headings = (name: string) =>
    cached('#' + name, async () => (await host.request<{ headings: string[] }>('noteHeadings', { name })).headings.map((h) => ({ label: h })));
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!enabled()) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = /\[\[([^\[\]|#]*)(?:#([^\[\]|]*))?$/.exec(line.text.slice(0, ctx.pos - line.from));
    if (!m || insideCode(ctx.state, ctx.pos)) return null;
    const inHeading = m[2] !== undefined;
    const items = await (inHeading ? headings(m[1].trim()) : notes());
    if (ctx.aborted || !items.length) return null;
    return {
      from: ctx.pos - (inHeading ? m[2].length : m[1].length),
      options: items.map((item) => ({
        ...item,
        type: inHeading ? 'text' : 'file',
        apply: (view, _completion, from, to) => applyWikiName(view, item.label, from, to),
      })),
      validFor: inHeading ? /^[^\[\]|]*$/ : /^[^\[\]|#]*$/,
    };
  };
}

export function completions(host: HostBridge, run: (id: CommandId) => void, wikiLinks: () => boolean = () => false): Extension {
  return autocompletion({
    override: [slashSource(run), pathSource(host), wikiSource(host, wikiLinks)],
    icons: false,
    activateOnTyping: true,
    closeOnBlur: true,
    maxRenderedOptions: 60,
  });
}
