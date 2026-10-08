// Reading and rewriting the attributes of an HTML tag kept as text, such as `<img …>`.

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'", '#39': "'" };

function decode(value: string): string {
  return value.replace(/&(amp|quot|lt|gt|apos|#39);/g, (_, name: string) => ENTITIES[name]);
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pattern(name: string): RegExp {
  return new RegExp(`(\\s${name}\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
}

/** Value of an attribute, or '' when the tag does not have it. */
export function getAttr(tag: string, name: string): string {
  const m = pattern(name).exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/** The tag with one attribute changed or added; everything else stays as written. */
export function setAttr(tag: string, name: string, value: string): string {
  const quoted = `"${escapeAttr(value)}"`;
  const m = pattern(name).exec(tag);
  if (m) return tag.slice(0, m.index) + m[1] + quoted + tag.slice(m.index + m[0].length);
  const close = /\s*\/?>$/.exec(tag);
  const at = close ? close.index : tag.length;
  return `${tag.slice(0, at)} ${name}=${quoted}${tag.slice(at)}`;
}

/** Finds `<img>` tags in a piece of HTML. Create a new one per use: it keeps state. */
export const imgTags = (): RegExp => /<img\b[^>]*>/gi;

/** True when the text is one `<img>` tag and nothing else. */
export function isLoneImg(text: string): boolean {
  return /^<img\b[^>]*>$/i.test(text);
}
