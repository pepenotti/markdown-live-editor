import { describe, expect, it } from 'vitest';
import { namesTheme, tokenCss, tokenStyles } from '../../src/shared/tokenColors';

describe('token colours from editor.tokenColorCustomizations', () => {
  it('takes the shorthand keys, as a colour or with a font style', () => {
    expect(tokenStyles({ comments: '#ff0000', keywords: { foreground: '#00ff00', fontStyle: 'bold' } }, 'Dark Modern')).toEqual({
      comment: { foreground: '#ff0000', fontStyle: undefined },
      keyword: { foreground: '#00ff00', fontStyle: 'bold' },
    });
  });

  it('matches TextMate rules on the scope and every scope below it', () => {
    const styles = tokenStyles(
      {
        textMateRules: [
          { scope: 'string', settings: { foreground: '#111111' } },
          { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#222222' } },
          { scope: 'entity.name.function, entity.name.type', settings: { foreground: '#333333' } },
        ],
      },
      '',
    );
    expect(styles.string.foreground).toBe('#111111');
    expect(styles.number.foreground).toBe('#222222');
    expect(styles.constant.foreground).toBe('#222222');
    expect(styles.name.foreground).toBe('#333333');
    expect(styles.type.foreground).toBe('#333333');
  });

  it('lets the more specific selector win, and the later of two equal ones', () => {
    const styles = tokenStyles(
      {
        textMateRules: [
          { scope: 'keyword.control', settings: { foreground: '#aaaaaa' } },
          { scope: 'keyword', settings: { foreground: '#bbbbbb' } },
          { scope: 'comment', settings: { foreground: '#cccccc' } },
          { scope: 'comment', settings: { foreground: '#dddddd' } },
        ],
      },
      '',
    );
    expect(styles.keyword.foreground).toBe('#aaaaaa');
    expect(styles.comment.foreground).toBe('#dddddd');
  });

  it('puts TextMate rules after the shorthands, and settles colour and font style separately', () => {
    const styles = tokenStyles({ comments: '#ff0000', textMateRules: [{ scope: 'comment', settings: { fontStyle: '' } }] }, '');
    expect(styles.comment).toEqual({ foreground: '#ff0000', fontStyle: '' });
    expect(tokenStyles({ comments: '#ff0000', textMateRules: [{ scope: 'comment', settings: { foreground: '#00ff00' } }] }, '').comment.foreground).toBe('#00ff00');
  });

  it('applies the section of the theme in use after the general settings', () => {
    const setting = { comments: '#111111', '[Monokai]': { comments: '#222222' }, '[*Light*]': { strings: '#333333' } };
    expect(tokenStyles(setting, 'Monokai').comment.foreground).toBe('#222222');
    expect(tokenStyles(setting, 'Dark Modern').comment.foreground).toBe('#111111');
    expect(tokenStyles(setting, 'Light Modern').string.foreground).toBe('#333333');
    expect(tokenStyles(setting, 'Dark Modern').string).toBeUndefined();
  });

  it('reads theme names with several groups and wildcards', () => {
    expect(namesTheme('[Abyss][Monokai]', 'Monokai')).toBe(true);
    expect(namesTheme('[*Dark*]', 'Default Dark+')).toBe(true);
    expect(namesTheme('[Monokai]', 'Monokai Dimmed')).toBe(false);
    expect(namesTheme('comments', 'comments')).toBe(false);
  });

  it('ignores selectors that depend on the enclosing scope, and anything that is not a colour', () => {
    const styles = tokenStyles(
      {
        comments: 'red; } body { display: none',
        strings: 'not-a-colour',
        textMateRules: [
          { scope: 'source.js keyword', settings: { foreground: '#123456' } },
          { scope: 'keyword', settings: { foreground: '#123456; color: red' } },
        ],
      },
      '',
    );
    expect(styles).toEqual({});
  });

  it('turns the styles into variables and font rules for the token classes', () => {
    const css = tokenCss({ comments: { foreground: '#6a9955', fontStyle: '' }, keywords: { fontStyle: 'italic bold underline' } }, '');
    expect(css).toContain('#app { --mdl-tok-comment: #6a9955; }');
    expect(css).toContain('#app .tok-comment { font-style: normal; font-weight: normal; text-decoration: none; }');
    expect(css).toContain('#app .tok-keyword, #app .tok-operatorKeyword { font-style: italic; font-weight: 600; text-decoration: underline; }');
  });

  it('gives no CSS when the setting is missing or empty', () => {
    expect(tokenCss(undefined, '')).toBe('');
    expect(tokenCss({}, '')).toBe('');
    expect(tokenCss({ textMateRules: [] }, '')).toBe('');
  });
});
