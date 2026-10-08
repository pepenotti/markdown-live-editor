// Syntax colours for exported code blocks, from the Lezer grammars the editor already uses.
// The output is HTML with `tok-…` classes (see `classHighlighter`).
import type { Parser } from '@lezer/common';
import { parser as cpp } from '@lezer/cpp';
import { parser as css } from '@lezer/css';
import { parser as go } from '@lezer/go';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { parser as html } from '@lezer/html';
import { parser as java } from '@lezer/java';
import { parser as javascript } from '@lezer/javascript';
import { parser as json } from '@lezer/json';
import { parser as python } from '@lezer/python';
import { parser as rust } from '@lezer/rust';
import { parser as xml } from '@lezer/xml';
import { parser as yaml } from '@lezer/yaml';

const typescript = javascript.configure({ dialect: 'ts' });
const jsx = javascript.configure({ dialect: 'jsx' });
const tsx = javascript.configure({ dialect: 'jsx ts' });

const PARSERS: Record<string, Parser> = {
  javascript, js: javascript, mjs: javascript, cjs: javascript, node: javascript,
  typescript, ts: typescript, mts: typescript, cts: typescript,
  jsx, tsx,
  json, jsonc: json, json5: json,
  python, py: python,
  css,
  html, htm: html, vue: html, svelte: html,
  xml, svg: xml, xsl: xml, plist: xml,
  yaml, yml: yaml,
  rust, rs: rust,
  go, golang: go,
  java,
  c: cpp, h: cpp, cpp, 'c++': cpp, cc: cpp, cxx: cpp, hpp: cpp,
};

// Parsing is linear, but nothing is gained from colouring a huge block.
const MAX_LENGTH = 200_000;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** Highlighted HTML for a code block, or null when the language is not known. */
export function highlight(code: string, language: string): string | null {
  const parser = Object.hasOwn(PARSERS, language.toLowerCase()) ? PARSERS[language.toLowerCase()] : undefined;
  if (!parser || code.length > MAX_LENGTH) return null;
  let out = '';
  try {
    highlightCode(
      code,
      parser.parse(code),
      classHighlighter,
      (text, classes) => {
        out += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
      },
      () => {
        out += '\n';
      },
    );
  } catch {
    return null;
  }
  return out;
}
