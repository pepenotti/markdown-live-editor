// The `mailto:` link that "Email Document…" opens. It carries a subject and a short note to
// paste, never the document: a link like this can only hold plain text, and mail apps cut
// long ones off.
//
// Everything that comes from outside (the title of a document, the address in the
// settings) is cleaned and then percent-encoded as a whole, so it can only ever be the
// value of the field it was meant for. A title such as `x&bcc=someone@example.com` or one
// with a line break in it cannot add a recipient, a header or an attachment.

/** Longest subject, in characters, before it is cut. */
export const MAX_SUBJECT = 120;
/** No link built here is longer than this. Mail apps start to truncate around 2000. */
export const MAX_LINK = 700;
export const PASTE_HINT = '(Paste here)';
const MAX_ENCODED_SUBJECT = 400;

/** One line of text without control characters, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const clean = text
    .replace(/[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : clean;
}

/** A plain address: one `@`, and none of the characters that mean something in a link or a header. */
const ADDRESS = /^[A-Za-z0-9.!#$*+/=^_`{|}~'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * The addresses in a "to" setting (separated by commas or semicolons) that are plain
 * addresses. Anything else is left out: a display name, a `?`, or a line break.
 */
export function recipients(setting: string): string[] {
  return setting
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length <= 254 && ADDRESS.test(part) && !/[?&%]/.test(part))
    .slice(0, 20);
}

const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** The link for a new message with this subject, to the addresses of the setting if there are any. */
export function mailtoLink(subject: string, to = ''): string {
  // An address is encoded too; the `@` is put back because some mail apps do not decode it.
  // Letters outside ASCII take up to nine characters each once encoded, so the subject is
  // also held to a length in the link, not only to a number of letters.
  let title = oneLine(subject, MAX_SUBJECT);
  while (encode(title).length > MAX_ENCODED_SUBJECT) title = oneLine(title, [...title].length - 1);
  const build = (addresses: string[]) => `mailto:${addresses.map((a) => encode(a).replace(/%40/g, '@')).join(',')}?subject=${encode(title)}&body=${encode(PASTE_HINT)}`;
  let addresses = recipients(to);
  let link = build(addresses);
  // A subject is at most a few hundred bytes; only a long list of addresses can make the link too long.
  while (link.length > MAX_LINK && addresses.length) {
    addresses = addresses.slice(0, -1);
    link = build(addresses);
  }
  return link;
}

/** True for a link this module could have built: `mailto:`, one line, of bounded length, with only the two fields. */
export function isSafeMailto(link: string): boolean {
  return link.length <= MAX_LINK && /^mailto:[A-Za-z0-9.!#$*+/=^_`{|}~'@,%-]*\?subject=[A-Za-z0-9._~%-]*&body=[A-Za-z0-9._~%-]*$/.test(link);
}
