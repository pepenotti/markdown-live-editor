import { describe, expect, it } from 'vitest';
import { applyOp, emptyTable, parseTable, serializeTable, setCell, tableFromTSV } from '../../src/webview/table/model';

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
});
