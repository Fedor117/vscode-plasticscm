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
theme: status, author and assignee, the branch and both sides of the comparison, where the review
stands (whom it waits on, files viewed, change requests, questions and sign-off), a card per
reviewer with their latest verdict and its replies, the open change requests and questions, the
conversation and the other threads without a file location (each with its replies), the
changesets (for a changeset review, its comment and files instead), and the review's history.

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
  status shown does not change. With experimental posting on, it can first add you as a reviewer:
  see [Add Me as Reviewer](#experimental-add-me-as-reviewer).
* While a review view or the open review's Overview is visible, the extension checks for changes
  every minute, unless one of your own actions is still running. The queue updates in place. For
  the open review, a **Review updated** row describes what changed (branch moved to a new head,
  new comments, counting edited ones and applied change requests, and status), and the review
  stays as loaded until you select that row or **Load Updates**. Open diffs keep their revisions.
  When the active diff was opened from Changes or Merged from other branches and a file with the
  same path is still in the review, Load Updates reopens it against the new head. **Refresh
  Review** reloads at any time.
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

### Experimental comment posting

Posting is off by default and is limited to Unity Version Control cloud repositories. It goes
through Unity's hosted API with a token you enter, has been tested with mocks only, and its
sign-in, line encoding and reply payload have not been verified against a live write. Your
existing `cm` login does not enable it.

1. Turn on `plastic-scm.reviews.experimentalPosting` (an application-wide setting). The workspace
   must be trusted.
2. From the Reviews view's `…` menu, choose **Configure Experimental Posting…** and enter the
   hosted organization and repository names and a review-service bearer token. The token is kept
   in VS Code SecretStorage, scoped to the workspace and its repository.
   **Forget Experimental Posting Token** removes it.
3. In a review diff, use the gutter `+` on any line of a non-empty side and choose **Post Comment
   (Experimental)**, or reply in a thread with **Post Reply (Experimental)**. Only comments and
   replies can be posted.
4. Every send first shows a confirmation naming the destination and the file and line (and, for
   a new comment, the revision).

The result stays in the thread as a local comment that keeps your text:

* **Posted · refresh to verify**: refresh the review to see it as the server stored it.
* **Not sent: <reason>**: **Send Again** reuses the same request key, so an accepted comment is
  never posted twice.
* **Result unknown**: check the review first. **Allow Another Attempt** takes a new key and may
  post a duplicate if the first attempt arrived.

The experimental adapter assumes a zero-based decimal string for `locationSpec` and
`{ "commentText": "..." }` for replies. These assumptions are isolated in `reviewWriter.ts`.
The endpoint is fixed to `https://services.api.unity.com/plastic/v1`; redirects and automatic
write retries are not followed.

Validate actual writes in a separately designated test repository before relying on this feature.
See [the investigation](docs/plastic-review-comment-research.md) for the unresolved API details.

### Experimental: Add Me as Reviewer

With `plastic-scm.reviews.experimentalPosting` on, you can add yourself to a review's reviewers
through the same hosted API and connection as comment posting. It works with Unity Version
Control cloud repositories only and needs a bearer token for that API, saved with **Configure
Experimental Posting…**. `cm` has no way to add a reviewer, and changing the assignee would
replace one, so the extension does neither.

* **Add Me as Reviewer** (Review view title bar, a review's context menu in Reviews, the Command
  Palette, or **Add me as reviewer** under the Overview's reviewer cards) sends your `cm whoami`
  name, which must be an e-mail address, to the review's reviewers. It then reloads the
  discussions and the timeline, so your reviewer card appears. You can be added when you are not
  the review's author or its assignee and nobody's request for you is still active; someone who
  only left a verdict can be added. The title bar and the Overview offer it only then, and hide it
  while the add is in flight. From a review's context menu or the Command Palette it says why
  when you can't be added.
* **Set Review Status…** adds you first when you can be added. With a saved token it adds you and
  then writes the status. If the add fails, it asks whether to set the status anyway. Without a
  token it asks whether to configure one and add you, or to set the status without adding you.
  When a Reviewed warning also applies, it is part of the same question. While Add Me as Reviewer
  is still adding you, it waits for that add instead of sending another. With the setting off,
  Set Review Status… works as before.
* A token refused with 401 or 403 has expired or lacks permission: set a new one with
  **Configure Experimental Posting…**.

Unity does not document how a user gets a token for this API, and the reviewer endpoint has not
been verified against a live write; see [the investigation](docs/plastic-review-comment-research.md).

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
|`plastic-scm.reviews.experimentalPosting`            |`boolean`|`false`  |**Experimental.** Allows posting review comments and replies, and adding yourself as a reviewer, through Unity's hosted API with a token you enter (cloud repositories only)

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
