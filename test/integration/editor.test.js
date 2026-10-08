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
    const written = await vscode.commands.executeCommand('seamlessMarkdown.exportHtml', target);
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
      await vscode.commands.executeCommand('seamlessMarkdown.exportHtml', target);
      const linked = fs.readFileSync(target.fsPath, 'utf8');
      assert.ok(linked.includes('<img src="assets/diagram.svg" alt="The pipeline">'), 'images keep their relative paths');
      assert.ok(!linked.includes('src="data:'), 'nothing is embedded');
    } finally {
      await settings.update('embedImages', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.strictEqual(vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()).isDirty, false);
  });

  test('exports math as MathML and, by default, a diagram as its source', async () => {
    await open('diagrams.md');
    const target = vscode.Uri.file(path.join(dir, 'diagrams-export.html'));
    await vscode.commands.executeCommand('seamlessMarkdown.exportHtml', target);
    const html = fs.readFileSync(target.fsPath, 'utf8');
    assert.strictEqual((html.match(/<math /g) || []).length, 3, 'three formulas');
    assert.ok(html.includes('<div class="math-block"><span class="katex"><math '), 'block math');
    assert.ok(html.includes('a price like $5 or $10 stays a price'), 'prices are not math');
    assert.ok(html.includes('<pre><code class="language-mermaid">flowchart LR'), 'the diagram is a code block');
    assert.ok(!html.includes('<script'), 'no script without the CDN setting');

    const settings = vscode.workspace.getConfiguration('seamlessMarkdown.export');
    try {
      await settings.update('mermaidFromCdn', true, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('seamlessMarkdown.exportHtml', target);
      const drawn = fs.readFileSync(target.fsPath, 'utf8');
      assert.ok(drawn.includes('<pre class="mermaid">flowchart LR'), 'the diagram is left for Mermaid to draw');
      assert.ok(/<script type="module">\s*import mermaid from 'https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\//.test(drawn), 'Mermaid comes from the CDN');
    } finally {
      await settings.update('mermaidFromCdn', undefined, vscode.ConfigurationTarget.Global);
    }
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
