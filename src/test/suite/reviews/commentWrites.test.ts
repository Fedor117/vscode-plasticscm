import { Comment, CommentMode, InputBoxOptions, MarkdownString, Uri } from "vscode";
import { exited, FakeCm } from "./cmFixtures";
import { fakePostingEditors, fakeThread, IFakePostingEditors } from "./editorFixtures";
import { ICommentTarget, ReviewPosting } from "../../../reviews/reviewPosting";
import { IReviewDraft, ReviewWriter } from "../../../reviews/reviewWriter";
import { comment } from "./fixtures";
import { expect } from "chai";
import { ICmOutput } from "../../../reviews/cmRunner";
import { IReviewComment } from "../../../reviews/models";

/**
 * Review-level comments, replies, edits and deletes with cm, on a fake
 * runner: nothing runs cm or reaches a server. Every user, repository,
 * review and GUID is made up.
 */

const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";
const ROOT = "/work/nimbus";
const ME = "sam.okafor@example.com";
const MINE = "0a1b2c3d-1111-4222-8333-000000000001";
const THEIRS = "0a1b2c3d-1111-4222-8333-000000000002";
const DESCRIPTION = "0a1b2c3d-1111-4222-8333-000000000003";
const draft: IReviewDraft = {
  key: "draft-one", location: 4, path: "/Code/Test.cs", reviewId: 12831, revisionId: 42, workspaceId: "workspace",
};
const KILLED: ICmOutput = { code: undefined, killed: "timeout", started: true, stderr: "", stdout: "" };

function row(overrides: Partial<IReviewComment>): IReviewComment {
  return comment({
    changesetId: -1, location: -1, reviewId: 12831, revisionId: -1, type: "conversation", ...overrides,
  });
}

const own = row({ guid: MINE, id: 501, owner: ME.toUpperCase(), text: "Ship it after the rename?" });
const theirs = row({ guid: THEIRS, id: 502, owner: "jordan.lee@example.com", text: "Looks fine." });
const target = (which: IReviewComment, extra: Partial<ICommentTarget> = {}): ICommentTarget =>
  ({ comment: which, reviewId: 12831, workspaceId: "workspace", ...extra });

/** A rendered comment's Markdown; undefined while it holds plain text, as an editor does. */
function markdownOf(native: Comment): string | undefined {
  return native.body instanceof MarkdownString ? native.body.value : undefined;
}

describe("Comment edits and review-level comments (fake cm)", () => {
  let cm: FakeCm;
  let editors: IFakePostingEditors;
  let posting: ReviewPosting;
  let inputs: InputBoxOptions[];
  let inputAnswer: string | undefined;
  let confirms: Array<{ message: string; detail: string; action?: string }>;
  let confirmAnswer: boolean;
  let notices: string[];
  let warnings: string[];
  let progress: string[];
  let reloads: Array<[string, number]>;
  let picks: string[];
  let setting: boolean;
  /** Which local comment each fake rendered comment shows, for the diff's Edit. */
  let shown: Map<Comment, ICommentTarget>;

  beforeEach(async () => {
    cm = new FakeCm();
    editors = fakePostingEditors(draft);
    shown = new Map();
    const thread = fakeThread(Uri.from({ path: "/Code/Test.cs", scheme: "plastic-review" }), 4);
    editors.serverComment = rendered => shown.get(rendered);
    editors.threadOf = rendered => (shown.has(rendered) ? thread : undefined);
    inputs = [];
    inputAnswer = undefined;
    confirms = [];
    confirmAnswer = true;
    notices = [];
    warnings = [];
    progress = [];
    reloads = [];
    picks = [];
    setting = true;
    const writer = new ReviewWriter({ cmPath: () => "cm", platform: "linux", run: cm.run });
    posting = new ReviewPosting(writer, {
      reloadDiscussions: (workspaceId, reviewId) => {
        reloads.push([ workspaceId, reviewId ]);
        return Promise.resolve();
      },
      repository: () => REPOSITORY,
      root: () => ROOT,
      user: () => ME,
    }, editors, {
      confirm: (message, detail, action) => {
        confirms.push({ action, detail, message });
        return Promise.resolve(confirmAnswer);
      },
      input: options => {
        inputs.push(options);
        return Promise.resolve(inputAnswer);
      },
      notify: message => notices.push(message),
      pick: (items, placeHolder) => {
        picks.push(placeHolder);
        return Promise.resolve(items[items.length - 1]);
      },
      progress: (title, task) => {
        progress.push(title);
        return task();
      },
      setting: () => setting,
      trusted: () => true,
      warn: message => warnings.push(message),
    });
    await posting.select("workspace");
  });
  afterEach(() => posting.dispose());

  describe("from Discussions and the Overview", () => {
    it("adds a comment on the whole review from the input box, then reloads the discussions", async () => {
      inputAnswer = "Rebased on main; please look again.";
      await posting.addReviewComment("workspace", 12831);
      expect(inputs).to.have.length(1);
      expect(inputs[0].title).to.equal("Comment on review #12831");
      expect(inputs[0].prompt).to.contain("acme-studio@unity").and.contain("Unity Version Control");
      expect(inputs[0].validateInput!(" ")).to.equal("Enter some text.");
      expect(inputs[0].validateInput!("x".repeat(64001))).to.equal("Enter at most 64,000 characters.");
      expect(cm.writes()).to.deep.equal([{
        args: [ "codereview", "comment", "add", "12831", "-commentsfile=-" ], cmPath: "cm", cwd: ROOT,
        stdin: "Rebased on main; please look again.",
      }]);
      expect(progress).to.deep.equal(["Posting a comment to review #12831…"]);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
      expect([ notices, warnings, confirms ]).to.deep.equal([[], [], []]);
    });

    it("sends nothing when the input box is dismissed", async () => {
      await posting.addReviewComment("workspace", 12831);
      await posting.replyTo(target(theirs));
      await posting.editWithInput(target(own));
      expect(inputs).to.have.length(3);
      expect(cm.writes()).to.deep.equal([]);
      expect(reloads).to.deep.equal([]);
    });

    it("replies to a comment by its GUID", async () => {
      inputAnswer = "Will do.";
      await posting.replyTo(target(theirs));
      expect(inputs[0].prompt).to.contain("\"Looks fine.\"");
      expect(cm.writes().map(call => [ call.args, call.stdin ])).to.deep.equal([
        [[ "codereview", "comment", "reply", THEIRS, "-commentsfile=-" ], "Will do." ],
      ]);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    });

    it("edits the user's own comment from a box that starts with its text, and sends nothing unchanged", async () => {
      inputAnswer = own.text;
      await posting.editWithInput(target(own));
      expect(inputs[0].value).to.equal(own.text);
      expect(inputs[0].prompt).to.not.contain("can't be shown");
      expect(cm.writes()).to.deep.equal([]);
      inputAnswer = "Ship it after the rename.";
      await posting.editWithInput(target(own));
      expect(cm.writes().map(call => [ call.args, call.stdin ])).to.deep.equal([
        [[ "codereview", "comment", "edit", MINE, "-commentsfile=-" ], "Ship it after the rename." ],
      ]);
      expect(progress).to.deep.equal(["Saving your comment on review #12831…"]);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    });

    it("says when the text has line breaks the box cannot show, and sends it as typed", async () => {
      const multi = { ...own, text: "First point.\n\nSecond point." };
      inputAnswer = "First point. Second point, revised.";
      await posting.editWithInput(target(multi));
      expect(inputs[0].value).to.equal("First point. Second point.");
      expect(inputs[0].prompt).to.contain("line breaks can't be shown here");
      expect(cm.writes()[0].stdin).to.equal("First point. Second point, revised.");
    });

    it("refuses to edit or delete someone else's comment, or a timeline row, before asking anything", async () => {
      inputAnswer = "Mine now";
      await posting.editWithInput(target(theirs));
      await posting.deleteComment(target(theirs));
      await posting.deleteComment(target({ ...own, type: "timeline" }));
      expect(notices).to.deep.equal([
        "Only your own comments can be edited.",
        "Only your own comments can be deleted.",
        "Only your own comments can be deleted.",
      ]);
      expect([ inputs, confirms, cm.writes() ]).to.deep.equal([[], [], []]);
    });

    it("edits the user's own description, and never deletes it", async () => {
      const description = row({ guid: DESCRIPTION, id: 503, owner: ME, text: "Adds lap splits.", type: "timeline" });
      inputAnswer = "Adds lap splits and ghost runs.";
      await posting.editWithInput(target(description, { description: true }));
      expect(inputs[0].title).to.equal("Edit the description on review #12831");
      expect(cm.writes().map(call => call.args)).to.deep.equal([
        [ "codereview", "comment", "edit", DESCRIPTION, "-commentsfile=-" ],
      ]);
      await posting.deleteComment(target(description, { description: true }));
      await posting.editWithInput(target({ ...description, owner: "jordan.lee@example.com" }, { description: true }));
      expect(notices).to.deep.equal([
        "Only your own comments can be deleted.", "Only your own description can be edited.",
      ]);
      expect(cm.writes()).to.have.length(1);
    });

    it("deletes only after the modal, says what is known about replies, and reloads", async () => {
      confirmAnswer = false;
      await posting.deleteComment(target(own, { replies: 2 }));
      expect(confirms).to.have.length(1);
      expect(confirms[0].message).to.equal("Delete this comment? This can't be undone.");
      expect(confirms[0].action).to.equal("Delete");
      expect(confirms[0].detail.split("\n")).to.deep.equal([
        "Review #12831: \"Ship it after the rename?\"",
        "It has 2 replies. cm's help doesn't say whether replies are deleted with the comment.",
        "Destination: acme-studio@unity through cm, as the user cm is signed in as",
      ]);
      expect(cm.writes()).to.deep.equal([]);
      expect(reloads).to.deep.equal([]);

      confirmAnswer = true;
      await posting.deleteComment(target(own));
      expect(confirms[1].detail).to.not.contain("repl");
      expect(cm.writes().map(call => [ call.args, call.stdin ])).to.deep.equal([
        [[ "codereview", "comment", "delete", MINE ], undefined ],
      ]);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    });

    it("shows cm's refusal, and reloads the discussions all the same", async () => {
      cm.answer = () => exited(1, "", "Error: The comment does not exist.");
      await posting.deleteComment(target(own));
      expect(notices).to.deep.equal(["The comment does not exist."]);
      expect(warnings).to.deep.equal([]);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    });

    it("says the result is unknown when cm may have written, and reloads", async () => {
      cm.answer = () => KILLED;
      inputAnswer = "Hello?";
      await posting.addReviewComment("workspace", 12831);
      expect(warnings).to.deep.equal([
        "Result unknown: cm did not finish in time. The comment may have been posted; refresh the review before " +
        "retrying.",
      ]);
      expect(notices).to.deep.equal([]);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    });

    it("asks for nothing and runs no write while posting is off", async () => {
      setting = false;
      inputAnswer = "Hello";
      await posting.addReviewComment("workspace", 12831);
      await posting.deleteComment(target(own));
      expect(notices).to.have.length(2);
      expect(notices[0]).to.contain("plastic-scm.reviews.commentWrites");
      expect([ inputs, confirms, cm.writes() ]).to.deep.equal([[], [], []]);
    });

    it("acts on the user's only comment in a thread, and asks which when there are several", async () => {
      expect(await posting.chooseOwn("workspace", [ theirs, own ], "edit")).to.equal(own);
      expect(picks).to.deep.equal([]);
      const second = { ...own, guid: THEIRS, id: 504, text: "Also the tests." };
      expect(await posting.chooseOwn("workspace", [ own, theirs, second ], "delete")).to.equal(second);
      expect(picks).to.deep.equal(["Which of your comments do you want to delete?"]);
      expect(await posting.chooseOwn("workspace", [theirs], "edit")).to.equal(undefined);
    });
  });

  describe("in a review diff", () => {
    const rendered = (which: IReviewComment): Comment => {
      const body = new MarkdownString("rendered *markdown*");
      const native: Comment = { author: { name: "sam.okafor" }, body, contextValue: "reviewComment-own",
        mode: CommentMode.Preview };
      shown.set(native, target(which));
      return native;
    };

    it("edits the comment's own text, saves it with cm and reloads", async () => {
      const native = rendered(own);
      posting.startEdit(native);
      expect(native.mode).to.equal(CommentMode.Editing);
      expect(native.body).to.equal(own.text);
      native.body = "Ship it after the rename and the tests.";
      await posting.saveEdit(native);
      expect(cm.writes().map(call => [ call.args, call.stdin ])).to.deep.equal([
        [[ "codereview", "comment", "edit", MINE, "-commentsfile=-" ], "Ship it after the rename and the tests." ],
      ]);
      expect(native.mode).to.equal(CommentMode.Preview);
      expect(markdownOf(native)).to.contain("Ship it after the rename and the tests.");
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
      expect(confirms).to.deep.equal([]);
    });

    it("cancels back to what it showed, and saves unchanged text without cm", async () => {
      const native = rendered(own);
      const before = native.body;
      posting.startEdit(native);
      native.body = "Changed my mind";
      posting.cancelEdit(native);
      expect([ native.mode, native.body ]).to.deep.equal([ CommentMode.Preview, before ]);
      posting.startEdit(native);
      await posting.saveEdit(native);
      expect([ native.mode, native.body ]).to.deep.equal([ CommentMode.Preview, before ]);
      expect(cm.writes()).to.deep.equal([]);
      expect(reloads).to.deep.equal([]);
    });

    it("keeps the editor open with the text when cm refuses, and ends it when the result is unknown", async () => {
      const native = rendered(own);
      posting.startEdit(native);
      native.body = "New text";
      cm.answer = () => exited(1, "", "Error: You can only edit your own comments.");
      await posting.saveEdit(native);
      expect(notices).to.deep.equal(["You can only edit your own comments."]);
      expect([ native.mode, native.body ]).to.deep.equal([ CommentMode.Editing, "New text" ]);
      cm.answer = () => KILLED;
      await posting.saveEdit(native);
      expect(native.mode).to.equal(CommentMode.Preview);
      expect(warnings[0]).to.match(/^Result unknown: cm did not finish in time\. The comment may have been changed/);
      expect(reloads).to.deep.equal([[ "workspace", 12831 ]]);
    });

    it("does not edit someone else's comment", () => {
      const native = rendered(theirs);
      posting.startEdit(native);
      expect(native.mode).to.equal(CommentMode.Preview);
    });
  });
});
