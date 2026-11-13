import * as fs from "fs";
import * as path from "path";
import { STATUS_BAR_MENU, SWITCH_COMMANDS } from "../../commands/switch";
import { ANNOTATE_COMMANDS } from "../../commands/annotate";
import { BRANCH_COMMANDS } from "../../commands/branch";
import { COMPARISON_COMMANDS } from "../../comparison/comparisonTree";
import { expect } from "chai";
import { FILE_HISTORY_COMMANDS } from "../../fileHistory/fileHistoryTree";
import { IGNORE_RULE_COMMANDS } from "../../commands/ignoreRules";
import { LABEL_COMMANDS } from "../../commands/label";
import { LOCK_COMMANDS } from "../../commands/locks";
import { TRACKED_FILE_COMMANDS } from "../../commands/trackedFiles";

interface IPackage {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
  };
}

function readPackage(): IPackage {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as IPackage;
}

describe("Branch, switch and label contributions", () => {
  const pkg = readPackage();
  const declared = new Set(pkg.contributes.commands.map(command => command.command));
  const ours = [
    ...Object.values(BRANCH_COMMANDS),
    ...Object.values(LABEL_COMMANDS),
    ...Object.values(SWITCH_COMMANDS),
  ];

  it("declares every command the code registers", () => {
    for (const id of ours) {
      expect(declared.has(id), id).to.equal(true);
    }
  });

  it("gives every command a title that ends the way a prompt does or names the action", () => {
    for (const id of ours) {
      const command = pkg.contributes.commands.find(candidate => candidate.command === id);
      expect(command?.title.length, id).to.be.greaterThan(0);
    }
  });

  it("lists every command in the palette menu, so none is visible by accident", () => {
    const listed = new Set(pkg.contributes.menus.commandPalette.map(entry => entry.command));
    for (const id of ours) {
      expect(listed.has(id), id).to.equal(true);
    }
  });

  it("hides only the status bar menu from the palette", () => {
    const hidden = pkg.contributes.menus.commandPalette
      .filter(entry => ours.includes(entry.command) && entry.when === "false")
      .map(entry => entry.command);
    expect(hidden).to.eql([SWITCH_COMMANDS.statusBarMenu]);
  });

  it("puts Update in the Source Control title menu", () => {
    const entry = pkg.contributes.menus["scm/title"].find(item => item.command === SWITCH_COMMANDS.update);
    expect(entry?.when).to.contain("scmProvider");
  });

  it("offers in the status bar menu only commands that exist", () => {
    for (const item of STATUS_BAR_MENU) {
      expect(declared.has(item.command) || item.command === "workbench.view.scm", item.command).to.equal(true);
    }
  });

  it("never offers Delete on the row the workspace is on", () => {
    const deletes = pkg.contributes.menus["view/item/context"].filter(
      item => item.command === BRANCH_COMMANDS.delete || item.command === LABEL_COMMANDS.delete);
    expect(deletes).to.have.length(2);
    for (const item of deletes) {
      expect(item.when).to.match(/viewItem == (branch|label)$/);
    }
  });
});

describe("Lock, checkout, delete, move and rule contributions", () => {
  const pkg = readPackage();
  const declared = new Set(pkg.contributes.commands.map(command => command.command));
  const ours = [
    ...Object.values(LOCK_COMMANDS),
    ...Object.values(TRACKED_FILE_COMMANDS),
    ...Object.values(IGNORE_RULE_COMMANDS),
  ];
  const palette = pkg.contributes.menus.commandPalette;

  it("declares every command and lists it in the palette menu", () => {
    for (const id of ours) {
      expect(declared.has(id), id).to.equal(true);
      expect(palette.some(entry => entry.command === id), id).to.equal(true);
    }
  });

  it("hides only the lock row commands from the palette", () => {
    const hidden = palette.filter(entry => ours.includes(entry.command) && entry.when === "false")
      .map(entry => entry.command);
    expect(hidden.sort()).to.eql([ LOCK_COMMANDS.release, LOCK_COMMANDS.remove ].sort());
  });

  it("offers checkout on SCM rows, in the Explorer and in the editor tab menu", () => {
    const has = (menu: string, id: string) => (pkg.contributes.menus[menu] ?? []).some(item => item.command === id);
    expect(has("scm/resourceState/context", LOCK_COMMANDS.checkout)).to.equal(true);
    expect(has("explorer/context", LOCK_COMMANDS.checkout)).to.equal(true);
    expect(has("editor/title/context", LOCK_COMMANDS.checkout)).to.equal(true);
  });

  it("offers delete, move and the three rule commands on SCM rows and in the Explorer", () => {
    const ids = [
      TRACKED_FILE_COMMANDS.delete,
      TRACKED_FILE_COMMANDS.move,
      IGNORE_RULE_COMMANDS.addIgnore,
      IGNORE_RULE_COMMANDS.addHiddenChanges,
      IGNORE_RULE_COMMANDS.addCloaked,
    ];
    for (const id of ids) {
      expect(pkg.contributes.menus["scm/resourceState/context"].some(item => item.command === id), id).to.equal(true);
      expect(pkg.contributes.menus["explorer/context"].some(item => item.command === id), id).to.equal(true);
    }
  });

  it("puts release and remove on lock rows only", () => {
    for (const id of [ LOCK_COMMANDS.release, LOCK_COMMANDS.remove ]) {
      const entries = pkg.contributes.menus["view/item/context"].filter(item => item.command === id);
      expect(entries, id).to.have.length(1);
      expect(entries[0].when).to.contain("lock");
    }
  });
});

describe("File history, annotate and compare contributions", () => {
  const pkg = readPackage();
  const declared = new Set(pkg.contributes.commands.map(command => command.command));
  const ours = [
    ...Object.values(FILE_HISTORY_COMMANDS),
    ...Object.values(ANNOTATE_COMMANDS),
    ...Object.values(COMPARISON_COMMANDS),
  ];
  const palette = pkg.contributes.menus.commandPalette;
  const has = (menu: string, id: string) => (pkg.contributes.menus[menu] ?? []).some(item => item.command === id);

  it("declares every command and lists it in the palette menu", () => {
    for (const id of ours) {
      expect(declared.has(id), id).to.equal(true);
      expect(palette.some(entry => entry.command === id), id).to.equal(true);
    }
  });

  it("leaves only the four commands that need no row in the palette", () => {
    const visible = palette.filter(entry => ours.includes(entry.command) && entry.when !== "false")
      .map(entry => entry.command);
    expect(visible.sort()).to.eql([
      ANNOTATE_COMMANDS.toggle,
      COMPARISON_COMMANDS.branchChanges,
      COMPARISON_COMMANDS.changesets,
      FILE_HISTORY_COMMANDS.show,
    ].sort());
  });

  it("offers Show File History in the Explorer, the editor, SCM rows and the Graph's file rows", () => {
    const menus = [ "explorer/context", "editor/context", "editor/title/context" ];
    menus.push("scm/resourceState/context", "webview/context");
    for (const menu of menus) {
      expect(has(menu, FILE_HISTORY_COMMANDS.show), menu).to.equal(true);
    }
  });

  it("offers every per-revision command on revision rows only", () => {
    for (const id of [
      FILE_HISTORY_COMMANDS.openChanges,
      FILE_HISTORY_COMMANDS.compareWithWorkspace,
      FILE_HISTORY_COMMANDS.openAtRevision,
      FILE_HISTORY_COMMANDS.copyChangesetId,
      FILE_HISTORY_COMMANDS.revert,
    ]) {
      const entries = pkg.contributes.menus["view/item/context"].filter(item => item.command === id);
      expect(entries.length, id).to.be.greaterThan(0);
      for (const entry of entries) {
        expect(entry.when).to.contain("viewItem == fileRevision");
      }
    }
  });

  it("shows the Comparison view only while it has a result", () => {
    const views = (pkg.contributes as unknown as { views: { scm: Array<{ id: string; when: string }> } }).views.scm;
    expect(views.find(view => view.id === "plastic-scm.comparison")?.when).to.contain("plastic-scm.comparison.active");
  });
});
