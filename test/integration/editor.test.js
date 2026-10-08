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

/** What the link check reports for a file, in document order. */
function linkProblems(uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === 'Seamless Markdown')
    .sort((x, y) => x.range.start.compareTo(y.range.start));
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

  test('reports broken links in the Problems panel and in the editor, and clears them on close', async () => {
    fs.writeFileSync(
      path.join(dir, 'links.md'),
      [
        '# Links',
        '',
        'Fine: [note](notes/other.md), [heading](notes/other.md#other-note), [here](#links), [web](https://example.invalid/nothing.md).',
        '',
        'Broken: [gone](soon.md) and ![pic](assets/nope.png).',
        'Also [anchor](notes/other.md#other-nte), [here](#linsk) and [ref][nope].',
        '',
      ].join('\n'),
    );
    const { uri, document } = await open('links.md');
    const expected = [
      'File not found: soon.md',
      'File not found: assets/nope.png',
      'No heading "other-nte" in notes/other.md',
      'No heading "linsk" in this document',
      'No definition for [nope]',
    ];
    const found = await until(() => {
      const d = linkProblems(uri);
      return d.length === expected.length ? d : null;
    }, 'the diagnostics');
    assert.deepStrictEqual(found.map((d) => d.message), expected);
    assert.ok(found.every((d) => d.severity === vscode.DiagnosticSeverity.Warning));
    // Each range covers exactly the link it is about.
    assert.deepStrictEqual(found.map((d) => document.getText(d.range)), [
      '[gone](soon.md)',
      '![pic](assets/nope.png)',
      '[anchor](notes/other.md#other-nte)',
      '[here](#linsk)',
      '[ref][nope]',
    ]);
    assert.deepStrictEqual([found[0].range.start.line, found[0].range.start.character], [4, 8]);

    // The webview underlines the same links, having asked the host about the files.
    await until(async () => {
      const state = await api.state(uri);
      return state && JSON.stringify(state.brokenLinks) === JSON.stringify(expected) ? state : null;
    }, 'the editor to underline the broken links');

    // Creating the missing file is noticed without an edit to the document.
    fs.writeFileSync(path.join(dir, 'soon.md'), '# Soon\n');
    await until(() => linkProblems(uri).length === expected.length - 1, 'the diagnostic of the created file to go away', 30000);
    assert.deepStrictEqual(linkProblems(uri).map((d) => d.message), expected.slice(1));
    await until(async () => {
      const state = await api.state(uri);
      return state && JSON.stringify(state.brokenLinks) === JSON.stringify(expected.slice(1)) ? state : null;
    }, 'the underline of the created file to go away');
    assert.strictEqual(document.isDirty, false, 'checking links must not dirty the document');

    // Editing a link re-checks it.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, found[3].range, '[here](#links)');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(() => linkProblems(uri).length === expected.length - 2, 'the fixed link to stop being reported');
    const state = await until(async () => {
      const s = await api.state(uri);
      return s && s.brokenLinks.length === expected.length - 2 ? s : null;
    }, 'the fixed link to lose its underline');
    assert.deepStrictEqual(state.problems, []);

    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until(() => linkProblems(uri).length === 0, 'the diagnostics to be cleared when the document closes');
  });

  test('answers which link targets are missing, and why', async () => {
    fs.writeFileSync(path.join(dir, 'notes', 'With space & (1).md'), '# Twice\n\n## Twice\n\nSetext heading\n---\n\n<a name="legacy"></a>\n');
    const { uri } = await open('features.md');
    const targets = [
      { path: 'notes/other.md', anchor: '' },
      { path: 'notes', anchor: '' },
      { path: 'notes/nope.md', anchor: '' },
      { path: '../' + path.basename(dir) + '/plain.md', anchor: '' },
      // Outside a workspace folder a leading slash resolves from the document's folder, as when opening the link.
      { path: '/notes/other.md', anchor: 'other-note' },
      { path: 'notes/other.md', anchor: 'Other Note' },
      { path: 'notes/other.md', anchor: 'other-notes' },
      { path: 'notes/other.md', anchor: 'something-else-entirely' },
      { path: 'notes/With space & (1).md', anchor: 'twice-1' },
      { path: 'notes/With space & (1).md', anchor: 'twice-2' },
      { path: 'notes/With space & (1).md', anchor: 'setext-heading' },
      { path: 'notes/With space & (1).md', anchor: 'legacy' },
      // Only Markdown files have headings to check.
      { path: 'assets/diagram.svg', anchor: 'layer1' },
    ];
    assert.deepStrictEqual(await api.checkLinks(uri, targets), [
      null,
      null,
      { reason: 'file' },
      null,
      null,
      null,
      { reason: 'anchor', suggestion: 'other-note' },
      { reason: 'anchor', suggestion: undefined },
      null,
      { reason: 'anchor', suggestion: 'twice-1' },
      null,
      null,
      null,
    ]);
  });

  test('offers the closest heading as a quick fix, also in the plain text editor', async () => {
    const file = path.join(dir, 'fix.md');
    fs.writeFileSync(file, '# Set up\r\n\r\nIntro.\r\n\r\nSee [how](#setup) or [the note](notes/other.md#other-nte).\r\n');
    const uri = vscode.Uri.file(file);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    assert.strictEqual(api.sessionCount(uri), 0, 'the file is open as plain text');
    const found = await until(() => {
      const d = linkProblems(uri);
      return d.length === 2 ? d : null;
    }, 'the diagnostics');
    assert.deepStrictEqual(found.map((d) => [d.message, d.range.start.line, d.range.start.character, d.range.end.character]), [
      ['No heading "setup" in this document', 4, 4, 17],
      ['No heading "other-nte" in notes/other.md', 4, 21, 57],
    ]);
    for (const [index, title] of [
      [1, 'Change to "#other-note"'],
      [0, 'Change to "#set-up"'],
    ]) {
      const current = await until(() => {
        const d = linkProblems(uri);
        return d.length === index + 1 ? d : null;
      }, 'the diagnostics after a fix');
      const action = await until(async () => {
        const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, current[index].range, vscode.CodeActionKind.QuickFix.value);
        return (actions || []).find((a) => a.title === title);
      }, `the quick fix ${title}`);
      assert.ok(action.edit, 'the quick fix carries its edit');
      assert.ok(await vscode.workspace.applyEdit(action.edit));
    }
    assert.strictEqual(document.getText(), '# Set up\r\n\r\nIntro.\r\n\r\nSee [how](#set-up) or [the note](notes/other.md#other-note).\r\n');
    await until(() => linkProblems(uri).length === 0, 'the diagnostics to go away');
  });

  test('stops checking links when the setting is off', async () => {
    fs.writeFileSync(path.join(dir, 'off.md'), 'A [broken link](nowhere.md).\n');
    const { uri } = await open('off.md');
    const config = vscode.workspace.getConfiguration('seamlessMarkdown');
    const underlined = async (count) =>
      until(async () => {
        const state = await api.state(uri);
        return state && state.brokenLinks.length === count && linkProblems(uri).length === count;
      }, `${count} broken link(s) in the editor and the Problems panel`);
    await underlined(1);
    try {
      await config.update('checkLinks', false, vscode.ConfigurationTarget.Global);
      await underlined(0);
    } finally {
      await config.update('checkLinks', undefined, vscode.ConfigurationTarget.Global);
    }
    await underlined(1);
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

  test('is offered for Markdown files but does not take over as the default', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    await vscode.commands.executeCommand('vscode.open', uri);
    assert.ok(vscode.window.activeTextEditor, 'a plain open uses the text editor');
    assert.strictEqual(api.sessionCount(uri), 0);
  });
});
