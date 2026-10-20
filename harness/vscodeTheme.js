// Loads a VS Code colour theme into the harness the way VS Code does for a webview:
// every colour becomes a `--vscode-*` variable on <html>, and <body> gets the theme kind's class.
// Query: ?vstheme=dark_modern.json (a file in harness/themes/, see index.json there).
//
// VS Code fills in a default for every colour a theme leaves out. DEFAULTS mirrors those defaults
// (from src/vs/platform/theme/common/colors/*.ts and the contributions that register colours) for
// the colours Seamless Markdown reads, so a theme looks here as it would in VS Code.

/** Theme kinds, in the order of the default tuples below. */
export const KINDS = ['dark', 'light', 'hcDark', 'hcLight'];

/** The <body> class VS Code sets for each kind. */
export const BODY_CLASS = {
  dark: 'vscode-dark',
  light: 'vscode-light',
  hcDark: 'vscode-high-contrast',
  hcLight: 'vscode-high-contrast vscode-high-contrast-light',
};

/** The kind for a theme's `uiTheme` (package.json) or `type` (theme file). */
export function kindOf(uiTheme) {
  switch (uiTheme) {
    case 'vs':
    case 'light':
      return 'light';
    case 'hc-black':
    case 'hc':
    case 'hcDark':
      return 'hcDark';
    case 'hc-light':
    case 'hcLight':
      return 'hcLight';
    default:
      return 'dark';
  }
}

// A default is a colour ('#rrggbb[aa]'), null (no colour), the id of another colour,
// or [id, alpha] for that colour made transparent. One value applies to all four kinds;
// an array of four gives [dark, light, hcDark, hcLight].
const T = (id, alpha) => [id, alpha];
export const DEFAULTS = {
  foreground: ['#cccccc', '#616161', '#ffffff', '#292929'],
  descriptionForeground: [T('foreground', 0.7), '#717171', T('foreground', 0.7), T('foreground', 0.7)],
  disabledForeground: ['#cccccc80', '#61616180', '#a5a5a5', '#7f7f7f'],
  errorForeground: ['#f48771', '#a1260d', '#f48771', '#b5200d'],
  'icon.foreground': ['#c5c5c5', '#424242', '#ffffff', '#292929'],
  focusBorder: ['#007fd4', '#0090f1', '#f38518', '#006bbd'],
  contrastBorder: [null, null, '#6fc3df', '#0f4a85'],
  contrastActiveBorder: [null, null, 'focusBorder', 'focusBorder'],
  'textLink.foreground': ['#3794ff', '#006ab1', '#21a6ff', '#0f4a85'],
  'textPreformat.foreground': ['#d7ba7d', '#a31515', '#ffffff', '#ffffff'],
  'textBlockQuote.background': ['#222222', '#f2f2f2', null, '#f2f2f2'],
  'textBlockQuote.border': ['#007acc80', '#007acc80', '#ffffff', '#292929'],
  'textCodeBlock.background': ['#0a0a0a66', '#dcdcdc66', '#000000', '#f2f2f2'],
  'editor.background': ['#1e1e1e', '#ffffff', '#000000', '#ffffff'],
  'editor.foreground': ['#bbbbbb', '#333333', '#ffffff', 'foreground'],
  'editor.selectionBackground': ['#264f78', '#add6ff', '#f3f518', '#0f4a85'],
  'editor.inactiveSelectionBackground': [T('editor.selectionBackground', 0.5), T('editor.selectionBackground', 0.5), T('editor.selectionBackground', 0.7), T('editor.selectionBackground', 0.5)],
  'editorCursor.foreground': ['#aeafad', '#000000', '#ffffff', '#0f4a85'],
  'editor.findMatchBackground': ['#515c6a', '#a8ac94', null, null],
  'editor.findMatchBorder': [null, null, 'contrastActiveBorder', 'contrastActiveBorder'],
  'editor.findMatchHighlightBackground': ['#ea5c0055', '#ea5c0055', null, null],
  'editor.findMatchHighlightBorder': [null, null, 'contrastActiveBorder', 'contrastActiveBorder'],
  'editorWidget.background': ['#252526', '#f3f3f3', '#0c141f', '#ffffff'],
  'editorWidget.foreground': 'foreground',
  'editorWidget.border': [T('editorWidget.foreground', 0.2), T('editorWidget.foreground', 0.2), 'contrastBorder', 'contrastBorder'],
  'widget.border': [null, null, 'contrastBorder', 'contrastBorder'],
  'widget.shadow': ['#0000005c', '#00000029', null, null],
  'editorError.foreground': ['#f14c4c', '#e51400', '#f48771', '#b5200d'],
  'editorWarning.foreground': ['#cca700', '#bf8803', '#ffd370', '#895503'],
  'editorInfo.foreground': ['#59a4f9', '#0063d3', '#59a4f9', '#0063d3'],
  'notificationsInfoIcon.foreground': 'editorInfo.foreground',
  'toolbar.hoverBackground': ['#5a5d5e50', '#b8b8b850', null, null],
  'toolbar.hoverOutline': [null, null, 'contrastActiveBorder', 'contrastActiveBorder'],
  'panel.border': ['#80808059', '#80808059', 'contrastBorder', 'contrastBorder'],
  'input.background': ['#3c3c3c', '#ffffff', '#000000', '#ffffff'],
  'input.foreground': 'foreground',
  'input.border': [null, null, 'contrastBorder', 'contrastBorder'],
  'inputOption.activeBorder': ['#007acc', '#007acc', 'contrastBorder', 'contrastBorder'],
  'inputOption.activeBackground': [T('focusBorder', 0.4), T('focusBorder', 0.2), '#00000000', '#00000000'],
  'inputOption.activeForeground': ['#ffffff', '#000000', 'foreground', 'foreground'],
  'inputValidation.errorBorder': ['#be1100', '#be1100', 'contrastBorder', 'contrastBorder'],
  'button.background': ['#0e639c', '#007acc', '#000000', '#0f4a85'],
  'button.foreground': '#ffffff',
  'dropdown.background': ['#3c3c3c', '#ffffff', '#000000', '#ffffff'],
  'dropdown.border': ['dropdown.background', '#cecece', 'contrastBorder', 'contrastBorder'],
  'dropdown.foreground': ['#f0f0f0', 'foreground', '#ffffff', 'foreground'],
  'list.activeSelectionBackground': ['#04395e', '#0060c0', null, '#0f4a851a'],
  'list.activeSelectionForeground': ['#ffffff', '#ffffff', null, null],
  'menu.background': 'dropdown.background',
  'menu.foreground': 'dropdown.foreground',
  'menu.border': [null, null, 'contrastBorder', 'contrastBorder'],
  'menu.selectionBackground': 'list.activeSelectionBackground',
  'menu.selectionForeground': 'list.activeSelectionForeground',
  'charts.red': 'editorError.foreground',
  'charts.blue': 'editorInfo.foreground',
  'charts.yellow': 'editorWarning.foreground',
  'charts.orange': ['#d18616', '#d18616', '#ab5a00', '#0f4a85'],
  'charts.green': ['#89d185', '#388a34', '#89d185', '#374e06'],
  'charts.purple': ['#b180d7', '#652d90', '#b180d7', '#652d90'],
  'testing.iconPassed': ['#73c991', '#73c991', '#73c991', '#007100'],
  'debugTokenExpression.name': ['#c586c0', '#9b46b0', 'foreground', 'foreground'],
  'debugTokenExpression.type': ['#4a90e2', '#4a90e2', 'foreground', 'foreground'],
  'debugTokenExpression.value': ['#cccccc99', '#6c6c6ccc', 'foreground', 'foreground'],
  'debugTokenExpression.string': ['#ce9178', '#a31515', '#f48771', '#a31515'],
  'debugTokenExpression.boolean': ['#4e94ce', '#0000ff', '#75bdfe', '#0000ff'],
  'debugTokenExpression.number': ['#b5cea8', '#098658', '#89d185', '#098658'],
  'debugTokenExpression.error': ['#f48771', '#e51400', '#f48771', '#e51400'],
  'symbolIcon.classForeground': ['#ee9d28', '#d67e00', '#ee9d28', '#d67e00'],
  'symbolIcon.functionForeground': ['#b180d7', '#652d90', '#b180d7', '#652d90'],
  'symbolIcon.variableForeground': ['#75beff', '#007acc', '#75beff', '#007acc'],
  'symbolIcon.keywordForeground': 'foreground',
  'symbolIcon.stringForeground': 'foreground',
  'symbolIcon.numberForeground': 'foreground',
};

/** Parses '#rgb', '#rgba', '#rrggbb' or '#rrggbbaa' into [r, g, b, a] (a from 0 to 1), or null. */
export function parseHex(hex) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(hex).trim());
  if (!m || m[1].length === 5 || m[1].length === 7) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

function toHex([r, g, b, a]) {
  const x = (v) => Math.round(v).toString(16).padStart(2, '0');
  return '#' + x(r) + x(g) + x(b) + (a < 1 ? x(a * 255) : '');
}

/** Strips comments and trailing commas, as VS Code accepts them in theme files. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * The colours VS Code would use: the theme's own, then the defaults for what it leaves out.
 * Returns a map from colour id to a CSS colour; ids without a colour are left out.
 */
export function resolveColors(themeColors, kind) {
  const index = KINDS.indexOf(kind);
  const theme = {};
  for (const [id, value] of Object.entries(themeColors || {})) {
    const c = typeof value === 'string' ? parseHex(value) : null;
    if (c) theme[id] = c;
  }
  const cache = new Map();
  const resolve = (id, seen = new Set()) => {
    if (theme[id]) return theme[id];
    if (cache.has(id)) return cache.get(id);
    if (seen.has(id) || !(id in DEFAULTS)) return null;
    seen.add(id);
    const entry = DEFAULTS[id];
    const value = Array.isArray(entry) && entry.length === 4 ? entry[index] : entry;
    let c = null;
    if (typeof value === 'string') c = value.startsWith('#') ? parseHex(value) : resolve(value, seen);
    else if (Array.isArray(value)) {
      const base = resolve(value[0], seen);
      c = base && [base[0], base[1], base[2], base[3] * value[1]];
    }
    cache.set(id, c);
    return c;
  };
  const out = {};
  for (const id of new Set([...Object.keys(theme), ...Object.keys(DEFAULTS)])) {
    const c = resolve(id);
    if (c) out[id] = toHex(c);
  }
  return out;
}

/**
 * The CSS variable VS Code uses for a colour id: 'editor.background' → '--vscode-editor-background'.
 * Like VS Code (webview/browser/themeing.ts), only the first dot becomes a dash.
 */
export const cssVariable = (id) => '--vscode-' + id.replace('.', '-');

/** Reads a theme file and the files it includes; later files override earlier ones. */
export async function loadThemeColors(url, read = (u) => fetch(u).then((r) => r.text())) {
  const json = parseJsonc(await read(url));
  const base = json.include ? await loadThemeColors(new URL(json.include, url).href, read) : { colors: {} };
  const colors = { ...base.colors };
  // As in VS Code, a token rule without a scope gives the editor's colours when `colors` does not.
  const global = Array.isArray(json.tokenColors) ? json.tokenColors.filter((r) => r && !r.scope && r.settings).pop() : undefined;
  if (global?.settings.foreground) colors['editor.foreground'] = global.settings.foreground;
  if (global?.settings.background) colors['editor.background'] = global.settings.background;
  Object.assign(colors, json.colors || {});
  return { colors, type: json.type || base.type, name: json.name || base.name };
}

/** Sets the variables and body class as VS Code does. */
export function applyTheme(doc, colors, kind) {
  const root = doc.documentElement;
  for (const [id, value] of Object.entries(colors)) root.style.setProperty(cssVariable(id), value);
  // VS Code also passes its interface font (DEFAULT_FONT_FAMILY in src/vs/base/browser/fonts.ts).
  const platform = doc.defaultView?.navigator.platform ?? '';
  const font = /Win/.test(platform) ? '"Segoe WPC", "Segoe UI", sans-serif' : /Mac/.test(platform) ? '-apple-system, BlinkMacSystemFont, sans-serif' : 'system-ui, "Ubuntu", "Droid Sans", sans-serif';
  root.style.setProperty('--vscode-font-family', font);
  root.style.colorScheme = kind === 'light' || kind === 'hcLight' ? 'light' : 'dark';
  doc.body.className = BODY_CLASS[kind];
  doc.body.dataset.vscodeThemeKind = BODY_CLASS[kind].split(' ').pop();
}

/** Loads harness/themes/<file> (its kind from themes/index.json) into the page. */
export async function loadTheme(file, doc = document) {
  const base = new URL('themes/', doc.baseURI);
  const index = await fetch(new URL('index.json', base)).then((r) => r.json());
  const entry = index.themes.find((t) => t.file === file);
  if (!entry) throw new Error(`Unknown theme ${file}; see harness/themes/index.json`);
  const theme = await loadThemeColors(new URL(file, base).href);
  const kind = kindOf(entry.uiTheme);
  applyTheme(doc, resolveColors(theme.colors, kind), kind);
  return { label: entry.label, kind };
}
