import {
  branchColor,
  buildExplorerModel,
  EXPLORER_PALETTE_SIZE,
  ExplorerScope,
  IExplorerModel,
  IExplorerRow,
  toFlatExplorerRow,
} from "../../../explorer/explorerGraph";
import { IHistoryChangeset, ILabelInfo, IMergeLink } from "../../../models";
import { expect } from "chai";

const MAIN = "/main";
const TASK = "/main/task";

function cs(id: number, parentId: number, branch: string, owner = "dana.kim@example.com"): IHistoryChangeset {
  return {
    branch,
    comment: `Changeset ${id}\nwith a second line`,
    date: new Date(Date.UTC(2026, 8, 1, 10, id)),
    guid: `cafe${String(id).padStart(4, "0")}-4b1d-4c2e-9d3f-5a6b7c8d9e0f`,
    id,
    owner,
    parentId,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

function merge(sourceId: number, sourceBranch: string, destinationId: number, type = "merge"): IMergeLink {
  return {
    destinationBranch: MAIN,
    destinationChangesetId: destinationId,
    sourceBranch,
    sourceChangesetId: sourceId,
    type,
  };
}

function label(name: string, changesetId: number): ILabelInfo {
  return {
    branch: MAIN,
    changesetId,
    comment: "",
    date: new Date(Date.UTC(2026, 8, 2)),
    id: 9000 + changesetId,
    name,
    owner: "dana.kim@example.com",
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

/**
 * main: 1 - 2 - 4 - 5, task: 3 branched from 2 and merged into 5.
 */
const HISTORY = [
  cs(1, -1, MAIN), cs(2, 1, MAIN), cs(3, 2, TASK, "lee.park@example.com"), cs(4, 2, MAIN), cs(5, 4, MAIN),
];
const MERGES = [merge(3, TASK, 5)];

function build(scope: ExplorerScope, overrides: { currentChangesetId?: number; currentBranch?: string } = {}):
    IExplorerModel {
  return buildExplorerModel({
    changesets: HISTORY,
    currentBranch: "currentBranch" in overrides ? overrides.currentBranch : MAIN,
    currentChangesetId: overrides.currentChangesetId ?? 5,
    labels: [ label("v1.0", 2), label("v1.0", 2), label("nightly", 2) ],
    merges: MERGES,
    scope,
  });
}

function rowOf(model: IExplorerModel, id: number): IExplorerRow {
  const row = model.rows.find(candidate => candidate.id === id);
  if (!row) {
    throw new Error(`cs:${id} is not a row`);
  }
  return row;
}

/** The line pieces of a row as `[top, bottom, color, merge]` tuples, sorted so order does not matter. */
function pieces(row: IExplorerRow): number[][] {
  const result: number[][] = [];
  for (let index = 0; index < row.lines.length; index += 4) {
    result.push(row.lines.slice(index, index + 4));
  }
  return result.sort((left, right) => left.join(",").localeCompare(right.join(",")));
}

function sorted(list: number[][]): number[][] {
  return list.slice().sort((left, right) => left.join(",").localeCompare(right.join(",")));
}

describe("Branch Explorer graph model", () => {
  const main = branchColor(MAIN);
  const task = branchColor(TASK);

  context("A single branch", () => {
    const model = buildExplorerModel({
      changesets: [ cs(11, 10, MAIN), cs(12, 11, MAIN), cs(10, -1, MAIN) ],
      currentBranch: MAIN,
      currentChangesetId: 11,
      labels: [],
      merges: [],
      scope: { kind: "all" },
    });

    it("lists the changesets newest first whatever order they arrive in", () => {
      expect(model.rows.map(row => row.id)).to.eql([ 12, 11, 10 ]);
    });

    it("keeps every changeset on the first lane", () => {
      expect(model.rows.map(row => row.lane)).to.eql([ 0, 0, 0 ]);
      expect(model.laneCount).to.equal(1);
    });

    it("draws the head downwards only, the middle both ways and the root upwards only", () => {
      expect(pieces(rowOf(model, 12))).to.eql([[ -1, 0, main, 0 ]]);
      expect(pieces(rowOf(model, 11))).to.eql(sorted([[ 0, -1, main, 0 ], [ -1, 0, main, 0 ]]));
      expect(pieces(rowOf(model, 10))).to.eql([[ 0, -1, main, 0 ]]);
    });

    it("marks the workspace's changeset", () => {
      expect(model.rows.filter(row => row.isCurrent).map(row => row.id)).to.eql([11]);
    });

    it("carries the subject, the whole comment, the short owner and an ISO date", () => {
      const row = rowOf(model, 12);
      expect(row.subject).to.equal("Changeset 12");
      expect(row.comment).to.equal("Changeset 12\nwith a second line");
      expect(row.ownerShort).to.equal("dana.kim");
      expect(row.date).to.equal("2026-09-01T10:12:00.000Z");
    });
  });

  context("A history whose oldest parent is not loaded", () => {
    const model = buildExplorerModel({
      changesets: [ cs(21, 20, MAIN), cs(22, 21, MAIN) ],
      currentChangesetId: 22,
      labels: [],
      merges: [],
      scope: { kind: "all" },
    });

    it("runs the oldest row's line off the bottom of the graph", () => {
      expect(pieces(rowOf(model, 21))).to.eql(sorted([[ 0, -1, main, 0 ], [ -1, 0, main, 0 ]]));
    });
  });

  context("Two branches and a merge", () => {
    const model = build({ kind: "all" });

    it("shows every changeset", () => {
      expect(model.rows.map(row => row.id)).to.eql([ 5, 4, 3, 2, 1 ]);
      expect(model.loadedCount).to.equal(5);
    });

    it("gives the side branch a lane of its own", () => {
      expect(model.rows.map(row => row.lane)).to.eql([ 0, 0, 1, 0, 0 ]);
      expect(model.laneCount).to.equal(2);
    });

    it("draws the merge as a dashed line from the destination towards the source", () => {
      expect(pieces(rowOf(model, 5))).to.eql(sorted([[ -1, 0, main, 0 ], [ -1, 1, task, 1 ]]));
      // The dashed line passes cs:4 on its way down to cs:3.
      expect(pieces(rowOf(model, 4))).to.eql(sorted([[ 0, -1, main, 0 ], [ -1, 0, main, 0 ], [ 1, 1, task, 1 ]]));
      expect(pieces(rowOf(model, 3))).to.eql(sorted([[ 0, 0, main, 0 ], [ 1, -1, task, 1 ], [ -1, 1, task, 0 ]]));
    });

    it("brings both branches together at the changeset they share", () => {
      expect(pieces(rowOf(model, 2))).to.eql(sorted([[ 0, -1, main, 0 ], [ 1, -1, task, 0 ], [ -1, 0, main, 0 ]]));
    });

    it("names the merge source on the destination", () => {
      expect(rowOf(model, 5).mergedFrom).to.eql([{ branch: TASK, id: 3, type: "merge" }]);
      expect(rowOf(model, 4).mergedFrom).to.eql([]);
    });

    it("puts a branch pill on each branch's newest changeset and flags the workspace's branch", () => {
      expect(rowOf(model, 5).refs).to.eql([{ isCurrent: true, kind: "branch", text: MAIN }]);
      expect(rowOf(model, 3).refs).to.eql([{ isCurrent: false, kind: "branch", text: TASK }]);
      expect(rowOf(model, 4).refs).to.eql([]);
    });

    it("puts each label on its changeset once", () => {
      expect(rowOf(model, 2).refs).to.eql([
        { isCurrent: false, kind: "label", text: "v1.0" },
        { isCurrent: false, kind: "label", text: "nightly" },
      ]);
    });

    it("offers the loaded branches and owners sorted", () => {
      expect(model.branches).to.eql([ MAIN, TASK ]);
      expect(model.owners).to.eql([ "dana.kim@example.com", "lee.park@example.com" ]);
    });

    it("colours a row by its branch", () => {
      expect(rowOf(model, 3).color).to.equal(task);
      expect(rowOf(model, 5).color).to.equal(main);
    });
  });

  context("A changeset loaded twice", () => {
    const model = buildExplorerModel({
      changesets: [ cs(2, 1, MAIN), cs(2, 1, MAIN), cs(1, -1, MAIN) ],
      currentChangesetId: 2,
      labels: [],
      merges: [ merge(1, MAIN, 2), merge(1, MAIN, 2) ],
      scope: { kind: "all" },
    });

    it("is listed once", () => {
      expect(model.rows.map(row => row.id)).to.eql([ 2, 1 ]);
      expect(model.loadedCount).to.equal(2);
    });

    it("does not draw a merge link over the parent line", () => {
      expect(pieces(rowOf(model, 2))).to.eql([[ -1, 0, main, 0 ]]);
    });
  });

  context("Scoped to selected branches", () => {
    it("shows only their changesets but still reports everything loaded", () => {
      const model = build({ branches: [TASK], kind: "branches" });
      expect(model.rows.map(row => row.id)).to.eql([3]);
      expect(model.loadedCount).to.equal(5);
      expect(model.branches).to.eql([ MAIN, TASK ]);
    });

    it("leaves a lone row without lines when none of its ancestors is shown", () => {
      const model = build({ branches: [TASK], kind: "branches" });
      expect(rowOf(model, 3).lines).to.eql([]);
    });

    it("connects what is left and drops the link to a hidden merge source", () => {
      const model = build({ branches: [MAIN], kind: "branches" });
      expect(model.rows.map(row => row.id)).to.eql([ 5, 4, 2, 1 ]);
      expect(model.laneCount).to.equal(1);
      expect(pieces(rowOf(model, 5))).to.eql([[ -1, 0, main, 0 ]]);
      // The details still say where the merge came from.
      expect(rowOf(model, 5).mergedFrom).to.eql([{ branch: TASK, id: 3, type: "merge" }]);
    });

    it("skips hidden changesets to reach the nearest shown ancestor", () => {
      const model = buildExplorerModel({
        changesets: [ cs(1, -1, MAIN), cs(2, 1, TASK), cs(3, 2, MAIN) ],
        currentChangesetId: 3,
        labels: [],
        merges: [],
        scope: { branches: [MAIN], kind: "branches" },
      });
      expect(model.rows.map(row => row.id)).to.eql([ 3, 1 ]);
      expect(pieces(rowOf(model, 3))).to.eql([[ -1, 0, main, 0 ]]);
      expect(pieces(rowOf(model, 1))).to.eql([[ 0, -1, main, 0 ]]);
    });

    it("shows nothing for a branch without loaded changesets", () => {
      expect(build({ branches: ["/main/unknown"], kind: "branches" }).rows).to.eql([]);
    });
  });

  context("Scoped to the current branch", () => {
    it("follows parents and merges from the workspace's changeset", () => {
      const model = build({ kind: "current" });
      expect(model.rows.map(row => row.id)).to.eql([ 5, 4, 3, 2, 1 ]);
    });

    it("leaves out what the workspace's branch does not descend from", () => {
      const model = build({ kind: "current" }, { currentBranch: TASK, currentChangesetId: 3 });
      expect(model.rows.map(row => row.id)).to.eql([ 3, 2, 1 ]);
    });

    it("includes the branch head when the workspace is behind it", () => {
      const model = build({ kind: "current" }, { currentBranch: MAIN, currentChangesetId: 2 });
      expect(model.rows.map(row => row.id)).to.eql([ 5, 4, 3, 2, 1 ]);
    });

    it("starts from the changeset alone when the workspace is not on a branch", () => {
      const model = build({ kind: "current" }, { currentBranch: undefined, currentChangesetId: 4 });
      expect(model.rows.map(row => row.id)).to.eql([ 4, 2, 1 ]);
    });
  });

  context("Lane reuse", () => {
    // Two short side branches, one after the other, both merged back.
    const model = buildExplorerModel({
      changesets: [
        cs(1, -1, MAIN), cs(2, 1, "/main/a"), cs(3, 1, MAIN), cs(4, 3, "/main/b"), cs(5, 3, MAIN),
      ],
      currentChangesetId: 5,
      labels: [],
      merges: [],
      scope: { kind: "all" },
    });

    it("hands a freed lane to the next branch instead of widening the graph", () => {
      expect(rowOf(model, 4).lane).to.equal(1);
      expect(rowOf(model, 2).lane).to.equal(1);
      expect(model.laneCount).to.equal(2);
    });
  });

  describe("branchColor", () => {
    it("stays inside the palette and is stable", () => {
      for (const branch of [ MAIN, TASK, "", "/main/Engine 2019.4.19f1", "/main/ünïcode" ]) {
        const color = branchColor(branch);
        expect(color).to.be.within(0, EXPLORER_PALETTE_SIZE - 1);
        expect(branchColor(branch)).to.equal(color);
      }
    });
  });

  describe("toFlatExplorerRow", () => {
    it("makes a row without graph, refs or merge sources", () => {
      const row = toFlatExplorerRow(cs(7, 6, TASK), 7);
      expect(row).to.include({ branch: TASK, id: 7, isCurrent: true, lane: 0, parentId: 6, subject: "Changeset 7" });
      expect(row.lines).to.eql([]);
      expect(row.refs).to.eql([]);
      expect(row.mergedFrom).to.eql([]);
      expect(toFlatExplorerRow(cs(7, 6, TASK), 8).isCurrent).to.equal(false);
    });
  });
});
