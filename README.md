# Seamless Markdown

A Markdown editor for VS Code that removes the need for a separate preview. You edit one document and choose how much of the syntax you want to see.

![Typing Markdown, editing a table and switching between the three modes](images/demo.gif)

![The same document in raw, half preview and full preview](images/modes.png)

| Mode | What you see | How you edit |
| :--- | :----------- | :----------- |
| **Raw** | Plain Markdown with syntax colours | Like any text file |
| **Half preview** | The rendered document. The syntax of the element under the cursor appears so you can change it. Images stay visible while you edit their path | Type Markdown, or use the toolbar and shortcuts |
| **Full preview** | The finished document. Syntax stays hidden | Type text; links and images are edited in a small popover, everything else with the toolbar and shortcuts |

Switching modes is instant and keeps your place. The mode is remembered per file.

In half preview, the element under the cursor shows its Markdown. Here the cursor is in the image path, and the image stays visible:

![Half preview with the image path revealed under the cursor](images/half-preview.png)

Tables are edited in place, with a bar for rows, columns and alignment:

![Editing a table cell](images/table.png)

Math and Mermaid diagrams are drawn in place. Here the cursor is in the formula, so its source shows above the result:

![Math and a Mermaid diagram](images/diagrams.png)

Full preview hides all syntax; links and images are edited in a popover. It follows your colour theme:

![Full preview in a dark theme with the link popover](images/full-preview-dark.png)

The file on disk is always plain Markdown. The editor never rewrites text you did not touch: opening and saving a file leaves it byte for byte the same. The only reformatting it does is to re-align the pipes of a table whose cell you edited (this can be turned off).

## Getting started

1. Install the packaged extension:

   ```bash
   code --install-extension seamless-markdown-0.2.0.vsix
   ```

2. Open a Markdown file, then click the preview icon in the editor title bar, or run **Seamless Markdown: Open with Seamless Markdown** from the Command Palette.
3. To use it for every Markdown file, run **Seamless Markdown: Use as Default Editor for Markdown**. **Seamless Markdown: Stop Using as Default Editor** reverts this.

The extension never becomes the default by itself, and it is not used in diff views.

To try it without installing, run it from this folder:

```bash
code --extensionDevelopmentPath="$PWD" sample
```

## Features

- **Formatting**: bold, italic, strikethrough, inline code, headings, bullet, numbered and task lists, quotes, code blocks, links, rules. By typing Markdown, by shortcut, or from the toolbar.
- **Tables**: rendered as a grid in both preview modes. Click a cell to edit it. `Tab` and `Shift+Tab` move between cells, `Enter` moves down, and both add a row at the end. Arrow keys move in and out of the table. A small bar above the table inserts, deletes and moves rows and columns, sets column alignment, and shows the table's Markdown source.
- **Images**: shown inline, with relative paths resolved from the document. Paste an image from the clipboard or drop one in and it is saved to an `assets` folder next to the document and linked. Dragging a file from the Explorer links it without copying (hold `Shift` while dropping, as VS Code requires). File paths are completed as you type the target of a link or image.
- **Math**: `$x^2$` inline and `$$` blocks, drawn with KaTeX. A price such as $5 is left alone.
- **Mermaid diagrams**: a `mermaid` code block is drawn as a diagram. Click a diagram or formula block, or move into it with the arrow keys, to edit its source with the result shown underneath.
- **Slash menu**: type `/` at the start of a line to insert a heading, list, quote, code block, table, image, link or divider.
- **Smart paste**: pasting a URL over selected text makes a link; pasting cells copied from a spreadsheet makes a table.
- **Links**: `Cmd`/`Ctrl`+click opens web links in the browser, relative `.md` links in this editor, and `#heading` links jump within the document.
- **Task lists** with clickable checkboxes, **GitHub alerts** (`> [!NOTE]`), **code blocks** with syntax colours and a copy button, **front matter** shown as a tidy block.
- **Outline**: a "Markdown Outline" panel in the Explorer lists the headings; click one to jump to it.
- **Copy as HTML**: copies the selection, or the whole document, as HTML.
- **Find and replace**, **Go to Heading**, **folding** of the section under a heading (hover a heading and click the arrow in the margin), word count and reading time in the status bar.
- Follows the VS Code colour theme, and works with undo, redo, save, hot exit, split editors and source control exactly like a text file, because it edits the same text document.

## Shortcuts

`Mod` is `Cmd` on macOS and `Ctrl` elsewhere. All of them apply only while this editor has focus and can be changed in Keyboard Shortcuts.

| Action | Shortcut |
| :----- | :------- |
| Switch to the next mode | `Alt+M` |
| Bold / italic | `Mod+B` / `Mod+I` |
| Strikethrough | `Alt+Shift+5` |
| Inline code | `Mod+E` |
| Insert or edit link | `Mod+L` |
| Bullet / numbered list | `Mod+Shift+8` / `Mod+Shift+7` |
| Quote | `Mod+Shift+9` |
| Tick or untick a task | `Alt+C` |
| Heading level up / down | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| Go to heading | `Mod+Shift+O` |
| Fold / unfold the section at the cursor | `Mod+Alt+[` / `Mod+Alt+]` |
| Find and replace | `Mod+F` |
| Indent / outdent a list item | `Tab` / `Shift+Tab` |
| Move a table row | `Alt+Up` / `Alt+Down` in a cell |
| Delete a table row / column | `Mod+Shift+Backspace` / `Mod+Alt+Backspace` in a cell |
| Add another cursor | `Alt`+click |

`Mod+K` is not used for links because it starts VS Code's two-key shortcuts.

## Settings

| Setting | Default | Meaning |
| :------ | :------ | :------ |
| `seamlessMarkdown.defaultMode` | `half` | Mode for files that have no remembered mode |
| `seamlessMarkdown.rememberModePerFile` | `true` | Reopen each file in the mode it was last used in |
| `seamlessMarkdown.lineWidth` | `860` | Maximum text width in the preview modes, in pixels. `0` uses the full width |
| `seamlessMarkdown.fontSize` | `15` | Font size of the preview modes |
| `seamlessMarkdown.fontFamily` | empty | Font of the preview modes. Empty uses the VS Code interface font |
| `seamlessMarkdown.showToolbar` | `true` | Show the toolbar |
| `seamlessMarkdown.imageFolder` | `assets` | Where pasted and dropped images are saved, relative to the document. `${fileBasenameNoExtension}` is replaced by the document name |
| `seamlessMarkdown.tableAutoAlign` | `true` | Re-align a table's pipes when one of its cells is edited |
| `seamlessMarkdown.customCss` | empty | Extra CSS rules for the editor |
| `seamlessMarkdown.promptToSetDefault` | `true` | Ask once whether to become the default Markdown editor |

## Known limitations

- VS Code does not offer its own Outline view, breadcrumb symbols or find widget to custom editors. Use the Markdown Outline panel, **Go to Heading** and the editor's find panel instead.
- HTML is shown as source. `<img>` tags get an image preview next to them.
- Diagrams other than Mermaid (Graphviz, ECharts and so on) are not drawn. Inline math cannot be edited in full preview; switch to half preview for that.
- There is no side-by-side split view. The point of the editor is that you do not need one.
- Tables that are indented or sit inside a list or quote are shown as source.
- In full preview, a reference-style link (`[text][label]`) shows its target read-only; edit it in half preview. An empty code block cannot be entered with the arrow keys; use the toolbar button, which puts the cursor inside.
- Typing is sent to VS Code in short bursts so that one burst is one undo step. If you have both `files.autoSave` with a delay and `files.trimTrailingWhitespace` on, a trailing space can be trimmed while you pause in the middle of a sentence, because VS Code cannot see the cursor of a custom editor.
- Very large documents (several thousand lines) are slower to type in for the first few seconds after opening, while the document is still being parsed.

## Development

```bash
npm install
npm run build              # bundles into dist/
npm test                   # unit tests
npm run test:integration   # runs the editor inside a real VS Code
npm run package            # produces the .vsix
npm run screenshots        # regenerates the icon and README images
npm run demo-gif           # regenerates the animated demo
```

`npm run harness` serves the project on port 5173. `http://localhost:5173/harness/index.html?doc=features.md&mode=half&theme=dark` runs the editor in a plain browser against a stand-in for the extension host, which is the quickest way to work on rendering.

How it is put together:

- `src/extension` is the extension host side: a `CustomTextEditorProvider`, document sync, image and link handling, commands.
- `src/webview` is the editor: CodeMirror 6 with the Lezer Markdown parser. The three modes are three levels of decoration over the same text, so nothing is ever converted to another format and back.
- `src/shared` holds the message protocol between the two.

### Releasing

`main` is protected: changes go in through a pull request, and the CI check has to pass.

1. On a branch, bump the version and describe it in `CHANGELOG.md` under a `## x.y.z` heading:

   ```bash
   npm version patch --no-git-tag-version
   ```

2. Open a pull request and merge it once CI is green.
3. On an up-to-date `main`, create and push the tag:

   ```bash
   npm run release:tag
   ```

The tag starts the Release workflow. It runs the tests again, builds the `.vsix`, creates a GitHub release with the `.vsix` attached and that version's changelog as notes, and publishes to the Marketplace if the repository has a `VSCE_PAT` secret. Without the secret it stops after the GitHub release, and `npx vsce publish --no-dependencies` publishes by hand.

### Checks that still need a person

The automated tests cover document sync, undo and redo, CRLF files, split editors, CSP, image saving and link handling inside a real VS Code. These need a human at the keyboard:

- `Mod+B` formats text and does not toggle the side bar; `Mod+S` saves; `Mod+Z` undoes one burst of typing.
- Pasting an image from the clipboard and dropping one from the desktop with `Shift` held.
- The look of the editor in your own colour theme.

## Credits

Built on [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/), both MIT licensed. See `THIRD-PARTY-NOTICES.md`.
