import { IBranchInfo, IListPage } from "../../../../../models";
import { IShellMock, mockShell, mockShellAnswering } from "../findChangesets/shellMock";
import { expect } from "chai";
import { ListBranches } from "../../../../../cm/commands";

const XML_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

function branch(name: string, date = "2026-08-31T12:59:54+01:00"): IBranchInfo {
  return {
    comment: "",
    date: new Date(date),
    guid: "b2a4c6d8-0e1f-4a3b-8c5d-6e7f8a9b0c1d",
    headChangesetId: 7,
    name,
    owner: "someone@example.com",
    parent: "/main",
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

describe("ListBranches command", () => {
  context("When cm returns one row more than the limit", () => {
    const rows = [ branch("/main/c"), branch("/main/b"), branch("/main/a") ];
    const shell: IShellMock = mockShell({ result: rows, success: true });
    let page: IListPage<IBranchInfo>;

    before(async () => {
      page = await ListBranches.run(shell.mock.object, { limit: 2 });
    });

    it("asks for one extra row, newest first", () => {
      expect(shell.calls).to.eql([{
        args: [ "branch", "order by date desc limit 3", ...XML_ARGS ],
        command: "find",
      }]);
    });

    it("returns the limit and says there is more", () => {
      expect(page.items.map(b => b.name)).to.eql([ "/main/c", "/main/b" ]);
      expect(page.hasMore).to.be.true;
    });
  });

  context("When asking for a later page", () => {
    const shell: IShellMock = mockShell({ result: [branch("/main/a")], success: true });
    let page: IListPage<IBranchInfo>;

    before(async () => {
      page = await ListBranches.run(shell.mock.object, { limit: 50, offset: 100 });
    });

    it("passes the offset", () => {
      expect(shell.calls[0].args[1]).to.equal("order by date desc limit 51 offset 100");
    });

    it("says there is no more", () => {
      expect(page.hasMore).to.be.false;
      expect(page.items).to.have.lengthOf(1);
    });
  });

  context("When hidden branches are included", () => {
    const visible = [
      branch("/main/v3", "2026-08-05"), branch("/main/v2", "2026-08-03"), branch("/main", "2026-01-01"),
    ];
    const hidden = [ branch("/main/h2", "2026-08-04"), branch("/main/h1", "2026-08-02") ];
    const shell: IShellMock = mockShellAnswering<IBranchInfo[]>(call => ({
      result: call.args[1].includes("hidden") ? hidden : visible,
      success: true,
    }));
    let first: IListPage<IBranchInfo>;
    let second: IListPage<IBranchInfo>;

    before(async () => {
      first = await ListBranches.run(shell.mock.object, { limit: 2 }, { includeHidden: true });
      second = await ListBranches.run(shell.mock.object, { limit: 2, offset: 2 }, { includeHidden: true });
    });

    it("asks cm for the visible and the hidden branches up to the end of the page", () => {
      expect(shell.calls.map(call => call.args[1])).to.eql([
        "order by date desc limit 3",
        "where hidden = 'true' order by date desc limit 3",
        "order by date desc limit 5",
        "where hidden = 'true' order by date desc limit 5",
      ]);
    });

    it("merges both newest first, marking the hidden ones", () => {
      expect(first.items.map(b => [ b.name, b.hidden ?? false ])).to.eql([[ "/main/v3", false ], [ "/main/h2", true ]]);
      expect(first.hasMore).to.be.true;
      expect(second.items.map(b => b.name)).to.eql([ "/main/v2", "/main/h1" ]);
      expect(second.hasMore).to.be.true;
    });
  });

  context("When hidden branches are included and the last page is reached", () => {
    const visible = [ branch("/main/v", "2026-08-03"), branch("/main", "2026-01-01") ];
    const hidden = [branch("/main/h", "2026-08-03")];
    const shell: IShellMock = mockShellAnswering<IBranchInfo[]>(call => ({
      result: call.args[1].includes("hidden") ? hidden : visible,
      success: true,
    }));

    it("puts the visible branch first on equal dates and says there is no more", async () => {
      const page = await ListBranches.run(shell.mock.object, { limit: 2, offset: 1 }, { includeHidden: true });
      expect(page.items.map(b => b.name)).to.eql([ "/main/h", "/main" ]);
      expect(page.hasMore).to.be.false;
    });
  });

  context("When the parser produced no result", () => {
    const shell: IShellMock = mockShell<IBranchInfo[]>({ success: true });

    it("returns an empty page", async () => {
      expect(await ListBranches.run(shell.mock.object, { limit: 5 })).to.eql({ hasMore: false, items: [] });
    });
  });

  context("When the command fails", () => {
    it("surfaces the underlying error", async () => {
      const shell = mockShell<IBranchInfo[]>({ error: new Error("Sample error"), success: false });
      const error = await runCatching(() => ListBranches.run(shell.mock.object, { limit: 5 }));
      expect(error?.message).to.equal("Sample error");
    });

    it("falls back to a generic error", async () => {
      const shell = mockShell<IBranchInfo[]>({ success: false });
      const error = await runCatching(() => ListBranches.run(shell.mock.object, { limit: 5 }));
      expect(error?.message).to.equal("cm find branch failed.");
    });

    it("throws the parser error", async () => {
      const shell = mockShell<IBranchInfo[]>({ error: new Error("Parse error"), result: [], success: true });
      const error = await runCatching(() => ListBranches.run(shell.mock.object, { limit: 5 }));
      expect(error?.message).to.equal("Parse error");
    });
  });

  context("When the page is invalid", () => {
    [
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: 10, offset: -1 },
      { limit: 10, offset: 0.5 },
    ].forEach(query => {
      it(`rejects ${JSON.stringify(query)} before calling cm`, async () => {
        const shell = mockShell<IBranchInfo[]>({ result: [], success: true });
        const error = await runCatching(() => ListBranches.run(shell.mock.object, query));
        expect(error).to.not.be.undefined;
        expect(shell.calls).to.eql([]);
      });
    });
  });
});
