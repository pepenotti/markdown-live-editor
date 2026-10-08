// A small model of a GFM pipe table: parse, edit, serialise. No editor dependencies.

export type Align = 'left' | 'center' | 'right' | null;

export interface Span {
  /** Raw cell range inside the source, between the pipes and including padding. */
  from: number;
  to: number;
}

export interface TableModel {
  /** rows[0] is the header. Every row has exactly `align.length` cells. */
  rows: string[][];
  align: Align[];
  /** Where each cell sits in the source it was parsed from; absent for missing cells. */
  spans: (Span | undefined)[][];
}

interface RawCell extends Span {
  text: string;
}

function splitRow(line: string, offset: number): RawCell[] {
  const cells: RawCell[] = [];
  let i = 0;
  const n = line.length;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] === '|') i++;
  let start = i;
  let text = '';
  for (; i < n; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n) {
      text += line[i + 1] === '|' ? '|' : ch + line[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push({ text: text.trim(), from: offset + start, to: offset + i });
      start = i + 1;
      text = '';
    } else {
      text += ch;
    }
  }
  // Text after the last pipe is a cell only when it is not just whitespace.
  if (text.trim() !== '' || cells.length === 0) cells.push({ text: text.trim(), from: offset + start, to: offset + n });
  return cells;
}

function parseAlign(cell: string): Align | undefined {
  const m = /^(:?)-+(:?)$/.exec(cell);
  if (!m) return undefined;
  if (m[1] && m[2]) return 'center';
  if (m[2]) return 'right';
  if (m[1]) return 'left';
  return null;
}

export function parseTable(source: string): TableModel | null {
  const lines = source.split('\n');
  if (lines.length < 2) return null;
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  const header = splitRow(lines[0], offsets[0]);
  const delim = splitRow(lines[1], offsets[1]);
  if (header.length !== delim.length) return null;
  const align: Align[] = [];
  for (const d of delim) {
    const a = parseAlign(d.text);
    if (a === undefined) return null;
    align.push(a);
  }
  const cols = align.length;
  const rows: string[][] = [header.map((c) => c.text)];
  const spans: (Span | undefined)[][] = [header.map(({ from, to }) => ({ from, to }))];
  for (let i = 2; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = splitRow(lines[i], offsets[i]);
    const row: string[] = [];
    const rowSpans: (Span | undefined)[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(cells[c]?.text ?? '');
      rowSpans.push(cells[c] ? { from: cells[c].from, to: cells[c].to } : undefined);
    }
    rows.push(row);
    spans.push(rowSpans);
  }
  return { rows, align, spans };
}

export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - text.length);
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

function delimiter(width: number, align: Align): string {
  const w = Math.max(3, width);
  if (align === 'center') return ':' + '-'.repeat(w - 2) + ':';
  if (align === 'right') return '-'.repeat(w - 1) + ':';
  if (align === 'left') return ':' + '-'.repeat(w - 1);
  return '-'.repeat(w);
}

export function serializeTable(model: Pick<TableModel, 'rows' | 'align'>, padCells: boolean): string {
  const cols = model.align.length;
  const cells = model.rows.map((row) => row.map(escapeCell));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 3;
    if (padCells) for (const row of cells) w = Math.max(w, (row[c] ?? '').length);
    widths.push(w);
  }
  const line = (row: string[]) =>
    '| ' + row.map((cell, c) => (padCells ? pad(cell, widths[c], model.align[c]) : cell)).join(' | ') + ' |';
  const out = [line(cells[0]), '| ' + model.align.map((a, c) => delimiter(padCells ? widths[c] : 3, a)).join(' | ') + ' |'];
  for (let r = 1; r < cells.length; r++) out.push(line(cells[r]));
  return out.join('\n');
}

/**
 * Returns the source with one cell changed. With `padCells` the whole table is
 * re-aligned; without it only that cell's text is replaced.
 */
export function setCell(source: string, r: number, c: number, text: string, padCells: boolean): string | null {
  const model = parseTable(source);
  if (!model || r < 0 || r >= model.rows.length || c < 0 || c >= model.align.length) return null;
  const span = model.spans[r][c];
  if (!padCells && span) {
    const escaped = escapeCell(text);
    return source.slice(0, span.from) + (escaped === '' ? ' ' : ` ${escaped} `) + source.slice(span.to);
  }
  model.rows[r][c] = text;
  return serializeTable(model, padCells);
}

export type TableOp =
  | { op: 'insertRow'; at: number }
  | { op: 'deleteRow'; row: number }
  | { op: 'moveRow'; row: number; by: -1 | 1 }
  | { op: 'insertCol'; at: number }
  | { op: 'deleteCol'; col: number }
  | { op: 'moveCol'; col: number; by: -1 | 1 }
  | { op: 'align'; col: number; align: Align }
  | { op: 'sort'; col: number; dir: 'asc' | 'desc' }
  | { op: 'duplicateRow'; row: number }
  | { op: 'clearRow'; row: number }
  | { op: 'clearCol'; col: number };

/** The value of a cell that reads as a number, such as `12`, `-3.5`, `1,200`, `$5` or `40%`. */
function numberOf(text: string): number | null {
  const m = /^([-+]?)[$€£]?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s?%?$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return m[1] === '-' ? -n : n;
}

/** Cell text without the emphasis, code and link markers, so `**b**` sorts next to `b`. */
function sortText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();
}

const collator = new Intl.Collator(undefined, { sensitivity: 'accent', numeric: true });

/**
 * Sorts the body rows by one column and leaves the header where it is. The sort is stable.
 * A column whose filled cells are all numbers sorts by value, any other column by its text
 * without regard to case. Empty cells go last in both directions.
 */
function sortRows(rows: string[][], col: number, dir: 'asc' | 'desc'): void {
  const body = rows.slice(1);
  const filled = body.map((row) => row[col].trim()).filter((v) => v !== '');
  const numeric = filled.length > 0 && filled.every((v) => numberOf(v) !== null);
  const sign = dir === 'asc' ? 1 : -1;
  const keyed = body.map((row, index) => {
    const value = row[col].trim();
    return { row, index, empty: value === '', num: numeric ? (numberOf(value) ?? 0) : 0, text: numeric ? '' : sortText(value) };
  });
  keyed.sort((a, b) => {
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    const order = a.empty ? 0 : numeric ? a.num - b.num : collator.compare(a.text, b.text);
    return order !== 0 ? sign * order : a.index - b.index;
  });
  rows.splice(1, body.length, ...keyed.map((k) => k.row));
}

/** Applies a structural change. Returns false when it is not possible (for example deleting the header). */
export function applyOp(model: Pick<TableModel, 'rows' | 'align'>, op: TableOp): boolean {
  const cols = model.align.length;
  const swap = <T>(arr: T[], a: number, b: number) => {
    const t = arr[a];
    arr[a] = arr[b];
    arr[b] = t;
  };
  switch (op.op) {
    case 'insertRow': {
      const at = Math.max(1, Math.min(model.rows.length, op.at));
      model.rows.splice(at, 0, new Array<string>(cols).fill(''));
      return true;
    }
    case 'deleteRow':
      if (op.row < 1 || op.row >= model.rows.length) return false;
      model.rows.splice(op.row, 1);
      return true;
    case 'moveRow': {
      const to = op.row + op.by;
      if (op.row < 1 || to < 1 || op.row >= model.rows.length || to >= model.rows.length) return false;
      swap(model.rows, op.row, to);
      return true;
    }
    case 'insertCol': {
      const at = Math.max(0, Math.min(cols, op.at));
      model.align.splice(at, 0, null);
      for (const row of model.rows) row.splice(at, 0, '');
      return true;
    }
    case 'deleteCol':
      if (cols <= 1 || op.col < 0 || op.col >= cols) return false;
      model.align.splice(op.col, 1);
      for (const row of model.rows) row.splice(op.col, 1);
      return true;
    case 'moveCol': {
      const to = op.col + op.by;
      if (op.col < 0 || to < 0 || op.col >= cols || to >= cols) return false;
      swap(model.align, op.col, to);
      for (const row of model.rows) swap(row, op.col, to);
      return true;
    }
    case 'align':
      if (op.col < 0 || op.col >= cols) return false;
      model.align[op.col] = op.align;
      return true;
    case 'sort':
      if (op.col < 0 || op.col >= cols) return false;
      sortRows(model.rows, op.col, op.dir);
      return true;
    case 'duplicateRow':
      if (op.row < 1 || op.row >= model.rows.length) return false;
      model.rows.splice(op.row + 1, 0, [...model.rows[op.row]]);
      return true;
    case 'clearRow':
      if (op.row < 0 || op.row >= model.rows.length) return false;
      model.rows[op.row] = new Array<string>(cols).fill('');
      return true;
    case 'clearCol':
      // The header names the column, so it is kept.
      if (op.col < 0 || op.col >= cols) return false;
      for (let r = 1; r < model.rows.length; r++) model.rows[r][op.col] = '';
      return true;
  }
}

export function emptyTable(rows: number, cols: number): string {
  const header = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => new Array<string>(cols).fill(''));
  return serializeTable({ rows: [header, ...body], align: new Array<Align>(cols).fill(null) }, true);
}

/** The table as tab-separated text, one line per row, for pasting into a spreadsheet. */
export function tableToTSV(model: Pick<TableModel, 'rows'>): string {
  return model.rows.map((row) => row.map((cell) => cell.replace(/\s*[\t\r\n]+\s*/g, ' ').trim()).join('\t')).join('\n');
}

/**
 * Turns clipboard text copied from a spreadsheet into a table.
 * Returns null unless every line has the same number (two or more) of tab-separated cells.
 */
export function tableFromTSV(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 2 || !lines.every((l) => l.includes('\t'))) return null;
  const rows = lines.map((l) => l.split('\t').map((c) => c.trim()));
  const cols = rows[0].length;
  if (cols < 2 || !rows.every((r) => r.length === cols)) return null;
  return serializeTable({ rows, align: new Array<Align>(cols).fill(null) }, true);
}
