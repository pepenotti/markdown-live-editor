// The notes of the workspace, for wiki links and backlinks: which Markdown files exist,
// which names they answer to, and which links each of them contains.
//
// Nothing here runs while `seamlessMarkdown.wikiLinks` is off: no file is listed, nothing
// is watched, and every question is answered with "nothing". Once it is on, the file list
// is read once and then kept current through the shared file watchers. File contents are
// read only when backlinks or headings are asked for, parsed once into a short list of
// links, and read again only after the file changes.
import * as vscode from 'vscode';
import {
  baseName,
  dirName,
  isNotePath,
  linkLeadsTo,
  mayLeadTo,
  newNoteFileName,
  NOTE_EXTENSIONS,
  NoteSet,
  type ScannedNote,
  scanNote,
  stripNoteExtension,
} from '../shared/wikiLinks';
import type { FileEvent, FileWatch } from './fileWatch';
import { EXCLUDE } from './images';

const GLOB = `**/*.{${NOTE_EXTENSIONS.join(',')}}`;
const IGNORED = /\/(?:node_modules|\.git|dist|out|build|\.next|\.venv|target)\//;
const MAX_NOTES = 20000;
/** Larger files are not searched for links. */
const MAX_NOTE_BYTES = 1024 * 1024;
const READS_AT_ONCE = 24;
/** How long a look at a file the index does not list is trusted. */
const STAT_MS = 5000;
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

/** True when the setting is on for the window or for any of its folders. */
function enabledSomewhere(): boolean {
  return wikiLinksEnabled() || (vscode.workspace.workspaceFolders ?? []).some((folder) => wikiLinksEnabled(folder.uri));
}

export class NoteIndex implements vscode.Disposable {
  private readonly notes = new NoteSet();
  private readonly uris = new Map<string, vscode.Uri>();
  private readonly parsed = new Map<string, Promise<ScannedNote>>();
  /** Folders outside the workspace that were listed because a note in them was opened. */
  private readonly looseFolders = new Map<string, { uri: vscode.Uri; scan: Promise<void> }>();
  private workspaceScan: Promise<void> | undefined;
  /** Files that are not listed (too deep, in a skipped folder) but were asked for by path. */
  private readonly stats = new Map<string, { at: number; exists: Promise<boolean> }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly notesChanged = new vscode.EventEmitter<void>();
  private readonly contentChanged = new vscode.EventEmitter<void>();
  /** Fires, after a short pause, when notes were added or removed. */
  readonly onDidChangeNotes = this.notesChanged.event;
  /** Fires, after a short pause, when notes were added, removed or edited. */
  readonly onDidChange = this.contentChanged.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listChanged = false;
  /** Counts restarts, so a scan that was under way when the index was emptied adds nothing. */
  private generation = 0;

  constructor(private readonly watch: FileWatch) {
    this.disposables.push(
      this.notesChanged,
      this.contentChanged,
      watch.onDidChange((e) => this.fileChanged(e)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reset()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('seamlessMarkdown.wikiLinks') && !enabledSomewhere()) this.reset();
      }),
      // Unsaved text counts, so a link typed a moment ago shows up as a backlink.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.edited(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.edited(d.uri)),
    );
  }

  /** What the index holds and watches (for the tests). */
  get state(): { notes: number; parsed: number; started: boolean; looseFolders: number } {
    return { notes: this.notes.size, parsed: this.parsed.size, started: this.workspaceScan !== undefined, looseFolders: this.looseFolders.size };
  }

  /* ---------- keeping the list current ---------- */

  private touch(list: boolean): void {
    this.listChanged ||= list;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.listChanged) this.notesChanged.fire();
      this.listChanged = false;
      this.contentChanged.fire();
    }, 300);
  }

  /** True for a file in a folder this index has listed: a workspace folder or an opened note's folder. */
  private covered(uri: vscode.Uri): boolean {
    if (IGNORED.test(uri.path)) return false;
    if (vscode.workspace.getWorkspaceFolder(uri)) return this.workspaceScan !== undefined;
    return this.looseFolders.has(dirName(uri.path));
  }

  private add(uri: vscode.Uri): void {
    if (!isNotePath(uri.path) || IGNORED.test(uri.path) || this.notes.size >= MAX_NOTES) return;
    if (this.notes.add(uri.path)) {
      this.uris.set(uri.path, uri);
      this.touch(true);
    }
  }

  private remove(uri: vscode.Uri): void {
    if (!isNotePath(uri.path)) {
      // Perhaps a folder: its notes went with it.
      for (const path of [...this.notes.within([uri.path])]) {
        this.parsed.delete(path);
        this.uris.delete(path);
      }
      if (this.notes.deleteFolder(uri.path)) this.touch(true);
      return;
    }
    this.parsed.delete(uri.path);
    this.uris.delete(uri.path);
    if (this.notes.delete(uri.path)) this.touch(true);
  }

  /** Forgets what was read from a file. Files nobody asked about cost nothing here. */
  private edited(uri: vscode.Uri): void {
    if (this.parsed.delete(uri.path)) this.touch(false);
  }

  private fileChanged(event: FileEvent): void {
    // The watchers are shared: without a list of its own, the index has no use for their news.
    if (this.workspaceScan === undefined) return;
    this.stats.clear();
    if (event.kind === 'change') this.edited(event.uri);
    else if (event.kind === 'delete') this.remove(event.uri);
    else if (this.covered(event.uri)) this.add(event.uri);
  }

  /** Empties the index and stops watching. It starts again the next time it is asked something. */
  private reset(): void {
    const had = this.workspaceScan !== undefined;
    this.generation++;
    this.notes.clear();
    this.uris.clear();
    this.parsed.clear();
    this.stats.clear();
    this.looseFolders.clear();
    this.workspaceScan = undefined;
    this.watch.want(this, false);
    if (had) this.touch(true);
  }

  private wantWatchers(): void {
    this.watch.want(this, !!vscode.workspace.workspaceFolders?.length, [...this.looseFolders.values()].map((f) => f.uri));
  }

  private async scanWorkspace(): Promise<void> {
    const generation = this.generation;
    if (!vscode.workspace.workspaceFolders?.length) return;
    const found = await vscode.workspace.findFiles(GLOB, EXCLUDE, MAX_NOTES);
    if (generation === this.generation) for (const uri of found) this.add(uri);
  }

  /** A note outside the workspace: the Markdown files of its own folder, and no deeper. */
  private async scanLoose(dir: vscode.Uri): Promise<void> {
    const generation = this.generation;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    for (const [name, type] of entries) if (type & vscode.FileType.File) this.add(vscode.Uri.joinPath(dir, name));
  }

  /** Makes sure the notes around this document are known. False when there is nothing to know. */
  private async ready(from: vscode.Uri): Promise<boolean> {
    if (from.scheme === 'untitled' || !wikiLinksEnabled(from)) return false;
    if (!this.workspaceScan) {
      this.workspaceScan = this.scanWorkspace();
      this.wantWatchers();
    }
    await this.workspaceScan;
    if (vscode.workspace.getWorkspaceFolder(from)) return true;
    const dir = vscode.Uri.joinPath(from, '..');
    let folder = this.looseFolders.get(dir.path);
    if (!folder) {
      folder = { uri: dir, scan: this.scanLoose(dir) };
      this.looseFolders.set(dir.path, folder);
      this.wantWatchers();
    }
    await folder.scan;
    return true;
  }

  /**
   * The folders a note belongs to: every workspace folder, its own first, or just its own
   * folder when it is outside the workspace. Names are never resolved to anything outside them.
   */
  private roots(from: vscode.Uri): string[] {
    const own = vscode.workspace.getWorkspaceFolder(from);
    if (!own) return [dirName(from.path)];
    const others = (vscode.workspace.workspaceFolders ?? []).filter((f) => f !== own && f.uri.scheme === from.scheme && f.uri.authority === from.authority);
    return [own.uri.path, ...others.map((f) => f.uri.path)];
  }

  private uriOf(path: string, like: vscode.Uri): vscode.Uri {
    return this.uris.get(path) ?? like.with({ path, query: '', fragment: '' });
  }

  private exists(uri: vscode.Uri): Promise<boolean> {
    const key = uri.toString();
    const known = this.stats.get(key);
    if (known && Date.now() - known.at < STAT_MS) return known.exists;
    const exists = Promise.resolve(vscode.workspace.fs.stat(uri)).then(
      (stat) => !!(stat.type & vscode.FileType.File),
      () => false,
    );
    if (this.stats.size > 2000) this.stats.clear();
    this.stats.set(key, { at: Date.now(), exists });
    return exists;
  }

  /* ---------- names ---------- */

  /** The file a wiki link names, seen from the document `from`. Always inside the folders that document belongs to. */
  async resolve(from: vscode.Uri, name: string): Promise<ResolvedNote> {
    if (!(await this.ready(from))) return { status: 'missing' };
    const roots = this.roots(from);
    const found = this.notes.resolve(name, from.path, roots);
    if (found.status === 'found') return { status: 'found', uri: this.uriOf(found.path, from) };
    if (found.status === 'ambiguous') return { status: 'ambiguous', uris: found.paths.map((p) => this.uriOf(p, from)) };
    // A file the list leaves out (a subfolder outside the workspace, a skipped folder) still exists when named by its path.
    for (const path of NoteSet.exactPaths(name, from.path, roots).filter((p) => p.endsWith('.md') || isNotePath(name.trim()))) {
      const uri = from.with({ path, query: '', fragment: '' });
      if (await this.exists(uri)) return { status: 'found', uri };
    }
    return found;
  }

  /** Every note but this one, by the name to write in a wiki link. */
  async list(from: vscode.Uri): Promise<{ name: string; path: string }[]> {
    if (!(await this.ready(from))) return [];
    const roots = this.roots(from);
    const out: { name: string; path: string }[] = [];
    for (const path of this.notes.within(roots)) {
      if (path === from.path) continue;
      const root = roots.find((r) => path.startsWith(r + '/')) ?? roots[0];
      out.push({ name: this.notes.nameOf(path, roots), path: path.slice(root.length + 1) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Headings of the note a name stands for (of the note itself for an empty name). */
  async headings(from: vscode.Uri, name: string): Promise<string[]> {
    if (!(await this.ready(from))) return [];
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
    if (document) return document.getText().length > MAX_NOTE_BYTES ? EMPTY : scanNote(document.getText());
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_NOTE_BYTES) return EMPTY;
    return scanNote(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  }

  /** Notes that link to `target`, by wiki link or by a relative Markdown link. */
  async backlinks(target: vscode.Uri): Promise<Backlink[]> {
    if (!(await this.ready(target))) return [];
    const generation = this.generation;
    const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    const paths = [...this.notes.within(this.roots(target))].filter((p) => p !== target.path);
    const out: Backlink[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length && generation === this.generation) {
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

  /**
   * Where a note of this name would be created: directly in the folder of the document
   * that links to it. Undefined when the name cannot be a plain file name there.
   */
  locationFor(from: vscode.Uri, name: string): vscode.Uri | undefined {
    const file = newNoteFileName(name);
    if (file === null || from.scheme === 'untitled') return undefined;
    const uri = vscode.Uri.joinPath(from, '..', file);
    // Belt and braces: the file name must have survived as the last part of the path, in that folder.
    return baseName(uri.path) === file && dirName(uri.path) === dirName(from.path) ? uri : undefined;
  }

  /**
   * Creates the note with its name as the title. Never replaces a file: one that already
   * exists is left exactly as it is. Returns false when nothing could be created.
   */
  async create(uri: vscode.Uri): Promise<boolean> {
    const kind = async (): Promise<vscode.FileType | undefined> => {
      try {
        return (await vscode.workspace.fs.stat(uri)).type;
      } catch {
        return undefined;
      }
    };
    if ((await kind()) === undefined) {
      // Created with "do not overwrite", so a file that appears in between is not replaced either.
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { overwrite: false, ignoreIfExists: true, contents: new TextEncoder().encode(`# ${stripNoteExtension(baseName(uri.path))}\n`) });
      await vscode.workspace.applyEdit(edit);
    }
    this.stats.clear();
    const isFile = !!(((await kind()) ?? 0) & vscode.FileType.File);
    if (isFile && this.covered(uri)) this.add(uri);
    return isFile;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watch.want(this, false);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
