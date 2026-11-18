# Notes for Claude

Developer notes, testing and the release flow are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Shared documents never reach the repo

Documents the user shares in a session (pasted text, files, screenshots of their own work) are private. None of their content may reach the repository or GitHub: not as a sample, fixture or test, and not in a commit, pull request, issue comment or release note.

- To reproduce a bug locally, keep the document outside the repository (the session's scratchpad) or delete it as soon as you are done. Never leave it in `sample/` or `test/`.
- When a reproduction has to be committed, write a mock of the same shape (length, headings, table size, long wrapping cells, images) with invented content.
- In pull requests and issues, describe the input generically ("a long document with a seven-column table of long cells"), without quoting it.
- Before committing or posting, check that nothing from a shared document is staged or included.
