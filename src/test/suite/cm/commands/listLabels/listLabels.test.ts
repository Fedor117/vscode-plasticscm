import { ILabelInfo, IListPage } from "../../../../../models";
import { IShellMock, mockShell } from "../findChangesets/shellMock";
import { expect } from "chai";
import { ListLabels } from "../../../../../cm/commands";

const XML_ARGS = [ "--xml", "--nototal", "--encoding=utf-8" ];

function label(name: string, id = 1): ILabelInfo {
  return {
    branch: "/main",
    changesetId: 41,
    comment: "",
    date: new Date("2026-04-14T09:30:00+00:00"),
    id,
    name,
    owner: "someone@example.com",
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

describe("ListLabels command", () => {
  context("When listing", () => {
    const shell: IShellMock = mockShell({ result: [ label("v2"), label("v1") ], success: true });
    let page: IListPage<ILabelInfo>;

    before(async () => {
      page = await ListLabels.run(shell.mock.object, { limit: 1, offset: 3 });
    });

    it("queries newest first with one extra row", () => {
      expect(shell.calls).to.eql([{
        args: [ "label", "order by date desc limit 2 offset 3", ...XML_ARGS ],
        command: "find",
      }]);
    });

    it("cuts the page", () => {
      expect(page).to.eql({ hasMore: true, items: [label("v2")] });
    });
  });

  context("When the command fails", () => {
    it("falls back to a generic error", async () => {
      const shell = mockShell<ILabelInfo[]>({ success: false });
      const error = await runCatching(() => ListLabels.run(shell.mock.object, { limit: 5 }));
      expect(error?.message).to.equal("cm find label failed.");
    });
  });

  context("When looking a label up by name", () => {
    const shell: IShellMock = mockShell({ result: [label("Release 1.0 (iOS)", 9)], success: true });
    let found: ILabelInfo | undefined;

    before(async () => {
      found = await ListLabels.runByName(shell.mock.object, "Release 1.0 (iOS)");
    });

    it("queries by the exact name", () => {
      expect(shell.calls).to.eql([{
        args: [ "label", "where name = 'Release 1.0 (iOS)'", ...XML_ARGS ],
        command: "find",
      }]);
    });

    it("returns the label", () => {
      expect(found?.id).to.equal(9);
    });
  });

  context("When the name matches nothing exactly", () => {
    it("returns undefined", async () => {
      const shell = mockShell({ result: [label("release")], success: true });
      expect(await ListLabels.runByName(shell.mock.object, "Release")).to.be.undefined;
    });
  });

  context("When the name cannot be put in a query", () => {
    [ "it's", "say \"hi\"", "two\nlines" ].forEach(name => {
      it(`rejects ${JSON.stringify(name)} before calling cm`, async () => {
        const shell = mockShell<ILabelInfo[]>({ result: [], success: true });
        const error = await runCatching(() => ListLabels.runByName(shell.mock.object, name));
        expect(error).to.not.be.undefined;
        expect(shell.calls).to.eql([]);
      });
    });
  });
});
