import { describe, expect, it } from 'vitest';
import { popupKeyTarget } from '../../src/webview/ui/popupMenu';

const LABELS = ['Text', 'Heading 1', 'Heading 2', 'Heading 3'];
const ALL = LABELS.map(() => true);

describe('the keys of a drop-down list', () => {
  it('moves with the arrows, stopping at the ends in a list box and going round in a menu', () => {
    expect(popupKeyTarget('ArrowDown', LABELS, ALL, 1, false)).toBe(2);
    expect(popupKeyTarget('ArrowUp', LABELS, ALL, 1, false)).toBe(0);
    expect(popupKeyTarget('ArrowDown', LABELS, ALL, 3, false)).toBe(3);
    expect(popupKeyTarget('ArrowUp', LABELS, ALL, 0, false)).toBe(0);
    expect(popupKeyTarget('ArrowDown', LABELS, ALL, 3, true)).toBe(0);
    expect(popupKeyTarget('ArrowUp', LABELS, ALL, 0, true)).toBe(3);
  });

  it('starts at the first or the last entry when nothing is highlighted', () => {
    expect(popupKeyTarget('ArrowDown', LABELS, ALL, -1, true)).toBe(0);
    expect(popupKeyTarget('ArrowUp', LABELS, ALL, -1, true)).toBe(3);
  });

  it('goes to the ends with Home and End (and Page Up and Page Down)', () => {
    expect(popupKeyTarget('Home', LABELS, ALL, 2, false)).toBe(0);
    expect(popupKeyTarget('End', LABELS, ALL, 0, false)).toBe(3);
    expect(popupKeyTarget('PageUp', LABELS, ALL, 2, false)).toBe(0);
    expect(popupKeyTarget('PageDown', LABELS, ALL, 0, false)).toBe(3);
  });

  it('skips disabled entries', () => {
    const enabled = [true, false, true, false];
    expect(popupKeyTarget('ArrowDown', LABELS, enabled, 0, true)).toBe(2);
    expect(popupKeyTarget('ArrowDown', LABELS, enabled, 2, true)).toBe(0);
    expect(popupKeyTarget('End', LABELS, enabled, 0, true)).toBe(2);
    expect(popupKeyTarget('h', LABELS, enabled, 0, true)).toBe(2);
    expect(popupKeyTarget('ArrowDown', LABELS, [false, false, false, false], 0, true)).toBeNull();
  });

  it('jumps to the next entry starting with a typed letter, going round, in either case', () => {
    expect(popupKeyTarget('h', LABELS, ALL, 0, false)).toBe(1);
    expect(popupKeyTarget('h', LABELS, ALL, 1, false)).toBe(2);
    expect(popupKeyTarget('H', LABELS, ALL, 3, false)).toBe(1);
    expect(popupKeyTarget('t', LABELS, ALL, 2, false)).toBe(0);
    expect(popupKeyTarget('h', LABELS, ALL, -1, false)).toBe(1);
    expect(popupKeyTarget('e', ['  Export as HTML…', 'Email'], [true, true], -1, true)).toBe(0);
    expect(popupKeyTarget('z', LABELS, ALL, 0, false)).toBeNull();
  });

  it('leaves other keys alone', () => {
    for (const key of ['Enter', 'Escape', 'Tab', ' ', 'Shift', 'ArrowLeft', 'F1']) expect(popupKeyTarget(key, LABELS, ALL, 1, false)).toBeNull();
  });
});
