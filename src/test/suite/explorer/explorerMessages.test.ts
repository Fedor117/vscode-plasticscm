import * as fs from "fs";
import * as path from "path";
import { isExplorerMessage, parseExplorerScope } from "../../../explorer/branchExplorerPanel";
import { expect } from "chai";
import { EXPLORER_COMMANDS } from "../../../commands/explorer";
import { explorerChangesetFromArg } from "../../../commands/targets";
import { isCompareBetweenArgs } from "../../../commands/compare";
import { parseChangesetId } from "../../../explorer/explorerData";

describe("Branch Explorer messages", () => {
  describe("parseExplorerScope", () => {
    it("accepts the three scopes", () => {
      expect(parseExplorerScope({ kind: "all" })).to.eql({ kind: "all" });
      expect(parseExplorerScope({ kind: "current" })).to.eql({ kind: "current" });
      expect(parseExplorerScope({ branches: [ "/main", "/main/task" ], kind: "branches" }))
        .to.eql({ branches: [ "/main", "/main/task" ], kind: "branches" });
    });

    it("drops whatever else the webview sent along", () => {
      expect(parseExplorerScope({ branches: ["/main"], kind: "all" })).to.eql({ kind: "all" });
    });

    it("rejects anything malformed", () => {
      for (const value of [
        undefined, null, "all", 3, {}, { kind: "everything" }, { kind: "branches" },
        { branches: "/main", kind: "branches" }, { branches: [ "/main", 3 ], kind: "branches" },
      ]) {
        expect(parseExplorerScope(value), JSON.stringify(value)).to.equal(undefined);
      }
    });
  });

  describe("isExplorerMessage", () => {
    it("accepts every message the client posts", () => {
      for (const message of [
        { type: "ready" }, { type: "refresh" }, { type: "loadMore" }, { type: "showOutput" },
        { scope: { kind: "current" }, type: "scope" },
        { changesetId: 12, type: "files" },
        { changesetId: 12, path: "/src/a.cs", revisionId: 345, type: "openDiff" },
        { text: "fix", type: "search" },
      ]) {
        expect(isExplorerMessage(message), JSON.stringify(message)).to.equal(true);
      }
    });

    it("rejects unknown or incomplete messages", () => {
      for (const message of [
        undefined, null, "ready", {}, { type: "delete" },
        { scope: { kind: "nope" }, type: "scope" },
        { changesetId: "12", type: "files" }, { changesetId: 1.5, type: "files" },
        { changesetId: 12, revisionId: 345, type: "openDiff" },
        { changesetId: 12, path: "/src/a.cs", type: "openDiff" },
        { text: "   ", type: "search" }, { text: 5, type: "search" },
      ]) {
        expect(isExplorerMessage(message), JSON.stringify(message)).to.equal(false);
      }
    });
  });

  describe("parseChangesetId", () => {
    it("reads a number with or without the cs: prefix", () => {
      expect(parseChangesetId("1234")).to.equal(1234);
      expect(parseChangesetId(" cs:1234 ")).to.equal(1234);
      expect(parseChangesetId("CS:7")).to.equal(7);
    });

    it("leaves anything else to the comment search", () => {
      for (const text of [ "", "fix 12", "12a", "cs:", "-3", "1.5", "12345678901" ]) {
        expect(parseChangesetId(text), text).to.equal(undefined);
      }
    });
  });

  describe("explorerChangesetFromArg", () => {
    const row = { branch: "/main/task", changesetId: 42, webviewSection: "explorerChangeset", wkId: "wk1" };

    it("reads a row's context", () => {
      expect(explorerChangesetFromArg(row))
        .to.eql({ branch: "/main/task", changesetId: 42, compareWithId: undefined, wkId: "wk1" });
    });

    it("keeps the row selected for a comparison", () => {
      expect(explorerChangesetFromArg({ ...row, compareWithId: 40 })?.compareWithId).to.equal(40);
      expect(explorerChangesetFromArg({ ...row, compareWithId: "40" })?.compareWithId).to.equal(undefined);
    });

    it("ignores every other argument", () => {
      for (const arg of [
        undefined, null, "cs:42", { ...row, webviewSection: "changeset" }, { ...row, wkId: 1 },
        { ...row, changesetId: "42" }, { ...row, changesetId: 4.2 }, { ...row, branch: undefined },
      ]) {
        expect(explorerChangesetFromArg(arg), JSON.stringify(arg)).to.equal(undefined);
      }
    });
  });

  describe("isCompareBetweenArgs", () => {
    it("needs a workspace and two changeset ids", () => {
      expect(isCompareBetweenArgs({ fromId: 1, toId: 2, wkId: "wk1" })).to.equal(true);
      for (const arg of [
        undefined, null, {}, { fromId: 1, toId: 2 }, { fromId: "1", toId: 2, wkId: "wk1" },
        { fromId: 1, wkId: "wk1" }, { fromId: 1, toId: 2.5, wkId: "wk1" },
      ]) {
        expect(isCompareBetweenArgs(arg), JSON.stringify(arg)).to.equal(false);
      }
    });
  });
});

interface IMenuEntry {
  command: string;
  when?: string;
}

interface IPackage {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: Record<string, IMenuEntry[]>;
  };
}

describe("Branch Explorer contributions", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8")) as IPackage;
  const ours = Object.values(EXPLORER_COMMANDS);
  const palette = pkg.contributes.menus.commandPalette;
  const rowCommands = ours.filter(id => id !== EXPLORER_COMMANDS.open && id !== EXPLORER_COMMANDS.refresh);
  const context = pkg.contributes.menus["webview/context"];

  it("declares every command with a title and lists it in the palette menu", () => {
    for (const id of ours) {
      const declared = pkg.contributes.commands.find(command => command.command === id);
      expect(declared?.title, id).to.be.a("string").and.not.equal("");
      expect(palette.filter(entry => entry.command === id), id).to.have.length(1);
    }
  });

  it("keeps the row commands out of the palette", () => {
    const visible = palette.filter(entry => ours.includes(entry.command) && entry.when !== "false")
      .map(entry => entry.command);
    expect(visible.sort()).to.eql([ EXPLORER_COMMANDS.open, EXPLORER_COMMANDS.refresh ].sort());
  });

  it("offers every row command on the explorer's changeset rows only", () => {
    for (const id of rowCommands) {
      const entries = context.filter(entry => entry.command === id);
      expect(entries, id).to.have.length(1);
      expect(entries[0].when).to.contain("webviewId == plastic-scm.branchExplorer");
      expect(entries[0].when).to.contain("webviewSection == explorerChangeset");
    }
  });

  it("offers Compare with Selected only when another row is selected", () => {
    const entry = context.find(candidate => candidate.command === EXPLORER_COMMANDS.compareWithSelected);
    expect(entry?.when).to.contain("explorerCanCompare");
  });

  it("offers Show File History on the explorer's file rows", () => {
    expect(context.some(entry => entry.command === "plastic-scm.fileHistory.show"
      && (entry.when ?? "").includes("webviewSection == explorerFile"))).to.equal(true);
  });

  it("opens the explorer from the SCM title and the Graph and Repository views", () => {
    expect(pkg.contributes.menus["scm/title"].some(entry => entry.command === EXPLORER_COMMANDS.open)).to.equal(true);
    const views = pkg.contributes.menus["view/title"].filter(entry => entry.command === EXPLORER_COMMANDS.open)
      .map(entry => entry.when);
    expect(views.sort()).to.eql([ "view == plastic-scm.history", "view == plastic-scm.repository" ]);
  });

  it("puts Refresh in the explorer's own editor title", () => {
    const entry = pkg.contributes.menus["editor/title"]
      .find(candidate => candidate.command === EXPLORER_COMMANDS.refresh);
    expect(entry?.when).to.equal("activeWebviewPanelId == plastic-scm.branchExplorer");
  });
});
