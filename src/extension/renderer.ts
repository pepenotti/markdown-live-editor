// The Markdown-to-HTML renderer (markdown-it, KaTeX and the highlighting grammars) is a
// bundle of its own, dist/export.js, so that opening an editor does not pay for it.
// It is loaded the first time something is copied as HTML or exported.
import * as path from 'node:path';

export type Renderer = typeof import('../shared/exportHtml');

let loaded: Renderer | undefined;

export function renderer(): Renderer {
  // The path is computed, so the bundler leaves this as a real require.
  return (loaded ??= require(path.join(__dirname, 'export.js')) as Renderer);
}

/** True once the renderer has been loaded (for the tests). */
export function rendererLoaded(): boolean {
  return loaded !== undefined;
}
