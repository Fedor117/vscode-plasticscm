import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../../../models";
import { IShellMock, mockShell } from "../findChangesets/shellMock";
import { DiffChangeset } from "../../../../../cm/commands/diffChangeset/diffChangeset";
import { expect } from "chai";

const FORMAT = "--format=S:{status}{newline}T:{type}{newline}P:{path}{newline}R:{revid}{newline}"
  + "PR:{parentrevid}{newline}B:{baserevid}{newline}SP:{srccmpath}{newline}DP:{dstcmpath}{newline}RP:{repository}";

const change: IChangesetFileChange = {
  baseRevisionId: 11593,
  parentRevisionId: 11593,
  path: "/Assets/Code/Racing/UI/UILapTimeBanner.cs",
  repository: "Nimbus/Nimbus@acme-studio@unity",
  revisionId: 12347,
  revisionType: RevisionType.TextFile,
  status: FileChangeStatus.Changed,
};

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("DiffChangeset command", () => {
  context("When run successfully", () => {
    const shell: IShellMock = mockShell({ result: [change], success: true });
    let cmdResult: IChangesetFileChange[];

    before(async () => {
      cmdResult = await DiffChangeset.run(shell.mock.object, 3624);
    });

    it("returns the parsed changes", () => {
      expect(cmdResult).to.eql([change]);
    });

    it("diffs the changeset spec with the line-per-field format and repository paths", () => {
      expect(shell.calls).to.eql([{
        args: [ "cs:3624", FORMAT, "--repositorypaths" ],
        command: "diff",
      }]);
    });

    it("never passes a status filter, which would blank {status}", () => {
      expect(shell.calls[0].args.some(arg => /^--(added|changed|moved|deleted)$/.test(arg))).to.be.false;
    });
  });

  context("When run for a shelve", () => {
    const shell: IShellMock = mockShell({ result: [change], success: true });

    it("diffs the sh: spec with the same format, so the shelve is compared with its parent", async () => {
      const result = await DiffChangeset.runShelve(shell.mock.object, 41);
      expect(result).to.eql([change]);
      expect(shell.calls).to.eql([{ args: [ "sh:41", FORMAT, "--repositorypaths" ], command: "diff" }]);
    });

    it("rejects a shelve number that is not an integer", async () => {
      const error = await runCatching(() => DiffChangeset.runShelve(shell.mock.object, 1.5));
      expect(error).to.be.instanceOf(Error);
    });

    it("names the shelve in the fallback error", async () => {
      const failing = mockShell<IChangesetFileChange[]>({ success: false });
      const error = await runCatching(() => DiffChangeset.runShelve(failing.mock.object, 8));
      expect(error?.message).to.equal("cm diff sh:8 failed.");
    });
  });

  context("When run for two changesets", () => {
    const shell: IShellMock = mockShell({ result: [change], success: true });

    it("diffs cs:from against cs:to with the same format", async () => {
      expect(await DiffChangeset.runBetween(shell.mock.object, 3600, 3624)).to.eql([change]);
      expect(shell.calls).to.eql([{ args: [ "cs:3600", "cs:3624", FORMAT, "--repositorypaths" ], command: "diff" }]);
    });

    it("rejects ids that are not integers", async () => {
      const error = await runCatching(() => DiffChangeset.runBetween(shell.mock.object, 1, Number.NaN));
      expect(error).to.be.instanceOf(Error);
    });
  });

  context("When run for a branch or a spec", () => {
    const shell: IShellMock = mockShell({ result: [change], success: true });

    it("diffs br: against the parent", async () => {
      await DiffChangeset.runBranch(shell.mock.object, "/main/task7");
      expect(shell.calls[0]).to.eql({ args: [ "br:/main/task7", FORMAT, "--repositorypaths" ], command: "diff" });
    });

    it("adds --clean for a branch when asked", async () => {
      await DiffChangeset.runSpec(shell.mock.object, "br:/main/task7", { clean: true });
      expect(shell.calls[1].args).to.eql([ "br:/main/task7", FORMAT, "--repositorypaths", "--clean" ]);
    });

    it("refuses --clean for a changeset, other specs and quotes or line breaks", async () => {
      const before = shell.calls.length;
      const clean = await runCatching(() => DiffChangeset.runSpec(shell.mock.object, "cs:5", { clean: true }));
      expect(clean).to.be.instanceOf(Error);
      expect(await runCatching(() => DiffChangeset.runSpec(shell.mock.object, "lb:x"))).to.be.instanceOf(Error);
      expect(await runCatching(() => DiffChangeset.runBranch(shell.mock.object, "/main/a\"b"))).to.be.instanceOf(Error);
      expect(await runCatching(() => DiffChangeset.runSpec(shell.mock.object, "br:/a\nb"))).to.be.instanceOf(Error);
      expect(shell.calls).to.have.length(before);
    });
  });

  context("When the parser produced no result", () => {
    const shell: IShellMock = mockShell<IChangesetFileChange[]>({ success: true });
    let cmdResult: IChangesetFileChange[];

    before(async () => {
      cmdResult = await DiffChangeset.run(shell.mock.object, 1);
    });

    it("returns an empty list", () => {
      expect(cmdResult).to.eql([]);
    });
  });

  context("When the command fails", () => {
    const shell: IShellMock = mockShell({ error: new Error("Sample error"), success: false });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => DiffChangeset.run(shell.mock.object, 1));
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
      error = await runCatching(() => DiffChangeset.run(shell.mock.object, 42));
    });

    it("falls back to a generic error naming the changeset", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("cm diff cs:42 failed.");
    });
  });

  context("When the command succeeds but the parser reports an error", () => {
    const shell: IShellMock = mockShell({ error: new Error("Parse error"), result: [], success: true });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => DiffChangeset.run(shell.mock.object, 1));
    });

    it("throws the parser error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("Parse error");
    });
  });

  context("When the changeset id is not an integer", () => {
    const shell: IShellMock = mockShell({ result: [], success: true });

    [ 1.5, NaN, Infinity ].forEach(id => {
      it(`rejects ${id} before calling cm`, async () => {
        const error = await runCatching(() => DiffChangeset.run(shell.mock.object, id));
        expect(error).to.be.not.undefined;
        expect(shell.calls).to.eql([]);
      });
    });
  });
});
