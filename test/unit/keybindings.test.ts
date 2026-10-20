import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('keybindings', () => {
  it('apply whenever this editor has the keyboard, not only when the editor has reported its focus', () => {
    // The focus report is a message from the page and can lag or be lost; VS Code's own focus
    // keys tell when the keyboard is in the editor area. Undo depends on this: if the
    // extension's undo does not run, unsent typing is not handed over first.
    for (const binding of pkg.contributes.keybindings) {
      expect(binding.when, binding.command).toMatch(/^activeCustomEditorId == 'seamlessMarkdown\.editor' && \(seamlessMarkdown\.focus \|\| /);
      for (const part of ['!inputFocus', '!listFocus', '!editorTextFocus', '!terminalFocus', '!sideBarFocus', '!panelFocus']) {
        expect(binding.when, `${binding.command} ${part}`).toContain(part);
      }
    }
  });

  it('route undo, redo and save through the extension', () => {
    const commands = pkg.contributes.keybindings.map((b: { command: string }) => b.command);
    for (const c of ['seamlessMarkdown.undo', 'seamlessMarkdown.redo', 'seamlessMarkdown.save']) expect(commands).toContain(c);
  });
});
