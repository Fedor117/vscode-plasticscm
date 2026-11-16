import * as fs from "fs";
import * as path from "path";
import { describeMergeResult, MERGE_COMMANDS, mergeObstacle, planMerge } from "../../commands/merge";
import { expect } from "chai";
import { EXPLORER_COMMANDS } from "../../commands/explorer";
import { IMergeReport } from "../../cm/commands";
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
    expect(plan.kind === "merge" && plan.detail).to.contain("3 items to merge.");
    expect(plan.kind === "merge" && plan.detail).to.contain("pending changes with the merge link");
  });

  it("warns that files changed on both branches may conflict", () => {
    const plan = planMerge("/main/auto", "/main", report({ changedOnBoth: ["/long.txt"], incoming: 2 }));
    expect(plan.kind === "merge" && plan.detail).to.contain("3 items to merge. 1 file changed on both branches");
  });

  it("says so when there is nothing to merge", () => {
    expect(planMerge("/main/feature", "/main", report({ nothingToMerge: "No merges detected" }))).to.eql({
      kind: "nothing",
      message: "There is nothing to merge from /main/feature into /main (cm: No merges detected).",
    });
    expect(planMerge("/main/feature", "/main", report()).kind).to.equal("nothing");
  });

  it("stops at a directory conflict, naming it, before anything is merged", () => {
    const plan = planMerge("/main/dirconf", "/main", report({
      directoryConflicts: [{ destination: "Added /twin.txt", source: "Added /twin.txt", title: "Evil twin conflict" }],
      incoming: 1,
    }));

    expect(plan.kind).to.equal("blocked");
    expect(plan.message).to.contain("1 directory conflict.");
    expect(plan.kind === "blocked" && plan.detail).to.contain(
      "Evil twin conflict: Added /twin.txt on /main/dirconf, Added /twin.txt on /main");
    expect(plan.kind === "blocked" && plan.detail).to.contain("Plastic SCM GUI");
  });

  it("still merges when cm lists a kind of change this version does not know", () => {
    expect(planMerge("/main/feature", "/main", report({ other: ["FILE_NEW_KIND#|#/x"] })).kind).to.equal("merge");
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

  it("names the conflicting files and why cm left the ones it could not mark", () => {
    const outcome = describeMergeResult("/main/conflict", "/main", {
      report: report({
        unresolved: [{ path: "/b.txt", reason: "markers" }, { path: "/logo.png", reason: "binary" }],
      }),
      succeeded: false,
    });

    expect(outcome.kind).to.equal("conflicts");
    expect(outcome.message).to.equal("/main/conflict cannot be merged into /main automatically: 2 files conflict.");
    expect(outcome.kind === "conflicts" && outcome.files).to.equal("/b.txt\n/logo.png (binary)");
  });

  it("lists at most ten files", () => {
    const unresolved = Array.from({ length: 13 }, (_, index) => ({ path: `/f${index}.txt`, reason: "markers" }));
    const outcome = describeMergeResult("/a", "/main", { report: report({ unresolved }), succeeded: false });
    const lines = outcome.kind === "conflicts" ? outcome.files.split("\n") : [];
    expect(lines).to.have.length(11);
    expect(lines[10]).to.equal("… and 3 more");
  });

  it("passes on cm's words when it failed without naming a file", () => {
    const outcome = describeMergeResult("/a", "/main", {
      error: new Error("Error: something broke"),
      report: report({ applied: 1 }),
      succeeded: false,
    });
    expect(outcome.kind === "conflicts" && outcome.files).to.equal("Error: something broke");
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

  it("offers it on Branch Explorer rows of other branches", () => {
    expect(title(EXPLORER_COMMANDS.mergeFromBranch)).to.equal("Merge from This Branch…");
    const rows = pkg.contributes.menus["webview/context"].filter(
      entry => entry.command === EXPLORER_COMMANDS.mergeFromBranch);
    expect(rows).to.have.length(1);
    expect(rows[0].when).to.contain("!explorerIsWorkspaceBranch");
  });
});
