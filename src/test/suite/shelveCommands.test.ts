import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  automaticComment,
  controlledPaths,
  SHELVE_AND_CONTINUE_LABEL,
  SHELVE_COMMANDS,
  shelveOverlap,
  splitByModification,
} from "../../commands/shelve";
import {
  confirmPendingChanges,
  IPendingChangesHandler,
  pendingChangesDetail,
  runPendingChangesFollowUp,
  setPendingChangesFollowUp,
} from "../../commands/pendingChanges";
import { FileChangeStatus, IChangesetFileChange, IShelveInfo, RevisionType } from "../../models";
import { SHELVE_OPEN_FILE_COMMAND, shelveFileItem, shelvesSection } from "../../repository/repositorySections";
import { shelveFileFromNode, shelveFromNode } from "../../commands/targets";
import { describeShelveFileDiff } from "../../history/openChangesetFileDiff";
import { expect } from "chai";
import { ThemeIcon } from "vscode";
import { Workspace } from "../../workspace";

const SHELVE: IShelveInfo = {
  comment: "WIP",
  date: new Date(0),
  guid: "",
  id: 5101,
  owner: "someone@example.com",
  parentChangesetId: 880,
  repository: "Nimbus/Nimbus",
  server: "acme-studio@unity",
  shelveId: 41,
};

const CHANGE: IChangesetFileChange = {
  baseRevisionId: 11593,
  parentRevisionId: 11593,
  path: "/Assets/Code/Banner.cs",
  repository: "Nimbus/Nimbus@acme-studio@unity",
  revisionId: 12347,
  revisionType: RevisionType.TextFile,
  status: FileChangeStatus.Changed,
};

describe("Shelve helpers", () => {
  it("keeps only controlled changes' paths", () => {
    const states = [
      { isPrivate: false, resourceUri: { fsPath: "/work/a.cs" }},
      { isPrivate: true, resourceUri: { fsPath: "/work/b.tmp" }},
    ];
    expect(controlledPaths(states)).to.eql(["/work/a.cs"]);
  });

  it("finds the pending files a shelve also changes, ignoring case", () => {
    const overlap = shelveOverlap(
      path.join("/work", "Nimbus"),
      [ path.join("/work", "Nimbus", "Assets", "Code", "banner.cs"), path.join("/work", "Nimbus", "Other.txt") ],
      [ "/Assets/Code/Banner.cs", "/Assets/Code/Else.cs" ]);
    expect(overlap).to.eql([path.join("/work", "Nimbus", "Assets", "Code", "banner.cs")]);
  });

  it("finds no overlap when the files differ", () => {
    expect(shelveOverlap("/work/Nimbus", ["/work/Nimbus/a.txt"], ["/b.txt"])).to.eql([]);
  });

  it("keeps files written after the shelve out of the undo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-"));
    try {
      const older = path.join(dir, "older.txt");
      const newer = path.join(dir, "newer.txt");
      fs.writeFileSync(older, "a");
      fs.writeFileSync(newer, "b");
      const now = Date.now();
      fs.utimesSync(older, new Date(now - 60000), new Date(now - 60000));
      fs.utimesSync(newer, new Date(now + 60000), new Date(now + 60000));
      const missing = path.join(dir, "gone.txt");
      expect(splitByModification([ older, newer, missing ], now)).to.eql({ newer: [newer], safe: [ older, missing ] });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("words the automatic comment after the action", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    expect(automaticComment({ kind: "switch", target: "branch /main/task001" }, at))
      .to.equal(
        "Shelved by Plastic SCM for VS Code before switching to branch /main/task001 (2026-01-02T03:04:05.000Z)");
    expect(automaticComment({ kind: "update", target: "'Nimbus'" }, at)).to.contain("updating 'Nimbus'");
  });
});

describe("Shelve rows", () => {
  it("recognises a shelve row and a file under it by the section", () => {
    const section = { id: "shelves" };
    const row = { item: SHELVE, kind: "item", parent: { section }, workspace: { info: { id: "w1" }}};
    expect(shelveFromNode(row)).to.equal(SHELVE);
    expect(shelveFromNode({ ...row, parent: { section: { id: "labels" }}})).to.equal(undefined);

    const file = { child: CHANGE, kind: "child", parent: row };
    expect(shelveFileFromNode(file)).to.eql({ change: CHANGE, shelve: SHELVE });
    expect(shelveFileFromNode(row)).to.equal(undefined);
  });

  it("titles a file diff after the shelve and the changeset it was made on", () => {
    const diff = describeShelveFileDiff("w1", SHELVE, CHANGE);
    expect(diff?.title).to.equal("Banner.cs (cs:880) ↔ Banner.cs (sh:41)");
  });

  it("titles an added and a deleted file", () => {
    expect(describeShelveFileDiff("w1", SHELVE, { ...CHANGE, status: FileChangeStatus.Added })?.title)
      .to.equal("Banner.cs (added in sh:41)");
    expect(describeShelveFileDiff("w1", SHELVE, { ...CHANGE, status: FileChangeStatus.Deleted })?.title)
      .to.equal("Banner.cs (deleted in sh:41)");
  });

  it("has no diff for a binary file", () => {
    const binary = { ...CHANGE, revisionType: RevisionType.BinaryFile };
    expect(describeShelveFileDiff("w1", SHELVE, binary)).to.equal(undefined);
  });
});

describe("Files listed under a shelve", () => {
  it("shows the file name, its folder and a status icon, and opens the diff on click", () => {
    const item = shelveFileItem(CHANGE);
    expect(item.label).to.equal("Banner.cs");
    expect(item.description).to.equal("/Assets/Code");
    expect((item.iconPath as ThemeIcon).id).to.equal("diff-modified");
    expect(item.contextValue).to.equal("shelve.file");
    expect(item.command?.command).to.equal(SHELVE_OPEN_FILE_COMMAND);
    expect(SHELVE_OPEN_FILE_COMMAND).to.equal(SHELVE_COMMANDS.openFile);
  });

  it("uses an added, removed and renamed icon for those changes", () => {
    const icon = (status: FileChangeStatus) => (shelveFileItem({ ...CHANGE, status }).iconPath as ThemeIcon).id;
    expect(icon(FileChangeStatus.Added)).to.equal("diff-added");
    expect(icon(FileChangeStatus.Deleted)).to.equal("diff-removed");
    expect(icon(FileChangeStatus.Moved)).to.equal("diff-renamed");
  });

  it("makes the Shelves section's rows expandable", () => {
    expect(typeof shelvesSection.loadChildren).to.equal("function");
    expect(shelvesSection.childKey?.(CHANGE)).to.equal("/Assets/Code/Banner.cs#12347");
  });
});

function fakeWorkspace(id: string): Workspace {
  return {
    info: { id, name: "Nimbus" },
    pendingChanges: [{ isPrivate: false }],
  } as unknown as Workspace;
}

describe("Shelve and continue in the pending-changes dialog", () => {
  const handler: IPendingChangesHandler = {
    detail: "Shelves every pending change.",
    label: SHELVE_AND_CONTINUE_LABEL,
    run: () => Promise.resolve(true),
  };

  it("explains the button in the detail", () => {
    const detail = pendingChangesDetail({ kind: "switch", target: "branch /main" }, [handler]);
    expect(detail).to.contain(`Or use "${SHELVE_AND_CONTINUE_LABEL}"`);
    expect(detail).to.contain(`"${SHELVE_AND_CONTINUE_LABEL}": Shelves every pending change.`);
  });

  it("runs the follow-up once, with the outcome", async () => {
    const workspace = fakeWorkspace("w1");
    const seen: boolean[] = [];
    setPendingChangesFollowUp(workspace, succeeded => {
      seen.push(succeeded);
    });
    await runPendingChangesFollowUp(workspace, true);
    await runPendingChangesFollowUp(workspace, true);
    expect(seen).to.eql([true]);
  });

  it("drops a follow-up a cancelled dialog left behind", async () => {
    const workspace = fakeWorkspace("w2");
    const seen: boolean[] = [];
    setPendingChangesFollowUp(workspace, succeeded => {
      seen.push(succeeded);
    });
    await confirmPendingChanges(workspace, { kind: "switch", target: "x" }, [], () => Promise.resolve(undefined));
    await runPendingChangesFollowUp(workspace, true);
    expect(seen).to.eql([]);
  });

  it("offers the button next to Continue and lets the handler decide", async () => {
    let offered: string[] = [];
    const ok = await confirmPendingChanges(
      fakeWorkspace("w3"), { kind: "update", target: "'Nimbus'" }, [handler], (_m, _d, buttons) => {
        offered = buttons;
        return Promise.resolve(SHELVE_AND_CONTINUE_LABEL);
      });
    expect(offered).to.eql([ "Continue", SHELVE_AND_CONTINUE_LABEL ]);
    expect(ok).to.equal(true);
  });
});

describe("Shelve contributions", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
    contributes: {
      commands: Array<{ command: string }>;
      menus: Record<string, Array<{ command: string; when?: string }>>;
    };
  };
  const ids = Object.values(SHELVE_COMMANDS);

  it("declares every command and lists it in the palette menu", () => {
    const declared = new Set(pkg.contributes.commands.map(command => command.command));
    const listed = new Map(pkg.contributes.menus.commandPalette.map(entry => [ entry.command, entry.when ]));
    for (const id of ids) {
      expect(declared.has(id), id).to.equal(true);
      expect(listed.has(id), id).to.equal(true);
    }
  });

  it("hides the commands that need a row from the palette", () => {
    const listed = new Map(pkg.contributes.menus.commandPalette.map(entry => [ entry.command, entry.when ]));
    expect(listed.get(SHELVE_COMMANDS.createSelected)).to.equal("false");
    expect(listed.get(SHELVE_COMMANDS.copyId)).to.equal("false");
    expect(listed.get(SHELVE_COMMANDS.openFile)).to.equal("false");
  });

  it("puts Shelve Pending Changes in the Source Control title and Shelve Selected on change rows", () => {
    expect(pkg.contributes.menus["scm/title"].some(entry => entry.command === SHELVE_COMMANDS.create)).to.equal(true);
    const selected = pkg.contributes.menus["scm/resourceState/context"]
      .find(entry => entry.command === SHELVE_COMMANDS.createSelected);
    expect(selected?.when).to.contain("scmResourceGroup == status");
  });

  it("offers apply, copy and delete on shelve rows and the diff on file rows", () => {
    const rows = pkg.contributes.menus["view/item/context"];
    for (const id of [ SHELVE_COMMANDS.apply, SHELVE_COMMANDS.copyId, SHELVE_COMMANDS.delete ]) {
      expect(rows.some(entry => entry.command === id && entry.when?.includes("shelve")), id).to.equal(true);
    }
    expect(rows.find(entry => entry.command === SHELVE_COMMANDS.openFile)?.when).to.contain("viewItem == shelve.file");
  });
});
