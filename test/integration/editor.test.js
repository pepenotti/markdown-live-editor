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

/**
 * Runs an export command the way a user does: the command asks where to save, and the
 * dialog is answered with `target`. `source` is what the Explorer passes, when given.
 */
function exportTo(command, target, ...source) {
  api.answerSaveDialog(target);
  return vscode.commands.executeCommand(command, ...source);
}

const isPdf = (file) => {
  const bytes = fs.readFileSync(file);
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-' && bytes.subarray(-1024).toString('latin1').includes('%%EOF');
};

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
    for (const sub of ['sub', 'sub2']) fs.mkdirSync(path.join(dir, 'wiki', sub), { recursive: true });
    const wiki = (name, text) => fs.writeFileSync(path.join(dir, 'wiki', name), text);
    wiki('Home.md', '# Home\n\nSee [[Target]] and [[target#Second part|part two]].\n\nAlso [the target](Target.md#second-part) the standard way.\n\nNothing yet: [[Missing Note]].\n');
    wiki('Target.md', '# Target\n\nText\n\n## Second part\n\nMore\n');
    wiki('Beside.md', '# Beside\n\nBack to [[Target]].\n\n`[[Target]]` in code does not count.\n');
    wiki('Checks.md', 'A [[Target#Secnd part]] b [[Twin]] c [[Nope|shown]] d [[#Nowhere]] e [[sub/Deep]] f [[../plain]].\n');
    wiki('Existing.md', 'keep me\n');
    wiki('sub/Deep.md', '# Deep\n');
    wiki('sub/Twin.md', '# Twin one\n');
    wiki('sub2/Twin.md', '# Twin two\n');
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
    assert.strictEqual(api.rendererLoaded(), false, 'opening an editor does not load the export renderer');
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
    // The dirty flag reaches the extension host in a message of its own, just after the text.
    await until(() => document.isDirty, 'the document to be marked as changed');
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
    // Opened in this editor first, then handed to the text editor: the same document, still checked.
    const { uri, document } = await open('fix.md');
    await vscode.commands.executeCommand('seamlessMarkdown.openSource');
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'the text editor');
    await until(() => api.sessionCount(uri) === 0, 'the custom editor to close');
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

  test('leaves alone a Markdown file outside the workspace that was never opened in this editor', async () => {
    const file = path.join(dir, 'passing-by.md');
    fs.writeFileSync(file, 'A [broken link](nowhere.md) and [another](#nope).\n');
    const uri = vscode.Uri.file(file);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(linkProblems(uri), []);
    // Opening it in this editor is what asks for the check.
    await open('passing-by.md');
    await until(() => linkProblems(uri).length === 2, 'the diagnostics once the file is open in this editor');
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

  test('exports a self-contained HTML file', async () => {
    const { uri } = await open('features.md');
    const target = vscode.Uri.file(path.join(dir, 'features-export.html'));
    const written = await exportTo('seamlessMarkdown.exportHtml', target);
    assert.strictEqual(written && written.toString(), target.toString());
    const html = fs.readFileSync(target.fsPath, 'utf8');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'a complete document');
    assert.ok(html.includes('<title>Seamless Markdown</title>'), 'title from the first heading');
    assert.ok(html.includes('<h2 id="inline-formatting">Inline formatting</h2>'), 'headings have ids');
    assert.ok(!html.includes('Feature tour'), 'front matter is left out');
    assert.ok(html.includes('<input type="checkbox" disabled checked> A finished task'), 'task lists have checkboxes');
    assert.ok(/<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" alt="The pipeline">/.test(html), 'the SVG is embedded');
    assert.ok(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="a photo" title="Hills at dusk">/.test(html), 'the PNG is embedded');
    assert.ok(html.includes('<img src="assets/nope.png" alt="Missing image">'), 'a missing image keeps its path');
    assert.ok(!/<script|<link|@import/.test(html), 'nothing is loaded from elsewhere');

    const settings = vscode.workspace.getConfiguration('seamlessMarkdown.export');
    try {
      await settings.update('embedImages', false, vscode.ConfigurationTarget.Global);
      await exportTo('seamlessMarkdown.exportHtml', target);
      const linked = fs.readFileSync(target.fsPath, 'utf8');
      assert.ok(linked.includes('<img src="assets/diagram.svg" alt="The pipeline">'), 'images keep their relative paths');
      assert.ok(!linked.includes('src="data:'), 'nothing is embedded');
    } finally {
      await settings.update('embedImages', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.strictEqual(vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()).isDirty, false);
  });

  test('embeds only real images from the folder of the document', async () => {
    const outside = path.join(dir, '..', `${path.basename(dir)}-outside.png`);
    fs.copyFileSync(path.join(dir, 'assets', 'photo.png'), outside);
    fs.writeFileSync(path.join(dir, 'fake.png'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnot an image\n');
    fs.writeFileSync(
      path.join(dir, 'embed.md'),
      [
        '![real](assets/photo.png)',
        '![fake](fake.png)',
        `![outside](../${path.basename(outside)})`,
        '![climbing](assets/../../../../../../etc/hosts)',
        '<img src="notes/other.md" alt="markdown">',
        '<img src="plain.md" alt="text">',
        '![absolute](/etc/hosts)',
        '![through a link](linked/photo.png)',
      ].join('\n\n') + '\n',
    );
    // A folder inside the document folder that is really a link to somewhere else.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-elsewhere-'));
    fs.copyFileSync(path.join(dir, 'assets', 'photo.png'), path.join(elsewhere, 'photo.png'));
    if (process.platform !== 'win32') fs.symlinkSync(elsewhere, path.join(dir, 'linked'));
    try {
      await open('embed.md');
      const target = vscode.Uri.file(path.join(dir, 'embed-export.html'));
      await exportTo('seamlessMarkdown.exportHtml', target);
      const html = fs.readFileSync(target.fsPath, 'utf8');
      assert.strictEqual((html.match(/src="data:/g) || []).length, 1, 'only the real image is embedded');
      assert.ok(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="real">/.test(html));
      assert.ok(html.includes('<img src="fake.png" alt="fake">'), 'a file that is not an image keeps its path');
      assert.ok(html.includes(`<img src="../${path.basename(outside)}" alt="outside">`), 'an image outside the folder keeps its path');
      assert.ok(html.includes('<img src="notes/other.md" alt="markdown">'));
      assert.ok(html.includes('<img src="plain.md" alt="text">'));
      assert.ok(!html.includes('First line'), 'no other file leaks into the export');
      assert.ok(!html.includes('OPENSSH') && !html.includes(Buffer.from('-----BEGIN OPENSSH').toString('base64').slice(0, 16)));
      assert.ok(!html.includes('localhost'), 'nothing from /etc/hosts');
      assert.ok(html.includes('<img src="linked/photo.png" alt="through a link">'), 'a linked folder that leads elsewhere is not followed');
    } finally {
      fs.rmSync(outside, { force: true });
      fs.rmSync(path.join(dir, 'linked'), { force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('exports footnotes and alerts, and blocks scripts from the document', async () => {
    await open('footnotes.md');
    const target = vscode.Uri.file(path.join(dir, 'footnotes-export.html'));
    await exportTo('seamlessMarkdown.exportHtml', target);
    const html = fs.readFileSync(target.fsPath, 'utf8');
    assert.ok(html.includes('first used<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>'), 'first reference is note 1');
    assert.ok(html.includes('called<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2</a></sup>'), 'second note is note 2');
    assert.ok(html.includes('[^missing] stays as text'), 'an undefined note stays text');
    assert.ok(/<section class="footnotes">\n<ol>\n<li id="fn-1">The second definition\ncontinues on the next line\. /.test(html), 'the list is in reference order');
    assert.ok(!html.includes('Nothing points here'), 'an unused note is left out');
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none';`), 'the file carries a policy');
    assert.ok(!html.includes('script-src'), 'no script may run');

    await open('features.md');
    const features = vscode.Uri.file(path.join(dir, 'features-alerts.html'));
    await exportTo('seamlessMarkdown.exportHtml', features);
    const alerts = fs.readFileSync(features.fsPath, 'utf8');
    assert.ok(alerts.includes('<blockquote class="alert alert-note">\n<p><strong class="alert-title">Note</strong><br>'), 'a note callout');
    assert.ok(alerts.includes('<blockquote class="alert alert-warning">'), 'a warning callout');
  });

  test('reports an export that cannot be written instead of failing silently', async function () {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return this.skip();
    await open('plain.md');
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o555);
    try {
      const target = vscode.Uri.file(path.join(locked, 'out.html'));
      const written = await exportTo('seamlessMarkdown.exportHtml', target);
      assert.strictEqual(written, undefined, 'the command reports no file');
      assert.ok(!fs.existsSync(target.fsPath));
      const errors = api.shown().filter((entry) => entry.kind === 'error');
      assert.strictEqual(errors.length, 1, 'the user is told');
      assert.match(errors[0].text, /^The HTML export failed: /);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  /* ---------- export: reachable from anywhere, and never silent ---------- */

  const exported = () => api.shown().filter((entry) => entry.kind === 'info' && entry.text.startsWith('Exported '));
  const exportFolders = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('seamless-markdown-export-') || name.startsWith('seamless-markdown-profile-'));

  test('exports HTML from the plain text editor, with no editor of ours open', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'features.md'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    assert.strictEqual(api.sessionCount(uri), 0, 'the file is in the text editor only');
    const target = vscode.Uri.file(path.join(dir, 'from-text-editor.html'));
    const written = await exportTo('seamlessMarkdown.exportHtml', target);
    assert.strictEqual(written && written.toString(), target.toString());
    assert.ok(fs.readFileSync(target.fsPath, 'utf8').includes('<title>Seamless Markdown</title>'));
    // The dialog started next to the document, and the user is told where the file went.
    const shown = api.shown();
    assert.deepStrictEqual(shown.filter((e) => e.kind === 'save').map((e) => [path.basename(e.text), e.actions]), [['features.html', ['HTML']]]);
    assert.strictEqual(exported().length, 1);
    assert.strictEqual(exported()[0].text.split('.')[0], 'Exported from-text-editor');
    assert.strictEqual(exported()[0].actions[0], 'Open');
    assert.match(exported()[0].actions[1], /^(Reveal in Finder|Reveal in File Explorer|Open Containing Folder)$/);
  });

  test('exports the file the Explorer hands over, with no editor open at all', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const uri = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    const target = vscode.Uri.file(path.join(dir, 'from-explorer.html'));
    // The Explorer passes the clicked file and the whole selection.
    const written = await exportTo('seamlessMarkdown.exportHtml', target, uri, [uri]);
    assert.strictEqual(written && written.toString(), target.toString());
    assert.ok(fs.readFileSync(target.fsPath, 'utf8').includes('<h1 id="other-note">Other note</h1>'));
    assert.strictEqual(path.basename(api.shown().find((e) => e.kind === 'save').text), 'other.html');
    // It wins over the editor that happens to be active.
    await open('plain.md');
    await exportTo('seamlessMarkdown.exportHtml', target, uri);
    assert.ok(fs.readFileSync(target.fsPath, 'utf8').includes('Other note'));
  });

  test('says so when there is no Markdown file to export or copy, and throws nothing', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const target = vscode.Uri.file(path.join(dir, 'nothing.html'));
    const text = path.join(dir, 'plain.txt');
    fs.writeFileSync(text, 'not Markdown\n');
    for (const withTextFile of [false, true]) {
      if (withTextFile) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(text)));
      for (const command of ['exportHtml', 'exportPdf', 'copyAsHtml']) {
        api.answerSaveDialog(target);
        const result = await vscode.commands.executeCommand(`seamlessMarkdown.${command}`);
        assert.strictEqual(result, undefined, command);
        const shown = api.shown();
        assert.deepStrictEqual(shown.map((e) => e.kind), ['info'], `${command}: one message and no dialog`);
        assert.match(shown[0].text, /^Open a Markdown file first/);
      }
    }
    assert.ok(!fs.existsSync(target.fsPath));
    // A file that does not exist is reported too.
    api.answerSaveDialog(target);
    assert.strictEqual(await vscode.commands.executeCommand('seamlessMarkdown.exportHtml', vscode.Uri.file(path.join(dir, 'gone.md'))), undefined);
    assert.deepStrictEqual(api.shown().map((e) => e.kind), ['error']);
    assert.match(api.shown()[0].text, /^The file could not be opened: /);
  });

  test('writes nothing when the save dialog is cancelled', async () => {
    await open('plain.md');
    for (const command of ['seamlessMarkdown.exportHtml', 'seamlessMarkdown.exportPdf']) {
      assert.strictEqual(await exportTo(command, undefined), undefined);
      assert.ok(api.shown().every((e) => e.kind === 'save' || (command.endsWith('Pdf') && e.kind === 'error')), JSON.stringify(api.shown()));
    }
  });

  test('includes typing the editor has not sent yet', async () => {
    fs.writeFileSync(path.join(dir, 'typing.md'), 'Start.\n');
    const { uri, document } = await open('typing.md');
    await inStep(uri, document);
    await api.post(uri, { type: 'debugType', text: 'Typed a moment ago. ' });
    assert.strictEqual(document.getText(), 'Start.\n', 'the typing has not arrived yet');
    const target = vscode.Uri.file(path.join(dir, 'typing.html'));
    // Also when the command is told which file, as from the Explorer.
    await exportTo('seamlessMarkdown.exportHtml', target, uri);
    assert.ok(fs.readFileSync(target.fsPath, 'utf8').includes('<p>Typed a moment ago. Start.</p>'));
  });

  test('the Export menu of the toolbar exports and copies', async () => {
    const { uri } = await open('plain.md');
    const target = vscode.Uri.file(path.join(dir, 'from-toolbar.html'));
    api.answerSaveDialog(target);
    await api.fromWebview(uri, { type: 'export', action: 'html' });
    await until(() => exported().length === 1, 'the export to finish');
    assert.ok(fs.readFileSync(target.fsPath, 'utf8').includes('<p>First line</p>'));

    await vscode.env.clipboard.writeText('');
    await api.fromWebview(uri, { type: 'export', action: 'copyHtml' });
    assert.strictEqual(await until(() => vscode.env.clipboard.readText(), 'the clipboard to be filled'), '<p>First line</p>\n<p>Second paragraph with a word.</p>\n');

    // Anything else the page might send is ignored.
    api.resetUi();
    await api.fromWebview(uri, { type: 'export', action: 'rm -rf' });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(api.shown(), []);
    // The editor was told whether a PDF can be made here.
    const browser = api.exportBrowser();
    assert.strictEqual(typeof (browser.path || browser.reason), 'string');
  });

  test('copies as HTML from the plain text editor', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'plain.md'));
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('seamlessMarkdown.copyAsHtml');
    assert.strictEqual(await until(() => vscode.env.clipboard.readText(), 'the clipboard to be filled'), '<p>First line</p>\n<p>Second paragraph with a word.</p>\n');
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand('seamlessMarkdown.copyAsHtml');
    await until(async () => (await vscode.env.clipboard.readText()) === '<p>First</p>\n', 'the selection to be copied');
  });

  /* ---------- export: diagrams, math and PDF with a real browser ---------- */

  /** Skips, saying why, on a machine without a browser the export can use. */
  function needsBrowser(test) {
    const browser = api.exportBrowser();
    if (browser.path) return browser.path;
    console.log(`      SKIPPED: no Chrome, Edge, Chromium or Brave on this machine (${browser.reason})`);
    test.skip();
  }

  test('draws diagrams into the exported HTML as static SVG, with math laid out by KaTeX', async function () {
    needsBrowser(this);
    this.timeout(120000);
    const before = exportFolders();
    await open('diagrams.md');
    const target = vscode.Uri.file(path.join(dir, 'diagrams-export.html'));
    await exportTo('seamlessMarkdown.exportHtml', target);
    const html = fs.readFileSync(target.fsPath, 'utf8');
    assert.strictEqual((html.match(/<figure class="diagram"><svg /g) || []).length, 1, 'the diagram is drawn');
    assert.ok(html.includes('Half preview') && html.includes('Markdown file'), 'with its labels');
    assert.ok(!html.includes('language-mermaid') && !html.includes('flowchart LR'), 'its source is gone');
    assert.ok(!/<script/i.test(html), 'and no script is left');
    assert.strictEqual((html.match(/class="katex-html"/g) || []).length, 3, 'three formulas');
    assert.ok(html.includes('<div class="math-block"><span class="katex-display">'), 'block math');
    assert.ok(/@font-face\{[^}]*KaTeX_Main;[^}]*src:url\(data:font\/woff2;base64,/.test(html), 'the math font is embedded');
    // A drawing refers to its own markers with url(#…); nothing else may be a URL.
    assert.ok(!/url\((?!["']?(?:data:|#))/.test(html), 'and nothing is loaded from a file or the network');
    assert.ok(html.includes('a price like $5 or $10 stays a price'), 'prices are not math');
    assert.match(exported()[0].text, /^Exported diagrams-export\.html\.$/, 'nothing to add when everything was drawn');
    assert.deepStrictEqual(exportFolders(), before, 'no temporary folder or browser profile is left');
  });

  test('exports a PDF in one step, printed from the same HTML with the diagram drawn', async function () {
    needsBrowser(this);
    this.timeout(120000);
    const before = exportFolders();
    // From the plain text editor: no editor of ours is involved.
    const uri = vscode.Uri.file(path.join(dir, 'diagrams.md'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const target = vscode.Uri.file(path.join(dir, 'diagrams-export.pdf'));
    const written = await exportTo('seamlessMarkdown.exportPdf', target);
    assert.strictEqual(written && written.toString(), target.toString());
    assert.ok(isPdf(target.fsPath), 'a complete PDF');
    assert.ok(fs.statSync(target.fsPath).size > 10000, 'with content');
    const shown = api.shown();
    assert.deepStrictEqual(shown.map((e) => e.kind), ['save', 'progress', 'info'], 'dialog, progress, done: nothing else');
    assert.deepStrictEqual([path.basename(shown[0].text), shown[0].actions], ['diagrams.pdf', ['PDF']]);
    assert.strictEqual(shown[1].text, 'Creating diagrams-export.pdf…');
    assert.strictEqual(shown[2].text, 'Exported diagrams-export.pdf.');
    // What was printed.
    const html = api.lastExportHtml();
    assert.strictEqual((html.match(/<figure class="diagram"><svg /g) || []).length, 1, 'the diagram is in the printed page');
    assert.ok(!/<script/i.test(html), 'no script');
    assert.ok(html.includes('@page{margin:') && !html.includes('prefers-color-scheme'), 'the print style sheet');
    assert.strictEqual((html.match(/class="katex-html"/g) || []).length, 3);
    assert.deepStrictEqual(exportFolders(), before, 'no temporary folder or browser profile is left');
  });

  test('exports a PDF of the file the Explorer hands over, images included', async function () {
    needsBrowser(this);
    this.timeout(120000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const settings = vscode.workspace.getConfiguration('seamlessMarkdown.export');
    try {
      // A PDF has its images whatever the setting for HTML says.
      await settings.update('embedImages', false, vscode.ConfigurationTarget.Global);
      const target = vscode.Uri.file(path.join(dir, 'features-export.pdf'));
      await exportTo('seamlessMarkdown.exportPdf', target, vscode.Uri.file(path.join(dir, 'features.md')));
      assert.ok(isPdf(target.fsPath));
      assert.ok(fs.statSync(target.fsPath).size > 50000, 'large enough to hold the images');
      assert.ok(/<img src="data:image\/png;base64,/.test(api.lastExportHtml()));
      assert.match(exported()[0].text, /^Exported features-export\.pdf\. 1 image was not embedded \(assets\/nope\.png\)\.$/);
    } finally {
      await settings.update('embedImages', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('without a browser PDF export is not offered, says why when run, and HTML keeps diagrams as source', async function () {
    this.timeout(120000);
    const settings = vscode.workspace.getConfiguration('seamlessMarkdown.export');
    const had = api.exportBrowser().path;
    try {
      await settings.update('browserPath', path.join(dir, 'no-such-browser'), vscode.ConfigurationTarget.Global);
      await until(() => !api.exportBrowser().path, 'the missing browser to be noticed');
      assert.match(api.exportBrowser().reason, /browserPath does not exist/);

      await open('diagrams.md');
      const pdf = vscode.Uri.file(path.join(dir, 'never.pdf'));
      assert.strictEqual(await exportTo('seamlessMarkdown.exportPdf', pdf), undefined);
      const shown = api.shown();
      assert.deepStrictEqual(shown.map((e) => e.kind), ['error'], 'an error and no save dialog');
      assert.match(shown[0].text, /^Export as PDF needs a Chromium-based browser \(Chrome, Edge, Chromium or Brave\)/);
      assert.deepStrictEqual(shown[0].actions, ['Open Setting']);
      assert.ok(!fs.existsSync(pdf.fsPath));

      const target = vscode.Uri.file(path.join(dir, 'diagrams-source.html'));
      await exportTo('seamlessMarkdown.exportHtml', target);
      const html = fs.readFileSync(target.fsPath, 'utf8');
      assert.ok(html.includes('<pre><code class="language-mermaid">flowchart LR'), 'the diagram is a code block');
      assert.ok(!html.includes('<figure class="diagram">') && !/<script/i.test(html));
      assert.strictEqual((html.match(/class="katex-html"/g) || []).length, 3, 'math needs no browser');
      assert.strictEqual(exported()[0].text, 'Exported diagrams-source.html. Its diagram was exported as source code: drawing diagrams needs Chrome, Edge, Chromium or Brave.');
    } finally {
      await settings.update('browserPath', undefined, vscode.ConfigurationTarget.Global);
      await until(() => api.exportBrowser().path === had, 'the browser to be found again');
    }
  });

  /* ---------- Email Document ---------- */

  const opened = () => api.shown().filter((entry) => entry.kind === 'open').map((entry) => entry.text);
  const told = (kind) => api.shown().filter((entry) => entry.kind === kind).map((entry) => entry.text);
  /** The fields of a mailto link as a mail app reads them. */
  const mail = (link) => {
    const [, to, query] = /^mailto:([^?]*)\?(.*)$/.exec(link);
    return { to, ...Object.fromEntries(query.split('&').map((pair) => pair.split('=').map(decodeURIComponent))) };
  };
  /**
   * A page may only write to the clipboard while it has the keyboard focus, and it cannot
   * have it while the VS Code window itself is not the focused window (a test run in the
   * background, a locked screen). Then the command falls back to plain text and says so,
   * and that is what is checked: both outcomes are real, neither is skipped.
   */
  const windowFocused = () => vscode.window.state.focused;
  const NO_FOCUS = /^Formatted text could not be copied \(the editor does not have the keyboard focus\), so the document was copied as Markdown text instead\. /;
  function expectCopy(how, extra = '', paste = 'Paste it into the new email.') {
    if (how === 'formatted') {
      assert.deepStrictEqual(told('error'), []);
      assert.deepStrictEqual(told('info'), [`Copied as formatted text. ${paste}${extra}`]);
      return true;
    }
    assert.strictEqual(windowFocused(), false, `formatted copy failed in a focused window: ${JSON.stringify(api.shown())}`);
    console.log('      NOTE: this VS Code window does not have the focus, so the plain-text fallback and its message were checked instead of the formatted copy');
    assert.strictEqual(how, 'plain');
    assert.deepStrictEqual(told('info'), []);
    assert.strictEqual(told('error').length, 1);
    assert.match(told('error')[0], NO_FOCUS);
    return false;
  }
  /** What the editor can read back from the clipboard, or null (with the reason printed) where reading is not allowed. */
  async function richClipboard(uri) {
    const state = await api.clipboard(uri);
    if (state && !state.error) return state;
    console.log(`      NOTE: the HTML on the clipboard could not be read back here (${state ? state.error : 'no answer'}); only the plain text was checked`);
    return null;
  }

  test('emails a document from this editor: formatted text on the clipboard and a new message with the subject', async () => {
    const { uri, document } = await open('features.md');
    await inStep(uri, document);
    await vscode.env.clipboard.writeText('');
    api.resetUi();
    const how = await vscode.commands.executeCommand('seamlessMarkdown.emailDocument');
    // The new message: only a subject and a note, nothing of the document.
    assert.deepStrictEqual(opened(), ['mailto:?subject=Seamless%20Markdown&body=%28Paste%20here%29']);
    const formatted = expectCopy(how, ' Left out, because a pasted mail cannot carry them: 4 local images.');
    // The plain flavour is the Markdown itself (and it is all there is after the fallback).
    assert.strictEqual(lf(await vscode.env.clipboard.readText()), lf(document.getText()));
    const clipboard = formatted && (await richClipboard(uri));
    if (clipboard) {
      assert.ok(clipboard.types.includes('text/html') && clipboard.types.includes('text/plain'), `flavours: ${clipboard.types}`);
      assert.ok(/<h1 style="[^"]+">Seamless Markdown<\/h1>/.test(clipboard.html), 'headings with inline styles');
      assert.ok(/<td style="border:\s*1px solid/.test(clipboard.html), 'table cells with borders');
      assert.ok(/<pre style="[^"]*font-family:\s*ui-monospace/.test(clipboard.html), 'code in a monospace font');
      assert.ok(clipboard.html.includes('[Image: The pipeline]'), 'local images as their alt text');
      assert.ok(!/<script|<style| class=/.test(clipboard.html.replace(/<meta[^>]*>/g, '')), 'nothing a mail program drops');
    }
    assert.strictEqual(document.isDirty, false);
    // The editor still has its state and its focus was given back.
    const state = await inStep(uri, document);
    assert.deepStrictEqual(state.problems, []);
  });

  test('emails from the Export menu of the toolbar, with the recipient from the settings and a title that cannot inject', async () => {
    fs.writeFileSync(path.join(dir, 'inject.md'), '# Plan & budget?cc=x@evil.example&bcc=y@evil.example\nBcc: z@evil.example\n\nText with ```mermaid``` no diagram.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
    const settings = vscode.workspace.getConfiguration('seamlessMarkdown.email');
    try {
      await settings.update('to', 'team@example.com, not an address, boss@example.com?bcc=evil@example.com', vscode.ConfigurationTarget.Global);
      const { uri } = await open('inject.md');
      api.resetUi();
      await api.fromWebview(uri, { type: 'export', action: 'email' });
      await until(() => opened().length === 1, 'the mail app to be opened');
      const link = opened()[0];
      assert.ok(!/[\s]/.test(link) && link.length < 300, link);
      assert.deepStrictEqual(link.match(/[?&]/g), ['?', '&'], 'two fields and no more');
      assert.deepStrictEqual(mail(link), { to: 'team@example.com', subject: 'Plan & budget?cc=x@evil.example&bcc=y@evil.example', body: '(Paste here)' });
      await until(() => told('info').length + told('error').length === 1, 'the notification');
      expectCopy(told('info').length ? 'formatted' : 'plain', ' Left out, because a pasted mail cannot carry it: 1 diagram.');
    } finally {
      await settings.update('to', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('emails a document whose editor is behind another tab', async () => {
    const { uri, document } = await open('plain.md');
    await inStep(uri, document);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'notes', 'other.md'))), { preview: false });
    await vscode.env.clipboard.writeText('');
    api.resetUi();
    // As from the Explorer: the file is named, and it is not the one in front.
    const how = await vscode.commands.executeCommand('seamlessMarkdown.emailDocument', uri);
    assert.deepStrictEqual(opened(), ['mailto:?subject=plain&body=%28Paste%20here%29'], 'the file name is the subject when there is no heading');
    // The editor was brought to the front to do the copying.
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType, VIEW_TYPE);
    const formatted = expectCopy(how);
    assert.strictEqual(lf(await vscode.env.clipboard.readText()), 'First line\n\nSecond paragraph with a word.\n');
    const clipboard = formatted && (await richClipboard(uri));
    if (clipboard) assert.ok(/<p style="[^"]+">First line<\/p>/.test(clipboard.html), clipboard.html);
  });

  test('without an editor of ours, says that only the Markdown text was copied, and still opens the message', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const uri = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    for (const fromExplorer of [false, true]) {
      if (!fromExplorer) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      else await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      assert.strictEqual(api.sessionCount(uri), 0);
      await vscode.env.clipboard.writeText('');
      api.resetUi();
      const how = await vscode.commands.executeCommand('seamlessMarkdown.emailDocument', ...(fromExplorer ? [uri] : []));
      assert.strictEqual(how, 'plain');
      assert.deepStrictEqual(opened(), ['mailto:?subject=Other%20note&body=%28Paste%20here%29']);
      assert.strictEqual(lf(await vscode.env.clipboard.readText()), lf(text));
      const shown = api.shown().filter((entry) => entry.kind === 'info');
      assert.strictEqual(shown.length, 1);
      assert.strictEqual(shown[0].text, 'Copied the document as Markdown text, without formatting: formatted text can only be copied from the Seamless Markdown editor. Paste it into the new email.');
      assert.deepStrictEqual(shown[0].actions, ['Open in Seamless Markdown']);
    }
    // The offer in that message opens the file in this editor.
    api.resetUi();
    api.choose(undefined, 'Open in Seamless Markdown');
    await vscode.commands.executeCommand('seamlessMarkdown.emailDocument', uri);
    await until(() => api.sessionCount(uri) === 1, 'the editor to open');
  });

  test('says so when there is nothing to email or no mail app, and never opens anything but a mailto link', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    api.resetUi();
    assert.strictEqual(await vscode.commands.executeCommand('seamlessMarkdown.emailDocument'), undefined);
    assert.deepStrictEqual(api.shown().map((e) => e.kind), ['info']);
    assert.match(api.shown()[0].text, /^Open a Markdown file first/);

    const { uri } = await open('plain.md');
    api.resetUi();
    api.failToOpen();
    assert.strictEqual(await vscode.commands.executeCommand('seamlessMarkdown.emailDocument'), undefined, 'no message was opened');
    assert.strictEqual(opened().length, 1);
    assert.match(api.shown().filter((e) => e.kind !== 'open')[0].text, /No mail app could be opened; paste it into a new email yourself\./);
    // Whatever a document is called or contains, the only thing ever opened is a short mailto link.
    fs.writeFileSync(path.join(dir, 'odd.md'), `# https://evil.example/?x=1 file:///etc/passwd ${'long '.repeat(2000)}\n`);
    await open('odd.md');
    api.resetUi();
    await vscode.commands.executeCommand('seamlessMarkdown.emailDocument');
    assert.strictEqual(opened().length, 1);
    assert.match(opened()[0], /^mailto:\?subject=[A-Za-z0-9._~%-]*&body=%28Paste%20here%29$/);
    assert.ok(opened()[0].length < 700);
    assert.strictEqual(mail(opened()[0]).subject.length, 120);
    assert.ok(uri);
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

  /* ---------- wiki links ---------- */

  const wikiFile = (...parts) => vscode.Uri.file(path.join(dir, 'wiki', ...parts));
  const baseNames = (paths) => paths.map((p) => path.basename(p));

  test('with wiki links off, double brackets are text and no index of notes is built', async () => {
    const { uri, document } = await open('wiki/Home.md');
    const state = await inStep(uri, document);
    assert.strictEqual(state.rendered.wikiLinks, 0);
    assert.deepStrictEqual(state.problems, []);
    await open('wiki/Checks.md');
    const checks = wikiFile('Checks.md');
    // Everything that could start the index is asked, and answers with nothing.
    assert.strictEqual(await api.resolveNote(uri, 'Target'), 'missing');
    assert.deepStrictEqual(await api.listNotes(uri), []);
    assert.deepStrictEqual(await api.noteHeadings(uri, 'Target'), []);
    assert.deepStrictEqual(await api.backlinks(wikiFile('Target.md')), []);
    assert.deepStrictEqual(await api.backlinksView(), []);
    assert.deepStrictEqual(await api.checkLinks(uri, [{ path: 'Missing Note', anchor: '', wiki: true }]), [null]);
    assert.strictEqual(await api.openWikiLink(uri, 'Target', '', true), undefined);
    assert.strictEqual(await api.openWikiLink(uri, 'Brand New', '', true), undefined);
    assert.ok(!fs.existsSync(path.join(dir, 'wiki', 'Brand New.md')), 'nothing is created while the setting is off');
    const index = await api.noteIndexState();
    assert.deepStrictEqual({ notes: index.notes, parsed: index.parsed, started: index.started, looseFolders: index.looseFolders }, { notes: 0, parsed: 0, started: false, looseFolders: 0 });
    // The link checker says what it says on main: nothing about double brackets.
    await until(async () => (await api.state(checks))?.brokenLinks.length === 0 && linkProblems(checks).length === 0, 'no finding for double brackets');
    assert.deepStrictEqual(linkProblems(uri), []);
    // And they are exported as they are written.
    const target = vscode.Uri.file(path.join(dir, 'wiki-off.html'));
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    await exportTo('seamlessMarkdown.exportHtml', target);
    assert.ok(fs.readFileSync(target.fsPath, 'utf8').includes('<p>See [[Target]] and [[target#Second part|part two]].</p>'));
  });

  suite('wiki links', () => {
    const setting = (value) => vscode.workspace.getConfiguration('seamlessMarkdown').update('wikiLinks', value, vscode.ConfigurationTarget.Global);

    suiteSetup(() => setting(true));
    suiteTeardown(() => setting(undefined));

    test('resolves note names inside the folder of the document only', async () => {
      const { uri } = await open('wiki/Home.md');
      const target = wikiFile('Target.md').fsPath;
      // These files are outside any workspace folder: the folder of the document is the whole world.
      assert.strictEqual(await api.resolveNote(uri, 'Target'), target);
      assert.strictEqual(await api.resolveNote(uri, 'target.md'), target);
      assert.strictEqual(await api.resolveNote(uri, 'Missing Note'), 'missing');
      // A subfolder is not listed, but a file in it is found by its path.
      assert.strictEqual(await api.resolveNote(uri, 'sub/Deep'), wikiFile('sub', 'Deep.md').fsPath);
      assert.strictEqual(await api.resolveNote(uri, 'Deep'), 'missing');
      // Files that exist above the folder are out of reach, by name and by path.
      assert.ok(fs.existsSync(path.join(dir, 'plain.md')));
      for (const name of ['plain', '../plain', '../plain.md', '/plain', path.join(dir, 'plain.md'), '../../../../etc/hosts']) {
        assert.strictEqual(await api.resolveNote(uri, name), 'missing', name);
        assert.strictEqual(await api.openWikiLink(uri, name, '', false), undefined, name);
      }
      assert.strictEqual(api.sessionCount(vscode.Uri.file(path.join(dir, 'plain.md'))), 0);
      const notes = await api.listNotes(uri);
      assert.deepStrictEqual(notes.map((n) => n.name), ['Beside', 'Checks', 'Existing', 'Target']);
      assert.deepStrictEqual(await api.noteHeadings(uri, 'Target'), ['Target', 'Second part']);
      const index = await api.noteIndexState();
      assert.strictEqual(index.notes, 5);
      assert.strictEqual(index.looseFolders, 1);
      // One watcher for the folder, shared with the link checker.
      assert.strictEqual(index.watching.folders.filter((f) => f.endsWith('/wiki')).length, 1);
    });

    test('draws wiki links and reports the unresolved ones like any broken link', async () => {
      const { uri, document } = await open('wiki/Home.md');
      const state = await until(async () => {
        const s = await api.state(uri);
        return s && s.rendered.wikiLinks === 3 && s.brokenLinks.length === 1 ? s : null;
      }, 'the wiki links to be drawn and checked');
      assert.deepStrictEqual(state.brokenLinks, ['No note called "Missing Note"']);
      assert.deepStrictEqual(state.problems, []);
      assert.strictEqual(document.isDirty, false);
      await until(() => linkProblems(uri).length === 1, 'the diagnostic');
      assert.deepStrictEqual(linkProblems(uri).map((d) => [d.message, d.code, document.getText(d.range)]), [['No note called "Missing Note"', 'link-note', '[[Missing Note]]']]);

      // Two notes of one name in different folders, both known once those folders have been looked at.
      await api.listNotes(wikiFile('sub', 'Twin.md'));
      await api.listNotes(wikiFile('sub2', 'Twin.md'));
      const checks = await open('wiki/Checks.md');
      const expected = ['No heading "Secnd part" in Target', 'Several notes are called "Twin"', 'No note called "Nope"', 'No heading "Nowhere" in this document', 'No note called "../plain"'];
      await until(() => JSON.stringify(linkProblems(checks.uri).map((d) => d.message)) === JSON.stringify(expected), 'the diagnostics of the second note');
      await until(async () => JSON.stringify((await api.state(checks.uri))?.brokenLinks) === JSON.stringify(expected), 'the same findings in the editor');
      const fix = await until(async () => {
        const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', checks.uri, linkProblems(checks.uri)[0].range, vscode.CodeActionKind.QuickFix.value);
        return (actions || []).find((f) => f.title === 'Change to "#second-part"');
      }, 'the quick fix for the heading');
      assert.ok(await vscode.workspace.applyEdit(fix.edit));
      assert.ok(checks.document.getText().startsWith('A [[Target#second-part]] b [[Twin]]'), checks.document.getText());
      await until(() => linkProblems(checks.uri).length === expected.length - 1, 'the fixed link to stop being reported');
    });

    test('exports a wiki link as a link to the exported note, and a missing one as text', async () => {
      const { uri } = await open('wiki/Home.md');
      const target = vscode.Uri.file(path.join(dir, 'wiki-on.html'));
      await exportTo('seamlessMarkdown.exportHtml', target);
      const html = fs.readFileSync(target.fsPath, 'utf8');
      assert.ok(html.includes('<p>See <a href="Target.html" class="wikilink">Target</a> and <a href="Target.html#second-part" class="wikilink">part two</a>.</p>'), html);
      assert.ok(html.includes('<p>Nothing yet: Missing Note.</p>'), html);
      // A copied fragment has no folder to be relative to: notes are copied as their text.
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('seamlessMarkdown.copyAsHtml');
      const copied = await until(() => vscode.env.clipboard.readText(), 'the clipboard to be filled');
      assert.ok(copied.includes('<p>See Target and part two.</p>'), copied);
      assert.strictEqual(api.sessionCount(uri), 1);
    });

    test('lists the notes that link to a note, by wiki link or Markdown link', async () => {
      const target = wikiFile('Target.md');
      await open('wiki/Target.md');
      const links = await api.backlinks(target);
      assert.deepStrictEqual(baseNames(links.map((l) => l.path)), ['Beside.md', 'Checks.md', 'Home.md']);
      assert.deepStrictEqual(links[2].lines.map((l) => l.line), [2, 4]);
      assert.strictEqual(links[2].lines[1].text, 'Also [the target](Target.md#second-part) the standard way.');
      assert.deepStrictEqual(links[0].lines, [{ line: 2, text: 'Back to [[Target]].' }]);
      assert.deepStrictEqual(await api.backlinks(wikiFile('Home.md')), []);
      // The view shows them while the note is the active editor, and nothing for any other kind of editor.
      assert.deepStrictEqual(baseNames(await api.backlinksView()), ['Beside.md', 'Checks.md', 'Home.md']);
      const text = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(text, { preview: false });
      assert.deepStrictEqual(await api.backlinksView(), []);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      // A new file is picked up by the watcher.
      fs.writeFileSync(path.join(dir, 'wiki', 'Later.md'), 'Read [[Target|this]] first.\n');
      await until(async () => baseNames((await api.backlinks(target)).map((l) => l.path)).includes('Later.md'), 'the new file to show up');
      fs.rmSync(path.join(dir, 'wiki', 'Later.md'));
      await until(async () => !baseNames((await api.backlinks(target)).map((l) => l.path)).includes('Later.md'), 'the deleted file to disappear');

      // Unsaved text counts as well.
      const beside = await open('wiki/Beside.md');
      const edit = new vscode.WorkspaceEdit();
      edit.insert(beside.uri, new vscode.Position(0, 0), 'Up to [Target](./Target.md).\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      const lines = await until(async () => {
        const found = (await api.backlinks(target)).find((l) => path.basename(l.path) === 'Beside.md');
        return found && found.lines.length === 2 ? found.lines : null;
      }, 'the unsaved link to show up');
      assert.deepStrictEqual(lines.map((l) => l.line), [0, 3]);
    });

    test('opens a backlink at its line', async () => {
      const home = wikiFile('Home.md');
      await vscode.commands.executeCommand('seamlessMarkdown.openBacklink', home, 4);
      await until(() => api.sessionCount(home) === 1, 'the linking note to open');
      await until(async () => (await api.state(home))?.cursorLine === 4, 'the cursor to reach the line');
      // Only notes are opened this way.
      const image = vscode.Uri.file(path.join(dir, 'assets', 'photo.png'));
      await vscode.commands.executeCommand('seamlessMarkdown.openBacklink', image, 0);
      assert.strictEqual(api.sessionCount(image), 0);
    });

    test('follows a wiki link to a heading', async () => {
      const { uri } = await open('wiki/Home.md');
      const target = wikiFile('Target.md');
      assert.strictEqual((await api.openWikiLink(uri, 'target', 'Second part', false)).toString(), target.toString());
      await until(() => api.sessionCount(target) === 1, 'the linked note to open');
      await until(async () => (await api.state(target))?.cursorLine === 4, 'the cursor to reach the heading');
    });

    test('creates a missing note only when confirmed, in the folder of the document, and never over a file', async () => {
      const { uri } = await open('wiki/Home.md');
      const listing = () => fs.readdirSync(dir, { recursive: true }).map(String).sort();
      const before = listing();
      const created = path.join(dir, 'wiki', 'Missing Note.md');
      assert.strictEqual(await api.openWikiLink(uri, 'Missing Note', '', false), undefined);
      // Names that are not one plain file name are refused even with a yes.
      const refused = ['../Escape', '../../Escape', 'sub/New', 'sub\\New', '/tmp/mdl-escape', path.join(dir, 'Absolute'), '..', '.', '.hidden', 'CON', 'nul.md', 'a:b', 'a*b', 'bad\u0001name', 'trailing.'];
      for (const name of refused) assert.strictEqual(await api.openWikiLink(uri, name, '', true), undefined, JSON.stringify(name));
      assert.deepStrictEqual(listing(), before, 'nothing was created anywhere');
      assert.ok(!fs.existsSync('/tmp/mdl-escape.md'));

      const made = await api.openWikiLink(uri, 'Missing Note', '', true);
      assert.strictEqual(made.fsPath, vscode.Uri.file(created).fsPath);
      assert.strictEqual(fs.readFileSync(created, 'utf8'), '# Missing Note\n');
      await until(() => api.sessionCount(made) === 1, 'the new note to open');
      assert.strictEqual(await api.resolveNote(uri, 'Missing Note'), made.fsPath);
      assert.deepStrictEqual(listing().filter((f) => !before.includes(f)), [path.join('wiki', 'Missing Note.md')]);

      // The link is no longer reported, in the Problems panel or in the editor.
      await until(() => linkProblems(uri).length === 0, 'the diagnostic to go away');
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      await until(async () => {
        const s = await api.state(uri);
        return s && s.rendered.wikiLinks === 3 && s.brokenLinks.length === 0;
      }, 'the link to be drawn as found');

      // A file that is already there is never replaced, whatever the index believed.
      assert.strictEqual(await api.createNote(uri, 'Existing'), wikiFile('Existing.md').fsPath);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'wiki', 'Existing.md'), 'utf8'), 'keep me\n');
      fs.mkdirSync(path.join(dir, 'wiki', 'Taken.md'));
      assert.strictEqual(await api.createNote(uri, 'Taken'), undefined, 'a folder of that name is in the way');
      assert.ok(fs.statSync(path.join(dir, 'wiki', 'Taken.md')).isDirectory());
      assert.strictEqual(await api.createNote(uri, '../Escape'), undefined);
    });

    test('turning wiki links off forgets the notes and brings the plain behaviour back', async () => {
      const { uri } = await open('wiki/Checks.md');
      await until(() => linkProblems(uri).length === 5, 'the findings while it is on');
      assert.ok((await api.noteIndexState()).notes > 0);
      await setting(false);
      await until(async () => {
        const index = await api.noteIndexState();
        return index.notes === 0 && index.parsed === 0 && !index.started && index.looseFolders === 0;
      }, 'the index to be emptied');
      await until(async () => {
        const s = await api.state(uri);
        return s && s.rendered.wikiLinks === 0 && s.brokenLinks.length === 0 && linkProblems(uri).length === 0;
      }, 'double brackets to be text again');
      assert.strictEqual(await api.resolveNote(uri, 'Target'), 'missing');
      assert.strictEqual((await api.noteIndexState()).started, false);
    });
  });

  test('is offered for Markdown files but does not take over as the default', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'notes', 'other.md'));
    await vscode.commands.executeCommand('vscode.open', uri);
    assert.ok(vscode.window.activeTextEditor, 'a plain open uses the text editor');
    assert.strictEqual(api.sessionCount(uri), 0);
  });
});
