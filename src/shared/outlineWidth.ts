// How wide the outline panel inside the editor is, and what dragging its edge does.
// Shared by the webview, which draws and drags it, and the host, which remembers the width.

/** The width the panel starts with, and goes back to on a double-click of its edge. */
export const OUTLINE_DEFAULT_WIDTH = 246;
/** The narrowest the panel gets while open. */
export const OUTLINE_MIN_WIDTH = 170;
/** A stored width beyond this is taken to be a mistake. */
const OUTLINE_MAX_STORED_WIDTH = 4000;

/** The widest the panel gets beside an editor area this wide: half of it, and never under the minimum. */
export function outlineMaxWidth(areaWidth: number): number {
  return Math.max(OUTLINE_MIN_WIDTH, Math.floor(areaWidth / 2));
}

/** A width that fits beside an editor area this wide. */
export function clampOutlineWidth(width: number, areaWidth: number): number {
  return Math.round(Math.min(outlineMaxWidth(areaWidth), Math.max(OUTLINE_MIN_WIDTH, width)));
}

/**
 * What dragging the panel's edge to `wanted` pixels of width does: the panel follows between the
 * minimum and half the area, holds at the minimum while dragged a little narrower, and snaps shut
 * once dragged under half the minimum. A closed panel dragged out the same way opens again.
 * This is what VS Code's side bar does.
 */
export function dragOutlineWidth(wanted: number, areaWidth: number): { open: boolean; width: number } {
  if (wanted < OUTLINE_MIN_WIDTH / 2) return { open: false, width: OUTLINE_MIN_WIDTH };
  return { open: true, width: clampOutlineWidth(wanted, areaWidth) };
}

/** A remembered width as a whole number of pixels, or undefined when there is none or it makes no sense. */
export function normalizeOutlineWidth(width: unknown): number | undefined {
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined;
  return Math.round(Math.min(OUTLINE_MAX_STORED_WIDTH, Math.max(OUTLINE_MIN_WIDTH, width)));
}
