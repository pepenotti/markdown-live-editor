// Prints the CHANGELOG.md section of one version, for use as release notes.
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (!version || start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
if (end < 0) end = lines.length;
console.log(lines.slice(start + 1, end).join('\n').trim());
