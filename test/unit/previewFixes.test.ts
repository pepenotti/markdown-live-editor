import { describe, expect, it } from 'vitest';
import type { Mode } from '../../src/shared/protocol';
import { resizeImage } from '../../src/webview/commands/image';
import { blockField } from '../../src/webview/decorations/blocks';
import { collectInline, lineAtoms } from '../../src/webview/decorations/inline';
import { getAttr, isLoneImg, setAttr } from '../../src/webview/htmlTag';
import { popoverTargetAt, texChange, urlChange } from '../../src/webview/linkPopover';
import { footnoteAt, footnotes } from '../../src/webview/links';
import { withTex } from '../../src/webview/markdown';
import { modeField } from '../../src/webview/modes';
import { FootnoteWidget, ImageWidget } from '../../src/webview/widgets/simple';
import { stateOf } from './helpers';

const editor = (doc: string, mode: Mode) => stateOf(doc, [modeField.init(() => mode), blockField]);

/** Applies a change made for the element at the cursor and returns the new text. */
function applied(doc: string, make: (state: ReturnType<typeof stateOf>, pos: number) => { from: number; to: number; insert: string } | null): string | null {
  const state = editor(doc, 'full');
  const change = make(state, state.selection.main.head);
  return change ? state.update({ changes: change }).state.doc.toString() : null;
}

describe('html tag attributes', () => {
  it('reads attributes in any quoting', () => {
    const tag = `<img src="a b.png" alt='it&#39;s &amp; more' width=120 data-src="no">`;
    expect(getAttr(tag, 'src')).toBe('a b.png');
    expect(getAttr(tag, 'alt')).toBe("it's & more");
    expect(getAttr(tag, 'width')).toBe('120');
    expect(getAttr(tag, 'title')).toBe('');
  });

  it('changes one attribute and leaves the rest as written', () => {
    expect(setAttr(`<img  src='a.png'   width=50 alt="x">`, 'width', '200')).toBe(`<img  src='a.png'   width="200" alt="x">`);
    expect(setAttr('<img src="a.png">', 'width', '200')).toBe('<img src="a.png" width="200">');
    expect(setAttr('<img src="a.png" />', 'width', '200')).toBe('<img src="a.png" width="200" />');
    expect(setAttr('<img src="a.png"/>', 'alt', 'say "hi" <now>')).toBe('<img src="a.png" alt="say &quot;hi&quot; &lt;now&gt;"/>');
  });

  it('recognises a tag that is only an image', () => {
    expect(isLoneImg('<img src="a.png">')).toBe(true);
    expect(isLoneImg('<p><img src="a.png"></p>')).toBe(false);
    expect(isLoneImg('<image src="a.png">')).toBe(false);
  });
});

describe('image resizing', () => {
  const resize = (doc: string, width = 200) => applied(doc, (state, pos) => resizeImage(state, pos, width));

  it('turns a Markdown image into an img tag with a width', () => {
    expect(resize('See ![A "cat" & dog](pics/a%20b.png)¦ here')).toBe('See <img src="pics/a%20b.png" alt="A &quot;cat&quot; &amp; dog" width="200"> here');
    expect(resize('![alt](<my pic.png> "The title")¦')).toBe('<img src="my pic.png" alt="alt" title="The title" width="200">');
    expect(resize('![a\\]b](x.png)¦ text', 99.6)).toBe('<img src="x.png" alt="a]b" width="100"> text');
  });

  it('resolves a reference image and keeps its definition', () => {
    expect(resize('![Pic][p]¦ end\n\n[p]: img/p.png')).toBe('<img src="img/p.png" alt="Pic" width="200"> end\n\n[p]: img/p.png');
    expect(resize('![Pic][nowhere]¦')).toBeNull();
  });

  it('only changes the width of an existing tag', () => {
    expect(resize(`text <img alt='x' src="a.png" width="80">¦ more`, 300)).toBe(`text <img alt='x' src="a.png" width="300"> more`);
    expect(resize('<img src="a.png">¦\n')).toBe('<img src="a.png" width="200">\n');
    expect(resize('<p align="center"><img src="a.png" height=10>¦</p>\n')).toBe('<p align="center"><img src="a.png" height=10 width="200"></p>\n');
    expect(resize('<img src="a.png" width="200">¦')).toBeNull();
  });

  it('keeps the following lines Markdown when the tag would start an HTML block', () => {
    expect(resize('![a](a.png)¦\n*caption*\n')).toBe('<img src="a.png" alt="a" width="200">\n\n*caption*\n');
    expect(resize('![a](a.png)¦\n\n*caption*\n')).toBe('<img src="a.png" alt="a" width="200">\n\n*caption*\n');
    expect(resize('intro\n![a](a.png)¦\n*caption*')).toBe('intro\n<img src="a.png" alt="a" width="200">\n*caption*');
  });

  it('can be resized again and still draws a picture', () => {
    const once = resize('before\n\n![a](a.png)¦\n\nafter')!;
    const state = editor(once, 'full');
    const end = once.indexOf('>') + 1;
    const change = resizeImage(state, end, 64)!;
    expect(state.update({ changes: change }).state.doc.toString()).toBe('before\n\n<img src="a.png" alt="a" width="64">\n\nafter');
    const widgets = collectInline(state, [{ from: 0, to: state.doc.length }])
      .decorations.map((d) => d.value.spec.widget)
      .filter((w) => w instanceof ImageWidget) as ImageWidget[];
    expect(widgets.map((w) => [w.src, w.alt, w.width, w.below])).toEqual([['a.png', 'a', '200', false]]);
  });

  it('hides a tag that is only an image like a Markdown image', () => {
    const doc = 'a <img src="a.png" width="50"> b';
    expect(lineAtoms(editor(doc, 'full'), 0)).toEqual([{ from: 2, to: 30, kind: 'inline' }]);
    expect(lineAtoms(editor('a <kbd>x</kbd> b', 'full'), 0)).toEqual([]);
  });
});

describe('popover edits', () => {
  it('finds math, links, images and image tags next to the cursor', () => {
    const kind = (doc: string) => {
      const state = editor(doc, 'full');
      return popoverTargetAt(state, state.selection.main.head)?.kind ?? null;
    };
    expect(kind('a $x$¦ b')).toBe('math');
    expect(kind('a ¦$x$ b')).toBe('math');
    expect(kind('a $x$ ¦b')).toBeNull();
    expect(kind('a [te¦xt](u) b')).toBe('link');
    expect(kind('![a](u)¦')).toBe('image');
    expect(kind('x <img src="a.png">¦')).toBe('tag');
    expect(kind('x <kbd>¦k</kbd>')).toBeNull();
    expect(kind('price $5¦ and $6')).toBeNull();
  });

  it('rewrites the TeX between the dollar signs', () => {
    const tex = (doc: string, value: string) => applied(doc, (state, pos) => texChange(popoverTargetAt(state, pos)!, value));
    expect(tex('a $x$¦ b', ' x^2 + 1 ')).toBe('a $x^2 + 1$ b');
    expect(tex('a ¦$$x$$ b', '\\frac{1}{2}')).toBe('a $$\\frac{1}{2}$$ b');
    expect(tex('a $x$¦ b', 'cost \\$5')).toBe('a $cost \\$5$ b');
  });

  it('refuses TeX that would break the formula', () => {
    expect(withTex('$x$', '')).toBeNull();
    expect(withTex('$x$', '  ')).toBeNull();
    expect(withTex('$x$', 'a$b')).toBeNull();
    expect(withTex('$x$', 'a\\')).toBeNull();
    expect(withTex('$x$', 'a\\\\')).toBe('$a\\\\$');
    expect(withTex('$$x$$', 'a\nb')).toBe('$$a b$$');
  });

  it('edits the definition of a reference link', () => {
    const url = (doc: string, value: string) => applied(doc, (state, pos) => urlChange(state, popoverTargetAt(state, pos)!, value));
    const doc = 'See [the s¦pec][Spec] and [spec].\n\n[spec]: https://old.example/ "Title"\n';
    expect(url(doc, 'https://new.example/a')).toBe('See [the spec][Spec] and [spec].\n\n[spec]: https://new.example/a "Title"\n');
    expect(url(doc, 'my file.md')).toBe('See [the spec][Spec] and [spec].\n\n[spec]: <my file.md> "Title"\n');
    expect(url(doc, '')).toBe('See [the spec][Spec] and [spec].\n\n[spec]: <> "Title"\n');
    expect(url('![pic][p]¦\n\n[p]: <a b.png>', 'c.png')).toBe('![pic][p]\n\n[p]: c.png');
    expect(url('[te¦xt](old)', 'new')).toBe('[text](new)');
    expect(url('<img src="old.png" width="5">¦', 'new.png')).toBe('<img src="new.png" width="5">');
  });
});

describe('footnotes', () => {
  const DOC = 'One[^b] two[^a] three[^b] four[^none].\n\n[^a]: First *note*\n[^b]: Second\n[^c]: Unused';

  it('numbers footnotes in the order they are first referenced', () => {
    const notes = footnotes(editor(DOC, 'half'));
    expect([...notes.numbers]).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    expect(DOC.slice(notes.definitions.get('a')!)).toMatch(/^First/);
    expect(notes.references.get('b')).toBe(3);
  });

  const labels = (mode: Mode, cursor: number) => {
    const state = editor(DOC, mode).update({ selection: { anchor: cursor } }).state;
    return collectInline(state, [{ from: 0, to: state.doc.length }])
      .decorations.map((d) => d.value.spec.widget)
      .filter((w) => w instanceof FootnoteWidget)
      .map((w) => (w as FootnoteWidget).label + ((w as FootnoteWidget).reference ? '^' : ':'));
  };

  it('draws references as numbers and definitions with theirs', () => {
    expect(labels('full', 0)).toEqual(['1^', '2^', '1^', '2:', '1:', 'c:']);
    expect(labels('raw', 0)).toEqual([]);
  });

  it('shows the source under the cursor in half preview', () => {
    expect(labels('half', 5)).toEqual(['2^', '1^', '2:', '1:', 'c:']);
    expect(labels('half', DOC.indexOf('First'))).toEqual(['1^', '2^', '1^', '1:', 'c:']);
  });

  it('makes them atoms in full preview', () => {
    const state = editor(DOC, 'full');
    expect(lineAtoms(state, 0)).toEqual([
      { from: 3, to: 7, kind: 'inline' },
      { from: 11, to: 15, kind: 'inline' },
      { from: 21, to: 25, kind: 'inline' },
    ]);
    const def = DOC.indexOf('[^a]:');
    expect(lineAtoms(state, def)[0]).toEqual({ from: def, to: def + 6, kind: 'leading' });
  });

  it('finds the footnote at a position', () => {
    const state = editor(DOC, 'half');
    expect(footnoteAt(state, 3)).toEqual({ id: 'b', reference: true });
    expect(footnoteAt(state, 7)).toEqual({ id: 'b', reference: true });
    expect(footnoteAt(state, DOC.indexOf('[^a]:') + 2)).toEqual({ id: 'a', reference: false });
    expect(footnoteAt(state, 1)).toBeNull();
  });
});
