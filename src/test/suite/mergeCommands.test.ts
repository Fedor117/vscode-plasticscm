import * as fs from "fs";
import * as path from "path";
import {
  conflictItemName,
  describeMergeResult,
  directoryChoices,
  MERGE_COMMANDS,
  mergeComment,
  mergeObstacle,
  planMerge,
  renameProblem,
} from "../../commands/merge";
import { IDirectoryConflict, IMergeReport } from "../../cm/commands";
import { expect } from "chai";
import { EXPLORER_COMMANDS } from "../../commands/explorer";
import { MERGE_CONFLICTS_GROUP_ID } from "../../workspace";
import { WkConfigType } from "../../models";

const onMain = {
  config: { configType: WkConfigType.Branch, location: "/main", repSpec: "demo@local" },
  hasIncomingChanges: false,
  name: "wk",
  pendingChanges: 0,
};

function report(overrides: Partial<IMergeReport> = {}): IMergeReport {
  return {
    applied: 0,
    changedOnBoth: [],
    directoryConflicts: [],
    incoming: 0,
    other: [],
    unresolved: [],
    ...overrides,
  };
}

const twin: IDirectoryConflict = {
  destination: "Added /twin.txt", source: "Added /twin.txt", title: "Evil twin conflict", type: "EVIL",
};
const changeDelete: IDirectoryConflict = {
  destination: "Deleted /c.txt", source: "Modified /c.txt", title: "Change/Delete conflict", type: "CHG_RM",
};

describe("mergeObstacle", () => {
  it("lets a branch be merged into a clean, up-to-date workspace on another branch", () => {
    expect(mergeObstacle("/main/feature", onMain)).to.equal(undefined);
  });

  it("refuses a workspace that is not on a branch", () => {
    for (const configType of [ WkConfigType.Changeset, WkConfigType.Label, WkConfigType.Shelve ]) {
      expect(mergeObstacle("/main/feature", { ...onMain, config: { ...onMain.config, configType }}))
        .to.contain("not on a branch");
    }
    expect(mergeObstacle("/main/feature", { ...onMain, config: undefined })).to.contain("not on a branch");
  });

  it("refuses to merge a branch into itself", () => {
    expect(mergeObstacle("/main", onMain)).to.contain("is on /main");
  });

  it("refuses a workspace with pending changes and says how many", () => {
    expect(mergeObstacle("/main/feature", { ...onMain, pendingChanges: 1 })).to.contain("1 pending change.");
    expect(mergeObstacle("/main/feature", { ...onMain, pendingChanges: 3 })).to.contain("3 pending changes.");
  });

  it("refuses a workspace that is behind its branch", () => {
    expect(mergeObstacle("/main/feature", { ...onMain, hasIncomingChanges: true })).to.contain("Update the workspace");
  });
});

describe("planMerge", () => {
  it("asks to confirm, naming source and destination", () => {
    const plan = planMerge("/main/feature", "/main", report({ incoming: 3 }));
    expect(plan.kind).to.equal("merge");
    expect(plan.message).to.equal("Merge /main/feature into /main?");
    expect(plan.kind === "merge" && plan.detail).to.equal(
      "3 items to merge.\n\nThe result is left as pending changes with the merge link. " +
      "Review it and check it in from Source Control.");
  });

  it("says that overlapping changes become conflict markers to resolve in the editor", () => {
    const plan = planMerge("/main/auto", "/main", report({ changedOnBoth: ["/long.txt"], incoming: 2 }));
    expect(plan.kind === "merge" && plan.detail).to.contain("3 items to merge.");
    expect(plan.kind === "merge" && plan.detail).to.contain("1 file changed on both branches.");
    expect(plan.kind === "merge" && plan.detail).to.contain("conflict markers for you to resolve in the editor");
  });

  it("says that directory conflicts are asked about before anything changes", () => {
    const plan = planMerge("/main/dirconf", "/main", report({ directoryConflicts: [ twin, changeDelete ] }));
    expect(plan.kind === "merge" && plan.detail).to.contain("2 items to merge.");
    expect(plan.kind === "merge" && plan.detail).to.contain(
      "2 directory conflicts: you choose how to resolve each one next, before anything changes.");
  });

  it("says so when there is nothing to merge", () => {
    expect(planMerge("/main/feature", "/main", report({ nothingToMerge: "No merges detected" }))).to.eql({
      kind: "nothing",
      message: "There is nothing to merge from /main/feature into /main (cm: No merges detected).",
    });
    expect(planMerge("/main/feature", "/main", report()).kind).to.equal("nothing");
  });

  it("still merges when cm lists a kind of change this version does not know", () => {
    expect(planMerge("/main/feature", "/main", report({ other: ["FILE_NEW_KIND#|#/x"] })).kind).to.equal("merge");
  });
});

describe("directoryChoices", () => {
  it("offers each branch's side, saying what that branch did", () => {
    const choices = directoryChoices(changeDelete, "/main/task", "/main");
    expect(choices.map(choice => [ choice.keep, choice.label, choice.description ])).to.eql([
      [ "source", "$(arrow-down) Take /main/task", "Modified /c.txt" ],
      [ "destination", "$(circle-slash) Keep /main", "Deleted /c.txt" ],
    ]);
  });

  it("offers to keep both only where cm can rename", () => {
    expect(directoryChoices(twin, "/main/task", "/main").map(choice => choice.keep))
      .to.eql([ "source", "destination", "both" ]);
  });
});

describe("conflictItemName and renameProblem", () => {
  it("takes the name from a conflict side", () => {
    expect(conflictItemName("Added /twin.txt")).to.equal("twin.txt");
    expect(conflictItemName("Added /dir with space/d.txt")).to.equal("d.txt");
    expect(conflictItemName("Something without a path")).to.equal("");
  });

  it("accepts a different plain name only", () => {
    expect(renameProblem("twin-main.txt", "twin.txt")).to.equal(undefined);
    expect(renameProblem("twin.txt", "twin.txt")).to.contain("different");
    expect(renameProblem("  ", "twin.txt")).to.contain("Enter a name");
    for (const bad of [ "a/b", "a\\b", "a\"b", "-x", " x", "x " ]) {
      expect(renameProblem(bad, "twin.txt"), bad).to.contain("cannot");
    }
  });
});

describe("describeMergeResult", () => {
  it("points at the pending changes after a merge", () => {
    const outcome = describeMergeResult("/main/feature", "/main", { report: report({ applied: 3 }), succeeded: true });
    expect(outcome).to.eql({
      kind: "merged",
      message: "Merged /main/feature into /main. Review the pending changes and check them in.",
    });
  });

  it("leaves text conflicts to the editor, naming the files", () => {
    const outcome = describeMergeResult("/main/conflict", "/main", {
      report: report({ unresolved: [{ path: "/b.txt", reason: "markers" }, { path: "/src/a.cs", reason: "markers" }] }),
      succeeded: false,
    });

    expect(outcome).to.eql({
      kind: "conflicts",
      message: "Merged /main/conflict into /main with conflicts in 2 files. " +
        "Resolve the markers and save, then check in.",
      paths: [ "/b.txt", "/src/a.cs" ],
    });
  });

  it("asks which side to take for files that cannot be merged as text, before anything else", () => {
    const outcome = describeMergeResult("/main/mixed", "/main", {
      report: report({
        unresolved: [{ path: "/b.txt", reason: "markers" }, { path: "/logo.png", reason: "binary" }],
      }),
      succeeded: false,
    });

    expect(outcome.kind).to.equal("undecided");
    expect(outcome.message).to.equal("1 file cannot be merged automatically.");
    expect(outcome.kind === "undecided" && outcome.detail).to.contain("/logo.png (binary)");
    expect(outcome.kind === "undecided" && outcome.detail).to.not.contain("/b.txt");
    expect(outcome.kind === "undecided" && outcome.detail).to.contain("Cancel aborts the merge");
  });

  it("lists at most ten files", () => {
    const unresolved = Array.from({ length: 13 }, (_, index) => ({ path: `/f${index}.png`, reason: "binary" }));
    const outcome = describeMergeResult("/a", "/main", { report: report({ unresolved }), succeeded: false });
    const lines = outcome.kind === "undecided" ? outcome.detail.split("\n\n")[0].split("\n") : [];
    expect(lines).to.have.length(11);
    expect(lines[10]).to.equal("… and 3 more");
  });

  it("passes on cm's words when it stopped part-way without naming a file", () => {
    const outcome = describeMergeResult("/a", "/main", {
      error: new Error("Error: something broke"),
      report: report({ applied: 1 }),
      succeeded: false,
    });
    expect(outcome.kind).to.equal("failed");
    expect(outcome.message).to.contain("part of the merge is in the pending changes. Error: something broke");
  });

  it("offers a check-in comment naming both branches", () => {
    expect(mergeComment("/main/feature", "/main")).to.equal("Merge /main/feature into /main");
  });
});

interface IMenuEntry {
  command: string;
  when?: string;
}

describe("Merge contributions", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, IMenuEntry[]> };
  };
  const title = (id: string) => pkg.contributes.commands.find(command => command.command === id)?.title;

  it("declares the command and offers it in the palette", () => {
    expect(title(MERGE_COMMANDS.fromBranch)).to.equal("Merge from Branch…");
    const palette = pkg.contributes.menus.commandPalette.filter(entry => entry.command === MERGE_COMMANDS.fromBranch);
    expect(palette.map(entry => entry.when)).to.eql(["plastic-scm.active"]);
  });

  it("offers it on the Repository view's branch rows, except the workspace's own", () => {
    const rows = pkg.contributes.menus["view/item/context"].filter(
      entry => entry.command === MERGE_COMMANDS.fromBranch);
    expect(rows.map(entry => entry.when)).to.eql(["view == plastic-scm.repository && viewItem == branch"]);
  });

  it("offers the conflict commands on the Merge Conflicts group and its files only", () => {
    const palette = pkg.contributes.menus.commandPalette;
    const whenOf = (id: string) => palette.filter(entry => entry.command === id).map(entry => entry.when);
    expect(whenOf(MERGE_COMMANDS.abort)).to.eql(["plastic-scm.active"]);
    expect(whenOf(MERGE_COMMANDS.openConflicts)).to.eql(["plastic-scm.active"]);
    expect(whenOf(MERGE_COMMANDS.markResolved)).to.eql(["false"]);

    const onGroup = pkg.contributes.menus["scm/resourceGroup/context"];
    const onFile = pkg.contributes.menus["scm/resourceState/context"]
      .filter(entry => entry.command === MERGE_COMMANDS.markResolved);
    expect(new Set(onGroup.map(entry => entry.command)))
      .to.eql(new Set([ MERGE_COMMANDS.openConflicts, MERGE_COMMANDS.abort ]));
    expect(onFile.length).to.be.greaterThan(0);
    for (const entry of [ ...onGroup, ...onFile ]) {
      expect(entry.when).to.contain(`scmResourceGroup == ${MERGE_CONFLICTS_GROUP_ID}`);
    }
    for (const id of Object.values(MERGE_COMMANDS)) {
      expect(title(id), id).to.be.a("string").and.not.equal("");
    }
  });

  it("offers it on Branch Explorer rows of other branches", () => {
    expect(title(EXPLORER_COMMANDS.mergeFromBranch)).to.equal("Merge from This Branch…");
    const rows = pkg.contributes.menus["webview/context"].filter(
      entry => entry.command === EXPLORER_COMMANDS.mergeFromBranch);
    expect(rows).to.have.length(1);
    expect(rows[0].when).to.contain("!explorerIsWorkspaceBranch");
  });
});
