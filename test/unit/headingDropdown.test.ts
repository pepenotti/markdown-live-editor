// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createToolbar } from '../../src/webview/ui/toolbar';

describe('the paragraph style drop-down of the toolbar', () => {
  afterEach(() => document.body.replaceChildren());

  function setUp(level = 0) {
    const ran: [string, unknown][] = [];
    const toolbar = createToolbar((id, arg) => ran.push([id, arg]), false);
    document.body.append(toolbar.dom);
    toolbar.setHeading(level);
    const button = toolbar.dom.querySelector<HTMLButtonElement>('.mdl-heading')!;
    const list = () => document.querySelector<HTMLElement>('[role="listbox"]');
    const options = () => [...list()!.querySelectorAll<HTMLElement>('[role="option"]')];
    const active = () => options().findIndex((o) => o.classList.contains('mdl-menu-active'));
    const key = (target: EventTarget, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const mouseClick = () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    return { ran, toolbar, button, list, options, active, key, mouseClick };
  }

  it('is a button that shows the style of the current line and announces a list box', () => {
    const { toolbar, button, list } = setUp(2);
    expect(button.tagName).toBe('BUTTON');
    expect(button.querySelector('.mdl-heading-value')!.textContent).toBe('Heading 2');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Its name says what it is and what it is set to.
    const name = button
      .getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ');
    expect(name).toBe('Paragraph style Heading 2');
    expect(list()).toBeNull();
    toolbar.setHeading(0);
    expect(button.querySelector('.mdl-heading-value')!.textContent).toBe('Text');
  });

  it('opens with a click on the current style, and choosing another applies it', () => {
    const { ran, button, list, options, active, mouseClick } = setUp(1);
    mouseClick();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(list()!.getAttribute('aria-label')).toBe('Paragraph style');
    expect(options().map((o) => o.textContent)).toEqual(['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false', 'false', 'false', 'false']);
    expect(active()).toBe(1);
    // Opened with the mouse, the keyboard stays where it was (in the text, keeping its selection).
    expect(list()!.contains(document.activeElement)).toBe(false);
    options()[3].click();
    expect(list()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(ran).toEqual([
      ['heading', 3],
      ['focus', undefined],
    ]);
  });

  it('does nothing to the text when the current style is chosen, and Text removes the heading', () => {
    const { ran, options, mouseClick } = setUp(2);
    mouseClick();
    options()[2].click();
    expect(ran).toEqual([['focus', undefined]]);
    mouseClick();
    options()[0].click();
    // The heading command toggles: asking for the current level again takes it away.
    expect(ran).toEqual([
      ['focus', undefined],
      ['heading', 2],
      ['focus', undefined],
    ]);
  });

  it('works from the keyboard: Down opens, arrows, Home, End and letters move, Enter picks', () => {
    const { ran, button, list, options, active, key } = setUp(0);
    button.focus();
    key(button, 'ArrowDown');
    expect(list()).not.toBeNull();
    expect(document.activeElement).toBe(options()[0]);
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(options()[2]);
    key(document.activeElement!, 'End');
    expect(active()).toBe(6);
    // A list box stops at the ends.
    key(document.activeElement!, 'ArrowDown');
    expect(active()).toBe(6);
    key(document.activeElement!, 'Home');
    expect(active()).toBe(0);
    key(document.activeElement!, 'ArrowUp');
    expect(active()).toBe(0);
    // A letter goes to the next entry starting with it.
    key(document.activeElement!, 'h');
    expect(active()).toBe(1);
    key(document.activeElement!, 'h');
    expect(active()).toBe(2);
    key(document.activeElement!, 't');
    expect(active()).toBe(0);
    key(document.activeElement!, 'h');
    expect(document.activeElement).toBe(options()[1]);
    // Enter on the focused option clicks it, as on any button.
    (document.activeElement as HTMLElement).click();
    expect(ran).toEqual([
      ['heading', 1],
      ['focus', undefined],
    ]);
    expect(list()).toBeNull();
  });

  it('opens from Enter or Space on the focused option, and Escape gives the focus back to the button', () => {
    const { ran, button, list, options, key } = setUp(3);
    button.focus();
    // Enter and Space click a focused button; that click has no detail.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement).toBe(options()[3]);
    key(document.activeElement!, 'Escape');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(ran).toEqual([]);
  });

  it('takes the keys while open from the mouse, so they do not reach the text', () => {
    const { ran, list, active, key, mouseClick } = setUp(0);
    const text = document.createElement('div');
    text.tabIndex = 0;
    document.body.append(text);
    text.focus();
    const reached: string[] = [];
    text.addEventListener('keydown', (e) => reached.push(e.key));
    mouseClick();
    expect(document.activeElement).toBe(text);
    key(text, 'ArrowDown');
    key(text, 'ArrowDown');
    expect(active()).toBe(2);
    key(document.activeElement!, 'x');
    key(document.activeElement!, 'Enter');
    expect(reached).toEqual([]);
    expect(list()).toBeNull();
    expect(ran).toEqual([
      ['heading', 2],
      ['focus', undefined],
    ]);
    // Escape closes it without moving the focus out of the text.
    text.focus();
    mouseClick();
    key(text, 'Escape');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(text);
    // The arrows move the keyboard into the list; Escape then hands it to the button.
    mouseClick();
    key(text, 'ArrowUp');
    expect(active()).toBe(0);
    expect(list()!.contains(document.activeElement)).toBe(true);
    expect(reached).toEqual([]);
    key(document.activeElement!, 'Escape');
    expect(list()).toBeNull();
    // Closed, keys go to the text again.
    text.focus();
    key(text, 'a');
    expect(reached).toEqual(['a']);
  });

  it('keeps the selection: pressing the button or an entry does not take the focus', () => {
    const { button, options, mouseClick } = setUp(0);
    const press = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(press(button)).toBe(false);
    mouseClick();
    expect(press(options()[1])).toBe(false);
  });

  it('closes on a click elsewhere and when the toolbar is hidden', () => {
    const { toolbar, list, mouseClick } = setUp(0);
    mouseClick();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(list()).toBeNull();
    mouseClick();
    toolbar.setVisible(false);
    expect(list()).toBeNull();
  });
});
