import { buildGraphModel, IGraphInput, IGraphModel, IGraphRow, ILaneInput } from "../../../history/graphModel";
import { IHistoryChangeset, IMergeLink } from "../../../models";
import { expect } from "chai";

const main = "/main";
const task = "/main/task001";
const owner = "dana.kim@example.com";

function changeset(
    id: number, branch: string, parentId: number, comment = "", changesetOwner = owner): IHistoryChangeset {
  return {
    branch,
    comment,
    date: new Date(Date.UTC(2026, 8, 1, 12, 0, id % 60)),
    guid: `guid-${id}`,
    id,
    owner: changesetOwner,
    parentId,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

function lane(branch: string, changesets: IHistoryChangeset[], extra: Partial<ILaneInput> = {}): ILaneInput {
  return { branch, changesets, hasMore: false, loading: false, ...extra };
}

function mergeLink(
    type: string,
    sourceBranch: string,
    sourceChangesetId: number,
    destinationBranch: string,
    destinationChangesetId: number): IMergeLink {
  return { destinationBranch, destinationChangesetId, sourceBranch, sourceChangesetId, type };
}

function graphInput(lanes: ILaneInput[], overrides: Partial<IGraphInput> = {}): IGraphInput {
  return {
    currentBranch: lanes[0]?.branch ?? task,
    currentChangesetId: lanes[0]?.changesets[0]?.id ?? -1,
    lanes,
    merges: [],
    ...overrides,
  };
}

function build(lanes: ILaneInput[], overrides: Partial<IGraphInput> = {}): IGraphModel {
  return buildGraphModel(graphInput(lanes, overrides));
}

function rowOf(model: IGraphModel, id: number): IGraphRow {
  const row = model.rows.find(candidate => candidate.id === id);
  expect(row, `row ${id}`).to.not.be.undefined;
  return row!;
}

function rowIndex(model: IGraphModel, id: number): number {
  return model.rows.findIndex(row => row.id === id);
}

/** Task branch forked from /main@2080; both lanes hold three changesets, /main@2080's parent is not loaded. */
function twoLanes(): ILaneInput[] {
  return [
    lane(task, [
      changeset(2085, task, 2084, "Third on task"),
      changeset(2084, task, 2083, "Second on task"),
      changeset(2083, task, 2080, "Branch point"),
    ]),
    lane(main, [
      changeset(2082, main, 2081, "Main tip"),
      changeset(2081, main, 2080),
      changeset(2080, main, 99, "Base"),
    ]),
  ];
}

describe("Graph model", () => {
  context("with two lanes and a branch point", () => {
    let model: IGraphModel;

    before(() => {
      model = build(twoLanes());
    });

    it("lists lane 0's changesets then lane 1's, newest first, without interleaving", () => {
      expect(model.rows.map(row => row.id)).to.eql([ 2085, 2084, 2083, 2082, 2081, 2080 ]);
    });

    it("assigns each row to the lane of its branch", () => {
      expect(model.rows.map(row => row.lane)).to.eql([ 0, 0, 0, 1, 1, 1 ]);
      expect(model.rows.map(row => row.branch)).to.eql([ task, task, task, main, main, main ]);
    });

    it("describes the lanes", () => {
      expect(model.lanes).to.have.length(2);
      expect(model.lanes[0]).to.include({ branch: task, count: 3, kind: "current" });
      expect(model.lanes[1]).to.include({ branch: main, count: 3, kind: "parent" });
    });

    it("marks parentLoaded from the loaded rows", () => {
      expect(model.rows.map(row => row.parentLoaded)).to.eql([ true, true, true, true, true, false ]);
    });

    it("keeps parentId as reported", () => {
      expect(model.rows.map(row => row.parentId)).to.eql([ 2084, 2083, 2080, 2081, 2080, 99 ]);
    });

    it("emits one parent link per row with a loaded parent, in row order", () => {
      expect(model.links).to.eql([
        { fromId: 2085, kind: "parent", toId: 2084 },
        { fromId: 2084, kind: "parent", toId: 2083 },
        { fromId: 2083, kind: "parent", toId: 2080 },
        { fromId: 2082, kind: "parent", toId: 2081 },
        { fromId: 2081, kind: "parent", toId: 2080 },
      ]);
    });

    it("labels lane 0's first row with the current branch", () => {
      expect(rowOf(model, 2085).labels).to.eql([{ isCurrent: true, kind: "current", text: task }]);
    });

    it("labels lane 1's first row with the parent branch", () => {
      expect(rowOf(model, 2082).labels).to.eql([{ isCurrent: false, kind: "parent", text: main }]);
    });

    it("leaves every other row unlabelled", () => {
      for (const id of [ 2084, 2083, 2081, 2080 ]) {
        expect(rowOf(model, id).labels, `labels of ${id}`).to.eql([]);
      }
    });

    it("flags only the current changeset", () => {
      expect(model.rows.filter(row => row.isCurrent).map(row => row.id)).to.eql([2085]);
      expect(model.currentLoaded).to.be.true;
    });

    it("passes comment, owner and date through", () => {
      const row = rowOf(model, 2083);
      expect(row.comment).to.equal("Branch point");
      expect(row.subject).to.equal("Branch point");
      expect(row.owner).to.equal(owner);
      expect(row.ownerShort).to.equal("dana.kim");
      expect(row.date).to.equal("2026-09-01T12:00:43.000Z");
    });
  });

  context("merge links", () => {
    it("links a merge into the current lane from the destination to the source", () => {
      const model = build(twoLanes(), { merges: [mergeLink("merge", main, 2081, task, 2084)] });

      expect(model.links).to.have.length(6);
      expect(model.links[5]).to.eql({ fromId: 2084, kind: "merge", mergeType: "merge", toId: 2081 });
    });

    it("links a merge into the parent lane with the newer endpoint rendered below the older one", () => {
      const model = build(twoLanes(), { merges: [mergeLink("merge", task, 2083, main, 2082)] });

      expect(model.links[5]).to.eql({ fromId: 2082, kind: "merge", mergeType: "merge", toId: 2083 });
      expect(rowIndex(model, 2082)).to.be.greaterThan(rowIndex(model, 2083));
    });

    it("keeps merges in both directions in input order after the parent links", () => {
      const model = build(twoLanes(), {
        merges: [
          mergeLink("merge", task, 2083, main, 2082),
          mergeLink("merge", main, 2081, task, 2084),
        ],
      });

      expect(model.links.slice(5)).to.eql([
        { fromId: 2082, kind: "merge", mergeType: "merge", toId: 2083 },
        { fromId: 2084, kind: "merge", mergeType: "merge", toId: 2081 },
      ]);
    });

    it("passes the merge type through unchanged", () => {
      const model = build(twoLanes(), { merges: [mergeLink("cherrypick", main, 2081, task, 2085)] });

      expect(model.links[5].mergeType).to.equal("cherrypick");
    });

    it("skips a merge whose endpoints are on the same lane", () => {
      const model = build(twoLanes(), { merges: [mergeLink("cherrypicksubtractive", main, 2080, main, 2082)] });

      expect(model.links.filter(link => link.kind === "merge")).to.eql([]);
    });

    it("skips a merge whose source is not loaded", () => {
      const model = build(twoLanes(), { merges: [mergeLink("merge", main, 50, task, 2085)] });

      expect(model.links.filter(link => link.kind === "merge")).to.eql([]);
    });

    it("skips a merge whose destination is not loaded", () => {
      const model = build(twoLanes(), { merges: [mergeLink("merge", task, 2085, main, 2241)] });

      expect(model.links.filter(link => link.kind === "merge")).to.eql([]);
    });

    it("skips a merge that duplicates a parent link", () => {
      const model = build(twoLanes(), { merges: [mergeLink("merge", main, 2080, task, 2083)] });

      expect(model.links).to.have.length(5);
      expect(model.links.filter(link => link.kind === "merge")).to.eql([]);
    });

    it("keeps only the first of two identical merge links", () => {
      const model = build(twoLanes(), {
        merges: [
          mergeLink("merge", main, 2081, task, 2084),
          mergeLink("cherrypick", main, 2081, task, 2084),
        ],
      });

      expect(model.links.filter(link => link.kind === "merge")).to.eql([
        { fromId: 2084, kind: "merge", mergeType: "merge", toId: 2081 },
      ]);
    });

    it("ignores merges entirely when only one lane is loaded", () => {
      const model = build([twoLanes()[1]], { merges: [mergeLink("merge", main, 2080, main, 2082)] });

      expect(model.links.filter(link => link.kind === "merge")).to.eql([]);
    });
  });

  context("when lane 0 has no changesets", () => {
    const newBranch = "/main/fresh";

    it("moves the current label to the current changeset on the parent lane", () => {
      const model = build([ lane(newBranch, []), twoLanes()[1] ], { currentChangesetId: 2081 });

      expect(rowOf(model, 2081).labels).to.eql([{ isCurrent: true, kind: "current", text: newBranch }]);
      expect(rowOf(model, 2082).labels).to.eql([{ isCurrent: false, kind: "parent", text: main }]);
      expect(rowOf(model, 2080).labels).to.eql([]);
      expect(model.currentLoaded).to.be.true;
      expect(model.lanes[0]).to.include({ branch: newBranch, count: 0, kind: "current" });
      expect(model.lanes[1]).to.include({ branch: main, count: 3, kind: "parent" });
    });

    it("puts the current label before the parent label when both land on one row", () => {
      const model = build([ lane(newBranch, []), twoLanes()[1] ], { currentChangesetId: 2082 });

      expect(rowOf(model, 2082).labels).to.eql([
        { isCurrent: true, kind: "current", text: newBranch },
        { isCurrent: true, kind: "parent", text: main },
      ]);
    });

    it("shows no current label when the current changeset is not loaded", () => {
      const model = build([ lane(newBranch, []), twoLanes()[1] ], { currentChangesetId: 42 });

      expect(model.rows.flatMap(row => row.labels).filter(label => label.kind === "current")).to.eql([]);
      expect(model.currentLoaded).to.be.false;
    });

    it("yields an empty model when neither lane has changesets", () => {
      const model = build([ lane(newBranch, []), lane(main, []) ], { currentChangesetId: 7 });

      expect(model.rows).to.eql([]);
      expect(model.links).to.eql([]);
      expect(model.currentLoaded).to.be.false;
      expect(model.lanes.map(candidate => candidate.count)).to.eql([ 0, 0 ]);
    });
  });

  context("duplicate ids", () => {
    it("keeps the first occurrence when both lanes report the same changeset", () => {
      const lanes = twoLanes();
      lanes[1].changesets.push(changeset(2083, task, 2080, "Branch point"));
      const model = build(lanes);

      expect(model.rows.map(row => row.id)).to.eql([ 2085, 2084, 2083, 2082, 2081, 2080 ]);
      expect(rowOf(model, 2083).lane).to.equal(0);
      expect(model.lanes.map(candidate => candidate.count)).to.eql([ 3, 3 ]);
      expect(model.links.filter(link => link.fromId === 2083)).to.have.length(1);
    });

    it("keeps the first occurrence when one lane repeats a changeset", () => {
      const lanes = twoLanes();
      lanes[0].changesets.push(changeset(2084, task, 2083, "Repeated"));
      const model = build(lanes);

      expect(model.rows.map(row => row.id)).to.eql([ 2085, 2084, 2083, 2082, 2081, 2080 ]);
      expect(rowOf(model, 2084).comment).to.equal("Second on task");
      expect(model.lanes[0].count).to.equal(3);
    });
  });

  context("lane assignment", () => {
    it("places a changeset on the lane whose branch matches, not the lane it was fetched in", () => {
      const lanes = twoLanes();
      lanes[1].changesets.push(changeset(90, task, 89, "Stray"));
      const model = build(lanes);

      expect(rowOf(model, 90).lane).to.equal(0);
      expect(model.lanes.map(candidate => candidate.count)).to.eql([ 4, 3 ]);
    });

    it("falls back to the fetching lane when no lane has the changeset's branch", () => {
      const lanes = twoLanes();
      lanes[1].changesets.push(changeset(90, "/main/elsewhere", 89, "Foreign"));
      const model = build(lanes);

      expect(rowOf(model, 90).lane).to.equal(1);
      expect(model.lanes.map(candidate => candidate.count)).to.eql([ 3, 4 ]);
    });
  });

  context("with a single lane", () => {
    let model: IGraphModel;

    before(() => {
      model = build([twoLanes()[1]], { currentBranch: main, currentChangesetId: 2082 });
    });

    it("describes one current lane", () => {
      expect(model.lanes).to.have.length(1);
      expect(model.lanes[0]).to.include({ branch: main, count: 3, kind: "current" });
    });

    it("labels the first row with the current branch and nothing else", () => {
      expect(rowOf(model, 2082).labels).to.eql([{ isCurrent: true, kind: "current", text: main }]);
      expect(model.rows.flatMap(row => row.labels)).to.have.length(1);
    });

    it("points the oldest row's dangling tail at its own lane because there is no parent lane", () => {
      const root = rowOf(model, 2080);
      expect(root.parentLoaded).to.be.false;
      expect(root.parentLane).to.equal(0);
    });

    it("links the remaining rows to their parents", () => {
      expect(model.links).to.eql([
        { fromId: 2082, kind: "parent", toId: 2081 },
        { fromId: 2081, kind: "parent", toId: 2080 },
      ]);
    });
  });

  context("parentLane", () => {
    it("is the parent's actual lane when the parent is loaded", () => {
      const model = build(twoLanes());

      expect(rowOf(model, 2083).parentLane).to.equal(1);
      expect(rowOf(model, 2085).parentLane).to.equal(0);
      expect(rowOf(model, 2082).parentLane).to.equal(1);
    });

    it("is lane 1 for lane 0's oldest row when its parent is not loaded", () => {
      const lanes = twoLanes();
      lanes[1].changesets.pop();
      const model = build(lanes);

      const fork = rowOf(model, 2083);
      expect(fork.parentLoaded).to.be.false;
      expect(fork.parentLane).to.equal(1);
    });

    it("is -1 for the repository root", () => {
      const lanes = twoLanes();
      lanes[1].changesets.push(changeset(0, main, -1, "Root"));
      const model = build(lanes);

      const root = rowOf(model, 0);
      expect(root.parentLoaded).to.be.false;
      expect(root.parentLane).to.equal(-1);
    });

    it("is -1 for lane 0's oldest row when it is the repository root", () => {
      const model = build([lane(main, [ changeset(1, main, 0), changeset(0, main, -1) ])], { currentBranch: main });

      expect(rowOf(model, 0).parentLane).to.equal(-1);
    });

    it("is the row's own lane for a newer lane 0 row whose parent is missing", () => {
      const lanes = twoLanes();
      lanes[0].changesets.splice(1, 1);
      const model = build(lanes);

      const orphan = rowOf(model, 2085);
      expect(orphan.parentLoaded).to.be.false;
      expect(orphan.parentLane).to.equal(0);
    });

    it("is lane 1 for lane 1's oldest row when its parent is not loaded", () => {
      const model = build(twoLanes());

      expect(rowOf(model, 2080).parentLane).to.equal(1);
    });
  });

  context("hasNewer", () => {
    const cases: Array<{
      head: number | undefined; changesets: IHistoryChangeset[]; expected: boolean; name: string;
    }> = [
      { changesets: [changeset(2082, main, 2081)], expected: true, head: 2203, name: "head newer than the first row" },
      { changesets: [changeset(2082, main, 2081)], expected: false, head: 2082, name: "head equal to the first row" },
      { changesets: [changeset(2082, main, 2081)], expected: false, head: 90, name: "head older than the first row" },
      { changesets: [changeset(2082, main, 2081)], expected: false, head: undefined, name: "head unknown" },
      { changesets: [], expected: false, head: 2203, name: "no changesets loaded" },
    ];

    for (const testCase of cases) {
      it(`is ${testCase.expected} when ${testCase.name}`, () => {
        const model = build([lane(main, testCase.changesets, { headChangesetId: testCase.head })]);

        expect(model.lanes[0].hasNewer).to.equal(testCase.expected);
      });
    }

    it("is evaluated per lane", () => {
      const lanes = twoLanes();
      lanes[0] = { ...lanes[0], headChangesetId: 2085 };
      lanes[1] = { ...lanes[1], headChangesetId: 2221 };
      const model = build(lanes);

      expect(model.lanes.map(candidate => candidate.hasNewer)).to.eql([ false, true ]);
    });
  });

  context("lane state passthrough", () => {
    it("copies hasMore, loading and error", () => {
      const model = build([
        lane(task, [changeset(2085, task, 2084)], { hasMore: true, loading: true }),
        lane(main, [], { error: "cm exploded" }),
      ]);

      expect(model.lanes[0]).to.include({ error: undefined, hasMore: true, loading: true });
      expect(model.lanes[1]).to.include({ error: "cm exploded", hasMore: false, loading: false });
    });
  });

  context("currentLoaded", () => {
    it("is true when the current changeset is on the parent lane", () => {
      const model = build(twoLanes(), { currentChangesetId: 2081 });

      expect(model.currentLoaded).to.be.true;
      expect(rowOf(model, 2081).isCurrent).to.be.true;
      expect(rowOf(model, 2085).isCurrent).to.be.false;
    });

    it("is false when the current changeset is older than the loaded history", () => {
      const model = build(twoLanes(), { currentChangesetId: 12 });

      expect(model.currentLoaded).to.be.false;
      expect(model.rows.some(row => row.isCurrent)).to.be.false;
    });

    it("is false when the workspace has no changeset", () => {
      const model = build(twoLanes(), { currentChangesetId: -1 });

      expect(model.currentLoaded).to.be.false;
    });

    it("reports isCurrent on the label of a current row without the current pill", () => {
      const model = build(twoLanes(), { currentChangesetId: 2082 });

      expect(rowOf(model, 2082).labels).to.eql([{ isCurrent: true, kind: "parent", text: main }]);
      expect(rowOf(model, 2085).labels).to.eql([{ isCurrent: false, kind: "current", text: task }]);
    });
  });

  context("subject", () => {
    const cases: Array<[string, string, string]> = [
      [ "a single line", "Fix thing", "Fix thing" ],
      [ "surrounding whitespace", "  Fix thing  ", "Fix thing" ],
      [ "leading blank lines", "\n\n  Fix thing  \nsecond line", "Fix thing" ],
      [ "CRLF line breaks", "\r\n\r\nFix thing\r\nsecond line", "Fix thing" ],
      [ "a bare CR line break", "Fix thing\rsecond line", "Fix thing" ],
      [ "a whitespace-only first line", " \t \nFix thing", "Fix thing" ],
      [ "only whitespace", "  \n\t\r\n", "" ],
      [ "an empty comment", "", "" ],
    ];

    for (const [ name, comment, expected ] of cases) {
      it(`takes the first non-empty line from ${name}`, () => {
        const model = build([lane(main, [changeset(2082, main, 2081, comment)])]);

        expect(model.rows[0].subject).to.equal(expected);
        expect(model.rows[0].comment).to.equal(comment);
      });
    }
  });

  context("ownerShort", () => {
    const cases: Array<[string, string]> = [
      [ "dana.kim@example.com", "dana.kim" ],
      [ "name@host@cloud", "name" ],
      [ "plainuser", "plainuser" ],
      [ "@leading", "" ],
      [ "", "" ],
    ];

    for (const [ ownerName, expected ] of cases) {
      it(`shortens "${ownerName}" to "${expected}"`, () => {
        const model = build([lane(main, [changeset(2082, main, 2081, "", ownerName)])]);

        expect(model.rows[0].ownerShort).to.equal(expected);
        expect(model.rows[0].owner).to.equal(ownerName);
      });
    }
  });

  context("date", () => {
    it("is the ISO 8601 form of the changeset date", () => {
      const model = build([
        lane(main, [{ ...changeset(2082, main, 2081), date: new Date("2026-09-07T16:56:14+01:00") }]),
      ]);

      expect(model.rows[0].date).to.equal("2026-09-07T15:56:14.000Z");
    });

    it("falls back to the epoch for an invalid date instead of throwing", () => {
      const model = build([lane(main, [{ ...changeset(2082, main, 2081), date: new Date("not a date") }])]);

      expect(model.rows[0].date).to.equal("1970-01-01T00:00:00.000Z");
    });
  });

  context("with no lanes", () => {
    it("produces an empty model", () => {
      const model = buildGraphModel({ currentBranch: task, currentChangesetId: 5, lanes: [], merges: [] });

      expect(model).to.eql({ currentLoaded: false, lanes: [], links: [], rows: [] });
    });
  });

  context("purity", () => {
    it("does not mutate its input", () => {
      const input = graphInput(twoLanes(), {
        currentChangesetId: 2081,
        merges: [ mergeLink("merge", main, 2081, task, 2084), mergeLink("merge", main, 2080, main, 2082) ],
      });
      const snapshot = JSON.stringify(input);

      buildGraphModel(input);

      expect(JSON.stringify(input)).to.equal(snapshot);
    });

    it("is deterministic", () => {
      const input = graphInput(twoLanes(), { merges: [mergeLink("merge", task, 2083, main, 2082)] });

      expect(buildGraphModel(input)).to.eql(buildGraphModel(input));
    });
  });
});
