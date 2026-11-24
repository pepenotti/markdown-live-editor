// "Email Document…": the rendered document goes to the clipboard as formatted text, a new
// message is opened in the mail app with the subject filled in, and the user pastes.
// "Copy as Formatted Text" is the same copy without the mail app, for pasting anywhere.
//
// It is done this way because a `mailto:` link can carry neither formatting nor an
// attachment, and mail apps cut long links off. So the link holds the subject and a short
// note only (see src/shared/mailto.ts), never the document.
//
// Formatted text can only be put on the clipboard by a page, not by the extension host,
// so it is copied by a Seamless Markdown editor that has the document open. Without one,
// or when that copy fails, the Markdown text is copied instead and the user is told.
import * as vscode from 'vscode';
import { isSafeMailto, mailtoLink } from '../shared/mailto';
import { wikiHrefs } from './export';
import type { Session } from './markdownEditorProvider';
import type { NoteIndex } from './notes';
import { renderer } from './renderer';
import { ui } from './ui';

export interface EmailContext {
  /** An editor of ours that shows the document and can copy formatted text, if there is one. */
  session?: Session;
  /** Whether that editor is the one the user is working in, so that its selection counts. */
  useSelection: boolean;
  notes?: NoteIndex;
  /** Opens the file in the Seamless Markdown editor (offered when formatting needed one). */
  openInEditor(uri: vscode.Uri): Thenable<unknown>;
}

const OPEN_EDITOR = 'Open in Seamless Markdown';

function fileStem(document: vscode.TextDocument): string {
  const name = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);
  return name.replace(/\.[^.]+$/, '') || 'Document';
}

function leftOut(images: number, diagrams: number, carrier: string): string {
  const parts = [];
  if (images) parts.push(images === 1 ? '1 local image' : `${images} local images`);
  if (diagrams) parts.push(diagrams === 1 ? '1 diagram' : `${diagrams} diagrams`);
  if (!parts.length) return '';
  return ` Left out, because ${carrier} cannot carry ${images + diagrams === 1 ? 'it' : 'them'}: ${parts.join(' and ')}.`;
}

interface Copy {
  how: 'formatted' | 'plain';
  /** Why formatted text could not be copied, when an editor tried. */
  why: string;
  /** "the selection" or "the document". */
  what: string;
  title: string;
  omittedImages: number;
  omittedDiagrams: number;
}

/**
 * Puts the document (or the selection in the editor) on the clipboard as formatted text, with
 * the Markdown as its plain text, or as the Markdown alone when no editor of ours can copy.
 */
async function copyForPasting(document: vscode.TextDocument, context: EmailContext): Promise<Copy> {
  const { session } = context;
  const whole = document.getText();
  const selected = session && context.useSelection ? await session.selectedText() : '';
  const text = selected || whole;
  const render = renderer();
  // Pasted text has no folder next to it, so a note has nowhere to link to: wiki links are their text.
  const email = render.renderEmail(text, { wikiLinks: await wikiHrefs(document, text, context.notes, false) });
  // The title of the document, even when only a part of it is copied.
  const title = (selected ? render.renderMarkdown(whole).title : email.title) || fileStem(document);
  let how: Copy['how'] = 'plain';
  let why = '';
  if (session) {
    const result = await session.copyRich(email.html, text);
    if (result.ok) how = 'formatted';
    else why = result.error;
  }
  if (how === 'plain') await vscode.env.clipboard.writeText(text);
  return { how, why, what: selected ? 'the selection' : 'the document', title, omittedImages: email.omittedImages, omittedDiagrams: email.omittedDiagrams };
}

/** Says how a copy went when it is not formatted text; `paste` says where to paste it. */
function reportPlain(copy: Copy, context: EmailContext, document: vscode.TextDocument, paste: string, command: string): void {
  if (context.session) {
    void ui.error(`Formatted text could not be copied (${copy.why}), so ${copy.what} was copied as Markdown text instead.${paste} For formatted text, click into the editor and choose ${command} from its Export menu.`);
  } else {
    void ui
      .info(`Copied ${copy.what} as Markdown text, without formatting: formatted text can only be copied from the Seamless Markdown editor.${paste}`, OPEN_EDITOR)
      .then((choice) => {
        if (choice === OPEN_EDITOR) void context.openInEditor(document.uri);
      });
  }
}

/**
 * Copies the document (or the selection in the editor) for pasting anywhere: a mail, a
 * document, a chat. Returns how it was copied. Never silent.
 */
export async function copyFormatted(document: vscode.TextDocument, context: EmailContext): Promise<'formatted' | 'plain'> {
  const copy = await copyForPasting(document, context);
  if (copy.how === 'formatted') void ui.info(`Copied ${copy.what} as formatted text.${leftOut(copy.omittedImages, copy.omittedDiagrams, 'pasted text')}`);
  else reportPlain(copy, context, document, '', 'Copy as Formatted Text');
  return copy.how;
}

/**
 * Copies the document (or the selection in the editor) for a mail and opens a new message.
 * Returns how it was copied, or undefined when no message could be opened. Never silent:
 * every way out shows what happened.
 */
export async function emailDocument(document: vscode.TextDocument, context: EmailContext): Promise<'formatted' | 'plain' | undefined> {
  // 1. The clipboard, before the mail app takes the focus away.
  const copy = await copyForPasting(document, context);

  // 2. The new message. Only ever a mailto link, built from the title and the address in the settings.
  const to = vscode.workspace.getConfiguration('seamlessMarkdown.email').get<string>('to', '');
  const link = mailtoLink(copy.title, typeof to === 'string' ? to : '');
  const opened = isSafeMailto(link) && (await ui.open(link));

  // 3. What happened.
  const paste = opened ? 'Paste it into the new email.' : 'No mail app could be opened; paste it into a new email yourself.';
  if (copy.how === 'formatted') void ui.info(`Copied as formatted text. ${paste}${leftOut(copy.omittedImages, copy.omittedDiagrams, 'a pasted mail')}`);
  else reportPlain(copy, context, document, ` ${paste}`, 'Email Document');
  return opened ? copy.how : undefined;
}
