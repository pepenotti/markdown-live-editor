import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { stateOf } from './helpers';

function nodes(doc: string, wanted = /Footnote/): string[] {
  const state = stateOf(doc);
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (wanted.test(n.name)) out.push(`${n.name}:${state.doc.sliceString(n.from, n.to)}`);
    },
  });
  return out;
}

describe('footnote syntax', () => {
  it('parses references', () => {
    expect(nodes('Text[^1] and[^long-id].')).toEqual(['FootnoteReference:[^1]', 'FootnoteReference:[^long-id]']);
    expect(nodes('not [^] or [^a b] or `[^1]`')).toEqual([]);
  });

  it('parses definitions with inline content', () => {
    expect(nodes('a[^1]\n\n[^1]: The *note*.\n\nafter', /Footnote|Emphasis$|LinkReference/)).toEqual([
      'FootnoteReference:[^1]',
      'FootnoteDefinition:[^1]: The *note*.',
      'FootnoteLabel:[^1]:',
      'Emphasis:*note*',
    ]);
  });

  it('continues a definition until a blank line or another block', () => {
    expect(nodes('[^1]: one\ntwo\n[^2]: three\n- item', /FootnoteDefinition|List$/)).toEqual([
      'FootnoteDefinition:[^1]: one\ntwo',
      'FootnoteDefinition:[^2]: three',
      'BulletList:- item',
    ]);
  });

  it('ends a paragraph and works inside a quote', () => {
    expect(nodes('para\n[^1]: note', /FootnoteDefinition|Paragraph/)).toEqual(['Paragraph:para', 'FootnoteDefinition:[^1]: note']);
    expect(nodes('> [^1]: note\n> more', /FootnoteDefinition|Paragraph/)).toEqual(['FootnoteDefinition:[^1]: note', 'Paragraph:more']);
    expect(nodes('[^1]:', /FootnoteDefinition/)).toEqual(['FootnoteDefinition:[^1]:']);
  });
});
