// Widgets for content that is drawn from its source: math (KaTeX) and Mermaid diagrams.
import { type EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import { revealBlock } from '../modes';

/** Shows the source of the rendered block this widget stands for, with the cursor inside it. */
function revealOnClick(dom: HTMLElement, view: EditorView): void {
  dom.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = view.posAtDOM(dom);
    const doc = view.state.doc;
    const first = doc.lineAt(pos);
    const inside = first.to < doc.length ? first.to + 1 : Math.min(doc.length, pos + 2);
    view.dispatch({ effects: revealBlock.of(pos), selection: { anchor: inside } });
    view.focus();
  });
}

export function renderMath(target: HTMLElement, tex: string, display: boolean): void {
  try {
    katex.render(tex, target, { displayMode: display, throwOnError: false, strict: 'ignore' });
  } catch (err) {
    target.textContent = err instanceof Error ? err.message : String(err);
    target.classList.add('cm-md-render-error');
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** A replaced block: clicking it shows the source. */
    readonly replaces = false,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.replaces === this.replaces;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement(this.display ? 'div' : 'span');
    dom.className = this.display ? 'cm-md-math cm-md-math-block' : 'cm-md-math';
    renderMath(dom, this.tex, this.display);
    if (this.replaces) {
      dom.title = 'Click to edit';
      revealOnClick(dom, view);
    }
    return dom;
  }

  override get estimatedHeight(): number {
    return this.display ? 60 : -1;
  }

  override ignoreEvent(): boolean {
    return this.replaces;
  }
}

/* ---------- Mermaid ---------- */

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

// The diagram library sits next to this script.
const ownScript = typeof document === 'undefined' ? null : (document.currentScript as HTMLScriptElement | null);
const mermaidUrl = ownScript?.src ? ownScript.src.replace(/webview\.js(\?.*)?$/, 'mermaid.js') : 'mermaid.js';

let library: Promise<MermaidApi> | undefined;
function loadMermaid(): Promise<MermaidApi> {
  library ??= new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = mermaidUrl;
    script.nonce = ownScript?.nonce ?? '';
    script.onload = () => resolve((globalThis as unknown as { __mdlMermaid: MermaidApi }).__mdlMermaid);
    script.onerror = () => {
      library = undefined;
      reject(new Error('The diagram renderer could not be loaded.'));
    };
    document.head.append(script);
  });
  return library;
}

type Rendered = { svg: string } | { error: string };
const diagramCache = new Map<string, Rendered>();
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function darkTheme(): boolean {
  const c = document.body.classList;
  return c.contains('vscode-dark') || (c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light'));
}

/** Renders one diagram. Calls are queued because the library draws one diagram at a time. */
function renderDiagram(source: string): Promise<Rendered> {
  const dark = darkTheme();
  const key = `${dark ? 'd' : 'l'}:${source}`;
  const hit = diagramCache.get(key);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(async (): Promise<Rendered> => {
    const id = `mdl-diagram-${++counter}`;
    let result: Rendered;
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
      result = { svg: (await mermaid.render(id, source)).svg };
    } catch (err) {
      result = { error: (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 4).join('\n') };
    }
    // A failed render can leave its scratch element behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    if (diagramCache.size > 200) diagramCache.clear();
    diagramCache.set(key, result);
    return result;
  });
  queue = job.catch(() => undefined);
  return job;
}

export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly replaces: boolean,
  ) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.replaces === this.replaces;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-md-mermaid';
    dom.textContent = 'Drawing diagram…';
    if (this.replaces) {
      dom.title = 'Click to edit';
      revealOnClick(dom, view);
    }
    this.draw(dom, view);
    return dom;
  }

  /** Keeps the previous drawing on screen until the new one is ready. */
  override updateDOM(dom: HTMLElement, view: EditorView, from: MermaidWidget): boolean {
    if (from.replaces !== this.replaces || !dom.classList.contains('cm-md-mermaid')) return false;
    this.draw(dom, view);
    return true;
  }

  private draw(dom: HTMLElement, view: EditorView): void {
    const source = this.source;
    dom.dataset.source = source;
    if (source.trim() === '') {
      dom.textContent = 'Empty diagram';
      dom.dataset.state = 'error';
      return;
    }
    void renderDiagram(source).then((result) => {
      // Another edit may have replaced this one while it was drawing.
      if (dom.dataset.source !== source) return;
      if ('svg' in result) {
        dom.innerHTML = result.svg;
        dom.dataset.state = 'done';
      } else {
        dom.textContent = `Diagram error: ${result.error}`;
        dom.dataset.state = 'error';
      }
      view.requestMeasure();
    });
  }

  override get estimatedHeight(): number {
    return 220;
  }

  override ignoreEvent(): boolean {
    return this.replaces;
  }
}
