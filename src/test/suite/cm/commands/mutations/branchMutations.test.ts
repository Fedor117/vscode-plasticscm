import * as fs from "fs";
import {
  CreateBranch,
  DeleteBranch,
  EditBranchComment,
  RenameBranch,
} from "../../../../../cm/commands";
import { IShellMock, mockShell, mockShellAnswering } from "../findChangesets/shellMock";
import { expect } from "chai";

const OK = { result: [], success: true };
const channel = { appendLine: () => undefined };

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

/** The `-commentsfile=` argument of a call, with the file's text read while it still exists. */
function commentOf(args: string[]): { arg: string; text: string } | undefined {
  const arg = args.find(candidate => candidate.startsWith("-commentsfile="));
  return arg ? { arg, text: fs.readFileSync(arg.substring("-commentsfile=".length), "utf8") } : undefined;
}

describe("CreateBranch command", () => {
  context("When creating from the head of the parent", () => {
    const shell: IShellMock = mockShell(OK);

    before(async () => {
      await CreateBranch.run(shell.mock.object, channel, { name: "/main/task001" });
    });

    it("passes only the branch spec", () => {
      expect(shell.calls).to.eql([{ args: [ "create", "br:/main/task001" ], command: "branch" }]);
    });
  });

  context("When creating from a changeset with a comment", () => {
    let call: { args: string[]; comment?: { arg: string; text: string } } | undefined;
    const shell: IShellMock = mockShellAnswering(c => {
      call = { args: c.args, comment: commentOf(c.args) };
      return OK;
    });

    before(async () => {
      await CreateBranch.run(shell.mock.object, channel, {
        comment: "Fix the login timeout\nsecond line",
        fromChangeset: 42,
        name: "/main/task001",
      });
    });

    it("passes the changeset and the comments file", () => {
      expect(call?.args.slice(0, 3)).to.eql([ "create", "br:/main/task001", "--changeset=42" ]);
      expect(call?.args).to.have.length(4);
    });

    it("writes the comment to the file, line breaks included", () => {
      expect(call?.comment?.text).to.equal("Fix the login timeout\nsecond line");
    });

    it("removes the comments file afterwards", () => {
      expect(fs.existsSync(call!.comment!.arg.substring("-commentsfile=".length))).to.equal(false);
    });
  });

  context("When creating from a label", () => {
    const shell: IShellMock = mockShell(OK);

    before(async () => {
      await CreateBranch.run(shell.mock.object, channel, { comment: "  ", fromLabel: "v1.0", name: "/main/fix" });
    });

    it("passes the label spec, and no comments file for a blank comment", () => {
      expect(shell.calls).to.eql([{ args: [ "create", "br:/main/fix", "--label=lb:v1.0" ], command: "branch" }]);
    });
  });

  context("When the request cannot be sent to cm", () => {
    const shell: IShellMock = mockShell(OK);

    for (const [ description, request, message ] of [
      [ "a name that is not a full name", { name: "task001" }, "full name" ],
      [ "a quote in the name", { name: "/main/a\"b" }, "quotes" ],
      [ "both a changeset and a label", { fromChangeset: 1, fromLabel: "x", name: "/main/a" }, "not both" ],
      [ "a fractional changeset", { fromChangeset: 1.5, name: "/main/a" }, "integer" ],
      [ "a quote in the label", { fromLabel: "a\"b", name: "/main/a" }, "quotes" ],
    ] as const) {
      it(`rejects ${description} without calling cm`, async () => {
        const error = await runCatching(() => CreateBranch.run(shell.mock.object, channel, request));
        expect(error?.message).to.contain(message);
        expect(shell.calls).to.eql([]);
      });
    }
  });

  context("When cm fails", () => {
    it("throws cm's error", async () => {
      const shell = mockShell<string[]>({ error: new Error("Branch already exists"), success: false });
      const error = await runCatching(() => CreateBranch.run(shell.mock.object, channel, { name: "/main/a" }));
      expect(error?.message).to.equal("Branch already exists");
    });

    it("falls back to a generic message", async () => {
      const shell = mockShell<string[]>({ success: false });
      const error = await runCatching(() => CreateBranch.run(shell.mock.object, channel, { name: "/main/a" }));
      expect(error?.message).to.equal("cm branch create failed.");
    });
  });
});

describe("RenameBranch command", () => {
  it("passes the branch spec and the new short name", async () => {
    const shell = mockShell(OK);
    await RenameBranch.run(shell.mock.object, "/main/task0", "task1");
    expect(shell.calls).to.eql([{ args: [ "rename", "br:/main/task0", "task1" ], command: "branch" }]);
  });

  it("rejects a new name with a slash, which would move the branch", async () => {
    const shell = mockShell(OK);
    const error = await runCatching(() => RenameBranch.run(shell.mock.object, "/main/task0", "a/b"));
    expect(error?.message).to.contain("'/'");
    expect(shell.calls).to.eql([]);
  });

  it("rejects a new name cm would read as an option", async () => {
    const shell = mockShell(OK);
    const error = await runCatching(() => RenameBranch.run(shell.mock.object, "/main/task0", "-x"));
    expect(error?.message).to.contain("option");
  });
});

describe("DeleteBranch command", () => {
  it("passes only the branch spec, never --delete-changesets", async () => {
    const shell = mockShell(OK);
    await DeleteBranch.run(shell.mock.object, "/main/task001");
    expect(shell.calls).to.eql([{ args: [ "delete", "br:/main/task001" ], command: "branch" }]);
  });

  it("rejects a name that is not a full name", async () => {
    const shell = mockShell(OK);
    const error = await runCatching(() => DeleteBranch.run(shell.mock.object, "task001"));
    expect(error).to.be.instanceOf(Error);
    expect(shell.calls).to.eql([]);
  });
});

describe("EditBranchComment command", () => {
  it("sends the comment through a comments file", async () => {
    let comment: { arg: string; text: string } | undefined;
    let args: string[] = [];
    const shell = mockShellAnswering(c => {
      args = c.args;
      comment = commentOf(c.args);
      return OK;
    });

    await EditBranchComment.run(shell.mock.object, channel, "/main/task001", "Fix the login timeout");

    expect(args.slice(0, 2)).to.eql([ "editcomment", "br:/main/task001" ]);
    expect(args).to.have.length(3);
    expect(comment?.text).to.equal("Fix the login timeout");
    expect(shell.calls[0].command).to.equal("branch");
  });

  it("clears the comment with an empty argument, which cm documents", async () => {
    const shell = mockShell(OK);
    await EditBranchComment.run(shell.mock.object, channel, "/main/task001", "");
    expect(shell.calls).to.eql([{ args: [ "editcomment", "br:/main/task001", "" ], command: "branch" }]);
  });
});
