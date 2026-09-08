import { FindChangesets, IChangesetQuery } from "../../../../../cm/commands/findChangesets/findChangesets";
import { IShellMock, mockShell } from "./shellMock";
import { expect } from "chai";
import { IHistoryChangeset } from "../../../../../models";

const XML_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

const changeset: IHistoryChangeset = {
  branch: "/main/X",
  comment: "A comment",
  date: new Date("2026-09-07T16:56:14+01:00"),
  guid: "cafe0001-4b1d-4c2e-9d3f-5a6b7c8d9e0f",
  id: 3622,
  owner: "someone@example.com",
  parentId: 3621,
  repository: "Nimbus/Nimbus",
  server: "acme-studio@unity",
};

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("FindChangesets command", () => {
  context("When run with a paging cursor", () => {
    const shell: IShellMock = mockShell({ result: [changeset], success: true });
    const query: IChangesetQuery = { beforeChangesetId: 2080, branch: "/main/X", limit: 50 };
    let cmdResult: IHistoryChangeset[];

    before(async () => {
      cmdResult = await FindChangesets.run(shell.mock.object, query);
    });

    it("returns the parsed changesets", () => {
      expect(cmdResult).to.eql([changeset]);
    });

    it("runs exactly one find with the paged where clause", () => {
      expect(shell.calls).to.eql([{
        args: [
          "changeset",
          "where branch='/main/X' and changesetid < 2080 order by changesetid desc limit 50",
          ...XML_ARGS,
        ],
        command: "find",
      }]);
    });
  });

  context("When run without a paging cursor", () => {
    const shell: IShellMock = mockShell({ result: [], success: true });
    let cmdResult: IHistoryChangeset[];

    before(async () => {
      cmdResult = await FindChangesets.run(shell.mock.object, { branch: "/main", limit: 20 });
    });

    it("returns an empty list", () => {
      expect(cmdResult).to.eql([]);
    });

    it("omits the changesetid bound", () => {
      expect(shell.calls).to.eql([{
        args: [ "changeset", "where branch='/main' order by changesetid desc limit 20", ...XML_ARGS ],
        command: "find",
      }]);
    });
  });

  context("When the parser produced no result", () => {
    const shell: IShellMock = mockShell<IHistoryChangeset[]>({ success: true });
    let cmdResult: IHistoryChangeset[];

    before(async () => {
      cmdResult = await FindChangesets.run(shell.mock.object, { branch: "/main", limit: 1 });
    });

    it("returns an empty list", () => {
      expect(cmdResult).to.eql([]);
    });
  });

  context("When looking up a changeset by id", () => {
    const shell: IShellMock = mockShell({ result: [changeset], success: true });
    let cmdResult: IHistoryChangeset | undefined;

    before(async () => {
      cmdResult = await FindChangesets.runById(shell.mock.object, 3622);
    });

    it("returns the single changeset", () => {
      expect(cmdResult).to.eql(changeset);
    });

    it("queries by changesetid", () => {
      expect(shell.calls).to.eql([{
        args: [ "changeset", "where changesetid=3622", ...XML_ARGS ],
        command: "find",
      }]);
    });
  });

  context("When looking up an unknown changeset id", () => {
    const shell: IShellMock = mockShell({ result: [], success: true });
    let cmdResult: IHistoryChangeset | undefined;

    before(async () => {
      cmdResult = await FindChangesets.runById(shell.mock.object, 1);
    });

    it("returns undefined", () => {
      expect(cmdResult).to.be.undefined;
    });
  });

  context("When the command fails", () => {
    const shell: IShellMock = mockShell({ error: new Error("Sample error"), success: false });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindChangesets.run(shell.mock.object, { branch: "/main", limit: 5 }));
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
      error = await runCatching(() => FindChangesets.runById(shell.mock.object, 5));
    });

    it("falls back to a generic error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("cm find changeset failed.");
    });
  });

  context("When the command succeeds but the parser reports an error", () => {
    const shell: IShellMock = mockShell({ error: new Error("Parse error"), result: [], success: true });
    let error: Error | undefined;

    before(async () => {
      error = await runCatching(() => FindChangesets.run(shell.mock.object, { branch: "/main", limit: 5 }));
    });

    it("throws the parser error", () => {
      expect(error).to.be.not.undefined;
      expect(error!.message).to.equal("Parse error");
    });
  });

  context("When the arguments cannot be expressed in a cm query", () => {
    const shell: IShellMock = mockShell({ result: [], success: true });
    const badQueries: Array<[string, IChangesetQuery | number]> = [
      [ "single quote in branch", { branch: "/main/it's", limit: 5 }],
      [ "double quote in branch", { branch: "/main/say\"hi\"", limit: 5 }],
      [ "zero limit", { branch: "/main", limit: 0 }],
      [ "negative limit", { branch: "/main", limit: -3 }],
      [ "fractional limit", { branch: "/main", limit: 2.5 }],
      [ "NaN limit", { branch: "/main", limit: NaN }],
      [ "fractional cursor", { beforeChangesetId: 10.5, branch: "/main", limit: 5 }],
      [ "infinite cursor", { beforeChangesetId: Infinity, branch: "/main", limit: 5 }],
      [ "fractional id", 3.5 ],
      [ "NaN id", NaN ],
    ];

    badQueries.forEach(([ label, query ]) => {
      it(`rejects a ${label} before calling cm`, async () => {
        const error = await runCatching(() => typeof query === "number"
          ? FindChangesets.runById(shell.mock.object, query)
          : FindChangesets.run(shell.mock.object, query));
        expect(error).to.be.not.undefined;
        expect(shell.calls).to.eql([]);
      });
    });
  });
});
