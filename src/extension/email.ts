// "Email Document…": the rendered document goes to the clipboard as formatted text, a new
// message is opened in the mail app with the subject filled in, and the user pastes.
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

function leftOut(images: number, diagrams: number): string {
  const parts = [];
  if (images) parts.push(images === 1 ? '1 local image' : `${images} local images`);
  if (diagrams) parts.push(diagrams === 1 ? '1 diagram' : `${diagrams} diagrams`);
  if (!parts.length) return '';
  return ` Left out, because a pasted mail cannot carry ${images + diagrams === 1 ? 'it' : 'them'}: ${parts.join(' and ')}.`;
}

/**
 * Copies the document (or the selection in the editor) for a mail and opens a new message.
 * Returns how it was copied, or undefined when no message could be opened. Never silent:
 * every way out shows what happened.
 */
export async function emailDocument(document: vscode.TextDocument, context: EmailContext): Promise<'formatted' | 'plain' | undefined> {
  const { session } = context;
  const whole = document.getText();
  const selected = session && context.useSelection ? await session.selectedText() : '';
  const text = selected || whole;
  const render = renderer();
  // In a mail a note has nowhere to link to, so wiki links are their text.
  const email = render.renderEmail(text, { wikiLinks: await wikiHrefs(document, text, context.notes, false) });
  // The subject is the title of the document even when only a part of it is sent.
  const title = (selected ? render.renderMarkdown(whole).title : email.title) || fileStem(document);

  // 1. The clipboard, before the mail app takes the focus away.
  let copied: 'formatted' | 'plain' = 'plain';
  let why = '';
  if (session) {
    const result = await session.copyRich(email.html, text);
    if (result.ok) copied = 'formatted';
    else why = result.error;
  }
  if (copied === 'plain') await vscode.env.clipboard.writeText(text);

  // 2. The new message. Only ever a mailto link, built from the title and the address in the settings.
  const to = vscode.workspace.getConfiguration('seamlessMarkdown.email').get<string>('to', '');
  const link = mailtoLink(title, typeof to === 'string' ? to : '');
  const opened = isSafeMailto(link) && (await ui.open(link));

  // 3. What happened.
  const what = selected ? 'the selection' : 'the document';
  const paste = opened ? 'Paste it into the new email.' : 'No mail app could be opened; paste it into a new email yourself.';
  if (copied === 'formatted') {
    void ui.info(`Copied as formatted text. ${paste}${leftOut(email.omittedImages, email.omittedDiagrams)}`);
  } else if (session) {
    void ui.error(`Formatted text could not be copied (${why}), so ${what} was copied as Markdown text instead. ${paste} For formatted text, click into the editor and choose Email Document from its Export menu.`);
  } else {
    void ui
      .info(`Copied ${what} as Markdown text, without formatting: formatted text can only be copied from the Seamless Markdown editor. ${paste}`, OPEN_EDITOR)
      .then((choice) => {
        if (choice === OPEN_EDITOR) void context.openInEditor(document.uri);
      });
  }
  return opened ? copied : undefined;
}
