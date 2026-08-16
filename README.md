<p align="center">
  <img src="images/logo-full.png" alt="Plastic SCM" width="400" />
</p>

# Plastic SCM integration with VS Code's SCM features

## Intro

`plastic-scm` is a Visual Studio Code extension that integrates
[Plastic SCM / Unity Version Control](https://www.plasticscm.com/).
With this plugin, you can use Plastic SCM as your SCM tool.

> **This is a fork** of the [official extension](https://github.com/PlasticSCM/vscode-plasticscm)
> by [Codice Software](https://www.plasticscm.com/), aimed at closing the gap with
> VS Code's built-in Git extension: per-file and per-folder actions, adding private
> files, and a status refresh that stays usable on large Unity and Unreal
> workspaces. It is not published to the Marketplace — see [Install](#install).

## Requirements

* Visual Studio Code v1.95 or higher
* Plastic SCM / Unity Version Control, with `cm` on your `PATH`

## Features

1. Lists your pending changes, grouped per Plastic workspace
2. Checkin everything at once, or select just the files you want
3. **Add private (untracked) files to source control** with the `+` button
4. **Discard changes** per file, per folder, or per selection — reverting controlled
   files and deleting private ones, to the Trash by default
5. Inline gutter indicators and full-file diffs against the current changeset,
   fetched on demand rather than on every refresh
6. Group changes to assets from Unreal Engine 5 One File Per Actor (OFPA) in the
   "Dirty Unreal Levels" resource group, coalesced under the name(s) of the
   corresponding map(s)

## Install

This fork is distributed as a `.vsix` rather than through the Marketplace.

1. Download `plastic-scm-<version>.vsix` from the
   [Releases page](https://github.com/Fedor117/vscode-plasticscm/releases)
2. Either run:

   ```bash
   code --install-extension plastic-scm-<version>.vsix
   ```

   or, in VS Code, open the **Extensions** view, click the `...` menu at the top
   of the view, choose **Install from VSIX...**, and pick the downloaded file
3. Reload *Visual Studio Code*

## Configure

|Name                                                 |Type     |Default  |Description
|-----------------------------------------------------|---------|---------|-----------
|`plastic-scm.enabled`                                |`boolean`|`true`   |Whether the extension is enabled
|`plastic-scm.autorefresh`                            |`boolean`|`true`   |Whether the extension should automatically look for changes in the workspace
|`plastic-scm.ignoredDirectories`                     |`array`  |14 names |Top-level directory names whose changes never trigger an automatic refresh. Unity and Unreal rewrite `Library`, `Temp`, `Intermediate` and friends constantly, and watching them makes the refresh run continuously without ever showing a change
|`plastic-scm.discardPrivateChangesToTrash`           |`boolean`|`true`   |Whether discarding a private item moves it to the Recycle Bin / Trash instead of deleting it permanently
|`plastic-scm.decorations.enabled`                    |`boolean`|`true`   |Whether or not file decorations are enabled
|`plastic-scm.consolidateUnrealOneFilePerActorChanges`|`boolean`|`true`   |Whether all changes under Unreal Engine 5 One File Per Actor (OFPA) should be grouped under "Dirty Unreal Levels"
|`plastic-scm.cmConfiguration.cmPath`                 |`string` |`cm`     |Location of the `cm` CLI executable
|`plastic-scm.cmConfiguration.millisToWaitUntilUp`    |`number` |`5000`   |Time to wait for the shell to start
|`plastic-scm.cmConfiguration.millisToStop`           |`number` |`5000`   |Grace time to wait for a shell to close
|`plastic-scm.cmConfiguration.millisCommandTimeout`   |`number` |`120000` |How long a single `cm` command may run before it is abandoned and the shell restarted

## Commands

### Checkin

Type a message in the SCM input field and hit `Ctrl+Enter` to check in **all**
your pending changes.

To check in **some** of them, select the rows you want in the Source Control
view, right-click and choose **Checkin**. Private files are excluded — add them
first (see below).

You can also invoke the Checkin command from the Command Palette, which prompts
for a message.

### Add to Source Control

Private (untracked) files show a `+` on hover. It runs `cm add`, which is what
makes the file eligible for a checkin — Checkin skips anything still private.
Private parent directories are added for you, outermost first.

### Discard Changes

Available per row, per folder, and on a multi-selection. For controlled files it
runs `cm undo`. For private files there is nothing for `cm` to undo, so they are
**deleted from disk** — moved to the Recycle Bin / Trash unless you set
`plastic-scm.discardPrivateChangesToTrash` to `false`.

A selection containing both asks which you meant: revert the controlled files
only, or discard everything.

**Undo All Checkouts**, in the view's title bar, is deliberately narrower: it
reverts controlled changes across the whole workspace and leaves private files
alone.

### File Changes

When editing a tracked text file, you'll see VS Code show inline gutter color
indicators for lines added, changed, or removed, as with Git. Click any modified
text file in the Source Control panel to open a full-file diff against the
current changeset.

### Show Output

Reveals the `Plastic SCM` output channel, which carries every `cm` command and
its output. Failure notifications link to it directly.

## Contribute

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request

## Credits

* [Codice Software](https://www.plasticscm.com/), for the original extension
* [Visual Studio Code](https://code.visualstudio.com/)
* [vscode-docs on GitHub](https://github.com/Microsoft/vscode-docs)

## License

[MIT](LICENSE)
