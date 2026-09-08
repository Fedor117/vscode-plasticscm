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
