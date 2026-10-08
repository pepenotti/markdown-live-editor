// The KaTeX style sheet for an exported file, with only the fonts its formulas use,
// embedded as data URIs so the file needs nothing else. Pure code: the style sheet and the
// font files are handed in.

/**
 * Which class names in KaTeX's HTML ask for which font file. Taken from the rules of
 * katex.css that set a font family, weight or style; weight and style can come from
 * another class than the family (`\textbf{\textsf{x}}`), hence the combinations.
 */
const NEEDS: Record<string, (has: (pattern: RegExp) => boolean) => boolean> = {
  'KaTeX_Main-Regular': () => true,
  'KaTeX_Main-Bold': (has) => has(/\b(?:mathbf|textbf)\b/),
  'KaTeX_Main-Italic': (has) => has(/\b(?:mathit|textit)\b/),
  'KaTeX_Main-BoldItalic': (has) => has(/\btextbf\b/) && has(/\b(?:textit|mathit)\b/),
  'KaTeX_Math-Italic': (has) => has(/\bmathnormal\b/),
  'KaTeX_Math-BoldItalic': (has) => has(/\bboldsymbol\b/) || (has(/\bmathnormal\b/) && has(/\btextbf\b/)),
  'KaTeX_AMS-Regular': (has) => has(/\b(?:amsrm|mathbb|textbb)\b/),
  'KaTeX_Caligraphic-Regular': (has) => has(/\bmathcal\b/),
  'KaTeX_Caligraphic-Bold': (has) => has(/\bmathcal\b/) && has(/\b(?:textbf|mathbf|boldsymbol)\b/),
  'KaTeX_Fraktur-Regular': (has) => has(/\b(?:mathfrak|textfrak)\b/),
  'KaTeX_Fraktur-Bold': (has) => has(/\b(?:mathboldfrak|textboldfrak)\b/) || (has(/\b(?:mathfrak|textfrak)\b/) && has(/\btextbf\b/)),
  'KaTeX_SansSerif-Regular': (has) => has(/\b(?:mathsf|textsf)\b/),
  'KaTeX_SansSerif-Bold': (has) => has(/\b(?:mathboldsf|textboldsf)\b/) || (has(/\b(?:mathsf|textsf)\b/) && has(/\btextbf\b/)),
  'KaTeX_SansSerif-Italic': (has) => has(/\b(?:mathsfit|mathitsf|textitsf)\b/) || (has(/\b(?:mathsf|textsf)\b/) && has(/\btextit\b/)),
  'KaTeX_Script-Regular': (has) => has(/\b(?:mathscr|textscr)\b/),
  'KaTeX_Typewriter-Regular': (has) => has(/\b(?:mathtt|texttt)\b/),
  'KaTeX_Size1-Regular': (has) => has(/\bdelimsizing[^"]*\bsize1\b|\bdelim-size1\b|\bsmall-op\b/),
  'KaTeX_Size2-Regular': (has) => has(/\bdelimsizing[^"]*\bsize2\b|\blarge-op\b/),
  'KaTeX_Size3-Regular': (has) => has(/\bdelimsizing[^"]*\bsize3\b/),
  'KaTeX_Size4-Regular': (has) => has(/\bdelimsizing[^"]*\bsize4\b|\bdelim-size4\b/),
};

/** Names of the font files (without extension) that the KaTeX HTML in `html` needs. */
export function katexFontsFor(html: string): string[] {
  // Only class attributes count, so the text of the document cannot ask for a font.
  const classes = (html.match(/class="[^"]*"/g) ?? []).join(' ');
  const has = (pattern: RegExp) => pattern.test(classes);
  return Object.keys(NEEDS).filter((font) => NEEDS[font](has));
}

/**
 * The style sheet to embed for the formulas in `html`, or '' when there are none.
 * `css` is katex.css; `font` returns a font file (name without extension) as base64.
 * A font face that is not needed, or whose file is missing, is left out.
 */
export function katexStyles(html: string, css: string, font: (name: string) => string | undefined): string {
  if (!html.includes('class="katex')) return '';
  const wanted = new Set(katexFontsFor(html));
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@font-face\s*\{[^}]*\}/g, (face) => {
      const name = /(KaTeX_[A-Za-z0-9]+-[A-Za-z]+)\.woff2/.exec(face)?.[1];
      const data = name && wanted.has(name) ? font(name) : undefined;
      if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return '';
      return face.replace(/src\s*:[^;}]*/, `src:url(data:font/woff2;base64,${data}) format("woff2")`);
    })
    .trim();
}
