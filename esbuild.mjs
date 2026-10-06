// Builds the two bundles: the extension host (Node, CommonJS) and the webview (browser, IIFE).
import * as esbuild from 'esbuild';

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
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview), esbuild.context(styles)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview), esbuild.build(styles)]);
}
