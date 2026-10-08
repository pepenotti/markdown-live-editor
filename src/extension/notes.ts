// The notes of the workspace, for wiki links and backlinks: which Markdown files exist,
// which names they answer to, and which links each of them contains.
//
// The file list is read once and then kept current by file system watchers. File contents
// are read only when backlinks or headings are asked for, parsed once, and read again only
// after the file changes.
import * as vscode from 'vscode';
import {
  baseName,
  dirName,
  isNotePath,
  linkLeadsTo,
  mayLeadTo,
  NOTE_EXTENSIONS,
  NoteSet,
  type NoteStatus,
  type ScannedNote,
  scanNote,
  stripNoteExtension,
} from '../shared/wikiLinks';
import { EXCLUDE } from './images';

const GLOB = `**/*.{${NOTE_EXTENSIONS.join(',')}}`;
const IGNORED = /\/(?:node_modules|\.git|dist|out|build|\.next|\.venv|target)\//;
const MAX_NOTES = 20000;
/** Larger files are not searched for links. */
const MAX_NOTE_BYTES = 1024 * 1024;
const READS_AT_ONCE = 24;
const EMPTY: ScannedNote = { links: [], lines: new Map(), headings: [] };

export type ResolvedNote = { status: 'found'; uri: vscode.Uri } | { status: 'missing' } | { status: 'ambiguous'; uris: vscode.Uri[] };

export interface Backlink {
  uri: vscode.Uri;
  /** Lines of that file that link to the note. */
  lines: { line: number; text: string }[];
}

export function wikiLinksEnabled(resource?: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration('seamlessMarkdown', resource).get<boolean>('wikiLinks', false);
}

export class NoteIndex implements vscode.Disposable {
  private readonly notes = new NoteSet();
  private readonly uris = new Map<string, vscode.Uri>();
  private readonly parsed = new Map<string, Promise<ScannedNote>>();
  /** Folders outside the workspace that were listed because a note in them was opened. */
  private readonly looseFolders = new Map<string, Promise<void>>();
  private workspaceScan: Promise<void> | undefined;
  private readonly watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly notesChanged = new vscode.EventEmitter<void>();
  private readonly contentChanged = new vscode.EventEmitter<void>();
  /** Fires, after a short pause, when notes were added or removed. */
  readonly onDidChangeNotes = this.notesChanged.event;
  /** Fires, after a short pause, when notes were added, removed or edited. */
  readonly onDidChange = this.contentChanged.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listChanged = false;

  constructor() {
    this.disposables.push(
      this.notesChanged,
      this.contentChanged,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reset()),
      // Unsaved text counts, so a link typed a moment ago shows up as a backlink.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.edited(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.edited(d.uri)),
    );
  }

  /* ---------- keeping the list current ---------- */

  private touch(list: boolean): void {
    this.listChanged ||= list;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.listChanged) this.notesChanged.fire();
      this.listChanged = false;
      this.contentChanged.fire();
    }, 300);
  }

  private add(uri: vscode.Uri): void {
    if (!isNotePath(uri.path) || IGNORED.test(uri.path) || this.notes.size >= MAX_NOTES) return;
    if (this.notes.add(uri.path)) {
      this.uris.set(uri.path, uri);
      this.touch(true);
    }
  }

  private remove(uri: vscode.Uri): void {
    this.parsed.delete(uri.path);
    this.uris.delete(uri.path);
    if (this.notes.delete(uri.path)) this.touch(true);
  }

  /** Forgets what was read from a file. Files nobody asked about cost nothing here. */
  private edited(uri: vscode.Uri): void {
    if (this.parsed.delete(uri.path)) this.touch(false);
  }

  private watch(pattern: vscode.GlobPattern): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watchers.push(
      watcher,
      watcher.onDidCreate((uri) => this.add(uri)),
      watcher.onDidDelete((uri) => this.remove(uri)),
      watcher.onDidChange((uri) => this.edited(uri)),
    );
  }

  private reset(): void {
    for (const w of this.watchers.splice(0)) w.dispose();
    this.notes.clear();
    this.uris.clear();
    this.parsed.clear();
    this.looseFolders.clear();
    this.workspaceScan = undefined;
    this.touch(true);
  }

  private async scanWorkspace(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) return;
    this.watch(GLOB);
    for (const uri of await vscode.workspace.findFiles(GLOB, EXCLUDE, MAX_NOTES)) this.add(uri);
  }

  /** A note outside the workspace: its folder and the folders directly inside it. */
  private async scanLoose(dir: vscode.Uri): Promise<void> {
    this.watch(new vscode.RelativePattern(dir, GLOB));
    const list = async (folder: vscode.Uri, deeper: boolean): Promise<void> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(folder);
      } catch {
        return;
      }
      for (const [name, type] of entries) {
        const child = vscode.Uri.joinPath(folder, name);
        if (type & vscode.FileType.File) this.add(child);
        else if (deeper && type & vscode.FileType.Directory && !name.startsWith('.') && !IGNORED.test(`/${name}/`)) await list(child, false);
      }
    };
    await list(dir, true);
  }

  /** Makes sure the notes around this document are known. */
  private async ready(from: vscode.Uri): Promise<void> {
    await (this.workspaceScan ??= this.scanWorkspace());
    if (vscode.workspace.getWorkspaceFolder(from)) return;
    const dir = vscode.Uri.joinPath(from, '..');
    let scan = this.looseFolders.get(dir.path);
    if (!scan) this.looseFolders.set(dir.path, (scan = this.scanLoose(dir)));
    await scan;
  }

  /** Folders a path may be written relative to, besides the folder of the note itself. */
  private roots(from: vscode.Uri): string[] {
    const folder = vscode.workspace.getWorkspaceFolder(from);
    return [folder ? folder.uri.path : dirName(from.path)];
  }

  private uriOf(path: string, like: vscode.Uri): vscode.Uri {
    return this.uris.get(path) ?? like.with({ path });
  }

  /* ---------- names ---------- */

  async resolve(from: vscode.Uri, name: string): Promise<ResolvedNote> {
    await this.ready(from);
    const found = this.notes.resolve(name, from.path, this.roots(from));
    if (found.status === 'found') return { status: 'found', uri: this.uriOf(found.path, from) };
    if (found.status === 'ambiguous') return { status: 'ambiguous', uris: found.paths.map((p) => this.uriOf(p, from)) };
    return found;
  }

  async statuses(from: vscode.Uri, names: readonly string[]): Promise<Record<string, NoteStatus>> {
    await this.ready(from);
    const roots = this.roots(from);
    const out: Record<string, NoteStatus> = {};
    for (const name of names.slice(0, 2000)) out[name] = this.notes.resolve(name, from.path, roots).status;
    return out;
  }

  /** Every note but this one, by the name to write in a wiki link. */
  async list(from: vscode.Uri): Promise<{ name: string; path: string }[]> {
    await this.ready(from);
    const root = this.roots(from)[0];
    const out: { name: string; path: string }[] = [];
    for (const path of this.notes.all()) {
      if (path === from.path) continue;
      out.push({ name: this.notes.nameOf(path, root), path: path.startsWith(root + '/') ? path.slice(root.length + 1) : path });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Headings of the note a name stands for (of the note itself for an empty name). */
  async headings(from: vscode.Uri, name: string): Promise<string[]> {
    if (!name.trim()) return (await this.scan(from)).headings;
    const found = await this.resolve(from, name);
    return found.status === 'found' ? (await this.scan(found.uri)).headings : [];
  }

  /* ---------- contents ---------- */

  private scan(uri: vscode.Uri, open?: Map<string, vscode.TextDocument>): Promise<ScannedNote> {
    let note = this.parsed.get(uri.path);
    if (!note) {
      note = this.read(uri, open).catch(() => EMPTY);
      this.parsed.set(uri.path, note);
    }
    return note;
  }

  private async read(uri: vscode.Uri, open?: Map<string, vscode.TextDocument>): Promise<ScannedNote> {
    const document = open ? open.get(uri.toString()) : vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (document) return scanNote(document.getText());
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_NOTE_BYTES) return EMPTY;
    return scanNote(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  }

  /** Notes that link to `target`, by wiki link or by a relative Markdown link. */
  async backlinks(target: vscode.Uri): Promise<Backlink[]> {
    await this.ready(target);
    const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    const paths = [...this.notes.all()].filter((p) => p !== target.path);
    const out: Backlink[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const path = paths[next++];
        const uri = this.uriOf(path, target);
        const note = await this.scan(uri, open);
        let roots: string[] | undefined;
        const lines = new Set<number>();
        for (const link of note.links) {
          if (lines.has(link.line) || !mayLeadTo(link, target.path)) continue;
          if (linkLeadsTo(link, path, target.path, this.notes, (roots ??= this.roots(uri)))) lines.add(link.line);
        }
        if (lines.size) out.push({ uri, lines: [...lines].sort((a, b) => a - b).map((line) => ({ line, text: note.lines.get(line) ?? '' })) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, paths.length) }, worker));
    return out.sort((a, b) => a.uri.path.localeCompare(b.uri.path));
  }

  /* ---------- new notes ---------- */

  /** Where a note of this name would be created: in the folder of the document that links to it. */
  locationFor(from: vscode.Uri, name: string): vscode.Uri | undefined {
    const parts = name
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '-').trim())
      .filter((part) => part && part !== '.' && part !== '..');
    if (!parts.length) return undefined;
    if (!isNotePath(parts[parts.length - 1])) parts[parts.length - 1] += '.md';
    return vscode.Uri.joinPath(from, '..', ...parts);
  }

  /** Creates the note with its name as the title. An existing file is left as it is. */
  async create(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${stripNoteExtension(baseName(uri.path))}\n`));
    }
    this.add(uri);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of [...this.watchers.splice(0), ...this.disposables.splice(0)]) d.dispose();
  }
}
