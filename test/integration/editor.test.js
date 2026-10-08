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

  test('opens footnotes, image tags and references in every mode without changing them', async () => {
    const before = fs.readFileSync(path.join(dir, 'footnotes.md'));
    const { uri, document } = await open('footnotes.md');
    for (const mode of ['full', 'raw', 'half']) {
      await api.command(uri, 'setMode', mode);
      await until(async () => (await api.mode(uri)) === mode, `mode ${mode}`);
    }
    const state = await inStep(uri, document);
    assert.deepStrictEqual(state.problems, []);
    assert.strictEqual(document.isDirty, false, 'opening and switching modes must not dirty the document');
    await document.save();
    assert.ok(before.equals(fs.readFileSync(path.join(dir, 'footnotes.md'))), 'file bytes are unchanged');
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

  test('draws math and Mermaid diagrams inside VS Code without policy errors', async () => {
    const { uri, document } = await open('diagrams.md');
    const state = await until(async () => {
      const s = await api.state(uri);
      return s && s.rendered.diagrams >= 1 && s.rendered.math >= 3 ? s : null;
    }, 'the diagram and formulas to be drawn', 30000);
    assert.strictEqual(state.rendered.diagramErrors, 0);
    assert.deepStrictEqual(state.problems, []);
    assert.strictEqual(document.isDirty, false);
  });

  test('copies the document as HTML', async () => {
    await open('plain.md');
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('seamlessMarkdown.copyAsHtml');
    const html = await until(() => vscode.env.clipboard.readText(), 'the clipboard to be filled');
    assert.strictEqual(html, '<p>First line</p>\n<p>Second paragraph with a word.</p>\n');
  });

  test('builds the outline from the headings', async () => {
    const { uri } = await open('features.md');
    const outline = await api.outline(uri);
    assert.strictEqual(outline.length, 1);
    assert.strictEqual(outline[0].text, 'Seamless Markdown');
    assert.ok(outline[0].children.some((c) => c.text === 'Tables'));
  });

  /* ---------- table of contents ---------- */

  const STALE = '# Title\n\n<!-- toc -->\n- [Old](#old)\n<!-- tocstop -->\n\n## Alpha\n\n### Beta\n';
  const FRESH = '# Title\n\n<!-- toc -->\n- [Alpha](#alpha)\n  - [Beta](#beta)\n<!-- tocstop -->\n\n## Alpha\n\n### Beta\n';

  /** Writes a file and opens it in the plain text editor. */
  async function openText(name, content) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    return { file, document, editor, uri: document.uri };
  }

  async function append(document, text) {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, text);
    assert.ok(await vscode.workspace.applyEdit(edit));
  }

  async function withSettings(values, run) {
    const config = vscode.workspace.getConfiguration('seamlessMarkdown');
    try {
      for (const [key, value] of Object.entries(values)) await config.update(key, value, vscode.ConfigurationTarget.Global);
      await run();
    } finally {
      for (const key of Object.keys(values)) await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }

  test('saving in the plain text editor brings the table of contents up to date', async () => {
    const { file, document } = await openText('toc-text.md', STALE);
    await append(document, '\n## Gamma\n');
    assert.ok(await document.save());
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(
      fs.readFileSync(file, 'utf8'),
      '# Title\n\n<!-- toc -->\n- [Alpha](#alpha)\n  - [Beta](#beta)\n- [Gamma](#gamma)\n<!-- tocstop -->\n\n## Alpha\n\n### Beta\n\n## Gamma\n',
    );
  });

  test('saving leaves a table of contents that is up to date alone', async () => {
    const { file, document } = await openText('toc-fresh.md', FRESH);
    await append(document, '\nMore text, no new heading.\n');
    let changes = 0;
    const listener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === document && e.contentChanges.length) changes++;
    });
    try {
      assert.ok(await document.save());
    } finally {
      listener.dispose();
    }
    assert.strictEqual(changes, 0, 'the save must not edit the document');
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), FRESH + '\nMore text, no new heading.\n');
  });

  test('saving does not touch files without the markers, and keeps CRLF in files with them', async () => {
    const plain = '# Title\n\n## Alpha\n\n- [Old](#old)\n';
    const first = await openText('toc-none.md', plain);
    await append(first.document, 'tail\n');
    assert.ok(await first.document.save());
    assert.strictEqual(fs.readFileSync(first.file, 'utf8'), plain + 'tail\n');

    const second = await openText('toc-crlf.md', STALE.replace(/\n/g, '\r\n'));
    assert.strictEqual(second.document.eol, vscode.EndOfLine.CRLF);
    await append(second.document, 'tail\r\n');
    assert.ok(await second.document.save());
    assert.strictEqual(fs.readFileSync(second.file, 'utf8'), (FRESH + 'tail\n').replace(/\n/g, '\r\n'));
  });

  test('the table of contents commands work in the plain text editor and follow the settings', async () => {
    const { file, document, editor } = await openText('toc-commands.md', '# Title\n\n## Alpha\n\n### Beta\n');
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('seamlessMarkdown.insertTableOfContents');
    assert.strictEqual(document.getText(), FRESH);
    await withSettings({ 'toc.updateOnSave': false, 'toc.levels': '3..3', 'toc.ordered': true }, async () => {
      // Update on save is off: the list stays as it is although the settings changed.
      assert.ok(await document.save());
      assert.strictEqual(fs.readFileSync(file, 'utf8'), FRESH);
      await vscode.commands.executeCommand('seamlessMarkdown.updateTableOfContents');
      assert.strictEqual(document.getText(), '# Title\n\n<!-- toc -->\n1. [Beta](#beta)\n<!-- tocstop -->\n\n## Alpha\n\n### Beta\n');
    });
    // With the default settings back, saving restores the full list.
    assert.ok(await document.save());
    assert.strictEqual(fs.readFileSync(file, 'utf8'), FRESH);
    // The command has nothing left to do and must not dirty the document.
    await vscode.commands.executeCommand('seamlessMarkdown.updateTableOfContents');
    assert.strictEqual(document.getText(), FRESH);
    assert.strictEqual(document.isDirty, false);
  });

  test('inserts and updates a table of contents in the editor', async () => {
    fs.writeFileSync(path.join(dir, 'toc-insert.md'), '\n# Title\n\n## Alpha\n\n### Beta\n');
    const { uri, document } = await open('toc-insert.md');
    await inStep(uri, document);
    await api.command(uri, 'toc');
    await until(() => document.getText() === '<!-- toc -->\n- [Alpha](#alpha)\n  - [Beta](#beta)\n<!-- tocstop -->\n\n# Title\n\n## Alpha\n\n### Beta\n', 'the list to reach the document');
    await append(document, '\n## Gamma\n');
    await inStep(uri, document);
    await vscode.commands.executeCommand('seamlessMarkdown.updateTableOfContents');
    assert.ok(document.getText().startsWith('<!-- toc -->\n- [Alpha](#alpha)\n  - [Beta](#beta)\n- [Gamma](#gamma)\n<!-- tocstop -->\n'));
    // The marker lines are hidden in full preview; the webview must still hold the same text.
    await api.command(uri, 'setMode', 'full');
    await until(async () => (await api.mode(uri)) === 'full', 'full preview');
    const state = await inStep(uri, document);
    assert.deepStrictEqual(state.problems, []);
  });

  test('saving includes typing the editor has not sent yet in the file and in its table of contents', async () => {
    fs.writeFileSync(path.join(dir, 'toc-typing.md'), STALE);
    const { uri, document } = await open('toc-typing.md');
    await inStep(uri, document);
    // Make the document dirty first, so that the save below is a real one.
    await vscode.commands.executeCommand('seamlessMarkdown.updateTableOfContents');
    assert.strictEqual(document.getText(), FRESH);
    await inStep(uri, document);
    // Typed text waits in the webview for a moment. Save while it is still there, and not
    // through the editor's own Save command, which would ask for it first.
    await api.post(uri, { type: 'debugType', text: '## Zed\n\n' });
    assert.strictEqual(document.getText(), FRESH, 'the typing has not arrived yet');
    assert.ok(await document.save());
    const expected = '## Zed\n\n# Title\n\n<!-- toc -->\n- [Zed](#zed)\n- [Alpha](#alpha)\n  - [Beta](#beta)\n<!-- tocstop -->\n\n## Alpha\n\n### Beta\n';
    assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), expected);
    assert.strictEqual(document.getText(), expected);
    assert.strictEqual(document.isDirty, false);
    const state = await inStep(uri, document);
    assert.deepStrictEqual(state.problems, []);
  });

  test('is offered for Markdown files but does not take over as the default', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    await vscode.commands.executeCommand('vscode.open', uri);
    assert.ok(vscode.window.activeTextEditor, 'a plain open uses the text editor');
    assert.strictEqual(api.sessionCount(uri), 0);
  });
});
