# Changelog

## 0.3.0

- Footnotes: `[^1]` references render as numbers, and Cmd/Ctrl+click jumps to the definition.
- Image resizing: drag the corner of an image to set its width.
- Full preview can now edit inline math and the target of reference-style links in the popover.
- Rich-text paste: content copied from web pages, Google Docs or Word is pasted as Markdown. Turn it off with `seamlessMarkdown.pasteRichText`.
- Tables: sort by column, duplicate and clear rows, a right-click menu, copy as Markdown or TSV, and a width cap for long cells.
- Table of contents: insert with a command or `/toc`, and it is kept up to date on save.
- Spell check setting, `seamlessMarkdown.spellCheck`, off by default.
- Lone `<img>` tags now render like Markdown images, with the tag hidden until the cursor is on it.
- Copied Excel cells now paste as a table instead of a picture.

## 0.2.0

- Math: inline `$…$` and `$$` blocks, drawn with KaTeX.
- Mermaid diagrams, drawn in place of their code block.
- A Markdown Outline panel in the Explorer.
- Copy as HTML, for the selection or the whole document.
- A `seamlessMarkdown.customCss` setting.
- The editor now allows inline styles in its content security policy, which KaTeX and Mermaid need. Scripts remain restricted.

## 0.1.1

- Added an icon and screenshots to the listing.
- Table delete buttons are labelled, with shortcuts for deleting a row or column.

## 0.1.0

First version.

- Three modes for Markdown files: raw, half preview and full preview.
- Formatting commands, toolbar and shortcuts.
- Editable tables with row and column insert, delete, move and alignment.
- Inline images, with paste and drop saved next to the document.
- Slash menu, smart paste, task checkboxes, GitHub alerts, code block copy button, heading folding, find and replace, go to heading, word count.
