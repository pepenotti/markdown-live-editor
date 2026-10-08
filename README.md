# Seamless Markdown

**Write Markdown and see the result in the same place.** No preview pane, no switching back and forth.

![Typing Markdown, editing a table and switching between the three modes](images/demo.gif)

- **One editor, not two.** The document renders as you type. Click any element to edit it.
- **Your file stays yours.** It is always plain Markdown, and text you did not touch is never rewritten, so diffs stay clean.
- **It behaves like VS Code.** Undo, save, split editors, source control and your colour theme all work as they do for any text file.

## Get started

1. Install **Seamless Markdown**.
2. Open a Markdown file and click the preview icon in the editor title bar, or run **Seamless Markdown: Open with Seamless Markdown** from the Command Palette.
3. To use it for every Markdown file, run **Seamless Markdown: Use as Default Editor for Markdown**.

It never takes over Markdown files by itself, and it is not used in diff views.

## Three modes, one document

Switch with the buttons at the top right or `Alt+M`. Your place is kept, and each file remembers its mode.

| Mode | What you see | Best for |
| :--- | :----------- | :------- |
| **Raw** | Plain Markdown with syntax colours | Fixing syntax by hand |
| **Half preview** | The rendered document. The syntax of whatever the cursor is on appears, so you can change it | Everyday writing |
| **Full preview** | The finished document, with all syntax hidden. Links, images and formulas are edited in a small popover | Reading and light edits |

![The same document in raw, half preview and full preview](images/modes.png)

## What you can do

### Write
- Format with the toolbar, with shortcuts, or by typing Markdown.
- Type `/` at the start of a line to insert a heading, list, table, code block, image and more.
- Paste from a web page, Google Docs or Word and get Markdown. Paste a URL over selected text to make a link.
- Tick task boxes, fold sections, find and replace, and jump to any heading.

### Tables
- Click a cell and type. `Tab` and `Enter` move between cells and add rows.
- Insert, delete, move, duplicate and sort rows and columns from the bar above the table or the right-click menu.
- Paste cells copied from a spreadsheet to make a table.

![Editing a table cell](images/table.png)

### Images
- Paste or drop an image and it is saved next to the document and linked.
- Drag a corner to resize.
- In half preview, the picture stays visible while you edit its path.

![Half preview with the image path revealed under the cursor](images/half-preview.png)

### Math and diagrams
- `$x^2$` and `$$` blocks are drawn with KaTeX. A price such as $5 is left alone.
- A `mermaid` code block is drawn as a diagram. Click it to edit the source with the result underneath.

![Math and a Mermaid diagram](images/diagrams.png)

### Links and structure
- `Cmd`/`Ctrl`+click follows web links, other Markdown files and `#heading` links.
- Broken links are underlined and listed in the Problems panel: missing files, missing headings and missing reference definitions. Nothing is fetched from the network.
- A table of contents that updates itself on save. Insert it with `/toc`.
- Footnotes, GitHub alerts (`> [!NOTE]`), front matter and a **Markdown Outline** panel in the Explorer.
- Optional wiki links (`[[Note]]`) with a Backlinks panel. Off by default.

### Export and share
Use the **Export** button in the toolbar, right-click a Markdown file in the Explorer, or open the Command Palette.

- **Export as HTML** writes one self-contained file: styles, images, math and diagrams are all inside it.
- **Export as PDF** writes a PDF in one step. It needs Chrome, Edge, Chromium or Brave installed; without one, the command is not offered.
- **Copy as HTML** copies the selection or the whole document.
- **Email Document** copies the document as formatted text and opens a new email with the subject filled in; you paste. Formatting needs the file open in this editor, and local images, diagrams and math are replaced by short placeholders, because a pasted email cannot carry them.

Exported files contain no scripts and load nothing from the network.

![Full preview in a dark theme with the link popover](images/full-preview-dark.png)

---

## Reference

### Shortcuts

`Mod` is `Cmd` on macOS and `Ctrl` elsewhere. They apply only while this editor has focus, and can be changed in Keyboard Shortcuts.

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
| Fold / unfold a section | `Mod+Alt+[` / `Mod+Alt+]` |
| Find and replace | `Mod+F` |
| Indent / outdent a list item | `Tab` / `Shift+Tab` |
| Move a table row | `Alt+Up` / `Alt+Down` in a cell |
| Delete a table row / column | `Mod+Shift+Backspace` / `Mod+Alt+Backspace` in a cell |
| Duplicate a table row | `Mod+Shift+D` in a cell |
| Add another cursor | `Alt`+click |
| Paste as plain text | Hold `Shift` while pasting |

`Mod+K` is not used for links because it starts VS Code's two-key shortcuts.

### Settings

All settings start with `seamlessMarkdown.`

| Setting | Default | Meaning |
| :------ | :------ | :------ |
| `defaultMode` | `half` | Mode for files that have no remembered mode |
| `rememberModePerFile` | `true` | Reopen each file in the mode it was last used in |
| `lineWidth` | `860` | Maximum text width in the preview modes, in pixels. `0` uses the full width |
| `fontSize` | `15` | Font size of the preview modes |
| `fontFamily` | empty | Font of the preview modes. Empty uses the VS Code interface font |
| `showToolbar` | `true` | Show the toolbar |
| `customCss` | empty | Extra CSS rules for the editor |
| `spellCheck` | `false` | Turn on spell checking for the text and table cells |
| `imageFolder` | `assets` | Where pasted and dropped images are saved, relative to the document. `${fileBasenameNoExtension}` is replaced by the document name |
| `pasteRichText` | `true` | Paste formatted text as Markdown |
| `tableAutoAlign` | `true` | Re-align a table's pipes in the file when one of its cells is edited |
| `checkLinks` | `true` | Underline broken links and list them in the Problems panel |
| `toc.updateOnSave` | `true` | Update the table of contents when the file is saved |
| `toc.levels` | `1..6` | Heading levels the table of contents lists, such as `2..4` |
| `toc.ordered` | `false` | Numbered list instead of bullets |
| `wikiLinks` | `false` | Treat `[[Note]]` as a link to another Markdown file, and show the Backlinks panel |
| `export.embedImages` | `true` | Embed local images in exported HTML. When off, images keep their relative paths |
| `export.browserPath` | empty | Browser used for PDF export. Empty looks in the usual places |
| `email.to` | empty | Recipient to prefill for **Email Document** |
| `promptToSetDefault` | `true` | Ask once whether to become the default Markdown editor |

### Good to know

- **The one thing it reformats.** When you edit a table cell, that table's pipes are re-aligned in the file. Turn this off with `tableAutoAlign`.
- **Resized images become HTML.** Markdown has no syntax for a size, so a resized image is written as an `<img>` tag with a `width`.
- **Dropping files.** Hold `Shift` while dropping a file from the Explorer, as VS Code requires.
- **Outline and breadcrumbs.** VS Code does not offer its own Outline view or breadcrumb symbols to custom editors. Use the Markdown Outline panel and **Go to Heading** instead.
- **HTML in a document** is shown as source. An `<img>` tag is shown as the picture.
- **Not drawn:** diagram languages other than Mermaid, and tables that are indented or inside a list or quote.
- **No side-by-side view.** The point of the editor is that you do not need one.
- **Auto save and trailing spaces.** With both `files.autoSave` on a delay and `files.trimTrailingWhitespace` on, a trailing space can be trimmed while you pause mid-sentence.
- **Very large documents** are slower to type in for the first few seconds after opening.

### Feedback

Report problems and ideas at [github.com/pepenotti/markdown-live-editor/issues](https://github.com/pepenotti/markdown-live-editor/issues). To work on the extension, see [CONTRIBUTING.md](CONTRIBUTING.md).

Built on [CodeMirror 6](https://codemirror.net/), [KaTeX](https://katex.org/) and [Mermaid](https://mermaid.js.org/). See `THIRD-PARTY-NOTICES.md`.
