# Change Log

All notable changes to the "plastic-scm" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Changed

- The end-to-end review tests run on every test run, against a synthetic Plastic server.

## [0.4.0] - 2026-09-23

### Added

- **Plastic Reviews**, a new container in the Activity Bar for browsing Plastic
  code reviews with the installed `cm` client and its existing login. Nothing
  else to install or sign in to. It has three views:
  - **Reviews**: Needs My Review (assigned to you, or you are a requested
    reviewer), Rework Requested and Waiting for Reviewers (your own), All Open,
    and All Reviews (everyone's, in any status). The last two page 50 at a time.
    **Find Review…** searches the newest 2,000 reviews in the repository by
    title, number, author, assignee, status or branch.
  - **Review**: the selected review's Overview, Changes, Merged from other
    branches and Changesets. A branch review compares the branch base (the
    parent of its first changeset) with its head, as `cm diff br:` does, and
    both sides are named in every diff title. Files that changed only through
    merges are listed apart. Each file has a viewed checkbox, kept per file
    revision.
  - **Discussions**: every thread, grouped by file, then General.
- **Review comments in diffs**: questions, change requests (with applied or
  discarded state) and comments appear as threads on their lines. A thread on an
  older revision moves to the matching line, and one whose line is gone opens in
  an `outdated` diff, or in its original changeset.
- **Overview page**: clicking a review opens a themed page in VS Code's Markdown
  preview editor. It shows where the review stands, a card per reviewer with
  their verdict, the open change requests and questions, the conversation, the
  changesets and the history. File names and `File.cs:18` references on it open
  the diff or the discussion.
- **Set Review Status…** (Under review, Rework required, Reviewed) through
  `cm codereview`. It asks before marking a review Reviewed with pending change
  requests or unviewed files.
- The open review is checked for updates every minute while it is on screen.
  A **Review updated** row says what changed, and **Load Updates** applies it.
- Experimental comment posting to Unity Version Control cloud repositories,
  off by default (`plastic-scm.reviews.experimentalPosting`). See the README
  before relying on it.

### Fixed

- Two VS Code windows fetching the same revision could truncate each other's
  cached copy. Each fetch now writes to its own temporary file before the rename.

### Changed

- Test fixtures and examples use made-up data only.

## [0.3.1] - 2026-09-08

### Changed

- **The graph lists both branches in one sequence, newest first, like VS Code's
  Git graph**, instead of the current branch's changesets followed by the
  parent's. Each branch keeps its own column, and a merge is a line from the
  changeset it produced into the source's column. A single **Load more** row
  pages the branch that bounds what can be shown; rows of the other branch from
  below that point are held back until then, so a column never looks empty just
  because its page has not loaded.

### Fixed

- **Merges from a branch that is not one of the two lanes were invisible.** They
  are now drawn as a short grey hook ending in a dot on the changeset they
  produced, and every changeset a link touches explains it in its tooltip
  ("Merged from /main/release_2 cs:3591", "Merged into /main cs:3597").
- The last loaded changeset of the current branch bent its line toward the parent
  branch as if it were the fork, even when more pages were left to load.
- Merge links are now loaded for a branch without a parent lane too, so merges
  into `/main` show up on it.

## [0.3.0] - 2026-09-07

### Added

- **Plastic SCM Graph** view in the Source Control pane, modelled on VS Code's
  Git graph: the current branch and its parent branch as a lane graph with
  branch labels, a marker on the loaded changeset, and merge / cherry-pick links
  between the lanes. Click a changeset to expand the files it changed (`A`/`C`/
  `M`/`D` badges); click a file to diff it against the parent changeset. Each
  branch pages independently ("Load more"), the title bar has **Refresh Graph**,
  and the context menu offers **Copy Changeset Id**, **Copy Comment**, **Open
  Changes** and **Open File**.
- `plastic-scm.history.pageSize` (number, default `50`, 10–500) — changesets
  fetched per branch on each page of the graph.
- Revision content by id (`plastic:` URIs carrying a `revid`), so history diffs
  can show deleted and moved files that no longer exist at any workspace path.
  Cached under `.plastic/fileCache/revisions`, pruned after 24 hours.

### Changed

- History queries run on a dedicated read-only `cm shell` per workspace, so they
  never queue in front of a status refresh or a checkin.
- Changeset 0 now counts as a valid loaded changeset instead of "unknown".

### Fixed

- A `cm shell` that timed out while starting left its process behind: disposing
  the shell now kills it whether or not the start handshake completed.
- A diff whose `cm getfile` was interrupted cached the half-written file and
  served it as the revision from then on. Cached content is now published by
  rename, so an entry either holds the whole revision or is absent.

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
