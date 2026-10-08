// Style sheet embedded in exported HTML: readable, GitHub-like, light with a dark variant.

const LIGHT = `--fg:#1f2328;--bg:#fff;--muted:#59636e;--border:#d1d9e0;--soft:#f6f8fa;--code:#eff1f3;--link:#0969da;
--k:#cf222e;--s:#0a3069;--n:#0550ae;--f:#8250df;--t:#953800;--g:#116329;
--note:#0969da;--tip:#1a7f37;--important:#8250df;--warning:#9a6700;--caution:#cf222e`;
const DARK = `--fg:#f0f6fc;--bg:#0d1117;--muted:#9198a1;--border:#3d444d;--soft:#151b23;--code:#262c36;--link:#4493f8;
--k:#ff7b72;--s:#a5d6ff;--n:#79c0ff;--f:#d2a8ff;--t:#ffa657;--g:#7ee787;
--note:#4493f8;--tip:#3fb950;--important:#ab7df8;--warning:#d29922;--caution:#f85149`;

const BASE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";word-wrap:break-word}
.markdown-body{max-width:860px;margin:0 auto;padding:32px 24px 64px}
.markdown-body>:first-child{margin-top:0}
.markdown-body>:last-child{margin-bottom:0}
h1,h2,h3,h4,h5,h6{margin:1.5em 0 .65em;font-weight:600;line-height:1.25}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid var(--border)}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--border)}
h3{font-size:1.25em}
h4{font-size:1em}
h5{font-size:.875em}
h6{font-size:.85em;color:var(--muted)}
p,blockquote,ul,ol,dl,table,pre,details,.math-block{margin:0 0 1em}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
strong{font-weight:600}
img{max-width:100%;height:auto;vertical-align:middle}
hr{height:.25em;margin:1.5em 0;border:0;background:var(--border)}
blockquote{padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
blockquote>:last-child{margin-bottom:0}
.alert{padding:.5em 1em;color:inherit;border-left-color:var(--alert)}
.alert-title{color:var(--alert)}
.alert-note{--alert:var(--note)}
.alert-tip{--alert:var(--tip)}
.alert-important{--alert:var(--important)}
.alert-warning{--alert:var(--warning)}
.alert-caution{--alert:var(--caution)}
.footnote-ref{font-size:.75em;line-height:0}
.footnotes{margin-top:2em;padding-top:1em;font-size:.875em;color:var(--muted);border-top:1px solid var(--border)}
.footnotes li:target{color:var(--fg)}
.footnote-back{font-family:"Segoe UI Symbol","Apple Symbols",sans-serif}
ul,ol{padding-left:2em}
li+li{margin-top:.25em}
li>ul,li>ol{margin:.25em 0 0}
li>p{margin-bottom:.5em}
.contains-task-list{list-style:none;padding-left:1.4em}
.contains-task-list .contains-task-list{padding-left:2em}
.task-list-item input{margin:0 .4em .2em 0;vertical-align:middle}
code,pre,kbd,samp{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.85em}
code{padding:.2em .4em;border-radius:6px;background:var(--code)}
pre{padding:1em;overflow:auto;line-height:1.45;border-radius:6px;background:var(--soft)}
pre code{padding:0;font-size:1em;background:none;white-space:pre}
kbd{padding:.15em .4em;border:1px solid var(--border);border-bottom-width:2px;border-radius:6px;background:var(--soft)}
table{display:block;width:max-content;max-width:100%;overflow:auto;border-spacing:0;border-collapse:collapse}
th,td{padding:6px 13px;border:1px solid var(--border)}
th{font-weight:600}
thead tr,tbody tr:nth-child(2n){background:var(--soft)}
.math-block{overflow-x:auto;overflow-y:hidden;text-align:center}
math{font-size:1.1em}
.katex-error{color:var(--k)}
.diagram{margin:0 0 1em;text-align:center;overflow-x:auto}
.diagram svg{max-width:100%;height:auto}
.katex-display{margin:0}
.tok-comment,.tok-meta{color:var(--muted)}
.tok-keyword,.tok-operator,.tok-deleted{color:var(--k)}
.tok-string,.tok-string2,.tok-url,.tok-link{color:var(--s)}
.tok-number,.tok-atom,.tok-bool,.tok-literal,.tok-propertyName,.tok-labelName{color:var(--n)}
.tok-definition,.tok-macroName{color:var(--f)}
.tok-className,.tok-namespace{color:var(--t)}
.tok-typeName,.tok-inserted{color:var(--g)}
.tok-heading,.tok-strong{font-weight:600}
.tok-emphasis{font-style:italic}
`;

const PRINT = `
@page{margin:18mm 16mm}
@media print{
body{font-size:11pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.markdown-body{max-width:none;padding:0}
h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;break-inside:avoid;page-break-inside:avoid}
p,li{orphans:3;widows:3}
pre,blockquote,img,svg,tr,.math-block,.diagram,.footnotes li{break-inside:avoid;page-break-inside:avoid}
pre,pre code{white-space:pre-wrap;overflow-wrap:anywhere}
pre{overflow:visible}
table{display:table;width:auto;overflow:visible}
thead{display:table-header-group}
a{text-decoration:underline}
}
`;

/** The style sheet of an exported document. The print variant has no dark colours. */
export function exportCss(print: boolean): string {
  // Diagrams are drawn in light colours, so on a dark page they sit on a light card.
  const dark = print ? '' : `@media (prefers-color-scheme:dark){:root{color-scheme:dark;${DARK}}.diagram{padding:12px;border-radius:6px;background:#fff;color:#1f2328}}\n`;
  return `:root{color-scheme:${print ? 'only light' : 'light dark'};${LIGHT}}\n${dark}${BASE.trim()}\n${PRINT.trim()}\n`;
}
