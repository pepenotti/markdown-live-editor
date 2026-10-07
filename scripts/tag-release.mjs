// Tags the current commit of main with the version in package.json and pushes the tag,
// which starts the Release workflow. Refuses to run unless everything is in order.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`Cannot tag: ${message}`);
  process.exit(1);
};

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('switch to the main branch first.');
if (git('status', '--porcelain')) fail('there are uncommitted changes.');
git('fetch', '--quiet', '--tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in step with origin/main. Pull or push first.');
if (git('tag', '--list', tag)) fail(`${tag} already exists. Bump the version in package.json first.`);
if (!readFileSync('CHANGELOG.md', 'utf8').split('\n').some((l) => l.trim() === `## ${version}`)) {
  fail(`CHANGELOG.md has no "## ${version}" section.`);
}

git('tag', '--annotate', tag, '--message', `Seamless Markdown ${version}`);
git('push', 'origin', tag);
console.log(`Pushed ${tag}. Follow the release at https://github.com/pepenotti/markdown-live-editor/actions`);
