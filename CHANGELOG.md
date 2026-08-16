# Change Log

All notable changes to the "plastic-scm" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.0] - 2026-08-16

First release of this fork, aimed at closing the gap with VS Code's built-in Git
extension.

### Added

- `plastic-scm.add` ("Add to Source Control") — puts private items under source
  control, adding private ancestor directories outermost-first because `cm add`
  has no `--parents`. Private files previously had no route to a checkin at all,
  because Checkin filters them out of every selection.
- `plastic-scm.showOutput` ("Show Output") — reveals the Plastic SCM output
  channel from the Source Control title menu; failure notifications now offer a
  "Show Output" action.
- `scm/resourceFolder/context` menu — Discard Changes and Add to Source Control
  on folder rows in tree view.
- Per-resource `contextValue` tokens (`private`, `added`, `changed`, `moved`,
  `checkedout`, `deleted`, plus `file`/`text`/`binary`/`directory`) so menu
  entries vary by change type: Open File is hidden on directories, Checkin is
  hidden on private rows, Add appears only where there is something to add.
- Per-workspace source control ids (`plastic-scm:<workspace guid>`), so
  multi-root setups get one pane each.
- `plastic-scm.ignoredDirectories` (array, 14 defaults) — top-level directory
  names whose changes never trigger an automatic refresh.
- `plastic-scm.discardPrivateChangesToTrash` (boolean, default `true`) —
  discarded private items go to the Recycle Bin / Trash.
- `plastic-scm.cmConfiguration.millisCommandTimeout` (number, default `120000`)
  — a `cm` command exceeding this is abandoned and the shell restarted.
- New unit suites for `scmUtils`, `addToSourceControl`, `decodeRevision` and
  `PlasticScmResource.contextValue`.

### Changed

- **`plastic-scm.undoCheckout` retitled "Undo Checkout" → "Discard Changes"**,
  and widened: private items are now deleted from disk (to Trash by default)
  because `cm undo` cannot roll back a file it does not track. A mixed selection
  prompts for revert-controlled-only or discard-everything. The command id is
  unchanged, so keybindings survive.
- Previous revisions are fetched on demand through a new `plastic:` URI scheme
  instead of being prefetched for every changed file on each refresh — a refresh
  is now one `cm status` call rather than N `cm getfile` round trips.
- Binary/text/directory now comes from `cm status`'s `<RevisionType>`; the
  `isbinaryfile` dependency and its per-file disk read are gone.
- Status autorefresh switched from throttling every 1000 ms to debouncing at
  1500 ms; the 100 ms busy-wait on the `cm` shell is gone.
- Concurrent `cm` commands are queued and serialized instead of failing with
  "Shell was busy".
- `activationEvents` narrowed from `"*"` to `onStartupFinished` +
  `workspaceContains:**/.plastic/plastic.workspace`.
- Errors surface `cm`'s own message instead of "Command execution failed.", with
  blank lines dropped and output capped at 50 lines.
- Clicking a binary or directory row no longer attempts a diff.
- `@vscode/test-electron` ^2.5.2 → ^3.1.0, `@vscode/vsce` ^3.6.0 → ^3.9.2.

### Fixed

- "Undo All Checkouts" reverted only the workspace root directory item and left
  every changed file below it pending; it now runs `cm undo <root> -r`.
- A failed operation latched as permanently "running", silently disabling
  autorefresh for the rest of the session.
- A hung `cm` command left the shell busy forever; every later command failed
  until the window was reloaded.
- A `cm` shell stopped while a command was still in flight could resurrect
  itself minutes later, spawning an orphaned process for a disabled extension.
- SCM multi-selection acted on a single resource — VS Code spreads selected
  resources as separate arguments, which `getSelectedResources` did not handle.
  Open File and Refresh were registered with a single-parameter handler and are
  now on the same footing.
- Diffs of files with a byte order mark reported line 1 as modified, because the
  revision was decoded as plain UTF-8 while VS Code strips the BOM from the
  working copy. UTF-16 revisions decoded as mojibake.
- Workspace lookup by path used a bare prefix match, so `/dev/ProjectAlt` was
  claimed by a workspace at `/dev/Project`.
- `StatusParser` merged compound changes with `changes.get(uri.fsPath)` against a
  map keyed by `uri.path`, so on Windows a file reported under two change types
  kept only the last.
- `PlasticScmResource.isPrivate` used `===` against a bitflag, so a
  private-and-something-else file was not treated as private.
- `stop()` never waited for or killed the `cm` process (`ChildProcess.connected`
  is always false on a pipe-only spawn); stdout/stderr handlers were left
  attached to the dead process.
- The shell-startup timeout warning printed a literal `{this.mShellConfig...}`
  instead of the number of seconds.
- Open File no longer tries to open directory rows.
- `.vscodeignore` did not exclude agent/tooling state, so a local `vsce package`
  could ship a 106 MB package instead of 1.1 MB.
