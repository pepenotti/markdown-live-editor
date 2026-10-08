// Builds the two bundles: the extension host (Node, CommonJS) and the webview (browser, IIFE).
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

const extension = {
  ...common,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

// Markdown-to-HTML for Copy as HTML and the exports: markdown-it, KaTeX and the highlighting
// grammars. The extension requires it the first time it is needed, not on activation.
const exporter = {
  ...common,
  entryPoints: ['src/shared/exportHtml.ts'],
  outfile: 'dist/export.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
};

const webview = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

const styles = {
  ...common,
  entryPoints: ['src/webview/styles.css'],
  outfile: 'dist/webview.css',
  // KaTeX lists three formats per font; the webview only needs woff2.
  loader: { '.woff2': 'file', '.woff': 'empty', '.ttf': 'empty' },
  assetNames: 'fonts/[name]',
};

// The diagram library is large, so it is a separate file loaded on demand.
const diagrams = {
  ...common,
  entryPoints: ['src/webview/mermaidBundle.ts'],
  outfile: 'dist/mermaid.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: false,
  minify: true,
};

// The KaTeX style sheet as it is: an export embeds it, with the fonts it needs from dist/fonts.
mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/katex/dist/katex.min.css', 'dist/katex.css');

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(exporter), esbuild.context(webview), esbuild.context(styles), esbuild.context(diagrams)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(exporter), esbuild.build(webview), esbuild.build(styles), esbuild.build(diagrams)]);
}
