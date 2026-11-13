import { IListPage, IShelveInfo } from "../../../../../models";
import { IShellMock, mockShell } from "../findChangesets/shellMock";
import { expect } from "chai";
import { ListShelves } from "../../../../../cm/commands";

const XML_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

function shelve(shelveId: number): IShelveInfo {
  return {
    comment: `Shelve ${shelveId}`,
    date: new Date("2026-03-02T10:15:00+00:00"),
    guid: "00000000-0000-0000-0000-000000000000",
    id: 1000 + shelveId,
    owner: "someone@example.com",
    parentChangesetId: 320,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
    shelveId,
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

describe("ListShelves command", () => {
  // cm returns shelves oldest first and cannot order them.
  const oldestFirst = [ shelve(2), shelve(5), shelve(9), shelve(12) ];

  context("When listing the first page", () => {
    const shell: IShellMock = mockShell({ result: oldestFirst, success: true });
    let page: IListPage<IShelveInfo>;

    before(async () => {
      page = await ListShelves.run(shell.mock.object, { limit: 3 });
    });

    it("reads every shelve, because cm cannot order them", () => {
      expect(shell.calls).to.eql([{ args: [ "shelve", ...XML_ARGS ], command: "find" }]);
    });

    it("returns the newest first and says there is more", () => {
      expect(page.items.map(s => s.shelveId)).to.eql([ 12, 9, 5 ]);
      expect(page.hasMore).to.be.true;
    });
  });

  context("When listing the last page", () => {
    it("skips the offset and says there is no more", async () => {
      const shell = mockShell({ result: oldestFirst, success: true });
      const page = await ListShelves.run(shell.mock.object, { limit: 3, offset: 3 });
      expect(page).to.eql({ hasMore: false, items: [shelve(2)] });
    });
  });

  context("When the page is invalid", () => {
    it("rejects it before calling cm", async () => {
      const shell = mockShell<IShelveInfo[]>({ result: [], success: true });
      expect(await runCatching(() => ListShelves.run(shell.mock.object, { limit: 0 }))).to.not.be.undefined;
      expect(shell.calls).to.eql([]);
    });
  });

  context("When the command fails", () => {
    it("falls back to a generic error", async () => {
      const shell = mockShell<IShelveInfo[]>({ success: false });
      const error = await runCatching(() => ListShelves.run(shell.mock.object, { limit: 5 }));
      expect(error?.message).to.equal("cm find shelve failed.");
    });
  });

  context("When looking a shelve up by number", () => {
    const shell: IShellMock = mockShell({ result: [shelve(48)], success: true });
    let found: IShelveInfo | undefined;

    before(async () => {
      found = await ListShelves.runById(shell.mock.object, 48);
    });

    it("queries by shelve number", () => {
      expect(shell.calls).to.eql([{ args: [ "shelve", "where shelveid = 48", ...XML_ARGS ], command: "find" }]);
    });

    it("returns the shelve", () => {
      expect(found).to.eql(shelve(48));
    });

    it("rejects a non-integer before calling cm", async () => {
      const other = mockShell<IShelveInfo[]>({ result: [], success: true });
      expect(await runCatching(() => ListShelves.runById(other.mock.object, 4.5))).to.not.be.undefined;
      expect(other.calls).to.eql([]);
    });
  });
});
