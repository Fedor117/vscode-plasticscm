import {
  ADDED_PATH,
  ANALYTICS_PATH,
  BRANCH_REVIEW_ID,
  CHANGESET_REVIEW_ID,
  comment,
  commentsXml,
  defaultAnswer,
  file,
  LAP_TIMER_PATH,
  MERGED_PATH,
  PHANTOM_PATH,
} from "./fixtures";
import {
  allThreads,
  harness,
  loadContext,
  nativeThread,
  numberedText,
  reviewService,
  threadsOn,
  until,
} from "./editorFixtures";
import {
  commands,
  CommentThreadCollapsibleState,
  CommentThreadState,
  MarkdownString,
  Uri,
  window,
  workspace,
} from "vscode";
import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../models";
import { groupReviewThreads, IReviewComparison, IReviewThread } from "../../../reviews/models";
import {
  IReviewEditorContext,
  reviewCommentMarkdown,
  reviewDiff,
  reviewDiffTitle,
  ReviewEditors,
  reviewFileUri,
  reviewOverviewUri,
} from "../../../reviews/reviewEditors";
import { NO_CONTENT_CHANGE, noDiffReason, SOURCE_UNAVAILABLE } from "../../../reviews/reviewFileTree";
import { expect } from "chai";
import { noDiffMessage } from "../../../reviews/reviewPresentation";
import { ReviewDecorations } from "../../../reviews/reviewDecorations";
import { ReviewService } from "../../../reviews/reviewService";

const DUPLICATED = "This allocates a new List<Sprite> each frame.";

async function failure(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected a rejection.");
}

function row(context: IReviewEditorContext, path: string): IChangesetFileChange {
  const found = context.files!.final.files.find(change => change.path === path);
  if (!found) {
    throw new Error(`No row for ${path}`);
  }
  return found;
}

function thread(context: IReviewEditorContext, id: number): IReviewThread {
  return context.threads.find(candidate => candidate.id === id)!;
}

function activeTabLabel(): string | undefined {
  return window.tabGroups.activeTabGroup.activeTab?.label;
}

describe("Native review editors", function() {
  this.timeout(20000);
  const channel = window.createOutputChannel("Review editor tests");
  let texts: (id: number) => string;
  let service: ReviewService;
  let editors: ReviewEditors;
  let context: IReviewEditorContext;

  beforeEach(async () => {
    texts = () => numberedText(400);
    ({ service } = reviewService(channel, id => texts(id)));
    context = await loadContext(service);
    editors = new ReviewEditors({
      overview: (id, reviewId) => `# Overview of #${reviewId} in ${id}`,
      resolveService: id => id === "wk" ? service : undefined,
    });
    editors.setContext(context);
  });
  afterEach(async () => {
    await commands.executeCommand("workbench.action.closeAllEditors");
    editors.dispose();
    service.dispose();
  });
  after(() => channel.dispose());

  describe("thread placement and presentation", () => {
    it("puts a comment on the revision it names: right for the head, left for the base", async () => {
      const lapTimer = row(context, LAP_TIMER_PATH);
      await editors.open(context, context.files!.final, lapTimer, { preserveFocus: true });
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, lapTimer);
      const left = threadsOn(editors, diff.left.uri);
      expect(left.map(native => native.range.start.line)).to.deep.equal([55]);
      expect(left[0].label).to.equal("Comment");
      expect(left[0].state).to.equal(undefined);
      expect(left[0].collapsibleState).to.equal(CommentThreadCollapsibleState.Collapsed);
      const applied = nativeThread(editors, 12918)!;
      expect(applied.uri.toString()).to.equal(diff.right.uri.toString());
      expect(applied.range.start.line).to.equal(40);
      expect(applied.label).to.equal("Change request · applied in cs:3718");
      expect(applied.state).to.equal(CommentThreadState.Resolved);
      expect(applied.contextValue).to.equal("reviewThread;change;applied");
      expect(applied.canReply).to.equal(false);
    });

    it("maps another revision of the item onto the right side and says where it came from", async () => {
      await editors.open(context, context.files!.final, row(context, LAP_TIMER_PATH));
      const mapped = nativeThread(editors, 12919)!;
      expect(mapped.range.start.line).to.equal(12);
      expect(mapped.label).to.equal("Change request · discarded · from rev 12671");
      expect(mapped.state).to.equal(CommentThreadState.Resolved);
      // The thread's header names its type; the root comment does not repeat it.
      expect(mapped.comments[0].label).to.equal(undefined);
      expect(mapped.comments[0].author.name).to.equal("alex.reviewer");
      expect(mapped.comments[1].label).to.equal("Discarded");
      expect(mapped.comments[1].author.name).to.equal("erin.author");
      // Each author has an initials avatar, drawn inline so there is no file to serve.
      expect((mapped.comments[0].author.iconPath as Uri).scheme).to.equal("data");
      expect((mapped.comments[0].author.iconPath as Uri).toString(true)).to.not.equal(
        (mapped.comments[1].author.iconPath as Uri).toString(true));
      expect(mapped.comments[0].timestamp?.toISOString()).to.equal("2026-09-22T15:30:00.000Z");
    });

    it("leaves out a thread whose line no longer maps", async () => {
      texts = id => id === 12671 ? numberedText(400, "old") : numberedText(400);
      await editors.open(context, context.files!.final, row(context, LAP_TIMER_PATH));
      expect(nativeThread(editors, 12919)).to.equal(undefined);
      expect(nativeThread(editors, 12918)).not.to.equal(undefined);
    });

    it("expands pending change requests and questions only", async () => {
      const question: IReviewThread = {
        anchor: comment({ id: 99, location: 10, reviewId: BRANCH_REVIEW_ID, revisionId: 12797 }),
        comments: [comment({ id: 99, location: 10, reviewId: BRANCH_REVIEW_ID, revisionId: 12797 })],
        id: 99,
        kind: "question",
        state: "none",
      };
      context = { ...context, threads: context.threads.concat(question) };
      editors.setContext(context);
      await editors.open(context, context.files!.final, row(context, ANALYTICS_PATH));
      const pending = nativeThread(editors, 12907)!;
      expect(pending.label).to.equal("Change request");
      expect(pending.state).to.equal(CommentThreadState.Unresolved);
      expect(pending.collapsibleState).to.equal(CommentThreadCollapsibleState.Expanded);
      expect(pending.contextValue).to.equal("reviewThread;change;pending");
      const asked = nativeThread(editors, 99)!;
      expect(asked.label).to.equal("Question");
      expect(asked.collapsibleState).to.equal(CommentThreadCollapsibleState.Expanded);
      expect(asked.state).to.equal(undefined);
    });

    it("keeps generic types and line breaks in comment bodies", async () => {
      await editors.open(context, context.files!.final, row(context, LAP_TIMER_PATH));
      const body = nativeThread(editors, 12919)!.comments[0].body as MarkdownString;
      expect(body.value).to.equal("This allocates a new List\\<Sprite\\> each frame.");
      expect(body.isTrusted).to.equal(false);
      expect(body.supportHtml).to.equal(false);
      expect(thread(context, 12919).comments[0].text).to.equal(DUPLICATED);
    });

    it("counts the lines of a CR-only file the way the editor does", async () => {
      texts = () => numberedText(400, "line", "\r");
      const lapTimer = row(context, LAP_TIMER_PATH);
      await editors.open(context, context.files!.final, lapTimer);
      expect(nativeThread(editors, 12918)!.range.start.line).to.equal(40);
      expect(nativeThread(editors, 12919)!.range.start.line).to.equal(12);
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, lapTimer);
      expect((await editors.draftAt(diff.right.uri, 300)).location).to.equal(300);
    });

    it("re-renders threads when the same review reloads and drops them when another opens", async () => {
      const lapTimer = row(context, LAP_TIMER_PATH);
      await editors.open(context, context.files!.final, lapTimer);
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, lapTimer);
      const before = threadsOn(editors, diff.right.uri);
      let disposed = 0;
      before.forEach(native => {
        const dispose = native.dispose.bind(native);
        native.dispose = () => {
          disposed++;
          dispose();
        };
      });
      editors.setContext({ ...context, threads: context.threads.filter(candidate => candidate.id !== 12919) });
      await until(() => disposed === before.length);
      expect(nativeThread(editors, 12919)).to.equal(undefined);
      expect(nativeThread(editors, 12918)).not.to.equal(undefined);
      expect(editors.fileAt(diff.right.uri)).not.to.equal(undefined);

      editors.setContext({ ...context, review: { ...context.review, id: 2441 }});
      expect(allThreads(editors)).to.have.length(0);
      expect(harness(editors).diffs.size).to.equal(0);
      expect(editors.fileAt(diff.right.uri)).to.equal(undefined);
    });

    it("disposes a diff's threads when its tab closes", async () => {
      await editors.open(context, context.files!.final, row(context, LAP_TIMER_PATH));
      const natives = allThreads(editors);
      expect(natives.length).to.be.greaterThan(0);
      let disposed = 0;
      natives.forEach(native => {
        const dispose = native.dispose.bind(native);
        native.dispose = () => {
          disposed++;
          dispose();
        };
      });
      await commands.executeCommand("workbench.action.closeAllEditors");
      await until(() => harness(editors).diffs.size === 0);
      expect(disposed).to.equal(natives.length);
      expect(harness(editors).targets.size).to.equal(0);
      expect(harness(editors).threads.size).to.equal(0);
    });

    it("does not open a diff whose review was replaced meanwhile", async () => {
      let release!: (text: string) => void;
      const wait = new Promise<string>(resolve => {
        release = resolve;
      });
      service.text = () => wait;
      const opening = editors.open(context, context.files!.final, row(context, LAP_TIMER_PATH));
      editors.setContext({ ...context, review: { ...context.review, id: 2441 }});
      release(numberedText(400));
      await opening;
      expect(allThreads(editors)).to.have.length(0);
      expect(harness(editors).diffs.size).to.equal(0);
    });
  });

  describe("opening a discussion", () => {
    it("opens the discussion clicked last when two opens overlap", async () => {
      // The cm shell answers in order: each text() finishes after the ones asked for before it.
      let queue = Promise.resolve();
      service.text = (id: number) => {
        const text = queue.then(() => new Promise(resolve => setTimeout(resolve, 60)))
          .then(() => id < 0 ? "" : texts(id));
        queue = text.then(() => undefined, () => undefined);
        return text;
      };
      const first = editors.openComment(context, thread(context, 12907));
      await new Promise(resolve => setTimeout(resolve, 10));
      const second = editors.openComment(context, thread(context, 12918));
      await Promise.all([ first, second ]);
      expect(activeTabLabel()).to.equal("LapTimer.cs (cs:3471 ↔ cs:3715) · #12831");
      expect(window.tabGroups.all.some(group => group.tabs.some(tab =>
        tab.label.startsWith("GhostRunAnalyticsCollector.cs")))).to.equal(false);
      // A file opened after a discussion supersedes it the same way.
      const third = editors.openComment(context, thread(context, 12907));
      await new Promise(resolve => setTimeout(resolve, 10));
      const fourth = editors.open(context, context.files!.final, row(context, ADDED_PATH), { preserveFocus: true });
      await Promise.all([ third, fourth ]);
      expect(activeTabLabel()).to.equal("LapTimerDisplay.cs (added · cs:3715) · #12831");
    });

    it("opens the final diff on the left side for a base-side comment", async () => {
      await editors.openComment(context, thread(context, 12961));
      expect(activeTabLabel()).to.equal("LapTimer.cs (cs:3471 ↔ cs:3715) · #12831");
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, row(context, LAP_TIMER_PATH));
      const left = window.visibleTextEditors.find(
        editor => editor.document.uri.toString() === diff.left.uri.toString());
      expect(left?.selection.active.line).to.equal(55);
      expect(nativeThread(editors, 12961)!.collapsibleState).to.equal(CommentThreadCollapsibleState.Expanded);
    });

    it("opens the final diff at the mapped line for an older revision of the item", async () => {
      await editors.openComment(context, thread(context, 12919));
      expect(activeTabLabel()).to.equal("LapTimer.cs (cs:3471 ↔ cs:3715) · #12831");
      expect(editors.activeFile()?.file.path).to.equal(LAP_TIMER_PATH);
      expect(editors.activeFile()?.scope).to.equal("changes");
      expect(nativeThread(editors, 12919)!.collapsibleState).to.equal(CommentThreadCollapsibleState.Expanded);
    });

    it("compares an outdated comment's revision with the final row's left side", async () => {
      texts = id => id === 12671 ? numberedText(400, "old") : numberedText(400);
      await editors.openComment(context, thread(context, 12919));
      expect(activeTabLabel()).to.equal("LapTimer.cs (cs:3471 ↔ rev 12671 · outdated) · #12831");
      const native = nativeThread(editors, 12919)!;
      expect(native.range.start.line).to.equal(12);
      expect(native.label).to.equal("Change request · discarded · original context");
      const right = editors.activeFile();
      expect(right).to.equal(undefined, "an outdated diff is not a review file");
      const query = JSON.parse(native.uri.query) as { revisionId: number; side: string };
      expect(query).to.include({ revisionId: 12671, side: "right" });
      const left = allThreads(editors).find(candidate => candidate.label?.startsWith("Comment"));
      expect(JSON.parse(left!.uri.query)).to.include({ revisionId: 10851, side: "left" });
    });

    it("opens a comment without a final row in its revision's changeset, not the comment's CHANGESET", async () => {
      const answer = (command: string, args: string[]) => {
        if (command === "diff" && args[0].startsWith("br:")) {
          return "";
        }
        if (command === "find" && args[0] === "changereviewcomment") {
          return commentsXml([comment({ changesetId: -1 })]);
        }
        return defaultAnswer(command, args);
      };
      const simple = reviewService(channel, () => numberedText(10), answer, "wk2", "/unused");
      try {
        const simpleContext = await loadContext(simple.service, 5);
        await editors.openComment(simpleContext, simpleContext.threads[0]);
        expect(simple.shell.calls.some(call => call.command === "diff" && call.args[0] === "cs:2")).to.equal(true);
        expect(activeTabLabel()).to.equal("Test.cs (rev 11 · cs:2 · original context) · #5");
        expect(allThreads(editors).some(native => native.label === "Question · original context")).to.equal(true);
      } finally {
        simple.service.dispose();
      }
    });

    it("falls back to the revision against its previous revision", async () => {
      const answer = (command: string, args: string[]) => command === "diff" ? "" : defaultAnswer(command, args);
      const simple = reviewService(channel, () => numberedText(10), answer, "wk3", "/unused");
      try {
        const simpleContext = await loadContext(simple.service, 5);
        await editors.openComment(simpleContext, simpleContext.threads[0]);
        expect(activeTabLabel()).to.equal("Test.cs (rev 11 vs previous revision) · #5");
      } finally {
        simple.service.dispose();
      }
    });

    it("refuses a discussion without a location", async () => {
      expect(await failure(editors.openComment(context, thread(context, 12926)))).to.contain("General");
      const [wholeFile] = groupReviewThreads([comment({ location: -1, revisionId: 12804, type: "comment" })]);
      expect(await failure(editors.openComment(context, wholeFile))).to.contain("whole file");
    });
  });

  describe("files, sides and drafts", () => {
    it("resolves either side of a review diff to its file and scope", async () => {
      const lapTimer = row(context, LAP_TIMER_PATH);
      await editors.open(context, context.files!.final, lapTimer);
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, lapTimer);
      expect(editors.fileAt(diff.left.uri)).to.include({ file: lapTimer, reviewId: BRANCH_REVIEW_ID, side: "left",
        workspaceId: "wk" });
      expect(editors.fileAt(diff.right.uri)).to.include({ file: lapTimer, scope: "changes", side: "right" });
      expect(editors.fileAt(diff.right.uri)?.comparison).to.equal(context.files!.final);
      const merged = row(context, MERGED_PATH);
      await editors.open(context, context.files!.final, merged);
      expect(editors.activeFile()).to.include({ file: merged, scope: "merged" });
      expect(editors.fileAt(reviewOverviewUri("wk", BRANCH_REVIEW_ID))).to.equal(undefined);
    });

    it("reads a tab restored after a reload through its workspace's service", async () => {
      const comparison: IReviewComparison = { files: [], id: "restored", kind: "final", label: "cs:1 ↔ cs:2" };
      const uri = reviewDiff("wk", BRANCH_REVIEW_ID, comparison, file({ revisionId: 12804 })).right.uri;
      expect(await editors.provideTextDocumentContent(uri)).to.equal(numberedText(400));
      expect((await workspace.openTextDocument(uri)).lineCount).to.equal(400);
      const elsewhere = reviewDiff("gone", BRANCH_REVIEW_ID, comparison, file()).right.uri;
      expect(await failure(editors.provideTextDocumentContent(elsewhere))).to.contain("Reopen");
      const draft = await editors.draftAt(uri, 3);
      expect(draft).to.include({ location: 3, reviewId: BRANCH_REVIEW_ID, revisionId: 12804, workspaceId: "wk" });
      expect(editors.fileAt(uri)).to.equal(undefined);
    });

    it("serves the Overview and tells VS Code once when a burst of changes ends", async () => {
      const overview = reviewOverviewUri("wk", BRANCH_REVIEW_ID);
      expect(await editors.provideTextDocumentContent(overview)).to.equal("# Overview of #12831 in wk");
      const changed: string[] = [];
      editors.onDidChange(uri => changed.push(uri.toString()));
      // Mark All as Viewed, a stage landing and a poll at once: VS Code reads the Overview once.
      editors.refreshOverview("wk", BRANCH_REVIEW_ID);
      editors.refreshOverview("wk", BRANCH_REVIEW_ID);
      editors.refreshOverview("wk", CHANGESET_REVIEW_ID);
      editors.refreshOverview("wk", BRANCH_REVIEW_ID);
      expect(changed).to.deep.equal([]);
      await until(() => changed.length >= 2);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(changed.sort()).to.deep.equal([ overview, reviewOverviewUri("wk", CHANGESET_REVIEW_ID) ]
        .map(uri => uri.toString()).sort());
      // A later change is read again.
      editors.refreshOverview("wk", BRANCH_REVIEW_ID);
      await until(() => changed.length === 3);
      editors.setPostingEnabled(true);
      expect(editors.provideCommentingRanges(await workspace.openTextDocument(overview))).to.deep.equal([]);
    });

    it("creates a draft against the selected side's pinned revision", async () => {
      const lapTimer = row(context, LAP_TIMER_PATH);
      await editors.open(context, context.files!.final, lapTimer);
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, lapTimer);
      const draft = await editors.draftAt(diff.left.uri, 2);
      expect(draft).to.include({ location: 2, path: LAP_TIMER_PATH, reviewId: BRANCH_REVIEW_ID, revisionId: 10851,
        workspaceId: "wk" });
      expect(draft.changesetId).to.equal(3301);
      expect(draft.key).to.have.length(32);
      expect(await failure(editors.draftAt(diff.right.uri, 400))).to.contain("outside");
    });

    it("rejects drafts on a synthetic empty side", async () => {
      const added = row(context, ADDED_PATH);
      await editors.open(context, context.files!.final, added);
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, added);
      expect(await failure(editors.draftAt(diff.left.uri, 0))).to.contain("non-empty side");
    });

    it("offers commenting ranges and replies only while posting is enabled", async () => {
      const lapTimer = row(context, LAP_TIMER_PATH);
      await editors.open(context, context.files!.final, lapTimer);
      const diff = reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, lapTimer);
      const right = await workspace.openTextDocument(diff.right.uri);
      expect(editors.provideCommentingRanges(right)).to.deep.equal([]);
      expect(allThreads(editors).every(native => !native.canReply)).to.equal(true);
      editors.setPostingEnabled(true);
      expect(allThreads(editors).every(native => native.canReply)).to.equal(true);
      const ranges = editors.provideCommentingRanges(right);
      expect(ranges).to.have.length(1);
      expect(ranges[0].start.line).to.equal(0);
      expect(ranges[0].end.line).to.equal(399);
      const replyDraft = editors.replyDraft(nativeThread(editors, 12918)!);
      expect(replyDraft).to.include({ parentId: 12918, reviewId: BRANCH_REVIEW_ID, workspaceId: "wk" });
      expect(replyDraft?.key).to.have.length(32);
      const added = row(context, ADDED_PATH);
      await editors.open(context, context.files!.final, added);
      const empty = await workspace.openTextDocument(
        reviewDiff("wk", BRANCH_REVIEW_ID, context.files!.final, added).left.uri);
      expect(editors.provideCommentingRanges(empty)).to.deep.equal([]);
      expect(editors.provideCommentingRanges(await workspace.openTextDocument(right.uri))).to.have.length(1);
    });

    it("refuses rows without a text diff", async () => {
      expect(await failure(editors.open(context, context.files!.final, row(context, PHANTOM_PATH))))
        .to.contain("has no content change recorded");
      expect(await failure(editors.open(context, context.files!.final, file({
        baseRevisionId: -1,
        status: FileChangeStatus.Moved | FileChangeStatus.Changed,
      })))).to.contain("no source revision");
      expect(await failure(editors.open(context, context.files!.final, file({
        path: "/Art/Logo.png", revisionType: RevisionType.BinaryFile,
      })))).to.contain("Logo.png is a binary file");
    });
  });
});

describe("Review editor presentation", () => {
  const final: IReviewComparison = {
    baseChangesetId: 3471, files: [], headChangesetId: 3715, id: "f", kind: "final", label: "cs:3471 ↔ cs:3715",
  };
  const review = { kind: "review" } as const;

  it("titles every kind of diff with both sides", () => {
    const changed = file({ path: "/Code/Foo.cs" });
    expect(reviewDiffTitle(review, changed, final, 12831)).to.equal("Foo.cs (cs:3471 ↔ cs:3715) · #12831");
    expect(reviewDiffTitle(review, changed, { ...final, baseChangesetId: undefined }, 12831))
      .to.equal("Foo.cs (base ↔ cs:3715) · #12831");
    expect(reviewDiffTitle(review, file({ path: "/Code/Foo.cs", status: FileChangeStatus.Added }), final, 12831))
      .to.equal("Foo.cs (added · cs:3715) · #12831");
    expect(reviewDiffTitle(review, file({ path: "/Code/Foo.cs", status: FileChangeStatus.Deleted }), final, 12831))
      .to.equal("Foo.cs (deleted · cs:3715) · #12831");
    const moved = file({ oldPath: "/Code/Old.cs", path: "/Code/Foo.cs", status: FileChangeStatus.Moved });
    expect(reviewDiffTitle(review, moved, final, 12831)).to.equal("Old.cs ↔ Foo.cs (cs:3715) · #12831");
    expect(reviewDiffTitle(review, { ...moved, status: FileChangeStatus.Moved | FileChangeStatus.Changed }, final,
      12831)).to.equal("Old.cs (cs:3471) ↔ Foo.cs (cs:3715) · #12831");
    const changeset: IReviewComparison = {
      ...final, baseChangesetId: 3672, headChangesetId: 3673, kind: "changeset",
    };
    expect(reviewDiffTitle(review, changed, changeset, 12831)).to.equal("Foo.cs (cs:3672 ↔ cs:3673) · #12831");
    expect(reviewDiffTitle({ changesetId: 3651, kind: "original", revisionId: 12441 }, changed, final, 12831))
      .to.equal("Foo.cs (rev 12441 · cs:3651 · original context) · #12831");
    expect(reviewDiffTitle({ kind: "outdated", revisionId: 12441 }, changed, final, 12831))
      .to.equal("Foo.cs (cs:3471 ↔ rev 12441 · outdated) · #12831");
    expect(reviewDiffTitle({ kind: "previous", revisionId: 12441 }, changed, final, 12831))
      .to.equal("Foo.cs (rev 12441 vs previous revision) · #12831");
  });

  it("refuses exactly the rows the tree marks as having no text diff", () => {
    expect(noDiffReason(file())).to.equal(undefined);
    expect(noDiffReason(file({ baseRevisionId: -1, parentRevisionId: -1 }))).to.equal(NO_CONTENT_CHANGE);
    expect(noDiffReason(file({ baseRevisionId: -1 }))).to.equal(SOURCE_UNAVAILABLE);
    expect(noDiffMessage(file({ baseRevisionId: -1 }))).to.contain("no source revision");
    expect(noDiffMessage(file({ revisionType: RevisionType.Directory }))).to.contain("is a directory");
    expect(noDiffReason(file({ baseRevisionId: -1, status: FileChangeStatus.Added }))).to.equal(undefined);
    expect(noDiffReason(file({ baseRevisionId: -1, status: FileChangeStatus.Moved }))).to.equal(undefined);
    expect(noDiffReason(file({ baseRevisionId: -1, status: FileChangeStatus.Deleted }))).to.equal(undefined);
  });

  it("escapes angle brackets outside code and keeps line breaks", () => {
    expect(reviewCommentMarkdown(DUPLICATED)).to.equal("This allocates a new List\\<Sprite\\> each frame.");
    expect(reviewCommentMarkdown("Use `List<Sprite>` or ``a ` <b>`` here")).to.equal(
      "Use `List<Sprite>` or ``a ` <b>`` here");
    expect(reviewCommentMarkdown("first\nsecond\n\nnew <p>aragraph")).to.equal(
      "first  \nsecond\n\nnew \\<p\\>aragraph");
    expect(reviewCommentMarkdown("```cs\nvar x = new List<int>();\n```\nafter <b>")).to.equal(
      "```cs\nvar x = new List<int>();\n```\nafter \\<b\\>");
    expect(reviewCommentMarkdown("Code:\n\n    Dictionary<int, string> map;")).to.equal(
      "Code:\n\n    Dictionary<int, string> map;");
    expect(reviewCommentMarkdown("an `unclosed <tag>")).to.equal("an `unclosed \\<tag\\>");
    expect(reviewCommentMarkdown("already \\<escaped>\r\nwindows")).to.equal("already \\<escaped\\>  \nwindows");
    // A code block left open is closed with the fence that opened it.
    expect(reviewCommentMarkdown("Try:\n~~~~cs\nvar x = new List<int>();")).to.equal(
      "Try:\n~~~~cs\nvar x = new List<int>();\n~~~~");
    // Inside a list item, the closing fence keeps the item's indent; at column 0 it would open a new block.
    expect(reviewCommentMarkdown("- item\n  ```\n  code")).to.equal("- item\n  ```\n  code\n  ```");
    expect(reviewCommentMarkdown("1. item\n   ```cs\n   code")).to.equal("1. item\n   ```cs\n   code\n   ```");
  });

  it("keeps links whole: autolinks stay, and a bare URL before a bracket becomes one", () => {
    const ticket = "https://example.atlassian.net/browse/RAC-3921";
    expect(reviewCommentMarkdown(`Ticket: ${ticket}`)).to.equal(`Ticket: ${ticket}`);
    expect(reviewCommentMarkdown(`See <${ticket}> please`)).to.equal(`See <${ticket}> please`);
    // Escaped as \<, the bracket's backslash would end up in the link GFM makes of the bare URL.
    expect(reviewCommentMarkdown("https://example.com/List<Sprite>"))
      .to.equal("<https://example.com/List>\\<Sprite\\>");
    expect(reviewCommentMarkdown("x https://example.com/a> y")).to.equal("x <https://example.com/a>\\> y");
    expect(reviewCommentMarkdown("not a link: <b>https</b>")).to.equal("not a link: \\<b\\>https\\</b\\>");
    expect(reviewCommentMarkdown("`https://x.com/<a>`")).to.equal("`https://x.com/<a>`");
  });
});

describe("Review decorations", () => {
  let decorations: ReviewDecorations;
  const comparison: IReviewComparison = {
    files: [
      file({ path: "/A/Changed.cs", revisionId: 1 }),
      file({ path: "/A/Added.cs", revisionId: 2, status: FileChangeStatus.Added }),
      file({ path: "/A/Deleted.cs", revisionId: 3, status: FileChangeStatus.Deleted }),
      file({ oldPath: "/A/Old.cs", path: "/A/Moved.cs", revisionId: 4, status: FileChangeStatus.Moved }),
      file({
        oldPath: "/A/Older.cs", path: "/A/Both.cs", revisionId: 5,
        status: FileChangeStatus.Moved | FileChangeStatus.Changed,
      }),
    ],
    id: "cmp-1",
    kind: "final",
    label: "cs:1 ↔ cs:2",
  };
  beforeEach(() => {
    decorations = new ReviewDecorations();
  });
  afterEach(() => decorations.dispose());

  it("decorates each row's right-side URI with its status letters in Git's colours", () => {
    const fired: string[] = [];
    decorations.onDidChangeFileDecorations(uris => uris.forEach(uri => fired.push(uri.toString())));
    decorations.setComparison("wk", 5, comparison);
    const expected = [
      [ "C", "gitDecoration.modifiedResourceForeground" ],
      [ "A", "gitDecoration.addedResourceForeground" ],
      [ "D", "gitDecoration.deletedResourceForeground" ],
      [ "M", "gitDecoration.renamedResourceForeground" ],
      [ "CM", "gitDecoration.modifiedResourceForeground" ],
    ];
    comparison.files.forEach((change, index) => {
      const uri = reviewFileUri("wk", 5, comparison, change);
      const decoration = decorations.provideFileDecoration(uri)!;
      expect(decoration.badge).to.equal(expected[index][0]);
      expect(decoration.color?.id).to.equal(expected[index][1]);
      expect(decoration.propagate).to.equal(false);
      expect(fired).to.include(uri.toString());
    });
    const changed = comparison.files[0];
    expect(decorations.provideFileDecoration(reviewDiff("wk", 5, comparison, changed).left.uri)).to.equal(undefined);
    expect(decorations.provideFileDecoration(reviewFileUri("wk", 5, { ...comparison, id: "cmp-2" }, changed)))
      .to.equal(undefined);
    expect(decorations.provideFileDecoration(reviewFileUri("wk2", 5, comparison, changed))).to.equal(undefined);
  });

  it("replaces and clears a comparison's decorations", () => {
    decorations.setComparison("wk", 5, comparison);
    decorations.setComparison("wk", 5, { ...comparison, files: comparison.files.slice(0, 1) });
    expect(decorations.provideFileDecoration(reviewFileUri("wk", 5, comparison, comparison.files[1])))
      .to.equal(undefined);
    const first = reviewFileUri("wk", 5, comparison, comparison.files[0]);
    expect(decorations.provideFileDecoration(first)?.badge).to.equal("C");
    const other: IReviewComparison = { ...comparison, id: "cmp-2" };
    decorations.setComparison("wk", 5, other);
    const cleared: string[] = [];
    decorations.onDidChangeFileDecorations(uris => uris.forEach(uri => cleared.push(uri.toString())));
    decorations.clearComparison("wk", comparison);
    expect(decorations.provideFileDecoration(first)).to.equal(undefined);
    expect(cleared).to.deep.equal([first.toString()]);
    expect(decorations.provideFileDecoration(reviewFileUri("wk", 5, other, comparison.files[0]))?.badge)
      .to.equal("C");
    decorations.clear();
    expect(decorations.provideFileDecoration(reviewFileUri("wk", 5, other, comparison.files[0]))).to.equal(undefined);
  });
});
