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
8. **Branch Explorer**: the history of every branch in an editor tab, with a lane
   graph, search, branch and author filters, changeset details and a context menu
   to switch, branch, label, review and compare
9. **Repository view** listing the branches, labels and shelves of each workspace's
   repository, newest first
10. **Switch, create, rename and delete branches and labels, and update**, from the
    Command Palette, the Repository view and the status bar
11. **Shelves**: shelve all or selected pending changes, browse the files of a shelve
    and diff them, apply or delete a shelve, and shelve pending changes when a switch
    or update would meet them

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

### Creating reviews and managing reviewers

* **Create Code Review…** (Reviews view title bar, a branch in the Plastic SCM Repository view, a
  changeset in the Branch Explorer, or the Command Palette) reviews the current branch, a branch
  you pick, or a changeset you pick. It asks for a title, an optional description (passed to `cm`
  in a file) and optional reviewers, then offers to open the new review.
* **Add Reviewers…**, **Remove Reviewers…** and **Request Review Again…** (the Review view's `…`
  menu, a review's context menu in Reviews, and the Command Palette with a review open). Reviewers
  are a comma-separated list of users; write `group:<name>` for a group. Remove and Request Review
  Again pick from the reviewers `cm codereview reviewer list` prints; removing asks first.

They run `cm codereview <spec> <title>`, `cm codereview reviewer add|remove` and
`cm codereview review --re-request` with your `cm` sign-in, whatever the review writes setting
says, and tell you when the installed `cm` lacks those commands. They have been tested with a
mocked `cm` only, not against a live server.

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
|`plastic-scm.cmConfiguration.millisCommandTimeout`   |`number` |`120000` |How long a single `cm` command may run before it is abandoned and the shell restarted. `0` means no limit
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

### Branch Explorer

**Plastic SCM: Open Branch Explorer** — also the button in the Source Control
title bar and in the Graph and Repository views — opens an editor tab with the
history of the whole repository, the way Sourcetree or the Plastic SCM Branch
Explorer show it: every branch in one list, newest first, with a lane graph next
to it. Each branch has its own colour, merges and cherry-picks are dashed lines
to their source, branch heads and labels are pills on their changeset, and the
changeset your workspace is on is marked with a ring and a home icon.

The toolbar decides what is listed:

- **All branches**, **Current branch and its ancestors** (the workspace's
  changeset, the head of its branch and everything they descend from, through
  parents and merges), or **Selected branches…**, which lists the branches that
  have loaded changesets for you to tick.
- The **filter box** narrows the loaded changesets as you type, matching every
  word against the comment, branch, author, labels and `cs:` number. A filtered
  list has no graph, because the rows in between are gone.
- The **author** list keeps one person's changesets.
- **Search repository** (or Enter in the filter box) searches every changeset of
  the repository rather than the loaded ones: a number or `cs:N` finds that
  changeset, anything else is matched against the comment. `cm` matches comment
  text case-sensitively, and the newest 200 matches are listed.

Select a changeset to see its full comment, its parent and merge sources (click
one to jump to it) and the files it changed, with a filter of their own. Click a
file to open its diff against the parent changeset; right-click it for **Show
File History**. Arrow keys, Page Up/Down, Home and End move the selection.

Right-click a changeset for **Switch Workspace to This Changeset…**, **Switch
Workspace to This Branch…**, **Create Branch from This Changeset…**, **Label This
Changeset…**, **Create Code Review for This Branch…**, **Compare with Selected
Changeset** (select one, right-click another), **Compare with Workspace
Changeset**, and copying its id, branch name or comment. These run the same
commands as the Repository view and the palette, with the same confirmations.

Changesets load 300 at a time as you scroll; the home button jumps to the
workspace's changeset and the refresh button reloads from the server. New
changesets are picked up after a checkin, switch or update. The explorer runs on
its own `cm shell`.

### Repository

The **Plastic SCM Repository** view, in the Source Control pane, lists the
**Branches**, **Labels** and **Shelves** of the workspace's repository (one group
per workspace when several are open). A section runs no `cm` query until you
expand it, then loads the newest 50 rows; **Load More** fetches the next 50.
Branches and labels are newest by creation date. Shelves are newest by number:
`cm find shelve` cannot sort, so the view reads every shelve once and pages them
itself. Hidden branches are not listed.

The branch, label or shelve your workspace is on is marked *current*, and moves
when the workspace does. Hover a row for its owner, date, changeset and full
comment. The title bar has **Refresh Repository**; a section that failed to load
shows the error, and clicking it retries.

Branch and label rows have actions, see [Branches, labels, switch and update](#branches-labels-switch-and-update).

### Branches, labels, switch and update

All of these are in the Command Palette (`Plastic SCM: …`), the **Repository** view's rows and
section headers, and, for switching and updating, the status bar. They run one at a time per
workspace, show a progress notification, and show `cm`'s own error with a **Show Output** button
when something fails.

| Command | `cm` |
|---|---|
| **Switch to Branch…**, **Switch to Changeset…**, **Switch to Label…** | `cm switch <br:\|cs:\|lb:> --noinput` |
| **Create Branch…** from the current changeset, a changeset, a label or a branch's head | `cm branch create br:<name> [--changeset=<n> \| --label=lb:<name>]` |
| **Create Branch and Switch…** | the two above |
| **Rename Branch…**, **Delete Branch…**, **Edit Branch Comment…** | `cm branch rename \| delete \| editcomment` |
| **Create Label…** on the current changeset, a picked changeset or a branch's head | `cm label create lb:<name> cs:<n>` |
| **Rename Label…**, **Delete Label…** | `cm label rename \| delete` |
| **Update Workspace** | `cm update --noinput`, or `cm update --last --noinput` |

A new branch is created under the branch its starting changeset is on, so you type only its last
name segment. Comments are sent in a temporary file, so they can have any text. Names are checked
first: they cannot be empty, start or end with a space, start with `-`, or contain quotes, line
breaks or `@` (and a branch name cannot contain `/`). Creating a label with a name that already
exists is refused, because `cm label create` would put that label on one more changeset.
**Delete Branch…** and **Delete Label…** name the target in a confirmation, and refuse the branch
or label the workspace is on. A branch that still has changesets is not emptied: the command never
passes `--delete-changesets`, so `cm` is expected to refuse it.

**Pending changes.** `cm shell` cannot answer the question `cm` asks when a switch or update meets
pending changes, so the extension runs these commands with `--noinput`. `cm help switch` and
`cm help update` say only that this skips the questions and "disables the possibility of bringing
your pending changes"; they do not say what happens to the changes instead. So when the workspace
has pending changes (private files do not count), a dialog says so and offers **Continue** or
Cancel. Check in or discard what you need before continuing.

**Update.** A workspace on a changeset or a label stays where it is until it is switched, so
**Update Workspace** asks first and then runs `cm update --last`, which points the workspace at the
branch of that changeset or label and brings it to the latest changeset. A workspace on a shelve
cannot be updated; switch to a branch first. Switch and update download files and may take
minutes: they have no time limit.

**Status bar.** The workspace's entry (the branch, changeset, label or shelve it is on) opens a
menu: switch to a branch, changeset or label, create a branch, update the workspace, or show
Source Control. When the Graph has seen newer changesets on the workspace's branch, an **Update**
entry appears next to it, and the Source Control title bar has an **Update** button. The Graph
checks for newer changesets at most once a minute, and only while its view is open, so the entry
can lag behind the server.

### Shelves

Shelves keep pending changes on the server without a changeset. Everything here is in the
Command Palette, the Source Control view and the **Shelves** section of the Repository view.

| Command | Where | `cm` |
|---|---|---|
| **Shelve Pending Changes…** | Source Control title menu, status bar menu, palette | `cm shelveset create <paths> --all --summaryformat` |
| **Shelve Selected Changes…** | right-click on changed files (multi-select) | the same, with the selected paths |
| **Apply Shelve…** | a shelve row, palette | `cm shelveset apply sh:N --dontcheckout` |
| **Delete Shelve…** | a shelve row, palette | `cm shelveset delete sh:N` |
| **Copy Shelve Id** | a shelve row | |

Expand a shelve in the Repository view to list its files (`cm diff sh:N`); click one to open a diff
of it against the changeset the shelve was made on. Binary files and directories have no text diff.

- Only controlled changes are shelved. Private (untracked) files are not: add them to source
  control first. The comment is sent in a temporary file, so it can have any text.
- After shelving, a dialog offers to **Undo Changes** in the workspace (`cm undo` on the shelved
  files only, never deleting private files). Cancel keeps the changes in the workspace as well.
- **Delete Shelve…** asks first and names the shelve; a deleted shelve cannot be brought back.
- **Switch and update.** When a switch or update meets pending changes, the dialog has a third
  button, **Shelve changes and continue**: it shelves every pending change, undoes them in the
  workspace, then runs the switch or update. Afterwards a message tells you the shelve (`sh:N`) and
  offers **Apply Shelve Now**. If the shelve cannot be created or undone, nothing runs and the
  changes stay as they were.
- **Applying and conflicts.** `cm shelveset apply` has no option to resolve conflicts without a
  person, and `cm shell` cannot answer a merge tool. The extension applies with `--dontcheckout` (the
  changes become local changes and no file is exclusively checked out). If the workspace has pending
  changes, a dialog first names how many of them are in files the shelve also changes. If you go on
  and `cm` needs to merge, it may open its merge tool in a window outside VS Code; the apply waits
  until that window is closed or gives up after 10 minutes. Check in or shelve your own changes
  first if you want to avoid that. If `cm` reports a conflict in its output, a warning says so.
  `cm merge sh:N --conflict-markers` would write conflict markers in the files instead, but it is a
  merge (with traceability) rather than an apply, so it is not used.

### Locks, checkout, delete, move and ignore rules

- **Checkout** is in the right-click menu of SCM rows, Explorer files and the editor tab. It runs
  `cm checkout`; when the server's lock rules match, the checkout is exclusive and takes a lock. If
  someone else holds it, the error names them.
- **Locks** is a section of the Plastic SCM Repository view (`cm lock list`), grouped *Mine* and
  *Others*. **Release Lock** and **Remove Lock** ask first and warn when the lock is someone else's;
  `cm` only allows that for a server administrator. Locked files carry a badge in the Explorer and
  the Source Control list. The list is refreshed at most once a minute, or with **Refresh Locks**.
- **Delete (Plastic SCM)** (`cm remove`) and **Rename/Move (Plastic SCM)…** (`cm move`) are
  explicit commands. The extension does not hook Explorer renames or deletes: Plastic detects local
  moves and deletes in pending changes by itself.
- **Add to Ignore List / Hidden Changes List / Cloaked List** offer: this item, by name, by
  extension, or the parent folder, and append the rule to `ignore.conf`, `hidden_changes.conf` or
  `cloaked.conf` in the workspace root (created if missing, no duplicates). The files are versioned,
  so the change appears in pending changes. **Open ignore.conf** (and the other two) open them.
- Clicking an added file opens it, a deleted file opens its base revision read-only, and a moved
  file shows the old path at the loaded changeset next to the new one.

### File history, annotate and comparisons

- **Show File History** (Explorer, editor and editor tab menus, Source Control rows, and the files
  listed in the Graph) opens the **File History** view in the Source Control container: every
  revision of that file (`cm history --moveddeleted`) with changeset, branch, owner, date and
  comment. Per revision: **Open Changes** (against the revision before it; the first revision is
  shown against an empty file), **Compare with Workspace File**, **Open File at Revision** (a
  read-only copy), **Copy Changeset Id** and **Revert to This Revision** (`cm revert`; it asks
  first and warns when the file has pending changes of its own). Binary files have no text diff.
  The view shows one file at a time and is reloaded with its Refresh button; it does not follow
  the workspace on its own.
- **Toggle Annotate (Blame)** (editor context menu, editor tab menu, palette) puts the owner,
  changeset and date of the last change in front of every line (`cm annotate`). Hover the
  gutter of a line for the changeset's branch and comment, with links to the file's diff in that
  changeset and to the changeset's file list. The annotation is removed when you toggle it
  again, when the file is closed and as soon as the text is edited. A binary file, a file that is
  not under source control, an unsaved file and a file with pending changes (its lines would not
  match the checked-in revision) get a message instead.
- **Compare Changesets...** asks for two changesets (`cm diff cs:A cs:B`) and **Show Branch
  Changes...** for a branch (`cm diff br:X`, the branch against its parent; also on a branch row of
  the Repository view). Both fill the **Comparison** view with the files that differ, which opens
  the same diff editors as the Graph's file list. **Clear Comparison** empties it.

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
