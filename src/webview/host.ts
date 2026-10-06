// Typed bridge to the extension host (or to the mock host of the browser harness).
import type { HostMessage, RequestKind, WebviewMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export interface SavedState {
  scrollPos?: number;
  anchor?: number;
  head?: number;
}

export class HostBridge {
  private readonly api = acquireVsCodeApi();
  /** True when running in a plain browser page instead of VS Code. */
  readonly standalone = !!(window as unknown as { __MDL_HARNESS__?: boolean }).__MDL_HARNESS__;
  private nextRequest = 1;
  private readonly pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
  private readonly listeners: ((message: HostMessage) => void)[] = [];

  constructor() {
    window.addEventListener('message', (event) => {
      const message = event.data as HostMessage | undefined;
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (message.type === 'response') {
        const waiting = this.pending.get(message.reqId);
        if (!waiting) return;
        this.pending.delete(message.reqId);
        if (message.ok) waiting.resolve(message.data);
        else waiting.reject(new Error(message.error ?? 'Request failed'));
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  post(message: WebviewMessage): void {
    this.api.postMessage(message);
  }

  onMessage(listener: (message: HostMessage) => void): void {
    this.listeners.push(listener);
  }

  request<T>(kind: RequestKind, payload?: unknown): Promise<T> {
    const reqId = this.nextRequest++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (data: unknown) => void, reject });
      this.post({ type: 'request', reqId, kind, payload });
    });
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.post({ type: 'log', level, message });
  }

  getState(): SavedState {
    const s = this.api.getState();
    return s && typeof s === 'object' ? (s as SavedState) : {};
  }

  setState(state: SavedState): void {
    this.api.setState(state);
  }
}
