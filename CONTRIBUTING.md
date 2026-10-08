# Contributing to Seamless Markdown

Notes for working on the extension itself. For how to use it, see the [README](README.md).

## Building and testing

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

## Releasing

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

The tag starts the Release workflow. It runs the tests again, builds the `.vsix`, creates a GitHub release with the `.vsix` attached and that version's changelog as notes, and publishes to the Marketplace if the repository has a `VSCE_PAT` secret and to [Open VSX](https://open-vsx.org) if it has an `OVSX_PAT` secret. A registry without its secret is skipped with a notice, and `npx vsce publish --no-dependencies` or `npx ovsx publish <file>.vsix -p <token>` publishes by hand. The two registries are independent: if one publish fails, the other still runs and the workflow ends as failed.

To publish a tag again, for example after adding a secret that was missing, run the workflow by hand with the tag:

```bash
gh workflow run release.yml -f tag=v0.2.0
```

Running it again is safe. An existing GitHub release gets the `.vsix` uploaded over its asset, and a registry that already has that version is skipped with a notice. A manual run uses the workflow file from `main` and the code from the tag.

### Open VSX, one time

Open VSX is the registry used by Cursor, VSCodium, Windsurf and other editors built on VS Code. Before the first publish the repository owner has to do this once, following [Publishing Extensions](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions) in the Open VSX wiki:

1. Create an Eclipse account at <https://accounts.eclipse.org/user/register> and fill in its **GitHub Username** field with the GitHub account you will use on open-vsx.org.
2. Log in to <https://open-vsx.org> with that GitHub account.
3. In [Settings, Profile](https://open-vsx.org/user-settings/profile), click **Log in with Eclipse**, then **Show Publisher Agreement**, read it and click **Agree**.
4. In [Settings, Access Tokens](https://open-vsx.org/user-settings/tokens), generate a token and copy it. It is shown only once.
5. Create the namespace, which is the `publisher` in `package.json`. A publish fails until the namespace exists:

   ```bash
   npx ovsx create-namespace pepenotti -p <token>
   ```

6. Store the token as a repository secret. The command asks for the value, so it stays out of the shell history:

   ```bash
   gh secret set OVSX_PAT --repo pepenotti/markdown-live-editor
   ```

Creating the namespace does not make you its verified owner. To have the extension shown as verified, claim the namespace as described in [Namespace Access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

## Checks that still need a person

The automated tests cover document sync, undo and redo, CRLF files, split editors, CSP, image saving and link handling inside a real VS Code. These need a human at the keyboard:

- `Mod+B` formats text and does not toggle the side bar; `Mod+S` saves; `Mod+Z` undoes one burst of typing.
- Pasting an image from the clipboard and dropping one from the desktop with `Shift` held.
- The look of the editor in your own colour theme.
