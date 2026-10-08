// Values the rendering code needs that do not live in the document.
import { Facet } from '@codemirror/state';

export interface RenderConfig {
  /** Turns a Markdown image path into a URL the webview can load. */
  resolveUrl(src: string): string;
  /** Width of one monospace character divided by the font size. */
  monoRatio: number;
  tableAutoAlign: boolean;
  /** Let the browser check the spelling of the text. */
  spellCheck: boolean;
}

const DEFAULT: RenderConfig = { resolveUrl: (s) => s, monoRatio: 0.6, tableAutoAlign: true, spellCheck: false };

export const renderConfig = Facet.define<RenderConfig, RenderConfig>({
  combine: (values) => values[0] ?? DEFAULT,
});

/** Builds the path resolver from the folder URIs the host sends. */
export function makeResolver(baseUri: string, rootUri: string | null): (src: string) => string {
  const base = baseUri.replace(/\/+$/, '') + '/';
  const root = rootUri ? rootUri.replace(/\/+$/, '') + '/' : null;
  return (src) => {
    const s = src.trim();
    if (s === '') return '';
    if (/^(?:https?:|data:|blob:)/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
    try {
      if (s.startsWith('/')) return root ? new URL(s.replace(/^\/+/, ''), new URL(root, location.href)).href : '';
      return new URL(s, new URL(base, location.href)).href;
    } catch {
      return '';
    }
  };
}

/** Things the editor asks the host to do. */
export interface HostActions {
  openLink(href: string): void;
  /** Opens the note a wiki link names, or offers to create it. */
  openWikiLink(target: string, heading: string): void;
  /** Lets the user choose image files and returns paths relative to the document. */
  pickImages(): Promise<{ path: string; isImage: boolean; name: string }[]>;
}

export const hostActions = Facet.define<HostActions, HostActions>({
  combine: (values) => values[0] ?? { openLink: () => {}, openWikiLink: () => {}, pickImages: async () => [] },
});
