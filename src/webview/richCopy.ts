// Putting formatted text on the clipboard. The extension host can only write plain text,
// so this is done here, in the page. Two ways, tried in this order:
//
// 1. The Clipboard API with a `ClipboardItem` that has a `text/html` and a `text/plain`
//    flavour. It needs the page to have the focus.
// 2. A copy command on a hidden selection, with a `copy` listener that fills in both
//    flavours. Older, but it also works where the API is not allowed.
import type { RichCopyResult } from '../shared/protocol';

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)) || 'unknown error';

async function withApi(html: string, text: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('the Clipboard API is not available');
  await navigator.clipboard.write([
    new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) }),
  ]);
}

function withCommand(html: string, text: string): void {
  const holder = document.createElement('div');
  holder.contentEditable = 'true';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
  holder.textContent = '.';
  let filled = false;
  const fill = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', text);
    // Nothing else on the page gets to put its own selection there instead.
    event.preventDefault();
    event.stopImmediatePropagation();
    filled = true;
  };
  document.body.append(holder);
  document.addEventListener('copy', fill, true);
  try {
    holder.focus();
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const done = document.execCommand('copy');
    if (!done || !filled) throw new Error('the copy command was refused');
  } finally {
    document.removeEventListener('copy', fill, true);
    holder.remove();
  }
}

async function attempt(html: string, text: string): Promise<RichCopyResult> {
  let first: string;
  try {
    await withApi(html, text);
    return { ok: true, how: 'api' };
  } catch (err) {
    first = reason(err);
  }
  try {
    withCommand(html, text);
    return { ok: true, how: 'command' };
  } catch (err) {
    return { ok: false, error: `${first}; ${reason(err)}` };
  }
}

/** Resolves once the page has the focus, or after `ms` without it. */
function focused(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.hasFocus()) return resolve(true);
    const done = () => {
      window.removeEventListener('focus', done);
      clearTimeout(timer);
      resolve(document.hasFocus());
    };
    const timer = setTimeout(done, ms);
    window.addEventListener('focus', done);
  });
}

export const NO_FOCUS = 'the editor does not have the keyboard focus';

/**
 * Copies `html` as formatted text with `text` as its plain-text flavour. Says how, or why not.
 *
 * A page may only write to the clipboard while it has the focus. When a command was run
 * from elsewhere (the Command Palette, a menu), the focus is on its way back to the editor
 * at this moment, so `takeFocus` asks for it and one more attempt is made once it is here.
 */
export async function copyRich(html: string, text: string, takeFocus: () => void = () => {}): Promise<RichCopyResult> {
  let result = await attempt(html, text);
  if (result.ok || document.hasFocus()) return result;
  takeFocus();
  if (await focused(1500)) result = await attempt(html, text);
  return result.ok || document.hasFocus() ? result : { ok: false, error: NO_FOCUS };
}

/** What is on the clipboard, as far as this page may read it (for the tests). */
export async function readClipboard(): Promise<{ types: string[]; html: string; text: string; error?: string }> {
  try {
    const items = await navigator.clipboard.read();
    const types = items.flatMap((item) => [...item.types]);
    const get = async (type: string) => {
      const item = items.find((i) => i.types.includes(type));
      return item ? await (await item.getType(type)).text() : '';
    };
    return { types, html: await get('text/html'), text: await get('text/plain') };
  } catch (err) {
    return { types: [], html: '', text: '', error: reason(err) };
  }
}
