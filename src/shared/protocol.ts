// Messages exchanged between the extension host and the webview editor.
import type { TocOptions } from './toc';

export type Mode = 'raw' | 'half' | 'full';
export const MODES: readonly Mode[] = ['raw', 'half', 'full'];
export const MODE_LABELS: Record<Mode, string> = {
  raw: 'Raw',
  half: 'Half preview',
  full: 'Full preview',
};

export const VIEW_TYPE = 'seamlessMarkdown.editor';

export interface EditorConfig {
  defaultMode: Mode;
  /** Maximum width of the text column in px for the preview modes. 0 means no limit. */
  lineWidth: number;
  fontSize: number;
  fontFamily: string;
  showToolbar: boolean;
  /** Re-pad the pipes of a table whenever one of its cells is edited. */
  tableAutoAlign: boolean;
  /** Convert formatted clipboard content (text/html) to Markdown when pasting. */
  pasteRichText: boolean;
  /** Extra CSS rules applied to the editor. */
  customCss: string;
  /** Which headings a table of contents lists, and how. */
  toc: TocOptions;
  /** Turn on the browser's spell checking for the text. */
  spellCheck: boolean;
}

/**
 * One replaced range. Every position refers to the document as it was before the
 * edit, so several changes in one message never shift each other.
 * Offsets count LF-normalised text; line/character pairs are valid for any EOL.
 */
export interface TextChange {
  from: number;
  to: number;
  fromLine: number;
  fromCh: number;
  toLine: number;
  toCh: number;
  /** Replacement text using LF line breaks. */
  insert: string;
}

export type CommandId =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'image'
  | 'table'
  | 'codeBlock'
  | 'rule'
  | 'toc'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'toggleTask'
  | 'quote'
  | 'heading'
  | 'headingUp'
  | 'headingDown'
  | 'find'
  | 'setMode'
  | 'cycleMode'
  | 'revealLine'
  | 'revealAnchor'
  | 'insertImagePaths'
  | 'focus';

export type HostMessage =
  | {
      type: 'init';
      text: string;
      epoch: number;
      mode: Mode;
      config: EditorConfig;
      /** Webview URI of the folder that contains the document, without a trailing slash. */
      baseUri: string;
      /** Webview URI of the workspace folder, used for paths that start with "/". */
      rootUri: string | null;
      isMac: boolean;
      /** Set by the integration tests. Unlocks `debugType`. */
      test?: boolean;
    }
  | { type: 'sync'; text: string; epoch: number }
  | { type: 'patch'; from: number; to: number; insert: string; epoch: number; reason?: 'undo' | 'redo' }
  | { type: 'command'; id: CommandId; arg?: unknown }
  | { type: 'config'; config: EditorConfig }
  | { type: 'flush'; reqId: number }
  | { type: 'debugRequest'; reqId: number }
  /**
   * For the integration tests: types text at the cursor the way a keyboard would, so it
   * waits in the typing burst. Ignored unless the session was started with `test`.
   */
  | { type: 'debugType'; text: string }
  | { type: 'selectionRequest'; reqId: number }
  | { type: 'response'; reqId: number; ok: boolean; data?: unknown; error?: string };

export type RequestKind = 'saveImage' | 'listFiles' | 'pickImage' | 'resolveUris';

export interface SaveImagePayload {
  name: string;
  base64: string;
}
export interface ListFilesPayload {
  imagesOnly: boolean;
}
export interface ResolveUrisPayload {
  uris: string[];
}
export interface LinkedFile {
  /** Path relative to the document, already encoded for use inside a Markdown link. */
  path: string;
  isImage: boolean;
  name: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; epoch: number; changes: TextChange[] }
  | { type: 'flushed'; reqId: number }
  | { type: 'focus'; focused: boolean }
  | { type: 'modeChanged'; mode: Mode }
  | { type: 'stats'; words: number; chars: number; selWords: number }
  | { type: 'openLink'; href: string }
  | { type: 'request'; reqId: number; kind: RequestKind; payload?: unknown }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'selectionState'; reqId: number; text: string }
  | {
      type: 'debugState';
      reqId: number;
      text: string;
      mode: Mode;
      epoch: number;
      problems: string[];
      /** How many diagrams and formulas are drawn on screen, and how many diagrams failed. */
      rendered: { diagrams: number; diagramErrors: number; math: number };
    };

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico'];

export function isImagePath(path: string): boolean {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(path);
  return !!m && IMAGE_EXTENSIONS.includes(m[1].toLowerCase());
}
