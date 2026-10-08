// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ExportAction } from '../../src/shared/protocol';
import { createToolbar } from '../../src/webview/ui/toolbar';

describe('the Export menu of the toolbar', () => {
  afterEach(() => document.body.replaceChildren());

  function setUp() {
    const asked: ExportAction[] = [];
    const toolbar = createToolbar(() => {}, false, (action) => asked.push(action));
    document.body.append(toolbar.dom);
    const button = toolbar.dom.querySelector<HTMLButtonElement>('.mdl-export')!;
    const menu = () => document.querySelector<HTMLElement>('.mdl-menu');
    const item = (action: ExportAction) => menu()!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    return { asked, toolbar, button, menu, item };
  }

  it('offers the three actions and tells the host which one was chosen', () => {
    const { asked, toolbar, button, menu, item } = setUp();
    toolbar.setExport(true, '');
    expect(button.textContent).toBe('Export');
    expect(menu()).toBeNull();
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect([...menu()!.querySelectorAll('[role=menuitem] > span')].map((e) => e.textContent)).toEqual(['Export as HTML…', 'Export as PDF…', 'Copy as HTML']);
    item('html').click();
    expect(asked).toEqual(['html']);
    // Choosing closes the menu.
    expect(menu()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    item('pdf').click();
    button.click();
    item('copyHtml').click();
    expect(asked).toEqual(['html', 'pdf', 'copyHtml']);
  });

  it('shows the PDF entry disabled with the reason while no browser can print', () => {
    const { asked, toolbar, button, menu, item } = setUp();
    toolbar.setExport(false, 'Needs Chrome, Edge, Chromium or Brave to be installed.');
    button.click();
    const pdf = item('pdf');
    expect(pdf.getAttribute('aria-disabled')).toBe('true');
    expect(pdf.querySelector('small')!.textContent).toBe('Needs Chrome, Edge, Chromium or Brave to be installed.');
    expect(pdf.querySelector('small')!.hidden).toBe(false);
    pdf.click();
    expect(asked).toEqual([]);
    expect(menu()).not.toBeNull();
    // The other entries still work, and the entry comes back when a browser is found.
    expect(item('html').getAttribute('aria-disabled')).not.toBe('true');
    toolbar.setExport(true, '');
    expect(pdf.getAttribute('aria-disabled')).toBe('false');
    expect(pdf.querySelector('small')!.hidden).toBe(true);
    pdf.click();
    expect(asked).toEqual(['pdf']);
  });

  it('closes on Escape, on a click elsewhere and with the toolbar, and is usable from the keyboard', () => {
    const { asked, toolbar, button, menu, item } = setUp();
    toolbar.setExport(false, 'no browser');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(item('html'));
    // The disabled entry is skipped.
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(item('copyHtml'));
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(item('html'));
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);

    button.click();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).toBeNull();
    button.click();
    button.click();
    expect(menu()).toBeNull();
    button.click();
    toolbar.setVisible(false);
    expect(menu()).toBeNull();
    expect(asked).toEqual([]);
  });
});
