import { describe, expect, it } from 'vitest';
import {
  insertCodeBlock,
  insertLink,
  insertPaths,
  insertRule,
  insertTable,
  setHeading,
  shiftHeading,
  toggleInline,
  toggleList,
  toggleQuote,
  toggleTask,
} from '../../src/webview/commands/format';
import { run } from './helpers';

describe('inline formatting', () => {
  it('wraps and unwraps a selection', () => {
    expect(run('a ⟦bold⟧ c', toggleInline('bold'))).toBe('a **⟦bold⟧** c');
    expect(run('a **⟦bold⟧** c', toggleInline('bold'))).toBe('a ⟦bold⟧ c');
    expect(run('a ⟦**bold**⟧ c', toggleInline('bold'))).toBe('a ⟦bold⟧ c');
  });

  it('wraps the word under the cursor', () => {
    expect(run('some wo¦rd here', toggleInline('italic'))).toBe('some *wo¦rd* here');
    expect(run('some *wo¦rd* here', toggleInline('italic'))).toBe('some wo¦rd here');
  });

  it('inserts an empty pair when there is no word', () => {
    expect(run('a ¦ b', toggleInline('code'))).toBe('a `¦` b');
    expect(run('¦', toggleInline('strike'))).toBe('~~¦~~');
  });

  it('steps out of the format at its end instead of removing it', () => {
    expect(run('**bold¦** next', toggleInline('bold'))).toBe('**bold**¦ next');
  });

  it('keeps markers tight against the text', () => {
    expect(run('a⟦ bold ⟧c', toggleInline('bold'))).toBe('a **⟦bold⟧** c');
  });

  it('wraps each line of a multi-line selection', () => {
    expect(run('⟦one\n\ntwo⟧', toggleInline('bold'))).toBe('**⟦one**\n\n**two⟧**');
  });

  it('handles nested emphasis', () => {
    expect(run('**bo¦ld**', toggleInline('italic'))).toBe('***bo¦ld***');
    expect(run('~~go¦ne~~', toggleInline('strike'))).toBe('go¦ne');
    expect(run('`co¦de`', toggleInline('code'))).toBe('co¦de');
  });
});

describe('headings', () => {
  it('sets, changes and clears a heading', () => {
    expect(run('Tit¦le', setHeading(2))).toBe('## Tit¦le');
    expect(run('## Tit¦le', setHeading(3))).toBe('### Tit¦le');
    expect(run('### Tit¦le', setHeading(3))).toBe('Tit¦le');
  });

  it('puts a cursor at the line start behind the new marker', () => {
    expect(run('¦Title', setHeading(1))).toBe('# ¦Title');
    expect(run('¦', setHeading(1))).toBe('# ¦');
  });

  it('applies to every selected line that has text', () => {
    expect(run('⟦one\n\ntwo⟧', setHeading(2))).toBe('## ⟦one\n\n## two⟧');
  });

  it('shifts levels up and down within bounds', () => {
    expect(run('te¦xt', shiftHeading(1))).toBe('# te¦xt');
    expect(run('# te¦xt', shiftHeading(1))).toBe('## te¦xt');
    expect(run('# te¦xt', shiftHeading(-1))).toBe('te¦xt');
    expect(run('###### te¦xt', shiftHeading(1))).toBe('###### te¦xt');
    expect(run('te¦xt', shiftHeading(-1))).toBe('te¦xt');
  });
});

describe('lists and quotes', () => {
  it('toggles a bullet list', () => {
    expect(run('⟦one\ntwo⟧', toggleList('bullet'))).toBe('- ⟦one\n- two⟧');
    expect(run('- ⟦one\n- two⟧', toggleList('bullet'))).toBe('⟦one\ntwo⟧');
  });

  it('numbers an ordered list and converts between kinds', () => {
    expect(run('⟦a\nb\nc⟧', toggleList('ordered'))).toBe('1. ⟦a\n2. b\n3. c⟧');
    expect(run('1. ⟦a\n2. b⟧', toggleList('bullet'))).toBe('- ⟦a\n- b⟧');
    expect(run('- ⟦a\n- b⟧', toggleList('task'))).toBe('- [ ] ⟦a\n- [ ] b⟧');
    expect(run('- [x] do¦ne', toggleList('bullet'))).toBe('- do¦ne');
  });

  it('keeps indentation', () => {
    expect(run('  - nes¦ted', toggleList('ordered'))).toBe('  1. nes¦ted');
    expect(run('  nes¦ted', toggleList('bullet'))).toBe('  - nes¦ted');
  });

  it('starts a list on an empty line', () => {
    expect(run('¦', toggleList('bullet'))).toBe('- ¦');
  });

  it('ticks and unticks tasks', () => {
    expect(run('- [ ] to¦do', toggleTask)).toBe('- [x] to¦do');
    expect(run('- [x] to¦do', toggleTask)).toBe('- [ ] to¦do');
    expect(run('- it¦em', toggleTask)).toBe('- [ ] it¦em');
    expect(run('pla¦in', toggleTask)).toBe('- [ ] pla¦in');
  });

  it('toggles a block quote over all selected lines', () => {
    expect(run('⟦one\n\ntwo⟧', toggleQuote)).toBe('> ⟦one\n> \n> two⟧');
    expect(run('> ⟦one\n>\n> two⟧', toggleQuote)).toBe('⟦one\n\ntwo⟧');
  });
});

describe('block inserts', () => {
  it('inserts a code block with blank lines around it', () => {
    expect(run('text¦\nmore', insertCodeBlock)).toBe('text\n\n```\n¦\n```\n\nmore');
    expect(run('¦', insertCodeBlock)).toBe('```\n¦\n```');
  });

  it('wraps selected lines in a code block', () => {
    expect(run('a\n⟦let x;\nlet y;⟧\nb', insertCodeBlock)).toBe('a\n\n```\n⟦let x;\nlet y;⟧\n```\n\nb');
  });

  it('inserts a rule and a table', () => {
    expect(run('a¦', insertRule)).toBe('a\n\n---\n¦');
    expect(run('a\n¦\nb', insertTable(2, 2))).toBe(
      'a\n\n| ⟦Column 1⟧ | Column 2 |\n| -------- | -------- |\n|          |          |\n\nb',
    );
  });
});

describe('links', () => {
  it('turns a selection into a link and puts the cursor in the URL', () => {
    expect(run('see ⟦the docs⟧ now', insertLink)).toBe('see [the docs](¦) now');
  });

  it('uses a selected URL as the target', () => {
    expect(run('⟦https://example.com/a⟧', insertLink)).toBe('[¦](https://example.com/a)');
  });

  it('inserts a placeholder when nothing is selected', () => {
    expect(run('a ¦', insertLink)).toBe('a [⟦link text⟧]()');
  });

  it('selects the URL of an existing link', () => {
    expect(run('[te¦xt](http://x.y)', insertLink)).toBe('[text](⟦http://x.y⟧)');
  });

  it('inserts image and file links', () => {
    expect(run('a ¦', insertPaths([{ path: 'assets/my pic.png', isImage: true, name: 'my pic.png' }]))).toBe('a ![](<assets/my pic.png>)¦');
    expect(run('⟦label⟧', insertPaths([{ path: 'notes.md', isImage: false, name: 'notes.md' }]))).toBe('[label](notes.md)¦');
  });
});
