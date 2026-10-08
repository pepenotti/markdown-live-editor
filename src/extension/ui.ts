// The dialogs and notifications of the export, behind one object so the integration tests
// can answer the save dialog and read what was shown while the real code path runs.
import * as vscode from 'vscode';

export interface Ui {
  save(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  info(message: string, ...actions: string[]): Thenable<string | undefined>;
  error(message: string, ...actions: string[]): Thenable<string | undefined>;
  progress<T>(title: string, work: () => Promise<T>): Thenable<T>;
  /** Hands a link to the operating system. Resolves to false when nothing could open it. */
  open(link: string): Thenable<boolean>;
}

const real: Ui = {
  save: (options) => vscode.window.showSaveDialog(options),
  info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
  error: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
  progress: (title, work) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work),
  // Given as text on purpose: VS Code then hands the link on exactly as it is, where a Uri
  // object would be taken apart and put together again with different escaping.
  open: (link) => vscode.env.openExternal(link as unknown as vscode.Uri),
};

export const ui: Ui = { ...real };

export interface UiRecord {
  kind: 'save' | 'info' | 'error' | 'progress' | 'open';
  text: string;
  actions: string[];
}

export interface UiStub {
  /** Everything shown since the last `reset`. */
  log: UiRecord[];
  /** Answers for the next save dialogs, in order; with none left a dialog is cancelled. */
  saveAnswers: (vscode.Uri | undefined)[];
  /** Buttons to press on the next notifications that offer them, in order. */
  choices: string[];
  /** Makes `open` report that nothing could open the link. */
  openFails: boolean;
  reset(): void;
}

/** Replaces the dialogs with recorded ones. Only the integration tests call this. */
export function stubUi(): UiStub {
  const stub: UiStub = {
    log: [],
    saveAnswers: [],
    choices: [],
    openFails: false,
    reset() {
      stub.log.length = 0;
      stub.saveAnswers.length = 0;
      stub.choices.length = 0;
      stub.openFails = false;
    },
  };
  const notify = (kind: 'info' | 'error') => async (message: string, ...actions: string[]) => {
    stub.log.push({ kind, text: message, actions });
    const choice = stub.choices[0];
    return choice !== undefined && actions.includes(choice) ? stub.choices.shift() : undefined;
  };
  ui.save = async (options) => {
    stub.log.push({ kind: 'save', text: options.defaultUri?.fsPath ?? '', actions: Object.keys(options.filters ?? {}) });
    return stub.saveAnswers.shift();
  };
  ui.info = notify('info');
  ui.error = notify('error');
  ui.open = async (link) => {
    stub.log.push({ kind: 'open', text: link, actions: [] });
    return stub.openFails ? false : true;
  };
  ui.progress = async (title, work) => {
    stub.log.push({ kind: 'progress', text: title, actions: [] });
    return work();
  };
  return stub;
}
