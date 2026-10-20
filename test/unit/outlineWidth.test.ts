import { describe, expect, it } from 'vitest';
import { OUTLINE_OPEN_KEY, OUTLINE_WIDTH_KEY, OutlineMemory } from '../../src/extension/outlineMemory';
import {
  clampOutlineWidth,
  dragOutlineWidth,
  normalizeOutlineWidth,
  OUTLINE_DEFAULT_WIDTH,
  OUTLINE_MIN_WIDTH,
  outlineMaxWidth,
} from '../../src/shared/outlineWidth';

describe('the width of the outline panel', () => {
  it('starts at the default, which fits between the minimum and the maximum', () => {
    expect(OUTLINE_MIN_WIDTH).toBe(170);
    expect(OUTLINE_DEFAULT_WIDTH).toBeGreaterThan(OUTLINE_MIN_WIDTH);
    expect(clampOutlineWidth(OUTLINE_DEFAULT_WIDTH, 1000)).toBe(OUTLINE_DEFAULT_WIDTH);
  });

  it('is at most half the editor area, and never under the minimum', () => {
    expect(outlineMaxWidth(1000)).toBe(500);
    expect(outlineMaxWidth(1001)).toBe(500);
    expect(outlineMaxWidth(200)).toBe(OUTLINE_MIN_WIDTH);
    expect(clampOutlineWidth(800, 1000)).toBe(500);
    expect(clampOutlineWidth(100, 1000)).toBe(OUTLINE_MIN_WIDTH);
    expect(clampOutlineWidth(300.4, 1000)).toBe(300);
    expect(clampOutlineWidth(300, 300)).toBe(OUTLINE_MIN_WIDTH);
  });
});

describe('dragging the edge of the outline panel', () => {
  it('follows the pointer between the minimum and half the editor', () => {
    expect(dragOutlineWidth(300, 1200)).toEqual({ open: true, width: 300 });
    expect(dragOutlineWidth(700, 1200)).toEqual({ open: true, width: 600 });
  });

  it('holds at the minimum while a little narrower, and snaps shut under half the minimum, like VS Code', () => {
    expect(dragOutlineWidth(OUTLINE_MIN_WIDTH - 1, 1200)).toEqual({ open: true, width: OUTLINE_MIN_WIDTH });
    expect(dragOutlineWidth(OUTLINE_MIN_WIDTH / 2, 1200)).toEqual({ open: true, width: OUTLINE_MIN_WIDTH });
    expect(dragOutlineWidth(OUTLINE_MIN_WIDTH / 2 - 1, 1200).open).toBe(false);
    expect(dragOutlineWidth(0, 1200).open).toBe(false);
    expect(dragOutlineWidth(-50, 1200).open).toBe(false);
  });

  it('opens a closed panel at the minimum once dragged out far enough', () => {
    // A closed panel is dragged from a width of 0.
    expect(dragOutlineWidth(40, 1200).open).toBe(false);
    expect(dragOutlineWidth(90, 1200)).toEqual({ open: true, width: OUTLINE_MIN_WIDTH });
    expect(dragOutlineWidth(260, 1200)).toEqual({ open: true, width: 260 });
  });

  it('stays within half of a narrow editor, but not under the minimum', () => {
    expect(dragOutlineWidth(400, 500)).toEqual({ open: true, width: 250 });
    expect(dragOutlineWidth(400, 300)).toEqual({ open: true, width: OUTLINE_MIN_WIDTH });
  });
});

describe('a remembered width', () => {
  it('is a whole number of pixels, not less than the minimum, or nothing', () => {
    expect(normalizeOutlineWidth(300.6)).toBe(301);
    expect(normalizeOutlineWidth(10)).toBe(OUTLINE_MIN_WIDTH);
    expect(normalizeOutlineWidth(1e9)).toBe(4000);
    for (const bad of [undefined, null, NaN, Infinity, '300', {}]) expect(normalizeOutlineWidth(bad)).toBeUndefined();
  });
});

/** globalState as VS Code gives it to the extension. */
class FakeMemento {
  values = new Map<string, unknown>();
  updates: [string, unknown][] = [];
  hang = false;
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.updates.push([key, value]);
    // A slow write: globalState still hands back the old value meanwhile.
    if (this.hang) return new Promise(() => {});
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

describe('the host remembering the outline panel', () => {
  it('starts closed at the default width for a first-time user', () => {
    const memory = new OutlineMemory(new FakeMemento());
    expect(memory.open).toBe(false);
    expect(memory.width).toBeUndefined();
  });

  it('remembers the width next to whether the panel is open, for the next editor', async () => {
    const store = new FakeMemento();
    const memory = new OutlineMemory(store);
    await memory.rememberOpen(true);
    await memory.rememberWidth(312);
    expect(memory.open).toBe(true);
    expect(memory.width).toBe(312);
    expect(store.values.get(OUTLINE_OPEN_KEY)).toBe(true);
    expect(store.values.get(OUTLINE_WIDTH_KEY)).toBe(312);
    // Another window reads the same globalState.
    const next = new OutlineMemory(store);
    expect(next.open).toBe(true);
    expect(next.width).toBe(312);
  });

  it('answers with the latest width at once, even before globalState has it', () => {
    const store = new FakeMemento();
    store.hang = true;
    const memory = new OutlineMemory(store);
    void memory.rememberWidth(200);
    void memory.rememberWidth(280);
    expect(memory.width).toBe(280);
    expect(store.updates).toEqual([
      [OUTLINE_WIDTH_KEY, 200],
      [OUTLINE_WIDTH_KEY, 280],
    ]);
  });

  it('does not keep what is not a width, and forgets on request', async () => {
    const store = new FakeMemento();
    store.values.set(OUTLINE_WIDTH_KEY, 'wide');
    expect(new OutlineMemory(store).width).toBeUndefined();
    store.values.set(OUTLINE_WIDTH_KEY, 20);
    expect(new OutlineMemory(store).width).toBe(OUTLINE_MIN_WIDTH);
    const memory = new OutlineMemory(store);
    await memory.rememberWidth(NaN);
    expect(memory.width).toBeUndefined();
    expect(store.values.has(OUTLINE_WIDTH_KEY)).toBe(false);
    await memory.rememberWidth(260);
    await memory.rememberWidth(undefined);
    expect(memory.width).toBeUndefined();
  });
});
