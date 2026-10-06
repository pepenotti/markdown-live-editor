// End-to-end checks in a real VS Code: the webview editor and the text document stay in step.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const VIEW_TYPE = 'seamlessMarkdown.editor';
const SAMPLE = path.resolve(__dirname, '../../sample');
const lf = (s) => s.replace(/\r\n/g, '\n');

let api;
let dir;

async function until(check, what, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function open(name) {
  const uri = vscode.Uri.file(path.join(dir, name));
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  await api.whenReady(uri);
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  assert.ok(document, 'the text document is open');
  return { uri, document };
}

/** Waits until the webview holds exactly the document's text and returns its state. */
async function inStep(uri, document) {
  return until(async () => {
    const state = await api.state(uri);
    return state && state.text === lf(document.getText()) ? state : null;
  }, 'the webview to match the document');
}

suite('Seamless Markdown', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'seamless-markdown');
    assert.ok(extension, 'extension is installed in the test host');
    api = await extension.activate();
    assert.ok(api, 'test hooks are available');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-test-'));
    fs.cpSync(SAMPLE, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plain.md'), 'First line\n\nSecond paragraph with a word.\n');
    fs.writeFileSync(path.join(dir, 'split.md'), 'alpha\n\nbeta\n');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('opens a document without changing it and without script or CSP errors', async () => {
    const before = fs.readFileSync(path.join(dir, 'features.md'));
    const { uri, document } = await open('features.md');
    const state = await inStep(uri, document);
    assert.deepStrictEqual(state.problems, []);
    assert.strictEqual(document.isDirty, false, 'opening must not dirty the document');
    for (const mode of ['full', 'raw', 'half']) {
      await api.command(uri, 'setMode', mode);
      await until(async () => (await api.mode(uri)) === mode, `mode ${mode}`);
    }
    const after = await inStep(uri, document);
    assert.deepStrictEqual(after.problems, []);
    assert.strictEqual(document.isDirty, false, 'switching modes must not dirty the document');
    await document.save();
    assert.ok(before.equals(fs.readFileSync(path.join(dir, 'features.md'))), 'file bytes are unchanged');
  });

  test('an edit made in the webview reaches the document and can be undone', async () => {
    const { uri, document } = await open('plain.md');
    const original = document.getText();
    await api.command(uri, 'heading', 2);
    await until(() => document.getText() === '## ' + original, 'the heading to reach the document');
    assert.strictEqual(document.isDirty, true);
    await inStep(uri, document);

    await vscode.commands.executeCommand('seamlessMarkdown.undo');
    await until(() => document.getText() === original, 'undo to restore the document');
    await inStep(uri, document);

    await vscode.commands.executeCommand('seamlessMarkdown.redo');
    await until(() => document.getText() === '## ' + original, 'redo to reapply the heading');
    const state = await inStep(uri, document);
    assert.deepStrictEqual(state.problems, []);
  });

  test('a change made outside the webview shows up in it', async () => {
    const { uri, document } = await open('plain.md');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 5), ' (edited elsewhere)');
    edit.insert(uri, document.lineAt(document.lineCount - 1).range.end, '\nAppended line\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const state = await inStep(uri, document);
    assert.ok(state.text.startsWith('First (edited elsewhere) line'));
    // The webview keeps working from the new text.
    await api.command(uri, 'bulletList');
    await until(() => document.getText().startsWith('- First (edited elsewhere) line'), 'the list marker to reach the document');
    await inStep(uri, document);
  });

  test('CRLF files keep their line endings', async () => {
    const { uri, document } = await open('crlf.md');
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    await inStep(uri, document);
    await api.command(uri, 'heading', 1);
    await until(() => document.getText().startsWith('# First line\r\n'), 'the heading to reach the document');
    await api.command(uri, 'table');
    await until(() => document.getText().includes('| Column 1 |'), 'the table to reach the document');
    await inStep(uri, document);
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.ok(!/[^\r]\n/.test(document.getText()), 'no bare LF was introduced');
    await document.save();
    const bytes = fs.readFileSync(uri.fsPath, 'utf8');
    assert.ok(!/[^\r]\n/.test(bytes), 'saved file has only CRLF');
  });

  test('two editors on one document stay in step', async () => {
    const { uri, document } = await open('split.md');
    await vscode.commands.executeCommand('workbench.action.splitEditor');
    await until(() => api.sessionCount(uri) === 2, 'the second editor');
    await api.command(uri, 'quote');
    await until(() => document.getText().startsWith('> alpha'), 'the quote to reach the document');
    // Every session of the document reports the same text.
    await until(async () => {
      const states = await api.states(uri);
      return states.length === 2 && states.every((s) => s && s.text === lf(document.getText()));
    }, 'both webviews to match the document');
  });

  test('a hidden editor catches up when it is shown again', async () => {
    const { uri, document } = await open('plain.md');
    await inStep(uri, document);
    const other = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'notes', 'other.md')));
    await vscode.window.showTextDocument(other, { preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), 'Changed while hidden. ');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    const state = await inStep(uri, document);
    assert.ok(state.text.startsWith('Changed while hidden. First line'));
  });

  test('saves a pasted image next to the document and links it relatively', async () => {
    const { uri } = await open('plain.md');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const first = await api.saveImage(uri, 'My shot (1).png', png);
    assert.deepStrictEqual(first, { path: 'assets/My%20shot%20-1-.png', isImage: true, name: 'My shot -1-.png' });
    assert.ok(fs.existsSync(path.join(dir, 'assets', 'My shot -1-.png')));
    // The same name again must not overwrite the first file.
    const second = await api.saveImage(uri, 'My shot (1).png', png);
    assert.strictEqual(second.path, 'assets/My%20shot%20-1--1.png');
    // A clipboard image has no useful name and gets a dated one.
    const pasted = await api.saveImage(uri, 'image.png', png);
    assert.match(pasted.path, /^assets\/image-\d{8}-\d{6}\.png$/);
    // A path can never escape the image folder.
    const sneaky = await api.saveImage(uri, '../../evil.png', png);
    assert.strictEqual(sneaky.path, 'assets/evil.png');
  });

  test('lists linkable files and resolves dropped ones relative to the document', async () => {
    // These files are outside any workspace folder, so only the document's folder and its subfolders are listed.
    const { uri } = await open('features.md');
    const images = await api.listFiles(uri, true);
    assert.ok(images.includes('assets/diagram.svg'), `images: ${images}`);
    assert.ok(images.every((f) => /\.(png|svg)$/.test(f)));
    const all = await api.listFiles(uri, false);
    assert.ok(all.includes('notes/other.md'), `files: ${all}`);
    assert.ok(!all.includes('features.md'), 'the document itself is not offered');
    const other = await open('notes/other.md');
    const dropped = await api.resolveUris(other.uri, [vscode.Uri.file(path.join(dir, 'features.md')).toString(), 'https://example.com/pic.png']);
    assert.deepStrictEqual(dropped, [
      { path: '../features.md', isImage: false, name: 'features.md' },
      { path: 'https://example.com/pic.png', isImage: true, name: 'pic.png' },
    ]);
  });

  test('follows a relative link to another Markdown file in this editor', async () => {
    const { uri } = await open('features.md');
    const target = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    assert.strictEqual(api.sessionCount(target), 0);
    await api.openLink(uri, 'notes/other.md#other-note');
    await until(() => api.sessionCount(target) === 1, 'the linked file to open');
  });

  test('can hand the file back to the plain text editor', async () => {
    const { uri } = await open('plain.md');
    await vscode.commands.executeCommand('seamlessMarkdown.openSource');
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'the text editor');
    await until(() => api.sessionCount(uri) === 0, 'the custom editor to close');
    // And back again, replacing the text editor tab.
    await vscode.commands.executeCommand('seamlessMarkdown.openWith', uri);
    await until(() => api.sessionCount(uri) === 1, 'the custom editor to open');
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && t.input.uri.toString() === uri.toString());
    assert.strictEqual(tabs.length, 1, 'only one tab remains for the file');
  });

  test('becomes the default editor only when asked, and can be reverted', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'split.md'));
    const associations = () => vscode.workspace.getConfiguration('workbench').get('editorAssociations') || {};
    assert.notStrictEqual(associations()['*.md'], VIEW_TYPE);
    try {
      await vscode.commands.executeCommand('seamlessMarkdown.setAsDefault');
      await until(() => associations()['*.md'] === VIEW_TYPE, 'the association to be written');
      await vscode.commands.executeCommand('vscode.open', uri);
      await until(() => api.sessionCount(uri) === 1, 'the file to open in the custom editor');
    } finally {
      await vscode.commands.executeCommand('seamlessMarkdown.unsetAsDefault');
    }
    await until(() => associations()['*.md'] !== VIEW_TYPE, 'the association to be removed');
  });

  test('is offered for Markdown files but does not take over as the default', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    await vscode.commands.executeCommand('vscode.open', uri);
    assert.ok(vscode.window.activeTextEditor, 'a plain open uses the text editor');
    assert.strictEqual(api.sessionCount(uri), 0);
  });
});
