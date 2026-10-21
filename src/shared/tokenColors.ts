// VS Code does not give extensions the syntax colours of the theme, but the user's own
// `editor.tokenColorCustomizations` is an ordinary setting. Its rules are turned into CSS for
// the token classes of the editor's highlighting, so code blocks follow them as the code editor does.
//
// Each kind of token the editor colours stands for one TextMate scope, and the rules are matched
// against that scope the way VS Code matches them: a selector applies to its scope and every
// scope below it ("string" applies to "string.quoted.double"), the selector with more parts wins,
// and of two equal selectors the later one wins. Selectors that depend on the enclosing scope
// ("source.js keyword") cannot be told apart in a code block and are left out.

export interface TokenStyle {
  foreground?: string;
  fontStyle?: string;
}

interface TokenKind {
  /** The `--mdl-tok-*` variable that holds its colour. */
  variable: string;
  /** The scope it stands for. */
  scope: string;
  /** The shorthand key of the setting for it, and the scope VS Code gives that shorthand. */
  shorthand?: [key: string, scope: string];
  /** The editor's token classes, for the font style. */
  classes: string[];
}

const KINDS: TokenKind[] = [
  { variable: 'keyword', scope: 'keyword.control', shorthand: ['keywords', 'keyword'], classes: ['tok-keyword', 'tok-operatorKeyword'] },
  { variable: 'string', scope: 'string.quoted.double', shorthand: ['strings', 'string'], classes: ['tok-string', 'tok-string2'] },
  { variable: 'number', scope: 'constant.numeric', shorthand: ['numbers', 'constant.numeric'], classes: ['tok-number'] },
  { variable: 'constant', scope: 'constant.language', classes: ['tok-bool', 'tok-atom', 'tok-literal'] },
  { variable: 'comment', scope: 'comment.line', shorthand: ['comments', 'comment'], classes: ['tok-comment'] },
  { variable: 'name', scope: 'entity.name.function', shorthand: ['functions', 'entity.name.function'], classes: ['tok-variableName.tok-definition', 'tok-macroName'] },
  { variable: 'type', scope: 'entity.name.type', shorthand: ['types', 'entity.name.type'], classes: ['tok-typeName', 'tok-className', 'tok-namespace'] },
];

interface Rule {
  selectors: string[];
  style: TokenStyle;
}

const COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function styleOf(value: unknown): TokenStyle | null {
  if (typeof value === 'string') return COLOUR.test(value) ? { foreground: value } : null;
  if (!value || typeof value !== 'object') return null;
  const { foreground, fontStyle } = value as Record<string, unknown>;
  const style: TokenStyle = {};
  if (typeof foreground === 'string' && COLOUR.test(foreground)) style.foreground = foreground;
  if (typeof fontStyle === 'string') style.fontStyle = fontStyle;
  return style.foreground !== undefined || style.fontStyle !== undefined ? style : null;
}

/** The rules of one level of the setting: its shorthands first, then its TextMate rules. */
function rulesOf(section: Record<string, unknown>): Rule[] {
  const rules: Rule[] = [];
  for (const kind of KINDS) {
    if (!kind.shorthand) continue;
    const style = styleOf(section[kind.shorthand[0]]);
    if (style) rules.push({ selectors: [kind.shorthand[1]], style });
  }
  const textMate = section.textMateRules;
  if (Array.isArray(textMate)) {
    for (const entry of textMate) {
      if (!entry || typeof entry !== 'object') continue;
      const { scope, settings } = entry as Record<string, unknown>;
      const style = styleOf(settings);
      const scopes = typeof scope === 'string' ? scope.split(',') : Array.isArray(scope) ? scope : [];
      const selectors = scopes.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s && !/\s/.test(s));
      if (style && selectors.length) rules.push({ selectors, style });
    }
  }
  return rules;
}

/** Whether a key such as "[Monokai]" or "[*Dark*][Abyss]" names the theme. */
export function namesTheme(key: string, theme: string): boolean {
  const groups = key.match(/^(?:\[[^\]]+\])+$/) ? key.slice(1, -1).split('][') : [];
  return groups.some((glob) => new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(theme));
}

/** How many parts of `scope` the selector covers, or 0 when it does not apply to it. */
function specificity(selector: string, scope: string): number {
  return scope === selector || scope.startsWith(selector + '.') ? selector.split('.').length : 0;
}

/** The style each kind of token gets from the setting, by its variable name. */
export function tokenStyles(setting: unknown, theme: string): Record<string, TokenStyle> {
  if (!setting || typeof setting !== 'object') return {};
  const section = setting as Record<string, unknown>;
  const rules = rulesOf(section);
  for (const [key, value] of Object.entries(section)) {
    if (key.startsWith('[') && value && typeof value === 'object' && namesTheme(key, theme)) rules.push(...rulesOf(value as Record<string, unknown>));
  }
  const out: Record<string, TokenStyle> = {};
  for (const kind of KINDS) {
    // Colour and font style are settled separately, as in VS Code: a rule that only sets the
    // font style keeps the colour of a less specific rule.
    let colour: [number, string] | undefined;
    let font: [number, string] | undefined;
    for (const rule of rules) {
      const weight = Math.max(...rule.selectors.map((s) => specificity(s, kind.scope)));
      if (!weight) continue;
      if (rule.style.foreground !== undefined && (!colour || weight >= colour[0])) colour = [weight, rule.style.foreground];
      if (rule.style.fontStyle !== undefined && (!font || weight >= font[0])) font = [weight, rule.style.fontStyle];
    }
    if (colour || font) out[kind.variable] = { foreground: colour?.[1], fontStyle: font?.[1] };
  }
  return out;
}

/** CSS that applies the setting to the editor's highlighting; empty when it changes nothing. */
export function tokenCss(setting: unknown, theme: string): string {
  const styles = tokenStyles(setting, theme);
  const colours: string[] = [];
  const rules: string[] = [];
  for (const kind of KINDS) {
    const style = styles[kind.variable];
    if (!style) continue;
    if (style.foreground) colours.push(`--mdl-tok-${kind.variable}: ${style.foreground};`);
    if (style.fontStyle !== undefined) {
      const words = style.fontStyle.toLowerCase().split(/\s+/);
      const decoration = ['underline', 'strikethrough'].filter((w) => words.includes(w)).map((w) => (w === 'strikethrough' ? 'line-through' : w));
      const selector = kind.classes.map((c) => `#app .${c}`).join(', ');
      rules.push(
        `${selector} { font-style: ${words.includes('italic') ? 'italic' : 'normal'}; font-weight: ${words.includes('bold') ? '600' : 'normal'}; text-decoration: ${decoration.join(' ') || 'none'}; }`,
      );
    }
  }
  if (colours.length) rules.unshift(`#app { ${colours.join(' ')} }`);
  return rules.join('\n');
}
