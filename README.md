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
7. **Changeset graph** of the current branch and its parent branch, in the Source
   Control pane like VS Code's Git graph — expand a changeset to see the files it
   changed, click a file to diff it against the parent changeset

## Plastic Reviews

Open **Plastic Reviews** in the Activity Bar. It is also on the Source Control title bar's `…`
menu as **Show Plastic Reviews**. The container has three views.

* **Reviews** lists the reviews of one Plastic workspace:
  * **Needs My Review**: open reviews by other people that you are assigned to, or on which you
    are a currently requested reviewer.
  * **Rework Requested** and **Waiting for Reviewers**: your own open reviews, by status.
  * **All Open**: every review that is not Reviewed.
  * **All Reviews**: every review in the workspace's repository, by anyone and in any status. Each
    row names the author and the assignee.

  All Open and All Reviews list the newest 50 first, with **Load More…** for the next 50, and run
  no query until you expand them. The view badge counts Needs My Review. **Find Review…**, in the
  view's title bar, searches the newest 2,000 reviews in the repository by title, number, author,
  assignee, status or branch (unless the branch was deleted). Typing a number selects the review
  with that number, or else the review of that changeset; a number newer than every listed review
  offers to open it by ID. The reviews are read again once they are a minute old, and after
  **Refresh** or a status change. **Open Review by ID…**, in the Command Palette, opens any review
  by its number. With more than one Plastic workspace open, **Switch Workspace…** picks the one to
  list. If a group's query fails, that group shows the error and the others still load.
* **Review** shows the selected review: **Overview**, **Changes**, **Merged from other branches**
  and **Changesets**. Clicking a review in **Reviews** (or pressing Enter on it), or opening one with
  **Find Review…** or **Open Review by ID…**, loads it and opens its **Overview**. The Overview
  opens in the editor group that shows the previous review's, which it replaces, or else in the
  active group. After a click the list keeps the keyboard focus. A review that comes back after a
  window reload opens no editor.
* **Discussions** lists every thread, grouped by file, then **General** (conversations,
  reviewers' verdicts such as "Reviewed · LGTM…", and threads without a file location). The
  badge counts pending change requests.

**Overview** opens a read-only page in the Markdown preview, drawn in the colours of the current
theme and laid out like a GitHub pull request's Conversation tab. At the top: status, author and
assignee, the branch and both sides of the comparison, where the review stands (whom it waits on,
files viewed, change requests, questions and sign-off), a compact card per reviewer and a one-line
list of the open change requests and questions. Then one **Conversation**, oldest first, on a
timeline: the description as its opening comment, the review's creation, the branch's changesets
(a person's changesets within 30 minutes of each other are one entry, merges marked, with the
change requests each one applied), every discussion in full with its replies, whether on the whole
review or on a file's line (headed by its kind, state and file), and every review event: verdicts
and their text, review requests and removals, renames and description edits. A changeset review
shows its changeset comment above the Conversation and its files below it.

The Overview opens in VS Code's Markdown preview editor, so opening another Markdown file does not
replace it, and it is redrawn when you mark files viewed or the review reloads. Its title bar has
**Open Next Unviewed File**, **Set Review Status…** and **Refresh Review**, or **Load Updates** when the server
has newer data (a notice under the header says what changed). File names and `File.cs:18`
references are links: a click or Cmd/Ctrl+click opens the diff, or the discussion at its line, as
the same row in Review or Discussions does. They are `vscode://` links, so the first one asks
whether Plastic SCM may open it. They only open the review that is active in Plastic Reviews; any
other link says why it cannot open.

### What a review compares

* A **branch review** compares the branch base (the parent of the branch's first changeset) with
  the branch head at the time the review was loaded, the same as `cm diff br:<branch>`. Both
  sides are named in the diff title, for example `Foo.cs (cs:3471 ↔ cs:3715) · #12831`.
* Files that changed on the branch **only through merges** (from `/main` or a child branch) are
  listed separately under **Merged from other branches**, collapsed. They are the rows that
  `cm diff --clean` leaves out. Their diffs still compare the branch base with the head.
* A **changeset review** compares the changeset with its parent.
* Expand a changeset under **Changesets** to review it on its own, against its parent. Merge
  changesets have a merge icon. A file there at the same revision as in Changes says
  `same revision as head`; it is viewed together with its Changes row.
* Hidden branches load like any other; most merged branches are hidden. If the branch was
  deleted, the review says so, and its discussions still open where they were written.
* Binary files, directories and merge rows that record no content change are listed, but have
  no text diff.

### Going through the files

* Each file row has a **viewed** checkbox. Folder checkboxes mark every file below them.
  **Mark All as Viewed**, on the Changes row or a changeset, marks every file in it.
  **Changes** shows the progress, for example `4/23 viewed · cs:3471 ↔ cs:3715`.
* Viewed state is kept per file revision: it survives a rename, and a new check-in of the file
  makes it unviewed again. It is stored in VS Code's global storage for the 100 most recently
  used reviews.
* Click a file to open its diff as a preview, with focus left in the tree. The diff editor's
  title bar has **Open Previous File**, **Open Next File** and **Mark as Viewed and Open Next
  File** (or **Mark as Not Viewed**). Previous and next stay inside the group the diff was opened
  from (Changes, Merged from other branches or one changeset), in the order shown, and skip
  files without a text diff. The Review view selects the file in the active diff.
* **Open Next Unviewed File**, in the Review view's title bar, continues after the last file you
  opened from Changes. When the last file in Changes is marked viewed, you are offered **Set
  Review Status…**.
* **View as List** / **View as Tree** switches `plastic-scm.reviews.fileLayout`.

### Comments in diffs

Threads appear inline in every review diff, labelled Question, Change request (with
`applied in cs:N` or `discarded`) or Comment. Pending change requests are expanded and marked
unresolved. A thread written on an older revision of the file is moved to the matching line of
the revision shown and says `from rev N`. A thread whose line no longer exists is left out of
the diff, and Discussions still lists it.

Clicking a file thread in Discussions opens, in this order, with focus left in Discussions:

1. the review's diff at that line, when the commented revision is one side of it, or its line
   still exists in the file's current revision;
2. an `outdated` diff of the branch base against the commented revision;
3. the commented revision's own changeset (`original context`);
4. the commented revision against its previous revision.

Clicking a thread under **General** opens the Overview, where it is printed in full with its
replies.

### Status and updates

* **Set Review Status…** (Review view title bar, a review's context menu, or the Command Palette)
  offers Under review, Rework required and Reviewed. Marking a review Reviewed while change
  requests are pending or files are not viewed asks first. So does marking one where either count
  is unknown: a review that is not the open one, or whose files or discussions have not loaded.
  The change runs `cm codereview -e <id> --status=…` and reads the review back. If it fails, the
  status shown does not change. With review writes on, it can set your own status as
  a reviewer instead, adding you as a reviewer first: see
  [Review writes](#review-writes).
* The extension checks for changes every minute (`plastic-scm.reviews.updateCheckInterval`, in
  seconds, at least 15; `0` turns the checks off), unless one of your own actions is still
  running. A changed interval applies at once. The open review is checked for as long as it is
  open, whether or not its views are on screen; the queue is checked while the Reviews view is
  visible, and updates in place. For the open review, a **Review updated** row describes what
  changed (branch moved to a new head, new comments, counting edited ones and applied change
  requests, and status), and the review stays as loaded until you select that row or **Load
  Updates**. Open diffs keep their revisions.
  When the active diff was opened from Changes or Merged from other branches and a file with the
  same path is still in the review, Load Updates reopens it against the new head. **Refresh
  Review** reloads at any time.
* When a check finds something new in the open review, a notification says what, for example
  `Review #312: 2 new comments from ana@example.com; new changesets on the branch; status is now
  Reviewed`. **Load Updates** in it loads the changes, and **Show Discussions** brings the
  Discussions view to the front when comments changed. Each change is announced once: updates you
  have not loaded yet do not notify again until something further changes. Comments written by
  the user `cm` is signed in as, from this extension or anywhere else, do not notify, though they
  still show as updates until loaded. Turn the notifications off with
  `plastic-scm.reviews.notifyUpdates`; the **Review updated** row stays.
* After a window reload, the last review you opened in each workspace comes back, without
  opening any editor. **Close Review** forgets it and closes its Overview.

Browsing uses the installed `cm` client and its existing login, and works with any Plastic
server. No Unity packages, REST service or additional login are needed. Older clients without the
comment query can still browse reviews and diffs, with a notice in Discussions.

### Keybindings

There are no default keybindings. To move through a review from the keyboard, add something like
this to your `keybindings.json`:

```json
[
  { "key": "ctrl+alt+]", "command": "plastic-scm.reviews.nextFile", "when": "resourceScheme == plastic-review" },
  { "key": "ctrl+alt+[", "command": "plastic-scm.reviews.previousFile", "when": "resourceScheme == plastic-review" },
  { "key": "ctrl+alt+enter", "command": "plastic-scm.reviews.markViewedAndNext", "when": "resourceScheme == plastic-review" }
]
```

### Open in Unity Version Control

**Open in Unity Version Control** (a review's context menu in Reviews, and the Review view's `…`
menu) opens the review in the Unity Version Control desktop app through a `plastic://` code-review
link. It works whatever the review writes setting says. The desktop app must be installed.

### Review writes

With `plastic-scm.reviews.commentWrites` on, the extension can add you as a reviewer, set
your own status as a reviewer, post comments and replies, and edit or delete your own comments. It
does all of them with the
installed `cm` and its existing sign-in (`cm codereview comment`, `cm codereview reviewer` and
`cm codereview review`): there is no token and nothing else to sign in to, and it works with any
server `cm` works with. The writes need Unity Version Control client 11.0.16.10512 or newer and a
trusted workspace; with an older `cm` the extension says so and writes nothing, and it asks `cm`
again on the next action or when `plastic-scm.cmConfiguration` changes, so a client upgraded in
place is found without a reload. The setting is on by default. It replaces the deprecated
`plastic-scm.reviews.experimentalPosting`, which still counts where `commentWrites` is not set: a
user who turned the old setting off keeps writes off until they set `commentWrites`.

* **Add Me as Reviewer** (Review view title bar, a review's context menu, the Command Palette, or
  **Add me as reviewer** under the Overview's reviewer cards) adds the user `cm` is signed in as.
  It is not offered to the review's author or assignee, or when you are already a reviewer.
* **Set Review Status…** sets your own status as a reviewer, adding you first when you are not one
  yet. The author and the assignee set the review's status with `cm codereview -e --status` as
  before, and so does everyone while the setting is off or review writes are not available. If the
  add fails, no status is written unless you choose **Set Status Without Adding**, which sets the
  review's status instead; if `cm` refuses your own status, **Set the Review's Status** does the
  same. When `cm` is missing, cannot start or loses the server, the error is shown and nothing else
  is offered.
* **Comments and replies.** In a review diff, the gutter `+` offers **Post Comment**,
  and review threads offer **Post Reply**. Every send asks for
  confirmation first. A new comment is a plain comment on the line's revision; written in the diff
  of one changeset of a branch review, it is filed under that changeset. The `+` is on the sides
  `cm` takes comments on: the right side, and the left side only for a deleted file. It is not
  offered in outdated or previous-revision diffs, on files from xlinked repositories, or in a diff
  tab restored after a reload until it is opened again from Plastic Reviews. After a comment is
  posted, the review's discussions reload and show it as the server has it. Until then, and when
  it was not posted, the result stays in the thread: **Posted**, **Not sent** with `cm`'s message
  and **Send Again**, or **Result unknown** with **Allow Another Attempt**.
* **Edit and delete your own comments.** In a review diff, each comment written by the user `cm`
  is signed in as (`cm whoami`, compared without case) has **Edit** and **Delete**. **Edit** turns
  the comment into an editor with **Save** and **Cancel**; **Save** sends the new text with
  `cm codereview comment edit` (its type, file, line and changeset stay) and reloads the
  discussions. **Delete** always asks first, says it can't be undone and, for a comment with
  replies, that `cm`'s help does not say whether they are deleted with it; it then runs
  `cm codereview comment delete`. Timeline rows (verdicts, review requests, renames) offer neither.
* **Comments on the whole review.** In the Discussions view, General threads offer **Reply…**,
  and **Edit…** and **Delete** when a comment in them is yours (with several, you pick which);
  **Add Comment to Review…** in the view's title bar and the Command Palette adds a comment that
  is on no file. The Overview links the same, for threads on files too, as the desktop app's
  overview does: **Reply** under each thread (a reply to a file thread lands on its line), **Edit**
  and **Delete** under your own comments and replies, **Add comment** at the end
  of its Conversation and **Edit description** under your own review description (the
  description is never deleted from here; `cm` keeps its `[description]` marker). These write
  from a one-line input box: accepting it is the confirmation, and **Delete** asks in a dialog.
  The box cannot hold line breaks, so write longer text with line breaks in the Unity Version
  Control desktop app; editing a comment that has them shows them as spaces and saves the text as
  typed. The Overview's comment links work only from the Overview in the same window. After every
  write the discussions reload; a result `cm` could not confirm says **Result unknown** and asks
  you to refresh the review before trying again.

**Not sent** means `cm` answered with an error of its own, such as a missing review or permission,
so **Send Again** sends the same draft and cannot add a second copy of one the server took. A
write whose result is unknown is never retried automatically: `cm` was cancelled or did not finish
in time, exited with an error about the connection or the server's answer, or with no message, or
did not name the new comment. A delete after which `cm` reported an error is also of unknown
result: `cm` reports a comment it could not delete and goes on. The comment's text goes to `cm` on its standard input (on Windows,
in a temporary UTF-8 file that is deleted once `cm` has ended, so that non-ASCII text arrives
intact) and is never written to the output channel; the channel names the command and the review.

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
|`plastic-scm.history.pageSize`                       |`number` |`50`     |Changesets fetched per branch on each page of the Plastic SCM Graph view (10–500). Each page is one `cm find` round trip
|`plastic-scm.reviews.fileLayout`                     |`string` |`tree`   |How Plastic Reviews lists changed files: `tree` (folders) or `list` (sorted by path)
|`plastic-scm.reviews.updateCheckInterval`            |`number` |`60`     |Seconds between two checks for changes in Plastic Reviews: the open review, whatever is on screen, and the review queue while the Reviews view is visible. The shortest interval is 15 seconds; `0` turns the checks off
|`plastic-scm.reviews.notifyUpdates`                  |`boolean`|`true`   |Show a notification when a check finds new comments from someone else, new changesets or a new status in the open review. With this off, the **Review updated** row and **Load Updates** still show them
|`plastic-scm.reviews.commentWrites`                  |`boolean`|`true`   |Allows posting comments and replies, editing and deleting your own comments, adding yourself as a reviewer and setting your own review status, through `cm` as the user `cm` is signed in as. Needs Unity Version Control client 11.0.16.10512 or newer and a trusted workspace
|`plastic-scm.reviews.experimentalPosting`            |`boolean`|`false`  |**Deprecated**, use `plastic-scm.reviews.commentWrites`. Counts only where `commentWrites` is not set

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

### Graph

The **Plastic SCM Graph** view sits below the workspace status in the Source
Control pane and works like VS Code's Git graph. VS Code decides how much room a
contributed section gets, so the first time you open Source Control the graph may
be collapsed: click its header once and VS Code remembers it from then on.

It shows the changesets of the current branch and of its parent branch in one
list, newest first, each branch in its own column: branch labels, a hollow ring
on the changeset your workspace is loaded at, and the merge and cherry-pick links
between the two branches drawn as lines into the source's column. A merge whose
other end is not loaded — from a branch that has no lane, say — is drawn as a
short hook ending in a dot: pointing down when the other changeset is older, up
when it is newer, grey when its branch is not shown. Hover a changeset to read
where each of its lines comes from or goes to.

Click a changeset to list the files it changed, with the same `A`/`C`/`M`/`D`
badges as the status view. Click a file to open a diff against the parent
changeset — deleted and moved files included, because the content is fetched by
revision id rather than by workspace path. A single **Load more** row extends the
graph a page at a time, keeping both branches loaded to the same point; the title
bar has a **Refresh Graph** button, and the context menu offers **Copy Changeset
Id**, **Copy Comment**, **Open Changes** and **Open File**.

History queries run on a separate `cm shell`, so they never delay a status
refresh or a checkin. A branch that gained changesets since the view loaded shows
a *New changesets* row instead of reloading under you.

### Show Output

Reveals the `Plastic SCM` output channel, which carries every `cm` command and
its output. Review writes are the exception: the channel names
their command and review, never a comment's text or what `cm` printed. Failure
notifications link to it directly.

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
