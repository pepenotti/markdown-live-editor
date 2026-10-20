// GitHub alerts in the editor (which quotes are alerts, the box and the title), and the
// harness's VS Code theme loader that the colour checks rely on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { cssVariable, kindOf, loadThemeColors, parseJsonc, resolveColors } from '../../harness/vscodeTheme.js';
import { alertKindOfLine, alertTitle } from '../../src/shared/alerts';
import type { Mode } from '../../src/shared/protocol';
import { blockField } from '../../src/webview/decorations/blocks';
import { collectInline, lineAtoms } from '../../src/webview/decorations/inline';
import { modeField } from '../../src/webview/modes';
import { AlertLabelWidget } from '../../src/webview/widgets/simple';
import { stateOf } from './helpers';

const editor = (doc: string, mode: Mode) => stateOf(doc, [modeField.init(() => mode), blockField]);

/** The classes of each line's decoration, by line number (1-based). */
function lineClasses(doc: string, mode: Mode = 'full'): Record<number, string> {
  const state = editor(doc, mode);
  const out: Record<number, string> = {};
  for (const d of collectInline(state, [{ from: 0, to: state.doc.length }]).decorations) {
    const cls = d.value.spec.class as string | undefined;
    if (d.from === d.to && cls) {
      const n = state.doc.lineAt(d.from).number;
      out[n] = [out[n], cls].filter(Boolean).join(' ');
    }
  }
  return out;
}

function labels(doc: string, mode: Mode = 'full', cursor?: number): string[] {
  let state = editor(doc, mode);
  if (cursor !== undefined) state = state.update({ selection: EditorSelection.cursor(cursor) }).state;
  return collectInline(state, [{ from: 0, to: state.doc.length }])
    .decorations.map((d) => d.value.spec.widget)
    .filter((w) => w instanceof AlertLabelWidget)
    .map((w) => (w as AlertLabelWidget).kind);
}

describe('which quotes are alerts', () => {
  it('takes the five markers in any case, alone on the first line', () => {
    expect(alertKindOfLine('> [!NOTE]')).toBe('note');
    expect(alertKindOfLine('> [!tip]  ')).toBe('tip');
    expect(alertKindOfLine('>[!Important]')).toBe('important');
    expect(alertKindOfLine('   > [!WARNING]')).toBe('warning');
    expect(alertKindOfLine('> [!CAUTION]\t')).toBe('caution');
    expect(alertTitle('important')).toBe('Important');
  });

  it('does not take text after the marker, other words, or a nested quote, as GitHub does not', () => {
    expect(alertKindOfLine('> [!NOTE] Same line')).toBeUndefined();
    expect(alertKindOfLine('> [!INFO]')).toBeUndefined();
    expect(alertKindOfLine('> [! NOTE]')).toBeUndefined();
    expect(alertKindOfLine('> > [!NOTE]')).toBeUndefined();
    expect(alertKindOfLine('    > [!NOTE]')).toBeUndefined();
    expect(alertKindOfLine('[!NOTE]')).toBeUndefined();
  });
});

describe('alerts in the editor', () => {
  const doc = '> [!NOTE]\n> First paragraph.\n>\n> Second paragraph.\n\nAfter.';

  it('draws a box: every line tinted, the first and last carrying its edges', () => {
    const lines = lineClasses(doc);
    expect(lines[1]).toBe('cm-md-quote cm-md-alert cm-md-alert-note cm-md-alert-first');
    expect(lines[2]).toBe('cm-md-quote cm-md-alert cm-md-alert-note');
    expect(lines[3]).toBe('cm-md-quote cm-md-alert cm-md-alert-note');
    expect(lines[4]).toBe('cm-md-quote cm-md-alert cm-md-alert-note cm-md-alert-last');
    expect(lines[6]).toBeUndefined();
    expect(lineClasses('> [!TIP]')[1]).toBe('cm-md-quote cm-md-alert cm-md-alert-tip cm-md-alert-first cm-md-alert-last');
  });

  it('replaces the marker with the title, which the cursor steps over in full preview', () => {
    expect(labels(doc)).toEqual(['note']);
    expect(lineAtoms(editor(doc, 'full'), 0)).toEqual([
      { from: 0, to: 2, kind: 'leading' },
      { from: 2, to: 9, kind: 'inline' },
    ]);
  });

  it('shows the marker on the line with the cursor in half preview', () => {
    expect(labels(doc, 'half', 0)).toEqual([]);
    expect(labels(doc, 'half', doc.indexOf('Second'))).toEqual(['note']);
    // The box stays while the marker is being edited.
    expect(lineClasses(doc, 'half')[1]).toContain('cm-md-alert-first');
  });

  it('keeps lists and code inside the box', () => {
    const lines = lineClasses('> [!WARNING]\n> Steps:\n>\n> - one\n> - two\n>\n> ```js\n> let a = 1;\n> ```');
    for (let n = 1; n <= 9; n++) expect(lines[n], `line ${n}`).toContain('cm-md-alert-warning');
    expect(lines[9]).toContain('cm-md-alert-last');
  });

  it('hides the quote markers of code inside a quote, as on its other lines', () => {
    const code = '> [!NOTE]\n> x\n>\n> ```sh\n> npm test\n> ```\n';
    const state = editor(code, 'full');
    const line = code.indexOf('> npm');
    expect(lineAtoms(state, line)).toEqual([{ from: line, to: line + 2, kind: 'leading' }]);
    // In half preview the marker shows on the line with the cursor only.
    const half = editor(code, 'half').update({ selection: EditorSelection.cursor(line + 4) }).state;
    const marks = collectInline(half, [{ from: 0, to: half.doc.length }]).decorations.filter((d) => d.from === line);
    expect(marks.map((d) => d.value.spec.class)).toContain('cm-md-mark');
  });

  it('leaves other quotes plain, as GitHub does', () => {
    for (const text of ['> [!NOTE] Same line\n> more', '> > [!NOTE]\n> > x', '- > [!NOTE]\n  > x', '> text\n> [!NOTE]', '> [!NOPE]\n> x']) {
      expect(Object.values(lineClasses(text)).join(' '), text).not.toContain('alert');
      expect(labels(text), text).toEqual([]);
    }
  });
});

describe('the harness theme loader', () => {
  const themes = join(__dirname, '../../harness/themes');
  const load = (file: string) => loadThemeColors(pathToFileURL(join(themes, file)).href, async (url) => readFileSync(new URL(url), 'utf8'));

  it('reads theme files with comments and trailing commas', () => {
    expect(parseJsonc('{\n // note\n "a": "x//y", /* b */ "c": [1, 2,],\n}')).toEqual({ a: 'x//y', c: [1, 2] });
  });

  it('maps colour ids to the variables VS Code sets', () => {
    expect(cssVariable('editor.background')).toBe('--vscode-editor-background');
    expect(cssVariable('debugTokenExpression.name')).toBe('--vscode-debugTokenExpression-name');
    expect([kindOf('vs'), kindOf('vs-dark'), kindOf('hc-black'), kindOf('hc-light')]).toEqual(['light', 'dark', 'hcDark', 'hcLight']);
  });

  it('fills in VS Code defaults, following references and transparency', () => {
    const dark = resolveColors({ foreground: '#ffffff' }, 'dark');
    expect(dark['descriptionForeground']).toBe('#ffffffb3');
    expect(dark['debugTokenExpression.string']).toBe('#ce9178');
    expect(dark['contrastBorder']).toBeUndefined();
    const hc = resolveColors({}, 'hcDark');
    expect(hc['contrastBorder']).toBe('#6fc3df');
    expect(hc['contrastActiveBorder']).toBe('#f38518');
    expect(hc['editorWidget.border']).toBe('#6fc3df');
    expect(resolveColors({ 'editorInfo.foreground': '#123456' }, 'light')['notificationsInfoIcon.foreground']).toBe('#123456');
  });

  it('follows includes, and takes the editor colours from a theme rule without a scope', async () => {
    const modern = await load('dark_modern.json');
    expect(modern.colors['editor.background']).toBe('#1F1F1F');
    // Dark Modern includes Dark+, which includes Visual Studio Dark.
    expect(Object.keys(modern.colors).length).toBeGreaterThan(100);
    const solarized = await load('solarized-light-color-theme.json');
    expect(solarized.colors['editor.foreground']).toBe('#657B83');
  });

  it('lists every theme file it ships, with its kind', () => {
    const index = JSON.parse(readFileSync(join(themes, 'index.json'), 'utf8')) as { themes: { file: string; uiTheme: string }[] };
    for (const t of index.themes) {
      expect(() => parseJsonc(readFileSync(join(themes, t.file), 'utf8')), t.file).not.toThrow();
      expect(['vs', 'vs-dark', 'hc-black', 'hc-light']).toContain(t.uiTheme);
    }
  });
});
