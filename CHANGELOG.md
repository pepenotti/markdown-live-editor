# Changelog

## 0.5.0

- Export is now reachable from an Export button in the toolbar, the Explorer right-click menu and the Command Palette for any Markdown file, and always reports what it did.
- Export as PDF writes the PDF in one step, using an installed Chrome, Edge, Chromium or Brave. Without one, the command is not offered. The print-from-browser route is gone.
- Exported HTML and PDF now contain Mermaid diagrams as drawn images and math typeset with KaTeX. Exported files contain no scripts.
- Email Document: copies the document as formatted text and opens a new email to paste it into.
- Removed the `seamlessMarkdown.export.mermaidFromCdn` setting.
- A shorter README, with developer notes moved to CONTRIBUTING.md.

## 0.4.0

- Broken link checking: links to missing files, headings and reference definitions are underlined and listed in the Problems panel, with a quick fix for mistyped heading links. Nothing is fetched from the network. Turn it off with `seamlessMarkdown.checkLinks`.
- Export as HTML: one self-contained file with embedded styles and images, math, footnotes and alerts.
- Export as PDF: through an installed Chrome or Edge when there is one, otherwise through the browser's print dialog.
- Wiki links and a Backlinks panel, behind `seamlessMarkdown.wikiLinks` (off by default): `[[Note]]`, `[[Note|text]]` and `[[Note#Heading]]`, with completion and a prompt to create a missing note.
- Heading links for repeated headings now number the way GitHub does when a heading already ends in a number.

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
