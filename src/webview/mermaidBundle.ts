// Built as its own file (dist/mermaid.js) and loaded only when a document contains a diagram.
import mermaid from 'mermaid';

(globalThis as unknown as { __mdlMermaid: typeof mermaid }).__mdlMermaid = mermaid;
