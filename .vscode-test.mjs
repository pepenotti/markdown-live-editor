// Integration tests run inside a real VS Code. An installed copy is used when there is
// one, so nothing has to be downloaded; set VSCODE_TEST_DOWNLOAD=1 to fetch a clean build.
import { defineConfig } from '@vscode/test-cli';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [
  process.env.VSCODE_TEST_PATH,
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/usr/share/code/code',
].filter(Boolean);
const installed = process.env.VSCODE_TEST_DOWNLOAD ? undefined : candidates.find((p) => existsSync(p));

// VS Code opens a socket inside its user-data folder, and socket paths are limited to
// about 100 characters, so the profile lives in the system temp folder, not in the project.
const profile = join(tmpdir(), 'mdl-vscode-test');

export default defineConfig({
  files: 'test/integration/**/*.test.js',
  useInstallation: installed ? { fromPath: installed } : undefined,
  launchArgs: ['--user-data-dir', join(profile, 'user'), '--extensions-dir', join(profile, 'ext'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  mocha: { timeout: 60000, ui: 'tdd' },
});
