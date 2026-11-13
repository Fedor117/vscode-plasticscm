import * as fs from "fs";
import { CodeReview, IListedReviewer } from "../../../../../cm/commands";
import { hasSubcommands, parseCreatedReviewId } from "../../../../../cm/commands/codeReview/codeReview";
import { IExecCall, mockShell, mockShellAnswering } from "../findChangesets/shellMock";
import { expect } from "chai";

/** `cm codereview` writes, on a mock shell: the exact arguments cm would get. Names are made up. */

const OK = { result: [], success: true };
const channel = { appendLine: () => undefined };
const GUID = "27658884-5dcc-49b7-b0ef-a5760ae740a3";

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

/** A shell that answers like `mockShell(OK)` and records what each temp file held while cm ran. */
function recordingFiles(): { shell: ReturnType<typeof mockShell>; texts: string[] } {
  const texts: string[] = [];
  const shell = mockShellAnswering<string[]>((call: IExecCall) => {
    for (const arg of call.args) {
      const file = /^(?:-commentsfile|--descriptionfile)=(.+)$/.exec(arg);
      if (file) {
        texts.push(fs.readFileSync(file[1], "utf8"));
      }
    }
    return { result: ["5e1f0c2a-0000-4000-8000-000000007001"], success: true };
  });
  return { shell, texts };
}

describe("CodeReview.support", () => {
  const usage = (lines: { [args: string]: string[] }) => mockShellAnswering<string[]>(call => ({
    result: lines[call.args.join(" ")] ?? [], success: true,
  }));

  it("asks each subcommand's --usage, read-only and with a short timeout, and reads its command list", async () => {
    const shell = usage({
      "--usage": ["    --descriptionfile      Reads the description from a file."],
      "comment --usage": [ "Commands:", "    - add | mk", "    - reply", "    - edit", "    - delete | rm" ],
      "review --usage": [
        "    (--reviewed | --rework-required | --under-review)",
        "    cm cr review <id> --re-request",
      ],
      "reviewer --usage": [ "Commands:", "    - add", "    - remove", "    - list | ls" ],
    });
    const support = await CodeReview.support(shell.mock.object);
    expect(support).to.eql({ comments: true, descriptionFile: true, review: true, reviewers: true });
    expect(shell.calls).to.eql([
      { args: [ "comment", "--usage" ], command: "codereview", options: { timeoutMillis: 15000 }},
      { args: [ "reviewer", "--usage" ], command: "codereview", options: { timeoutMillis: 15000 }},
      { args: [ "review", "--usage" ], command: "codereview", options: { timeoutMillis: 15000 }},
      { args: ["--usage"], command: "codereview", options: { timeoutMillis: 15000 }},
    ]);
  });

  it("finds nothing where an older cm prints the general usage for every subcommand, with exit code 0", async () => {
    const general = [ "Creates, edits, or deletes code reviews.", "    cm codereview <spec> <title> [--status=<s>]" ];
    const shell = mockShellAnswering<string[]>(() => ({ result: general, success: true }));
    expect(await CodeReview.support(shell.mock.object))
      .to.eql({ comments: false, descriptionFile: false, review: false, reviewers: false });
  });

  it("finds nothing when cm fails", async () => {
    const shell = mockShell({ error: new Error("cm is not running"), success: false });
    expect(await CodeReview.support(shell.mock.object))
      .to.eql({ comments: false, descriptionFile: false, review: false, reviewers: false });
  });

  it("matches command rows, not words in prose", () => {
    expect(hasSubcommands([ "    - add | mk", "    - reply" ], [ "add", "reply" ])).to.equal(true);
    expect(hasSubcommands(["cm codereview (comment | reviewer) <command> to add a reply"], ["reply"])).to.equal(false);
  });
});

describe("CodeReview.create", () => {
  it("passes the target, the title and --format={id}, and reads the new id", async () => {
    const shell = mockShell({ result: ["1367"], success: true });
    const created = await CodeReview.create(shell.mock.object, channel, { spec: "br:/main/task001", title: "Fix it" });
    expect(created).to.eql({ id: 1367, lines: ["1367"] });
    expect(shell.calls).to.eql([{ args: [ "br:/main/task001", "Fix it", "--format={id}" ], command: "codereview" }]);
  });

  it("passes reviewers and groups, and the description in a file that is removed afterwards", async () => {
    const { shell, texts } = recordingFiles();
    await CodeReview.create(shell.mock.object, channel, {
      description: "Retries the token refresh once.\nSee the ticket.",
      reviewers: { groups: ["Developers"], users: [ "someone@example.com", "me" ] },
      spec: "cs:1856",
      title: "Login crash",
    });
    const args = shell.calls[0].args;
    expect(args.slice(0, 4))
      .to.eql([ "cs:1856", "Login crash", "--users=someone@example.com,me", "--groups=Developers" ]);
    expect(args[4]).to.match(/^--descriptionfile=/);
    expect(args[5]).to.equal("--format={id}");
    expect(texts).to.eql(["Retries the token refresh once.\nSee the ticket."]);
    expect(fs.existsSync(args[4].substring("--descriptionfile=".length))).to.equal(false);
  });

  it("names the review cm created when cm then fails, and says cm failed otherwise", async () => {
    const created = mockShell({ error: new Error("Could not add the description."), result: ["1368"], success: false });
    const error = await runCatching(() =>
      CodeReview.create(created.mock.object, channel, { description: "x", spec: "sh:12", title: "Shelve" }));
    expect(error?.message)
      .to.equal("Review #1368 was created, but cm reported an error: Could not add the description.");
    const failed = mockShell({ error: new Error("The branch does not exist."), success: false });
    const other = await runCatching(() =>
      CodeReview.create(failed.mock.object, channel, { spec: "br:/main/x", title: "X" }));
    expect(other?.message).to.equal("The branch does not exist.");
  });

  it("refuses targets, titles and names the shell could not quote, without calling cm", async () => {
    const shell = mockShell(OK);
    const requests = [
      { spec: "/main/task", title: "No prefix" },
      { spec: "br:/main/\"x", title: "Quote" },
      { spec: "lb:BL001", title: "Label" },
      { spec: "br:/main/x", title: "A \"quoted\" title" },
      { spec: "br:/main/x", title: "Two\nlines" },
      { spec: "br:/main/x", title: "  " },
      { reviewers: { users: ["a,b"] }, spec: "br:/main/x", title: "Comma" },
      { reviewers: { groups: ["dev\"s"] }, spec: "br:/main/x", title: "Quote" },
    ];
    for (const request of requests) {
      expect(await runCatching(() => CodeReview.create(shell.mock.object, channel, request)), JSON.stringify(request))
        .to.be.instanceOf(Error);
    }
    expect(shell.calls).to.eql([]);
  });

  it("reads the id from the last line that is only a number", () => {
    expect(parseCreatedReviewId([ "Creating…", " 42 " ])).to.equal(42);
    expect(parseCreatedReviewId(["Review 42 created"])).to.equal(undefined);
    expect(parseCreatedReviewId([])).to.equal(undefined);
  });
});

describe("CodeReview reviewers and own status", () => {
  it("lists reviewers as XML in UTF-8", async () => {
    const listed: IListedReviewer[] = [{ name: "someone@example.com", status: "Reviewed", type: "user" }];
    const shell = mockShell({ result: listed, success: true });
    expect(await CodeReview.listReviewers(shell.mock.object, 1367)).to.eql(listed);
    expect(shell.calls).to.eql([
      { args: [ "reviewer", "list", "1367", "--xml", "--encoding=utf-8" ], command: "codereview" },
    ]);
  });

  it("adds and removes users and groups", async () => {
    const shell = mockShell(OK);
    await CodeReview.addReviewers(shell.mock.object, 1367, { users: ["me"] });
    await CodeReview.addReviewers(shell.mock.object, 1367, { groups: ["Developers"], users: [ "a@example.com", " " ] });
    await CodeReview.removeReviewers(shell.mock.object, 1367, { users: ["a@example.com"] });
    expect(shell.calls).to.eql([
      { args: [ "reviewer", "add", "1367", "--users=me" ], command: "codereview" },
      { args: [ "reviewer", "add", "1367", "--users=a@example.com", "--groups=Developers" ], command: "codereview" },
      { args: [ "reviewer", "remove", "1367", "--users=a@example.com" ], command: "codereview" },
    ]);
  });

  it("sets the cm user's own status and asks reviewers again", async () => {
    const shell = mockShell(OK);
    await CodeReview.setOwnStatus(shell.mock.object, 1367, "Reviewed");
    await CodeReview.setOwnStatus(shell.mock.object, 1367, "Rework required");
    await CodeReview.setOwnStatus(shell.mock.object, 1367, "Under review");
    await CodeReview.reRequest(shell.mock.object, 1367, "all");
    await CodeReview.reRequest(shell.mock.object, 1367, { users: ["someone@example.com"] });
    expect(shell.calls.map(call => call.args)).to.eql([
      [ "review", "1367", "--reviewed" ],
      [ "review", "1367", "--rework-required" ],
      [ "review", "1367", "--under-review" ],
      [ "review", "1367", "--re-request", "--all" ],
      [ "review", "1367", "--re-request", "--users=someone@example.com" ],
    ]);
  });

  it("refuses a bad review id, nobody to add, and a status cm does not know, without calling cm", async () => {
    const shell = mockShell(OK);
    const attempts: Array<() => Promise<unknown>> = [
      () => CodeReview.addReviewers(shell.mock.object, 0, { users: ["me"] }),
      () => CodeReview.addReviewers(shell.mock.object, 1.5, { users: ["me"] }),
      () => CodeReview.addReviewers(shell.mock.object, 1, {}),
      () => CodeReview.removeReviewers(shell.mock.object, 1, { users: ["  "] }),
      () => CodeReview.reRequest(shell.mock.object, 1, {}),
      () => CodeReview.setOwnStatus(shell.mock.object, 1, "Approved" as "Reviewed"),
      () => CodeReview.listReviewers(shell.mock.object, -1),
    ];
    for (const attempt of attempts) {
      expect(await runCatching(attempt)).to.be.instanceOf(Error);
    }
    expect(shell.calls).to.eql([]);
  });

  it("throws cm's error when a write fails", async () => {
    const shell = mockShell({ error: new Error("You are not a reviewer."), success: false });
    const error = await runCatching(() => CodeReview.setOwnStatus(shell.mock.object, 1367, "Reviewed"));
    expect(error?.message).to.equal("You are not a reviewer.");
  });
});

describe("CodeReview comments", () => {
  it("adds a comment on the whole review from a comments file", async () => {
    const { shell, texts } = recordingFiles();
    await CodeReview.addComment(shell.mock.object, channel, 1367, "Looks \"good\"\noverall");
    const args = shell.calls[0].args;
    expect(args.slice(0, 3)).to.eql([ "comment", "add", "1367" ]);
    expect(args[3]).to.match(/^-commentsfile=/);
    expect(args).to.have.length(4);
    expect(texts).to.eql(["Looks \"good\"\noverall"]);
    expect(fs.existsSync(args[3].substring("-commentsfile=".length))).to.equal(false);
  });

  it("adds a comment on a line of a revision, counting lines from 1", async () => {
    const { shell } = recordingFiles();
    await CodeReview.addComment(shell.mock.object, channel, 1367, "Rename this", { line: 42, revisionId: 5821 });
    const args = shell.calls[0].args;
    expect(args.slice(4)).to.eql([ "--revision=revid:5821", "--line=42", "--type=Comment" ]);
  });

  it("replies to, edits and deletes a comment by its GUID", async () => {
    const { shell, texts } = recordingFiles();
    await CodeReview.reply(shell.mock.object, channel, GUID, "Done");
    await CodeReview.editComment(shell.mock.object, channel, GUID, "Fixed text");
    await CodeReview.deleteComment(shell.mock.object, GUID);
    expect(shell.calls.map(call => call.args.slice(0, 3))).to.eql([
      [ "comment", "reply", GUID ],
      [ "comment", "edit", GUID ],
      [ "comment", "delete", GUID ],
    ]);
    expect(shell.calls[0].args[3]).to.match(/^-commentsfile=/);
    expect(shell.calls[2].args).to.have.length(3);
    expect(texts).to.eql([ "Done", "Fixed text" ]);
  });

  it("refuses empty text, a GUID that is not one, and a bad anchor, without calling cm", async () => {
    const shell = mockShell(OK);
    const attempts: Array<() => Promise<unknown>> = [
      () => CodeReview.addComment(shell.mock.object, channel, 1367, "  "),
      () => CodeReview.addComment(shell.mock.object, channel, 1367, "x".repeat(64001)),
      () => CodeReview.addComment(shell.mock.object, channel, 1367, "x", { line: 0, revisionId: 5 }),
      () => CodeReview.addComment(shell.mock.object, channel, 1367, "x", { line: 1, revisionId: -1 }),
      () => CodeReview.reply(shell.mock.object, channel, "1234", "x"),
      () => CodeReview.editComment(shell.mock.object, channel, `${GUID}" --x`, "x"),
      () => CodeReview.deleteComment(shell.mock.object, ""),
    ];
    for (const attempt of attempts) {
      expect(await runCatching(attempt)).to.be.instanceOf(Error);
    }
    expect(shell.calls).to.eql([]);
  });
});
