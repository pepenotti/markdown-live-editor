// Runs the integration tests against the packaged extension: the .vsix is built, unpacked
// the way VS Code installs it, and the suite is pointed at that folder instead of at the
// working tree. So the tests exercise exactly the files a user gets, and a file that is
// missing from the package (see .vscodeignore) fails here and not after a release.
//
//   node scripts/test-vsix.mjs            package, unpack, test
//   node scripts/test-vsix.mjs --reuse    use the .vsix of the current version if it is there
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsix = join(root, `${pkg.name}-${pkg.version}.vsix`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Unpacks a zip archive (a .vsix is one) with nothing but zlib. Returns the number of files. */
export function unzip(archive, target) {
  const data = readFileSync(archive);
  // The end-of-central-directory record is at the very end, before an optional comment.
  let end = data.length - 22;
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${archive} is not a zip archive`);
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip directory is damaged');
    const method = data.readUInt16LE(at + 10);
    const packedSize = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const file = resolve(target, name);
    // Never write outside the target folder, whatever the archive says.
    if (file !== target && !file.startsWith(target + sep)) throw new Error(`Unsafe path in the archive: ${name}`);
    if (name.endsWith('/')) {
      mkdirSync(file, { recursive: true });
      continue;
    }
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const packed = data.subarray(start, start + packedSize);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported compression in ${name}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, method === 8 ? inflateRawSync(packed) : packed);
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!(process.argv.includes('--reuse') && existsSync(vsix))) run(npm, ['run', 'package']);
  if (!existsSync(vsix)) throw new Error(`Packaging did not produce ${vsix}`);
  const folder = mkdtempSync(join(tmpdir(), 'mdl-vsix-'));
  try {
    const files = unzip(vsix, folder);
    const extension = join(folder, 'extension');
    if (!existsSync(join(extension, 'package.json'))) throw new Error('The .vsix has no extension/package.json');
    console.log(`\nTesting the packaged extension: ${files} files of ${vsix} unpacked to ${extension}\n`);
    run(npx, ['vscode-test'], { MDL_EXTENSION_PATH: extension });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
