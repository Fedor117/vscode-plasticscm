import { IShellMock, mockShell } from "../findChangesets/shellMock";
import { expect } from "chai";
import { FindBranch } from "../../../../../cm/commands/findBranch/findBranch";
import { IBranchInfo } from "../../../../../models";

const XML_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

function branch(name: string, parent: string | undefined, headChangesetId: number): IBranchInfo {
  return {
    comment: "",
    date: new Date("2026-08-31T12:59:54+01:00"),
    guid: "b2a4c6d8-0e1f-4a3b-8c5d-6e7f8a9b0c1d",
    headChangesetId,
    name,
    owner: "someone@example.com",
    parent,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("FindBranch command", () => {
  context("When looking up the root branch", () => {
    const main = branch("/main", undefined, 3571);
    const shell: IShellMock = mockShell({ result: [main], success: true });
    let cmdResult: IBranchInfo | undefined;

    before(async () => {
      cmdResult = await FindBranch.run(shell.mock.object, "/main");
    });

    it("returns the branch", () => {
      expect(cmdResult).to.eql(main);
    });

    it("queries by the short name", () => {
      expect(shell.calls).to.eql([{
        args: [ "branch", "where name='main'", ...XML_ARGS ],
        command: "find",
      }]);
    });
  });

  context("When several branches share the short name", () => {
    const wanted = branch("/main/a/X", "/main/a", 2241);
    const decoy = branch("/main/X", "/main", 2080);
    const shell: IShellMock = mockShell({ result: [ decoy, wanted ], success: true });
    let cmdResult: IBranchInfo | undefined;

    before(async () => {
      cmdResult = await FindBranch.run(shell.mock.object, "/main/a/X");
    });

    it("picks the one whose full name matches", () => {
      expect(cmdResult).to.eql(wanted);
    });

    it("queries by the last path segment only", () => {
      expect(shell.calls).to.eql([{
        args: [ "branch", "where name='X'", ...XML_ARGS ],
        command: "find",
      }]);
    });
  });

  context("When the short name matches but the full name does not", () => {
    const shell: IShellMock = mockShell({ result: [branch("/main/other/X", "/main/other", 5)], success: true });
    let cmdResult: IBranchInfo | undefined;

    before(async () => {
      cmdResult = await FindBranch.run(shell.mock.object, "/main/X");
    });

    it("returns undefined", () => {
      expect(cmdResult).to.be.undefined;
    });
  });

  context("When the name differs only by case", () => {
    const shell: IShellMock = mockShell({ result: [branch("/main/x", "/main", 5)], success: true });
    let cmdResult: IBranchInfo | undefined;

    before(async () => {
      cmdResult = await FindBranch.run(shell.mock.object, "/main/X");
    });

    it("returns undefined", () => {
      expect(cmdResult).to.be.undefined;
    });
  });

  context("When the parser produced no result", () => {
    const shell: IShellMock = mockShell<IBranchInfo[]>({ success: true });
    let cmdResult: IBranchInfo | undefined;

    before(async () => {
      cmdResult = await FindBranch.run(shell.mock.object, "/main");
    });

    it("returns undefined", () => {
      expect(cmdResult).to.be.undefined;
    });
  });

  context("When the command fails", () => {
    const shell: IShellMock = mockShell({ error: new Error("Sample error"), success: false });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindBranch.run(shell.mock.object, "/main"));
    });

    it("surfaces the underlying error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("Sample error");
    });
  });

  context("When the command fails without saying why", () => {
    const shell: IShellMock = mockShell({ success: false });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindBranch.run(shell.mock.object, "/main"));
    });

    it("falls back to a generic error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("cm find branch failed.");
    });
  });

  context("When the command succeeds but the parser reports an error", () => {
    const shell: IShellMock = mockShell({ error: new Error("Parse error"), result: [], success: true });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindBranch.run(shell.mock.object, "/main"));
    });

    it("throws the parser error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("Parse error");
    });
  });

  context("When the branch name contains quotes", () => {
    const shell: IShellMock = mockShell({ result: [], success: true });

    [ "/main/it's", "/main/say\"hi\"" ].forEach(name => {
      it(`rejects ${name} before calling cm`, async () => {
        const error = await runCatching(() => FindBranch.run(shell.mock.object, name));
        expect(error).to.be.not.undefined;
        expect(shell.calls).to.eql([]);
      });
    });
  });
});
