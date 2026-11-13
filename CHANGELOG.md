# Change Log

All notable changes to the "plastic-scm" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.6.0] - 2026-11-13

### Added

- **Branch Explorer**. **Plastic SCM: Open Branch Explorer** (Source Control title bar, Graph and
  Repository view title bars, Command Palette) opens an editor tab with the changesets of every
  branch of the repository in one list, newest first, with a lane graph: one colour per branch,
  merge and cherry-pick links dashed, branch heads and labels as pills, the workspace's changeset
  marked. The toolbar narrows it to all branches, the current branch and everything it descends
  from, or a picked set of branches; filters the loaded changesets as you type by comment, branch,
  author, label or `cs:` number; filters by author; and **Search repository** searches every
  changeset by comment text or number (`cm find changeset "where comment like ..."`,
  case-sensitive, newest 200). Selecting a changeset shows its comment, parent, merge sources and
  files; clicking a file opens its diff. The context menu switches the workspace to the changeset
  or its branch, creates a branch, a label or a code review from it, compares it with the selected
  or the workspace's changeset, and copies its id, branch or comment. Changesets load 300 at a
  time as you scroll, on a separate `cm shell`. Tested against a synthetic history only.
- **Reviews: create and manage reviewers**. **Create Code Review…** (Reviews view title bar,
  Repository branch rows, Branch Explorer rows, Command Palette) creates a review of the current
  branch, a picked branch or a picked changeset with a title, an optional description (passed in a
  file) and reviewers (`cm codereview <spec> <title>`). **Add Reviewers…**, **Remove Reviewers…**
  and **Request Review Again…** (the Review view's `…` menu, a review's context menu, Command
  Palette) manage the reviewers of a review with `cm codereview reviewer add|remove|list` and
  `cm codereview review --re-request`; the open review reloads afterwards. They need a `cm` that
  has those commands and say so when it does not. Tested with a mocked `cm` only.
- **File history, annotate and comparisons**. **Show File History** (Explorer, editor, SCM rows and
  the Graph's file rows) fills a **File History** view with the revisions of a file
  (`cm history --moveddeleted`); each revision offers Open Changes (against the previous
  revision), Compare with Workspace File, Open File at Revision, Copy Changeset Id and **Revert to
  This Revision** (`cm revert`, with confirmation). **Toggle Annotate (Blame)** shows owner,
  changeset and date per line (`cm annotate`) with a hover for the comment and links to the
  changeset's changes; it clears on toggle, close and edit, and explains binary, uncontrolled,
  unsaved and locally changed files. **Compare Changesets...** and **Show Branch Changes...**
  (`cm diff cs:A cs:B`, `cm diff br:X`) list the differing files in a **Comparison** view that opens
  the Graph's diff editors. The branch/changeset diff is now one shared wrapper
  (`DiffChangeset.runSpec`), which the reviews use as well.
- **Locks, checkout, tracked delete and move, ignore rules**. **Checkout** (`cm checkout`, in the
  SCM row, Explorer and editor title context menus, multi-select aware) takes an exclusive lock
  when the server's lock rules match; if somebody else holds the lock the message names the
  holder. A **Locks** section in the Plastic SCM Repository view lists `cm lock list` grouped as
  *Mine* and *Others* with path, owner, branch and status, with **Refresh Locks**, **Release
  Lock** and **Remove Lock** (both ask first; a warning names the owner when the lock is not
  yours). Files locked by you or by someone else get a badge in the Explorer and the SCM list; the
  lock list is read at most once a minute or on refresh. **Delete (Plastic SCM)** (`cm remove`)
  and **Rename/Move (Plastic SCM)…** (`cm move`) are explicit commands in the Explorer and SCM row
  menus; Explorer renames and deletes are not intercepted. **Add to Ignore List**, **Add to Hidden
  Changes List** and **Add to Cloaked List** append a rule (this item, by name, by extension or the
  parent folder) to `ignore.conf`, `hidden_changes.conf` or `cloaked.conf` at the workspace root,
  never twice, and **Open ignore.conf / hidden_changes.conf / cloaked.conf** open them. In pending
  changes, added files open the file, deleted files open their base revision read-only and moved
  files diff the old path against the new one.
- **Shelves**: **Shelve Pending Changes…** (Source Control title menu) and **Shelve Selected
  Changes…** (right-click on changed files) create a shelve with a comment, then offer to undo the
  shelved changes in the workspace. In the Repository view, a shelve expands to its files, a click
  opens a diff against the changeset it was made on, and **Apply Shelve…**, **Delete Shelve…**
  (asks first) and **Copy Shelve Id** are on its row. Switching or updating with pending changes
  has a new choice, **Shelve changes and continue**, which shelves and undoes the changes, runs
  the switch or update and tells you the shelve to apply (**Apply Shelve Now**). Applying runs
  `cm shelveset apply --dontcheckout` and warns first when the workspace has changes in files the
  shelve also changes, because `cm` may then open its merge tool outside VS Code.
- **Plastic SCM Repository**, a new view in the Source Control pane that lists the branches,
  labels and shelves of each workspace's repository, newest first, 50 at a time with
  **Load More**. Sections query `cm` only when expanded, the branch, label or shelve the
  workspace is on is marked *current*, and **Refresh Repository** is in the title bar.
- **Switch, branches, labels and update**, so a normal day no longer needs the desktop app for
  them. **Switch to Branch…**, **Switch to Changeset…** and **Switch to Label…** (`cm switch`),
  **Create Branch…** from the current changeset, a changeset, a label or the head of a branch,
  **Create Branch and Switch…**, **Rename Branch…**, **Delete Branch…**, **Edit Branch Comment…**,
  **Create Label…**, **Rename Label…**, **Delete Label…** and **Update Workspace** (`cm update`)
  are in the Command Palette and on the Repository view's rows and section headers. Names are
  checked before `cm` is called. Deleting asks first and names the target; the branch or label the
  workspace is on cannot be deleted.
- Switching or updating with pending changes asks first, because `cm shell` cannot answer `cm`'s
  own question about them and the extension runs the command with `--noinput`. `cm help switch` and
  `cm help update` say that this disables bringing the pending changes along, and nothing more: the
  dialog says so and offers Continue or Cancel. Updating a workspace on a changeset or label asks
  too, because it moves the workspace to that one's branch (`cm update --last`).
- Switch and update show a progress notification and have no time limit.
- The **status bar entry** of the workspace now opens a menu (switch to a branch, changeset or
  label, create a branch, update the workspace) instead of only focusing the Source Control view.
  When the Graph has seen newer changesets on the workspace's branch, a second entry,
  **Update**, runs Update Workspace; the Source Control title bar has an **Update** button too.

### Changed

- The Unreal levels rows in Source Control have a tooltip naming the level and what changed,
  instead of "Hello".
- The checkin box of a workspace on a label or a shelve says in plain words that checking in needs
  a branch or a changeset and points at **Switch to Branch…**, instead of an apology with an emoji.
- `plastic-scm.cmConfiguration.millisCommandTimeout` set to `0` (or less) now means "no
  timeout"; before, every command timed out at once.

### Fixed

- **Crashes and hangs**: a `cm` that exits or breaks its pipe while a command runs now fails that
  command and restarts the shell instead of blocking every later command. Switch and update are
  bounded at two hours instead of having no timeout. A `millisCommandTimeout` above 2^31-1 ms is
  clamped (Node used to fire it after 1 ms). `cm lock list` is limited to the workspace's repository
  and, after one failure, stops running automatically until **Refresh Locks** succeeds.
- **Pending changes**: the switch/update question and **Shelve changes and continue** now count
  every pending change, including Unreal One-File-Per-Actor ones that the Source Control view
  groups. If **Create Branch and Switch** fails after changes were shelved, the message naming the
  shelve still appears.
- **Shelves**: **Undo Changes** after a shelve leaves files written since the shelve alone. Applying
  a shelve over pending changes to the same files is refused (cm would wait on a merge prompt the
  extension cannot answer); a timed-out apply says the workspace may be partly applied.
- **Delete (Plastic SCM)** warns when the items have uncommitted changes (Undo only restores the
  checked-in revision) and skips items that are already deleted with another flag set.
- **Locks**: releasing a lock refreshes afterwards and a failed listing no longer reports a
  successful release as failed; a checkout refreshes the lock list at once; two locks on the same
  item no longer clash in the Locks view or inherit each other's "mine" flag.
- **Revert to This Revision** refreshes the status and checks unsaved editor buffers before deciding
  to warn about overwriting changes.

### Known limitations

- Hidden changes as a separate collapsed group, and an optional setting that routes Explorer
  renames and deletes through `cm move`/`cm remove` (use **Delete (Plastic SCM)** and
  **Rename/Move (Plastic SCM)** meanwhile).
- The incoming-changes status-bar entry updates only while the Graph view is visible.
- The Shelves section still runs one `cm find shelve` per page; very large repositories can be slow.

## [0.5.1] - 2026-11-12

### Fixed

- The review Overview can no longer be scrolled past its end until the page is blank: it ends at
  its last line, whatever `editor.scrollBeyondLastLine` says. Other Markdown previews are unchanged.

## [0.5.0] - 2026-11-12

### Added

- **Add Me as Reviewer** (behind `plastic-scm.reviews.commentWrites`) adds the
  user `cm` is signed in as to a review's reviewers with `cm codereview reviewer add`. It is in the
  Review view's title bar, a review's context menu, the Command Palette and the Overview. The title
  bar and the Overview offer it only when you are not the review's author, its assignee or already
  requested; the context menu and the Command Palette say why when you can't be added.
- With review writes on, **Set Review Status…** sets your own status as a reviewer with
  `cm codereview review`, adding you as a reviewer first when you could be added. The review's
  author and assignee, and everyone while review writes are not available, still set the review's
  status with `cm codereview -e --status`. When the add fails, **Set Status Without Adding** sets
  the review's status instead, and so does **Set the Review's Status** when `cm` refuses your own.
  With writes off, nothing changes.
- **Open in Unity Version Control** opens a review in the desktop app through a `plastic://`
  code-review link. It is on a review's context menu and the Review view's `…` menu, and does not
  need the writes setting.
- A notification says when a check finds something new in the open review: new or changed comments
  and who wrote them, removed comments, new changesets on the branch and a new status. **Load
  Updates** loads them and **Show Discussions** brings the Discussions view to the front. Each
  change is announced once, and comments by the user `cm` is signed in as, including those posted
  from the extension, are not announced. `plastic-scm.reviews.notifyUpdates` turns the
  notifications off.
- `plastic-scm.reviews.updateCheckInterval` sets the seconds between two checks for changes
  (default 60, at least 15; `0` turns the checks off). It applies without a window reload.
- **Edit** and **Delete** on your own review comments (behind
  `plastic-scm.reviews.commentWrites`), with `cm codereview comment edit` and
  `cm codereview comment delete`. In a review diff they are on each comment written by the user
  `cm` is signed in as; Edit switches the comment to an editor with **Save** and **Cancel**, and
  Delete always asks first. Timeline rows offer neither.
- Comments on the whole review: **Reply…**, **Edit…** and **Delete** on General
  threads in the Discussions view, **Add Comment to Review…** in its title bar and the Command
  Palette, and the same as links in the Overview, which also links **Edit description** under your
  own description. They take their text from a one-line input box; longer text with line breaks is
  best written in the desktop app. The discussions reload after every write, and a result `cm`
  could not confirm says so.

### Changed

- Review writes are no longer experimental and are on by default. The setting is now
  `plastic-scm.reviews.commentWrites` (default on) and the "(Experimental)" labels are gone.
  `plastic-scm.reviews.experimentalPosting` is deprecated but still honoured where `commentWrites`
  is not set, so a user who turned it off stays off.
- Opening a discussion or a file shows that it is loading: a progress bar on the Discussions or
  Review view and "Opening LoginManager.cs:638…" in the status bar while `cm` reads the diff and
  places its discussions; past half a second a notification says so too.
- A discussion's header in the diff starts with its state, as in the trees: 🟠 a pending change
  request, ✅ an applied one or an answered question, ⚪ a discarded request, ❓ an open question.
  An answered question is resolved and collapsed, as Plastic has it.
- The Overview offers **Reply** on threads on files too, and **Edit** and **Delete** on your own
  comments and replies there, as the desktop app's review overview does.
- File and folder rows in the Review view mark their discussions with coloured symbols instead of
  "N discussions": 💬 for every thread, 🟠 for pending change requests and ❓ for open questions;
  a folder adds up its files. The Discussions view's header uses 🟠, ✅ and ❓ the same way.
- The open review is checked for changes for as long as it is open, not only while a review view
  or its Overview is visible. The review queue is still checked only while the Reviews view is.
- After a comment or a reply is posted, or you are added as a reviewer, the reloaded discussions
  stop counting as pending updates at once, without waiting for the next check.
- Review writes (comments, replies, Add Me as Reviewer and your own review status) run
  the installed `cm` with its own sign-in, on any server `cm` works with. They need Unity Version
  Control client 11.0.16.10512 or newer and a trusted workspace; with an older `cm` the extension
  says so and writes nothing. It asks `cm` again on the next action and when
  `plastic-scm.cmConfiguration` changes, so an upgraded client is found without a reload. No token
  is created, stored or asked for.
- A comment's text goes to `cm` on its standard input, never through the logged `cm shell`; on
  Windows it goes in a temporary UTF-8 file instead, deleted once `cm` has ended, so that non-ASCII
  text is not garbled by the console code page. The output channel names the command and the
  review only.
- A new comment is a plain comment on its line's revision; written in the diff of one changeset of
  a branch review, it is filed under that changeset. A reply answers its thread by the comment's
  GUID. The gutter `+` is offered only where `cm` takes a comment: the right side of a review or
  changeset diff, and the left side of a deleted file. Outdated and previous-revision diffs, files
  from xlinked repositories and diff tabs restored after a reload offer none.
- A `cm` error about the connection or the server's answer, or an error exit with no message,
  leaves a comment's result unknown (**Allow Another Attempt**) rather than **Not sent**, since
  the server may have taken it. Only a write `cm` refused offers **Set the Review's Status** after
  a failed verdict. A cancelled add whose `cm` had already started says the result is unknown and
  reloads the discussions.
- After a comment or a reply is posted, the review's discussions reload, so it shows as the server
  has it and can be replied to. The confirmation before every send names the workspace's server
  through `cm` as the destination.
- The end-to-end review tests run on every test run, against a synthetic Plastic
  server.
- The review Overview reads like a GitHub pull request's Conversation tab. Under the header and
  the summary tiles come compact reviewer cards and a one-line list of the open change requests
  and questions, then one **Conversation**, oldest first: the description as its opening comment
  (with **Edit description** when it is yours), the review's creation, the branch's changesets
  (a person's changesets within 30 minutes of each other are one entry, merges marked, with the
  change requests each one applied), every discussion in full with its replies (comments on the
  whole review and threads on a file's line, the latter headed by their kind, state and a
  `File.cs:18` link to the diff; applied and discarded change requests drawn as resolved), and
  every review event: verdicts with their text, review requests, re-requests and removals,
  renames and description edits. Each entry's kind is an icon on the line (comment, question,
  change request, changeset, review request, verdict, rename…), coloured by its state, and every
  author — of a comment, a reply or an event — has a small avatar beside their name.
  The timeline closes on a rule, and while posting works an **Add a comment** box follows it, with
  your avatar and a **Write a comment…** button that opens the input box at the top of the window.
  A changeset review keeps its changeset comment above the Conversation and its files below it. The separate
  Conversation, Other discussions, Changesets and History sections, and the verdict quotes on the
  reviewer cards, are gone; their content is in the Conversation.

### Removed

- **Configure Experimental Posting…** and **Forget Experimental Posting Token**, and the
  organization name, repository name and token they dealt with. The bearer token that 0.4.0 saved
  for a workspace and repository is deleted from VS Code's secret storage the next time Plastic
  Reviews shows that workspace, whatever the setting.

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
