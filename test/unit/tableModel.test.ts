import { describe, expect, it } from 'vitest';
import { applyOp, emptyTable, parseTable, serializeTable, setCell, tableFromTSV, tableToTSV } from '../../src/webview/table/model';

const TABLE = ['| Name  | Qty |  Note  |', '| :---- | --: | :----: |', '| Apple |   3 | fresh  |', '| Kiwi  |  12 | a \\| b |'].join('\n');

describe('table model', () => {
  it('parses cells, alignment and escaped pipes', () => {
    const m = parseTable(TABLE)!;
    expect(m.align).toEqual(['left', 'right', 'center']);
    expect(m.rows).toEqual([
      ['Name', 'Qty', 'Note'],
      ['Apple', '3', 'fresh'],
      ['Kiwi', '12', 'a | b'],
    ]);
  });

  it('serialises a canonical table back byte for byte', () => {
    expect(serializeTable(parseTable(TABLE)!, true)).toBe(TABLE);
  });

  it('accepts rows without outer pipes and with missing or extra cells', () => {
    const m = parseTable('a | b\n--- | ---\n1\n1 | 2 | 3')!;
    expect(m.rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('rejects text that is not a table', () => {
    expect(parseTable('just text')).toBeNull();
    expect(parseTable('| a | b |\n| --- |')).toBeNull();
    expect(parseTable('| a | b |\n| x | y |')).toBeNull();
  });

  it('re-aligns the table when a cell grows', () => {
    expect(setCell(TABLE, 1, 0, 'Pineapple', true)).toBe(
      ['| Name      | Qty |  Note  |', '| :-------- | --: | :----: |', '| Pineapple |   3 | fresh  |', '| Kiwi      |  12 | a \\| b |'].join('\n'),
    );
  });

  it('changes only the edited cell when padding is off', () => {
    const src = '|a|b|\n|-|-|\n|1|  2  |';
    expect(setCell(src, 1, 1, 'x|y', false)).toBe('|a|b|\n|-|-|\n|1| x\\|y |');
    expect(setCell(src, 1, 0, '', false)).toBe('|a|b|\n|-|-|\n| |  2  |');
  });

  it('fills in a missing cell by rewriting the table', () => {
    expect(setCell('| a | b |\n| --- | --- |\n| 1 |', 1, 1, 'z', false)).toBe('| a | b |\n| --- | --- |\n| 1 | z |');
  });

  it('inserts, deletes and moves rows but never the header', () => {
    const m = parseTable(TABLE)!;
    expect(applyOp(m, { op: 'insertRow', at: 1 })).toBe(true);
    expect(m.rows[1]).toEqual(['', '', '']);
    expect(applyOp(m, { op: 'deleteRow', row: 0 })).toBe(false);
    expect(applyOp(m, { op: 'deleteRow', row: 1 })).toBe(true);
    expect(applyOp(m, { op: 'moveRow', row: 1, by: -1 })).toBe(false);
    expect(applyOp(m, { op: 'moveRow', row: 1, by: 1 })).toBe(true);
    expect(m.rows.map((r) => r[0])).toEqual(['Name', 'Kiwi', 'Apple']);
  });

  it('inserts, deletes, moves and aligns columns', () => {
    const m = parseTable(TABLE)!;
    applyOp(m, { op: 'moveCol', col: 0, by: 1 });
    expect(m.rows[0]).toEqual(['Qty', 'Name', 'Note']);
    expect(m.align).toEqual(['right', 'left', 'center']);
    applyOp(m, { op: 'insertCol', at: 3 });
    expect(m.rows[1]).toEqual(['3', 'Apple', 'fresh', '']);
    applyOp(m, { op: 'deleteCol', col: 0 });
    applyOp(m, { op: 'align', col: 0, align: 'center' });
    expect(serializeTable(m, true)).toBe(
      ['| Name  |  Note  |     |', '| :---: | :----: | --- |', '| Apple | fresh  |     |', '| Kiwi  | a \\| b |     |'].join('\n'),
    );
    const one = parseTable('| a |\n| - |')!;
    expect(applyOp(one, { op: 'deleteCol', col: 0 })).toBe(false);
  });

  it('builds an empty table', () => {
    expect(emptyTable(2, 2)).toBe('| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |');
  });

  it('converts spreadsheet clipboard text', () => {
    expect(tableFromTSV('a\tb\r\n1\t2\r\n')).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |');
    expect(tableFromTSV('a\tb')).toBeNull();
    expect(tableFromTSV('a\tb\n1')).toBeNull();
    expect(tableFromTSV('plain\ntext')).toBeNull();
  });

  const table = (...rows: string[][]) => parseTable(serializeTable({ rows, align: rows[0].map(() => null) }, false))!;
  const column = (m: { rows: string[][] }, c = 0) => m.rows.map((r) => r[c]);

  it('sorts body rows by a text column and keeps the header first', () => {
    const m = table(['Zed'], ['pear'], ['Apple'], ['banana'], ['apple']);
    expect(applyOp(m, { op: 'sort', col: 0, dir: 'asc' })).toBe(true);
    // Case is ignored, and equal keys keep their original order.
    expect(column(m)).toEqual(['Zed', 'Apple', 'apple', 'banana', 'pear']);
    applyOp(m, { op: 'sort', col: 0, dir: 'desc' });
    expect(column(m)).toEqual(['Zed', 'pear', 'banana', 'Apple', 'apple']);
  });

  it('sorts a column of numbers by value', () => {
    const m = table(['Qty', 'Name'], ['10', 'a'], ['9', 'b'], ['-2.5', 'c'], ['1,200', 'd'], ['$30', 'e'], ['40%', 'f']);
    applyOp(m, { op: 'sort', col: 0, dir: 'asc' });
    expect(column(m)).toEqual(['Qty', '-2.5', '9', '10', '$30', '40%', '1,200']);
    expect(column(m, 1)).toEqual(['Name', 'c', 'b', 'a', 'e', 'f', 'd']);
    applyOp(m, { op: 'sort', col: 0, dir: 'desc' });
    expect(column(m)).toEqual(['Qty', '1,200', '40%', '$30', '10', '9', '-2.5']);
  });

  it('sorts a mixed column as text, with digit runs in numeric order', () => {
    const m = table(['Id'], ['item 10'], ['item 2'], ['7'], ['**bold**'], ['[link](http://x)']);
    applyOp(m, { op: 'sort', col: 0, dir: 'asc' });
    expect(column(m)).toEqual(['Id', '7', '**bold**', 'item 2', 'item 10', '[link](http://x)']);
  });

  it('puts empty cells last in both directions', () => {
    const m = table(['N', 'Tag'], ['', 'first'], ['3', 'x'], ['', 'second'], ['1', 'y']);
    applyOp(m, { op: 'sort', col: 0, dir: 'asc' });
    expect(m.rows.slice(1)).toEqual([['1', 'y'], ['3', 'x'], ['', 'first'], ['', 'second']]);
    applyOp(m, { op: 'sort', col: 0, dir: 'desc' });
    expect(m.rows.slice(1)).toEqual([['3', 'x'], ['1', 'y'], ['', 'first'], ['', 'second']]);
  });

  it('sorts stably and rejects a column that does not exist', () => {
    const m = table(['K', 'V'], ['b', '1'], ['a', '2'], ['b', '3'], ['a', '4']);
    applyOp(m, { op: 'sort', col: 0, dir: 'desc' });
    expect(column(m, 1)).toEqual(['V', '1', '3', '2', '4']);
    expect(applyOp(m, { op: 'sort', col: 2, dir: 'asc' })).toBe(false);
    expect(applyOp(m, { op: 'sort', col: -1, dir: 'asc' })).toBe(false);
    const headerOnly = parseTable('| b | a |\n| - | - |')!;
    expect(applyOp(headerOnly, { op: 'sort', col: 0, dir: 'asc' })).toBe(true);
    expect(headerOnly.rows).toEqual([['b', 'a']]);
  });

  it('duplicates a body row but never the header', () => {
    const m = parseTable(TABLE)!;
    expect(applyOp(m, { op: 'duplicateRow', row: 0 })).toBe(false);
    expect(applyOp(m, { op: 'duplicateRow', row: 3 })).toBe(false);
    expect(applyOp(m, { op: 'duplicateRow', row: 1 })).toBe(true);
    expect(column(m)).toEqual(['Name', 'Apple', 'Apple', 'Kiwi']);
    m.rows[2][0] = 'Pear';
    expect(m.rows[1][0]).toBe('Apple');
    expect(serializeTable(m, false).split('\n')[3]).toBe('| Pear | 3 | fresh |');
  });

  it('clears a row or the body of a column', () => {
    const m = parseTable(TABLE)!;
    expect(applyOp(m, { op: 'clearRow', row: 1 })).toBe(true);
    expect(m.rows).toEqual([['Name', 'Qty', 'Note'], ['', '', ''], ['Kiwi', '12', 'a | b']]);
    expect(applyOp(m, { op: 'clearCol', col: 1 })).toBe(true);
    expect(m.rows).toEqual([['Name', 'Qty', 'Note'], ['', '', ''], ['Kiwi', '', 'a | b']]);
    expect(applyOp(m, { op: 'clearRow', row: 3 })).toBe(false);
    expect(applyOp(m, { op: 'clearCol', col: 3 })).toBe(false);
    expect(m.align).toEqual(['left', 'right', 'center']);
    // A cleared table is still a table.
    expect(parseTable(serializeTable(m, true))!.rows).toEqual(m.rows);
  });

  it('writes the table as tab-separated text', () => {
    expect(tableToTSV(parseTable(TABLE)!)).toBe('Name\tQty\tNote\nApple\t3\tfresh\nKiwi\t12\ta | b');
    expect(tableFromTSV(tableToTSV(parseTable(TABLE)!))).toBe(serializeTable({ rows: parseTable(TABLE)!.rows, align: [null, null, null] }, true));
  });
});
