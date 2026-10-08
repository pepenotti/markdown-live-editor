// HTML for pasting into an email. Mail programs drop `<style>` blocks, class names and
// scripts, and keep little more than elements with a `style` attribute, so every element
// carries its own look here. What a mail cannot show is replaced by something it can:
//
// - a local image becomes its alt text (the file is not in the mail);
// - a Mermaid diagram becomes a short note (its source would mean nothing to the reader);
// - math becomes its TeX source in a monospace font (MathML is stripped by web mail);
// - a link that only works next to the file (another note, a heading) becomes plain text;
// - a task checkbox becomes a ballot box character, a footnote reference a number in brackets.
//
// Pure code: a markdown-it plugin that is active only while a document is rendered for email.
import type { MarkdownIt, Token } from 'markdown-it';
import { isLocalSource } from './embed';
import { escapeHtml } from './highlight';

/** Counts what was left out while one document is rendered. */
export interface EmailState {
  images: number;
  diagrams: number;
}

const MONO = `font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;
const BORDER = '#d1d9e0';
const HEADING = 'margin:20px 0 10px;font-weight:600;line-height:1.25;color:#1f2328';

/** The whole fragment sits in one element that sets the font, since nothing can be inherited from a page. */
export const EMAIL_WRAPPER = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2328`;

const STYLE: Record<string, string> = {
  p: 'margin:0 0 12px',
  h1: `${HEADING};font-size:24px`,
  h2: `${HEADING};font-size:20px`,
  h3: `${HEADING};font-size:17px`,
  h4: `${HEADING};font-size:15px`,
  h5: `${HEADING};font-size:14px`,
  h6: `${HEADING};font-size:13px;color:#59636e`,
  a: 'color:#0969da;text-decoration:underline',
  code: `${MONO};font-size:90%;background-color:#eff1f3;padding:1px 4px;border-radius:3px`,
  pre: `${MONO};font-size:13px;line-height:1.45;background-color:#f6f8fa;padding:12px;border-radius:6px;margin:0 0 12px;white-space:pre-wrap;word-wrap:break-word`,
  blockquote: `margin:0 0 12px;padding:0 12px;border-left:4px solid ${BORDER};color:#59636e`,
  ul: 'margin:0 0 12px;padding-left:28px',
  ol: 'margin:0 0 12px;padding-left:28px',
  li: 'margin:2px 0',
  table: 'border-collapse:collapse;margin:0 0 12px',
  th: `border:1px solid ${BORDER};padding:6px 12px;background-color:#f6f8fa;font-weight:600`,
  td: `border:1px solid ${BORDER};padding:6px 12px`,
  hr: `border:0;border-top:1px solid ${BORDER};margin:16px 0`,
  img: 'max-width:100%;height:auto',
};

const ALERT_COLOR: Record<string, string> = { note: '#0969da', tip: '#1a7f37', important: '#8250df', warning: '#9a6700', caution: '#cf222e' };

/** Links that still work once the text is in somebody's inbox. */
const WORKS_IN_MAIL = /^(?:https?:\/\/|mailto:)/i;

const DROPPED_ELEMENTS = /<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi;
const DROPPED_TAGS = /<\/?(?:script|style|iframe|object|embed|noscript|template|link|meta|base|form|input|button|select|textarea)\b[^>]*>/gi;
const IMG_TAG = /<img\b[^>]*>/gi;

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined);

/** What a mail may contain of the document's own HTML. */
function cleanHtml(html: string, state: EmailState): string {
  return html
    .replace(DROPPED_ELEMENTS, '')
    .replace(DROPPED_TAGS, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(IMG_TAG, (tag) => {
      const src = attribute(tag, 'src') ?? '';
      if (!isLocalSource(src)) return tag;
      state.images++;
      // The attribute is HTML already; only what could open a tag is escaped.
      return imageNote((attribute(tag, 'alt') ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'), true);
    });
}

const imageNote = (alt: string, isHtml = false) => `<em style="color:#59636e">[Image${alt.trim() ? `: ${isHtml ? alt.trim() : escapeHtml(alt.trim())}` : ''}]</em>`;

function setStyle(token: Token, style: string): void {
  const own = token.attrGet('style');
  token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'style' && name !== 'class' && name !== 'id');
  token.attrPush(['style', own ? `${style};${String(own)}` : style]);
}

/**
 * Makes the renderer produce mail-ready HTML for documents where `stateOf` returns a state.
 * Has to be applied after every other plugin: it wraps their rendering rules.
 */
export function emailPlugin(md: MarkdownIt, stateOf: (env: unknown) => EmailState | undefined): void {
  md.core.ruler.push('email', (state) => {
    const email = stateOf(state.env);
    if (!email) return;
    const visit = (tokens: Token[]) => {
      /** For each open link: whether it was turned into plain text. */
      const links: boolean[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.children) visit(token.children);
        if (token.type === 'link_open') {
          const plain = !WORKS_IN_MAIL.test(String(token.attrGet('href') ?? ''));
          links.push(plain);
          if (plain) {
            token.tag = 'span';
            token.attrs = null;
            continue;
          }
        } else if (token.type === 'link_close') {
          if (links.pop()) token.tag = 'span';
          continue;
        } else if (token.type === 'image') {
          if (isLocalSource(String(token.attrGet('src') ?? ''))) {
            email.images++;
            const note = new state.Token('html_inline', '', 0);
            // Already mail-ready: must not be cleaned again as if it came from the document.
            note.content = imageNote(token.content);
            note.meta = { email: true };
            tokens[i] = note;
            continue;
          }
        } else if (token.type === 'html_inline' && /^<input type="checkbox" disabled/.test(token.content)) {
          token.content = token.content.includes(' checked') ? '☑ ' : '☐ ';
          token.meta = { email: true };
          continue;
        } else if (token.type === 'html_inline' && /^<strong class="alert-title">/.test(token.content)) {
          const kind = />(\w+)</.exec(token.content)?.[1] ?? '';
          token.content = `<strong style="color:${ALERT_COLOR[kind.toLowerCase()] ?? '#1f2328'}">${kind}</strong>`;
          token.meta = { email: true };
          continue;
        }
        if (token.nesting === -1 || !Object.hasOwn(STYLE, token.tag)) continue;
        let style = STYLE[token.tag];
        const alert = token.tag === 'blockquote' ? /\balert-(\w+)/.exec(String(token.attrGet('class') ?? ''))?.[1] : undefined;
        if (alert) style = `margin:0 0 12px;padding:8px 12px;border-left:4px solid ${ALERT_COLOR[alert] ?? BORDER}`;
        if (token.tag === 'ul' && /\bcontains-task-list\b/.test(String(token.attrGet('class') ?? ''))) style += ';list-style:none;padding-left:8px';
        // A fence or an indented block is one token with the tag "code"; it is rendered as a whole below.
        if (token.type !== 'fence' && token.type !== 'code_block') setStyle(token, style);
      }
    };
    visit(state.tokens);
  });

  const rules = md.renderer.rules;
  const wrap = (name: string, mail: (tokens: Token[], idx: number, email: EmailState) => string) => {
    const usual = rules[name];
    rules[name] = (tokens, idx, options, env, self) => {
      const email = stateOf(env);
      if (email) return mail(tokens, idx, email);
      return usual ? usual(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
  };
  const block = (text: string) => `<pre style="${STYLE.pre}">${escapeHtml(text.replace(/\n$/, ''))}</pre>\n`;
  wrap('fence', (tokens, idx, email) => {
    if (/^mermaid(?:\s|$)/i.test(tokens[idx].info.trim())) {
      email.diagrams++;
      return `<p style="${STYLE.p}"><em style="color:#59636e">[Diagram left out]</em></p>\n`;
    }
    return block(tokens[idx].content);
  });
  wrap('code_block', (tokens, idx) => block(tokens[idx].content));
  wrap('math_inline', (tokens, idx) => {
    const mark = tokens[idx].meta?.display === true ? '$$' : '$';
    return `<code style="${STYLE.code}">${escapeHtml(`${mark}${tokens[idx].content}${mark}`)}</code>`;
  });
  wrap('math_block', (tokens, idx) => block(tokens[idx].content));
  wrap('footnote_ref', (tokens, idx) => `<sup style="font-size:75%;line-height:0">[${(tokens[idx].meta as { number: number }).number}]</sup>`);
  wrap('html_block', (tokens, idx, email) => cleanHtml(tokens[idx].content, email));
  wrap('html_inline', (tokens, idx, email) => (tokens[idx].meta?.email ? tokens[idx].content : cleanHtml(tokens[idx].content, email)));
}

/** The numbered notes at the end of a mail. `items` are already rendered. */
export function emailFootnotes(items: readonly { number: number; html: string }[]): string {
  if (!items.length) return '';
  const list = items.map((item) => `<li style="${STYLE.li}" value="${item.number}">${item.html}</li>\n`).join('');
  return `<hr style="${STYLE.hr}">\n<ol style="${STYLE.ol};font-size:13px;color:#59636e">\n${list}</ol>\n`;
}
