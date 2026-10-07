// Regenerates THIRD-PARTY-NOTICES.md from the packages that end up in the shipped bundles.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const entries = [
  { entryPoints: ['src/webview/main.ts'], platform: 'browser', format: 'iife' },
  { entryPoints: ['src/webview/mermaidBundle.ts'], platform: 'browser', format: 'iife' },
  { entryPoints: ['src/webview/styles.css'], loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' } },
  { entryPoints: ['src/extension/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'] },
];
const names = new Set();
for (const entry of entries) {
  const result = await esbuild.build({ ...entry, bundle: true, write: false, metafile: true, logLevel: 'silent', outdir: 'out' });
  for (const input of Object.keys(result.metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) names.add(m[1]);
  }
}
const rows = [...names].sort().map((name) => {
  const pkg = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'));
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  return { name, line: `| ${name} | ${pkg.version} | ${pkg.license ?? 'see package'} | ${repo.replace(/^git\+/, '').replace(/\.git$/, '')} |`, license: String(pkg.license ?? 'unknown') };
});
writeFileSync(
  'THIRD-PARTY-NOTICES.md',
  `# Third-party notices\n\nThe shipped bundles in \`dist/\` include the packages below. Each is distributed under the licence shown; the full licence text ships with the package and is available at its repository.\n\n| Package | Version | Licence | Repository |\n| :------ | :------ | :------ | :--------- |\n${rows.map((r) => r.line).join('\n')}\n`,
);
const counts = {};
for (const r of rows) counts[r.license] = (counts[r.license] ?? 0) + 1;
console.log(`${rows.length} bundled packages`, counts);
