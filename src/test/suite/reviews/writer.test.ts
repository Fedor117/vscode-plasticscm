import {
  cmMessage,
  commentArguments,
  IReviewDraft,
  ReviewWriteError,
  ReviewWriter,
} from "../../../reviews/reviewWriter";
import { commentGuid, exited, FakeCm, OLD_USAGE } from "./cmFixtures";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { CancellationTokenSource } from "vscode";
import { expect } from "chai";
import { ICmOutput } from "../../../reviews/cmRunner";
import { join } from "path";
import { ReviewStatus } from "../../../reviews/models";
import { tmpdir } from "os";

/**
 * Review writes with cm, on a fake runner: nothing here starts a process.
 * Every review, revision, path and GUID is made up.
 */

const ROOT = "/work/nimbus";
const PARENT = "5a1e0000-1111-4222-8333-444455556666";
const draft: IReviewDraft = {
  key: "draft-one",
  location: 4,
  path: "/Code/Test.cs",
  reviewId: 312,
  revisionId: 42,
  workspaceId: "workspace",
};
const reply: IReviewDraft = { ...draft, key: "reply-one", parentGuid: PARENT };
const KILLED: ICmOutput = { code: undefined, killed: "timeout", started: true, stderr: "", stdout: "" };

async function failure(action: Promise<unknown>): Promise<ReviewWriteError> {
  try {
    await action;
  } catch (error) {
    expect(error).to.be.instanceOf(ReviewWriteError);
    return error as ReviewWriteError;
  }
  throw new Error("Expected the write to be refused.");
}

describe("ReviewWriter (fake cm)", () => {
  let cm: FakeCm;
  let log: string[];
  let cmPath: string;
  let writer: ReviewWriter;

  beforeEach(() => {
    cm = new FakeCm();
    log = [];
    cmPath = "cm";
    writer = new ReviewWriter({ cmPath: () => cmPath, log: message => log.push(message), run: cm.run });
  });

  describe("arguments", () => {
    it("pins a new comment to its revision and one-based line, as a plain comment", () => {
      expect(commentArguments(draft)).to.deep.equal([
        "codereview", "comment", "add", "312", "-commentsfile=-", "--revision=revid:42", "--line=5", "--type=Comment",
      ]);
    });

    it("names the changeset only for a draft written in one changeset's diff", () => {
      expect(commentArguments({ ...draft, changesetId: 3715 })).to.deep.equal([
        "codereview", "comment", "add", "312", "-commentsfile=-", "--revision=revid:42", "--line=5",
        "--changeset=cs:3715", "--type=Comment",
      ]);
    });

    it("posts a draft without a revision as a comment on the whole review", () => {
      expect(commentArguments({ ...draft, location: -1, revisionId: -1 })).to.deep.equal([
        "codereview", "comment", "add", "312", "-commentsfile=-",
      ]);
    });

    it("replies by the parent's GUID alone", () => {
      expect(commentArguments(reply)).to.deep.equal([ "codereview", "comment", "reply", PARENT, "-commentsfile=-" ]);
    });

    it("refuses anything that is not what cm expects, before cm runs", async () => {
      const refused: Array<[string, IReviewDraft, string]> = [
        [ "a review id of zero", { ...draft, reviewId: 0 }, "Invalid review id: 0" ],
        [ "a fractional review id", { ...draft, reviewId: 3.5 }, "Invalid review id: 3.5" ],
        [ "a review id that is not a number", { ...draft, reviewId: "312 --all" as unknown as number },
          "Invalid review id: 312 --all" ],
        [ "a fractional revision", { ...draft, revisionId: 4.2 }, "valid pinned revision and line" ],
        [ "a revision without a line", { ...draft, location: -1 }, "valid pinned revision and line" ],
        [ "a line that is not an integer", { ...draft, location: 1.5 }, "valid pinned revision and line" ],
        [ "a negative changeset", { ...draft, changesetId: -1 }, "valid changeset" ],
        [ "a changeset that is not a number", { ...draft, changesetId: "7 --x" as unknown as number },
          "valid changeset" ],
        [ "an empty parent GUID", { ...draft, parentGuid: "" }, "cannot be replied to yet" ],
        [ "a parent that is a number", { ...draft, parentGuid: "2227" }, "cannot be replied to yet" ],
        [ "a GUID with something after it", { ...draft, parentGuid: `${PARENT} --discard` },
          "cannot be replied to yet" ],
        [ "a GUID in braces", { ...draft, parentGuid: `{${PARENT}}` }, "cannot be replied to yet" ],
      ];
      for (const [ what, bad, message ] of refused) {
        const error = await failure(writer.send(ROOT, { ...bad, key: what }, "Hello"));
        expect(error.message, what).to.contain(message);
        expect(error.uncertain, what).to.equal(false);
      }
      expect(cm.calls).to.deep.equal([]);
    });

    it("refuses an empty text and one over 64,000 characters", async () => {
      for (const text of [ "", "  \n ", "x".repeat(64001) ]) {
        expect((await failure(writer.send(ROOT, draft, text))).message)
          .to.equal("Enter a comment of at most 64,000 characters.");
      }
      expect(cm.calls).to.deep.equal([]);
      expect(await writer.send(ROOT, draft, "x".repeat(64000))).to.equal(commentGuid(1));
    });
  });

  describe("comments and replies", () => {
    it("runs cm in the workspace's folder with the text on stdin, and resolves the new comment's GUID", async () => {
      const text = "First line\n  second \"line\" & $(more) --type=Change\n";
      expect(await writer.send(ROOT, draft, text)).to.equal(commentGuid(1));
      expect(cm.writes()).to.deep.equal([{
        args: [
          "codereview", "comment", "add", "312", "-commentsfile=-", "--revision=revid:42", "--line=5",
          "--type=Comment",
        ],
        cmPath: "cm",
        cwd: ROOT,
        stdin: text,
      }]);
    });

    it("replies with the text on stdin and resolves the reply's GUID", async () => {
      expect(await writer.send(ROOT, reply, "Because.")).to.equal(commentGuid(1));
      expect(cm.writes()).to.deep.equal([{
        args: [ "codereview", "comment", "reply", PARENT, "-commentsfile=-" ], cmPath: "cm", cwd: ROOT,
        stdin: "Because.",
      }]);
    });

    it("finds the GUID among whatever else cm prints", async () => {
      cm.answer = () => exited(0, `Comment created: ${commentGuid(7).toUpperCase()}\r\n`);
      expect(await writer.send(ROOT, draft, "Hello")).to.equal(commentGuid(7).toUpperCase());
    });

    it("logs the command and the review, never the text or what cm printed", async () => {
      cm.answer = call => (call.args[2] === "reply" ? exited(1, "", "Error: secret words echoed") : undefined);
      await writer.send(ROOT, draft, "secret words");
      await failure(writer.send(ROOT, reply, "secret words"));
      expect(log).to.deep.equal([
        "cm codereview comment add 312 (text on stdin)",
        "cm codereview comment add 312: exit code 0",
        `cm codereview comment reply ${PARENT} (text on stdin)`,
        `cm codereview comment reply ${PARENT}: exit code 1`,
      ]);
    });

    it("refuses a draft that is sending or was sent, and sends a failed one again", async () => {
      let release!: () => void;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      cm.answer = () => held.then(() => undefined);
      const first = writer.send(ROOT, draft, "Hello");
      expect((await failure(writer.send(ROOT, draft, "Hello"))).message)
        .to.equal("This draft is already sending or has been sent.");
      release();
      await first;
      await failure(writer.send(ROOT, draft, "Hello"));
      expect(cm.writes()).to.have.length(1);

      cm.answer = () => exited(1, "", "Error: The code review 312 does not exist.");
      await failure(writer.send(ROOT, { ...draft, key: "other" }, "Hello"));
      cm.answer = undefined;
      expect(await writer.send(ROOT, { ...draft, key: "other" }, "Hello")).to.equal(commentGuid(2));
    });
  });

  describe("outcomes", () => {
    it("takes cm's message, on one line and without its Error prefix, as a refusal", async () => {
      cm.answer = () => exited(1, "", "Error: The revision revid:42 is not part\r\n  of the code review 312.\n");
      const error = await failure(writer.send(ROOT, draft, "Hello"));
      expect(error.message).to.equal("The revision revid:42 is not part of the code review 312.");
      expect([ error.uncertain, error.refused ]).to.deep.equal([ false, true ]);
    });

    it("reads the message from stdout when stderr is empty", async () => {
      cm.answer = () => exited(3, "Error: You must be a reviewer", "");
      const error = await failure(writer.setStatus(ROOT, 312, "Reviewed"));
      expect([ error.message, error.uncertain, error.refused ])
        .to.deep.equal([ "You must be a reviewer.", false, true ]);
    });

    it("does not know the result when cm lost the server, or failed without a word", async () => {
      const lost = [
        "Error: The server didn't respond in time.",
        "Error: The operation has timed out",
        "Error: Unable to connect to the remote server",
        "Error: Connection reset by peer",
        "Error: The service is unavailable.",
      ];
      for (const said of lost) {
        cm.answer = () => exited(1, "", said);
        const error = await failure(writer.send(ROOT, { ...draft, key: said }, "Hello"));
        expect([ error.uncertain, error.refused ], said).to.deep.equal([ true, false ]);
        expect(error.message, said)
          .to.match(/\. The comment may have been posted; refresh the review before retrying\.$/);
      }
      cm.answer = () => exited(3);
      const silent = await failure(writer.setStatus(ROOT, 312, "Reviewed"));
      expect([ silent.message, silent.uncertain, silent.refused ]).to.deep.equal([
        "cm exited with code 3. Your status may have been set; refresh the review before retrying.", true, false,
      ]);
      // Unknown is not sent: Send Again's guard does not hold the draft, Allow Another Attempt decides.
      cm.answer = undefined;
      expect(await writer.send(ROOT, { ...draft, key: lost[0] }, "Hello")).to.equal(commentGuid(1));
    });

    it("cleans cm's messages", () => {
      expect(cmMessage({ stderr: "Error: Error:  a\n\tb ", stdout: "ignored" })).to.equal("a b");
      expect(cmMessage({ stderr: " \n", stdout: "from stdout" })).to.equal("from stdout");
      expect(cmMessage({ stderr: "", stdout: "" })).to.equal(undefined);
      expect(cmMessage({ stderr: "x".repeat(400), stdout: "" })).to.have.length(300);
    });

    it("does not know the result when cm exits cleanly without a GUID", async () => {
      cm.answer = () => exited(0, "Done.\n");
      const error = await failure(writer.send(ROOT, draft, "Hello"));
      expect(error.uncertain).to.equal(true);
      expect(error.message).to.equal("cm did not name the new comment. The comment may have been posted; refresh " +
        "the review before retrying.");
      // Unknown is not sent: the same draft may go again once the user allows it.
      cm.answer = undefined;
      expect(await writer.send(ROOT, draft, "Hello")).to.equal(commentGuid(1));
    });

    it("does not know the result when cm was killed after it started", async () => {
      const cases: Array<[ICmOutput, string]> = [
        [ KILLED, "cm did not finish in time. The reply may have been posted; refresh the review before retrying." ],
        [{ ...KILLED, killed: "cancelled" },
          "Cancelled before cm finished. The reply may have been posted; refresh the review before retrying." ],
        [{ ...KILLED, killed: undefined },
          "cm ended without a result. The reply may have been posted; refresh the review before retrying." ],
      ];
      for (const [ output, message ] of cases) {
        cm.answer = () => output;
        const error = await failure(writer.send(ROOT, { ...reply, key: message }, "Hello"));
        expect(error.message).to.equal(message);
        expect(error.uncertain).to.equal(true);
      }
      cm.answer = () => KILLED;
      const add = await failure(writer.addReviewer(ROOT, 312));
      expect([ add.message, add.uncertain ]).to.deep.equal([
        "cm did not finish in time. You may have been added; refresh the review before retrying.", true,
      ]);
      const verdict = await failure(writer.setStatus(ROOT, 312, "Reviewed"));
      expect([ verdict.message, verdict.uncertain ]).to.deep.equal([
        "cm did not finish in time. Your status may have been set; refresh the review before retrying.", true,
      ]);
    });

    it("knows nothing was sent when cm did not start", async () => {
      cm.answer = () => ({ code: undefined, killed: "cancelled", started: false, stderr: "", stdout: "" });
      const cancelled = await failure(writer.addReviewer(ROOT, 312));
      expect([ cancelled.message, cancelled.uncertain ])
        .to.deep.equal([ "Cancelled before anything was sent.", false ]);
      cm.answer = () => ({ code: undefined, missing: true, started: false, stderr: "", stdout: "" });
      const missing = await failure(writer.addReviewer(ROOT, 312));
      expect([ missing.message, missing.uncertain ]).to.deep.equal([
        "cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting.", false,
      ]);
      cm.answer = () => ({ code: undefined, started: false, stderr: "", stdout: "" });
      const unstarted = await failure(writer.addReviewer(ROOT, 312));
      expect([ unstarted.uncertain, unstarted.refused ]).to.deep.equal([ false, false ]);
      expect(unstarted.message).to.contain("cm could not be started");
      // The operating system says a missing folder the way it says a missing cm; the runner tells them apart.
      cm.answer = () => ({ code: undefined, cwdMissing: true, started: false, stderr: "", stdout: "" });
      const gone = await failure(writer.addReviewer(ROOT, 312));
      expect([ gone.message, gone.uncertain, gone.refused ])
        .to.deep.equal([ "The review workspace's folder no longer exists.", false, false ]);
    });

    it("hands the cancellation to the runner", async () => {
      const source = new CancellationTokenSource();
      let seen: unknown;
      cm.answer = (_call, run) => {
        seen = run.cancel;
        return undefined;
      };
      await writer.addReviewer(ROOT, 312, source.token);
      expect(seen).to.equal(source.token);
      source.dispose();
    });

    it("refuses to write without a workspace folder", async () => {
      expect((await failure(writer.addReviewer("", 312))).message)
        .to.equal("The review workspace is no longer available.");
      expect(cm.calls).to.deep.equal([]);
    });
  });

  describe("the text on Windows", () => {
    let temp: string;
    beforeEach(() => {
      temp = mkdtempSync(join(tmpdir(), "writer-test-"));
    });
    afterEach(() => rmSync(temp, { force: true, recursive: true }));

    it("hands the text to cm in a UTF-8 file with a byte order mark, and deletes it once cm has ended", async () => {
      const windows = new ReviewWriter({
        cmPath: () => "cm", log: message => log.push(message), platform: "win32", run: cm.run, tempDir: () => temp,
      });
      const text = "Looks good \u2014 na\u00efve fix \u2713\nSecond line";
      let file = "";
      let bytes: Buffer | undefined;
      cm.answer = call => {
        file = call.args.find(arg => arg.startsWith("-commentsfile="))!.substring("-commentsfile=".length);
        bytes = readFileSync(file);
        return undefined;
      };
      expect(await windows.send(ROOT, draft, text)).to.equal(commentGuid(1));
      const [call] = cm.writes();
      expect(call.stdin).to.equal(undefined);
      expect(call.args).to.deep.equal([
        "codereview", "comment", "add", "312", `-commentsfile=${file}`, "--revision=revid:42", "--line=5",
        "--type=Comment",
      ]);
      expect(file.startsWith(temp)).to.equal(true);
      expect(bytes!.subarray(0, 3)).to.deep.equal(Buffer.from([ 0xef, 0xbb, 0xbf ]));
      expect(bytes!.subarray(3).toString("utf8")).to.equal(text);
      expect(readdirSync(temp)).to.deep.equal([]);
      expect(log[0]).to.equal("cm codereview comment add 312 (text in a temporary file)");

      // A failed run deletes it too, and so does one that never got to cm.
      cm.answer = () => exited(1, "", "Error: The code review 312 does not exist.");
      await failure(windows.send(ROOT, reply, text));
      expect(readdirSync(temp)).to.deep.equal([]);
      await failure(windows.send("", { ...reply, key: "no-folder" }, text));
      expect(readdirSync(temp)).to.deep.equal([]);
    });

    it("sends nothing when the file cannot be made", async () => {
      const windows = new ReviewWriter({
        cmPath: () => "cm", platform: "win32", run: cm.run, tempDir: () => join(temp, "missing", "deeper"),
      });
      const error = await failure(windows.send(ROOT, draft, "Hello"));
      expect([ error.message, error.uncertain ]).to.deep.equal([
        "The text could not be written to a temporary file for cm. Nothing was sent.", false,
      ]);
      expect(cm.writes()).to.deep.equal([]);
    });
  });

  describe("edits and deletes", () => {
    it("edits a comment by its GUID with the new text on stdin, and logs no text", async () => {
      const text = "Fixed text\nwith a second line --type=Change";
      await writer.editComment(ROOT, PARENT, text);
      expect(cm.writes()).to.deep.equal([{
        args: [ "codereview", "comment", "edit", PARENT, "-commentsfile=-" ], cmPath: "cm", cwd: ROOT, stdin: text,
      }]);
      expect(log).to.deep.equal([
        `cm codereview comment edit ${PARENT} (text on stdin)`,
        `cm codereview comment edit ${PARENT}: exit code 0`,
      ]);
    });

    it("deletes a comment by its GUID, with nothing on stdin", async () => {
      await writer.deleteComment(ROOT, PARENT);
      expect(cm.writes()).to.deep.equal([{
        args: [ "codereview", "comment", "delete", PARENT ], cmPath: "cm", cwd: ROOT, stdin: undefined,
      }]);
      expect(log).to.deep.equal([
        `cm codereview comment delete ${PARENT}`,
        `cm codereview comment delete ${PARENT}: exit code 0`,
      ]);
    });

    it("refuses a GUID that is not one whole GUID, and text cm would not take, before cm runs", async () => {
      for (const guid of [ "", "2227", `${PARENT} --repository=other`, `{${PARENT}}`, `-c=${PARENT}` ]) {
        expect((await failure(writer.editComment(ROOT, guid, "Text"))).message, guid).to.contain("Refresh the review");
        expect((await failure(writer.deleteComment(ROOT, guid))).message, guid).to.contain("Refresh the review");
      }
      for (const text of [ "", " \n", "x".repeat(64001) ]) {
        expect((await failure(writer.editComment(ROOT, PARENT, text))).message)
          .to.equal("Enter a comment of at most 64,000 characters.");
      }
      expect(cm.calls).to.deep.equal([]);
    });

    it("classifies edits and deletes as it does comments: refused, or of unknown result", async () => {
      cm.answer = () => exited(1, "", "Error: You can only edit your own comments.");
      const refused = await failure(writer.editComment(ROOT, PARENT, "Text"));
      expect([ refused.message, refused.uncertain, refused.refused ])
        .to.deep.equal([ "You can only edit your own comments.", false, true ]);
      cm.answer = () => KILLED;
      const lost = await failure(writer.deleteComment(ROOT, PARENT));
      expect([ lost.message, lost.uncertain ]).to.deep.equal([
        "cm did not finish in time. The comment may have been deleted; refresh the review before retrying.", true,
      ]);
      cm.answer = () => exited(1, "", "Error: The server didn't respond in time.");
      expect((await failure(writer.editComment(ROOT, PARENT, "Text"))).message).to.equal(
        "The server didn't respond in time. The comment may have been changed; refresh the review before retrying.");
    });

    it("does not know whether a delete happened when cm exits cleanly but reports an error", async () => {
      cm.answer = () => exited(0, "", "Error: The comment could not be deleted.");
      const error = await failure(writer.deleteComment(ROOT, PARENT));
      expect([ error.message, error.uncertain ]).to.deep.equal([
        "cm said: The comment could not be deleted. The comment may have been deleted; refresh the review to check.",
        true,
      ]);
    });

    it("hands an edit's text to cm in a temporary file on Windows, and deletes it", async () => {
      const temp = mkdtempSync(join(tmpdir(), "writer-test-"));
      try {
        const windows = new ReviewWriter({ cmPath: () => "cm", platform: "win32", run: cm.run, tempDir: () => temp });
        let text = "";
        cm.answer = call => {
          const file = call.args[4].substring("-commentsfile=".length);
          text = readFileSync(file).subarray(3).toString("utf8");
          return undefined;
        };
        await windows.editComment(ROOT, PARENT, "Naïve ✓");
        expect(cm.writes()[0].args.slice(0, 4)).to.deep.equal([ "codereview", "comment", "edit", PARENT ]);
        expect(cm.writes()[0].stdin).to.equal(undefined);
        expect(text).to.equal("Naïve ✓");
        expect(readdirSync(temp)).to.deep.equal([]);
      } finally {
        rmSync(temp, { force: true, recursive: true });
      }
    });
  });

  describe("reviewers and verdicts", () => {
    it("adds the cm user with --users=me", async () => {
      await writer.addReviewer(ROOT, 312);
      expect(cm.writes()).to.deep.equal([{
        args: [ "codereview", "reviewer", "add", "312", "--users=me" ], cmPath: "cm", cwd: ROOT, stdin: undefined,
      }]);
      expect(log).to.deep.equal([ "cm codereview reviewer add 312", "cm codereview reviewer add 312: exit code 0" ]);
    });

    it("maps each review status to cm's flag", async () => {
      const flags: Array<[ReviewStatus, string]> = [
        [ "Under review", "--under-review" ], [ "Reviewed", "--reviewed" ], [ "Rework required", "--rework-required" ],
      ];
      for (const [ status, flag ] of flags) {
        await writer.setStatus(ROOT, 312, status);
        const calls = cm.writes();
        expect(calls[calls.length - 1]).to.deep.equal({
          args: [ "codereview", "review", "312", flag ], cmPath: "cm", cwd: ROOT, stdin: undefined,
        });
      }
    });

    it("refuses an unknown status and an invalid review id before cm runs", async () => {
      for (const status of [ "Approved", "constructor", "--re-request" ]) {
        expect((await failure(writer.setStatus(ROOT, 312, status as ReviewStatus))).message)
          .to.equal(`Invalid review status: ${status}`);
      }
      expect((await failure(writer.setStatus(ROOT, -1, "Reviewed"))).message).to.equal("Invalid review id: -1");
      expect((await failure(writer.addReviewer(ROOT, Number.NaN))).message).to.equal("Invalid review id: NaN");
      expect(cm.calls).to.deep.equal([]);
    });

    it("sends every add it is asked for: the caller keeps one in flight", async () => {
      await writer.addReviewer(ROOT, 312);
      await writer.addReviewer(ROOT, 312);
      expect(cm.writes()).to.have.length(2);
    });
  });

  describe("capability detection", () => {
    it("asks cm once per path whether it has the comment commands", async () => {
      expect(await writer.support()).to.deep.equal({ supported: true });
      await writer.support();
      await writer.send(ROOT, draft, "Hello");
      await writer.addReviewer(ROOT, 312);
      expect(cm.probes()).to.deep.equal([{
        args: [ "codereview", "comment", "--usage" ], cmPath: "cm", cwd: undefined, stdin: undefined,
      }]);
      cmPath = "/opt/other/cm";
      await writer.support();
      expect(cm.probes().map(call => call.cmPath)).to.deep.equal([ "cm", "/opt/other/cm" ]);
    });

    it("blocks every write with an older cm, and says which client is needed", async () => {
      const reason = "Review writes need Unity Version Control client 11.0.16.10512 or newer.";
      for (const usage of [ exited(0, OLD_USAGE), exited(1, "", "Error: Unknown command"), exited(0, "") ]) {
        const old = new FakeCm();
        old.usage = usage;
        const other = new ReviewWriter({ cmPath: () => "cm", run: old.run });
        expect(await other.support()).to.deep.equal({ reason, supported: false });
        expect((await failure(other.send(ROOT, draft, "Hello"))).message).to.equal(reason);
        expect((await failure(other.addReviewer(ROOT, 312))).message).to.equal(reason);
        expect((await failure(other.setStatus(ROOT, 312, "Reviewed"))).message).to.equal(reason);
        expect(old.writes()).to.deep.equal([]);
        // A no is not kept: a client upgraded in place is found the next time.
        expect(old.probes(), "asked every time").to.have.length(4);
        old.usage = exited(0, "    - reply\n");
        expect(await other.support()).to.deep.equal({ supported: true });
      }
    });

    it("forgets every answer when told to, as on a change to the cm settings", async () => {
      expect(await writer.support()).to.deep.equal({ supported: true });
      cm.usage = exited(0, OLD_USAGE);
      expect(await writer.support()).to.deep.equal({ supported: true });
      writer.forgetSupport();
      expect((await writer.support()).supported).to.equal(false);
      expect(cm.probes()).to.have.length(2);
    });

    it("says cm is missing, and asks again once it may be there", async () => {
      cm.usage = { code: undefined, missing: true, started: false, stderr: "", stdout: "" };
      const reason = "cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting.";
      expect(await writer.support()).to.deep.equal({ reason, supported: false });
      const error = await failure(writer.send(ROOT, draft, "Hello"));
      expect([ error.message, error.uncertain ]).to.deep.equal([ reason, false ]);
      expect(cm.writes()).to.deep.equal([]);
      cm.usage = exited(0, "Commands:\n    - add | mk\n    - reply\n");
      expect(await writer.support()).to.deep.equal({ supported: true });
    });

    it("does not keep an answer from a cm that did not finish", async () => {
      cm.usage = KILLED;
      expect((await writer.support()).supported).to.equal(false);
      cm.usage = exited(0, "    - reply\n");
      expect(await writer.support()).to.deep.equal({ supported: true });
    });
  });
});
