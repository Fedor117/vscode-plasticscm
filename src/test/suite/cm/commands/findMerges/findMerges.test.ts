import { IShellMock, mockShell } from "../findChangesets/shellMock";
import { expect } from "chai";
import { FindMerges } from "../../../../../cm/commands/findMerges/findMerges";
import { IMergeLink } from "../../../../../models";

const XML_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

const link: IMergeLink = {
  destinationBranch: "/main/X",
  destinationChangesetId: 3351,
  sourceBranch: "/main",
  sourceChangesetId: 3331,
  type: "merge",
};

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("FindMerges command", () => {
  context("When run successfully", () => {
    const shell: IShellMock = mockShell({ result: [link], success: true });
    let cmdResult: IMergeLink[];

    before(async () => {
      cmdResult = await FindMerges.run(shell.mock.object, "/main/X", 3301);
    });

    it("returns the parsed links", () => {
      expect(cmdResult).to.eql([link]);
    });

    it("queries both directions bounded by the destination changeset", () => {
      expect(shell.calls).to.eql([{
        args: [
          "merge",
          "where (dstbranch='br:/main/X' or srcbranch='br:/main/X') and dstchangeset >= 3301",
          ...XML_ARGS,
        ],
        command: "find",
      }]);
    });
  });

  context("When the branch name contains a space", () => {
    const shell: IShellMock = mockShell<IMergeLink[]>({ result: [], success: true });

    before(async () => {
      await FindMerges.run(shell.mock.object, "/main/Engine 2019.4.19f1", 2891);
    });

    it("encodes the space, because cm stores and matches merge specs percent-encoded", () => {
      expect(shell.calls[0].args[1]).to.equal(
        "where (dstbranch='br:/main/Engine%202019.4.19f1' "
        + "or srcbranch='br:/main/Engine%202019.4.19f1') and dstchangeset >= 2891");
    });
  });

  context("When the branch name contains characters cm keeps raw", () => {
    const shell: IShellMock = mockShell<IMergeLink[]>({ result: [], success: true });

    before(async () => {
      await FindMerges.run(shell.mock.object, "/RAC-T1X(3.0)", 1);
    });

    it("encodes nothing else, because a re-encoded spec matches nothing on a real server", () => {
      // Asserted whole: the separator is the character a general-purpose URI
      // encoder would take (`br:%2FRAC-T1X(3.0)`), and that finds no merges.
      expect(shell.calls[0].args[1]).to.equal(
        "where (dstbranch='br:/RAC-T1X(3.0)' or srcbranch='br:/RAC-T1X(3.0)') and dstchangeset >= 1");
    });
  });

  context("When the parser produced no result", () => {
    const shell: IShellMock = mockShell<IMergeLink[]>({ success: true });
    let cmdResult: IMergeLink[];

    before(async () => {
      cmdResult = await FindMerges.run(shell.mock.object, "/main", 0);
    });

    it("returns an empty list", () => {
      expect(cmdResult).to.eql([]);
    });
  });

  context("When the command fails", () => {
    const shell: IShellMock = mockShell({ error: new Error("Sample error"), success: false });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindMerges.run(shell.mock.object, "/main", 1));
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
      error = await runCatching(() => FindMerges.run(shell.mock.object, "/main", 1));
    });

    it("falls back to a generic error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("cm find merge failed.");
    });
  });

  context("When the command succeeds but the parser reports an error", () => {
    const shell: IShellMock = mockShell({ error: new Error("Parse error"), result: [], success: true });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindMerges.run(shell.mock.object, "/main", 1));
    });

    it("throws the parser error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("Parse error");
    });
  });

  context("When the arguments cannot be expressed in a cm query", () => {
    const shell: IShellMock = mockShell({ result: [], success: true });
    const badArguments: Array<[string, string, number]> = [
      [ "single quote in branch", "/main/it's", 1 ],
      [ "double quote in branch", "/main/say\"hi\"", 1 ],
      [ "fractional changeset id", "/main", 1.5 ],
      [ "NaN changeset id", "/main", NaN ],
      [ "infinite changeset id", "/main", -Infinity ],
    ];

    badArguments.forEach(([ label, branchName, fromChangesetId ]) => {
      it(`rejects a ${label} before calling cm`, async () => {
        const error = await runCatching(() => FindMerges.run(shell.mock.object, branchName, fromChangesetId));
        expect(error).to.be.not.undefined;
        expect(shell.calls).to.eql([]);
      });
    });
  });
});
