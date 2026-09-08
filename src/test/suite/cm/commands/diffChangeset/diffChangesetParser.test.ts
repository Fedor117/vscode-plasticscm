import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../../../models";
import { DiffChangesetParser } from "../../../../../cm/commands/diffChangeset/diffChangesetParser";
import { expect } from "chai";

const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";

interface IRecordFields {
  base?: string;
  destinationPath?: string;
  parent?: string;
  path: string;
  revision: string;
  sourcePath?: string;
  status: string;
  type: string;
}

/** Prints a record the way `cm diff --format` does: paths quoted, empty ones as `""`. */
function record(fields: IRecordFields): string[] {
  return [
    `S:${fields.status}`,
    `T:${fields.type}`,
    `P:"${fields.path}"`,
    `R:${fields.revision}`,
    `PR:${fields.parent ?? "-1"}`,
    `B:${fields.base ?? "-1"}`,
    `SP:"${fields.sourcePath ?? ""}"`,
    `DP:"${fields.destinationPath ?? ""}"`,
    `RP:"${REPOSITORY}"`,
  ];
}

const BANNER = "/Assets/Code/Racing/UI/UILapTimeBanner.cs";
const BANNER_OLD = "/Assets/Code/Racing/UI/UISlowLapWarning.cs";

/** A made-up `cm diff cs:3624` sample: a moved+changed file, a pure move, deletes, adds and a directory. */
const SAMPLE_OUTPUT: string[] = [
  ...record({ base: "11593", parent: "11593", path: BANNER, revision: "12347", status: "C", type: "F" }),
  ...record({
    destinationPath: BANNER, parent: "11593", path: BANNER, revision: "12347",
    sourcePath: BANNER_OLD, status: "M", type: "F",
  }),
  ...record({
    destinationPath: `${BANNER}.meta`, path: `${BANNER}.meta`, revision: "5631",
    sourcePath: `${BANNER_OLD}.meta`, status: "M", type: "F",
  }),
  ...record({
    path: "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs", revision: "11586", status: "D", type: "F",
  }),
  ...record({
    parent: "10231", path: "/Jenkinsfile_track_import", revision: "10301", status: "D", type: "F",
  }),
  ...record({ path: "/Assets/Art/Race UI/Icons/Icon_Pit_Alert.png", revision: "12344", status: "A", type: "B" }),
  ...record({
    parent: "11401", path: "/Assets/AddressableAssetsData/AssetGroups/TrackSkin_Dunes.asset",
    revision: "11751", status: "A", type: "F",
  }),
  ...record({ path: "/JSON/Seasons", revision: "12221", status: "A", type: "D" }),
];

interface IParseOutcome {
  error: Error | undefined;
  outputLines: string[];
  result: IChangesetFileChange[] | undefined;
}

async function parseLines(stdout: string[], stderr: string[] = []): Promise<IParseOutcome> {
  const parser = new DiffChangesetParser();
  stdout.forEach(line => parser.readLineOut(line));
  stderr.forEach(line => parser.readLineErr(line));
  const result = await parser.parse();
  return {
    error: parser.getError(),
    outputLines: parser.getOutputLines(),
    result,
  };
}

function byPath(outcome: IParseOutcome, path: string): IChangesetFileChange {
  const found = outcome.result!.filter(change => change.path === path);
  expect(found, `exactly one row for ${path}`).to.have.lengthOf(1);
  return found[0];
}

describe("DiffChangeset Parser", () => {
  context("When there is no input", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([]);
    });

    it("produces an empty list without error", () => {
      expect(outcome.result).to.eql([]);
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When parsing the sample", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(SAMPLE_OUTPUT);
    });

    it("folds the moved+changed pair, keeping the other seven rows", () => {
      expect(outcome.result).to.have.lengthOf(7);
    });

    it("sorts by path ignoring case", () => {
      expect(outcome.result!.map(change => change.path)).to.eql([
        "/Assets/AddressableAssetsData/AssetGroups/TrackSkin_Dunes.asset",
        "/Assets/Art/Race UI/Icons/Icon_Pit_Alert.png",
        "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs",
        BANNER,
        `${BANNER}.meta`,
        "/Jenkinsfile_track_import",
        "/JSON/Seasons",
      ]);
    });

    it("merges the moved+changed file into one Changed|Moved row with the real base", () => {
      expect(byPath(outcome, BANNER)).to.eql({
        baseRevisionId: 11593,
        oldPath: BANNER_OLD,
        parentRevisionId: 11593,
        path: BANNER,
        repository: REPOSITORY,
        revisionId: 12347,
        revisionType: RevisionType.TextFile,
        status: FileChangeStatus.Changed | FileChangeStatus.Moved,
      });
    });

    it("keeps a pure move as Moved with -1 base and parent", () => {
      expect(byPath(outcome, `${BANNER}.meta`)).to.eql({
        baseRevisionId: -1,
        oldPath: `${BANNER_OLD}.meta`,
        parentRevisionId: -1,
        path: `${BANNER}.meta`,
        repository: REPOSITORY,
        revisionId: 5631,
        revisionType: RevisionType.TextFile,
        status: FileChangeStatus.Moved,
      });
    });

    it("reads a deleted file whose parent revision is unknown", () => {
      expect(byPath(outcome, "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs")).to.eql({
        baseRevisionId: -1,
        oldPath: undefined,
        parentRevisionId: -1,
        path: "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs",
        repository: REPOSITORY,
        revisionId: 11586,
        revisionType: RevisionType.TextFile,
        status: FileChangeStatus.Deleted,
      });
    });

    it("keeps the parent revision of a deleted file when cm reports one", () => {
      const deleted = byPath(outcome, "/Jenkinsfile_track_import");
      expect(deleted.status).to.equal(FileChangeStatus.Deleted);
      expect(deleted.revisionId).to.equal(10301);
      expect(deleted.parentRevisionId).to.equal(10231);
      expect(deleted.baseRevisionId).to.equal(-1);
    });

    it("reads an added binary file with a path containing spaces", () => {
      expect(byPath(outcome, "/Assets/Art/Race UI/Icons/Icon_Pit_Alert.png")).to.eql({
        baseRevisionId: -1,
        oldPath: undefined,
        parentRevisionId: -1,
        path: "/Assets/Art/Race UI/Icons/Icon_Pit_Alert.png",
        repository: REPOSITORY,
        revisionId: 12344,
        revisionType: RevisionType.BinaryFile,
        status: FileChangeStatus.Added,
      });
    });

    it("keeps the parent revision of an added file when cm reports one", () => {
      const added = byPath(outcome, "/Assets/AddressableAssetsData/AssetGroups/TrackSkin_Dunes.asset");
      expect(added.status).to.equal(FileChangeStatus.Added);
      expect(added.parentRevisionId).to.equal(11401);
      expect(added.baseRevisionId).to.equal(-1);
    });

    it("keeps directory rows", () => {
      const directory = byPath(outcome, "/JSON/Seasons");
      expect(directory.revisionType).to.equal(RevisionType.Directory);
      expect(directory.status).to.equal(FileChangeStatus.Added);
      expect(directory.revisionId).to.equal(12221);
    });

    it("strips the quotes from the repository spec", () => {
      expect(outcome.result!.every(change => change.repository === REPOSITORY)).to.be.true;
    });

    it("holds the output correctly", () => {
      expect(outcome.outputLines).to.eql(SAMPLE_OUTPUT);
    });

    it("doesn't produce any error", () => {
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When the M row comes before the C row", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        ...record({
          destinationPath: BANNER, parent: "11593", path: BANNER, revision: "12347",
          sourcePath: BANNER_OLD, status: "M", type: "F",
        }),
        ...record({ base: "11593", parent: "11593", path: BANNER, revision: "12347", status: "C", type: "F" }),
      ]);
    });

    it("still folds them into one row with the old path and the real base", () => {
      expect(outcome.result).to.have.lengthOf(1);
      expect(outcome.result![0].status).to.equal(FileChangeStatus.Changed | FileChangeStatus.Moved);
      expect(outcome.result![0].oldPath).to.equal(BANNER_OLD);
      expect(outcome.result![0].baseRevisionId).to.equal(11593);
    });
  });

  context("When one path is deleted and re-added in the same changeset", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        ...record({ path: "/a.txt", revision: "10", status: "D", type: "F" }),
        ...record({ path: "/a.txt", revision: "20", status: "A", type: "F" }),
      ]);
    });

    it("keeps both rows because the revisions differ", () => {
      expect(outcome.result!.map(change => [ change.status, change.revisionId ])).to.have.deep.members([
        [ FileChangeStatus.Deleted, 10 ],
        [ FileChangeStatus.Added, 20 ],
      ]);
    });
  });

  context("When the merged pair disagrees on type", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        ...record({ path: "/a.txt", revision: "10", status: "M", type: "?" }),
        ...record({ base: "5", path: "/a.txt", revision: "10", status: "C", type: "F" }),
      ]);
    });

    it("takes the first known type", () => {
      expect(outcome.result![0].revisionType).to.equal(RevisionType.TextFile);
    });
  });

  context("When the type letter is unknown", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        ...record({ path: "/link", revision: "10", status: "A", type: "S" }),
        ...record({ path: "/xlink", revision: "11", status: "A", type: "X" }),
      ]);
    });

    it("reads it as Unknown", () => {
      expect(outcome.result!.map(change => change.revisionType))
        .to.eql([ RevisionType.Unknown, RevisionType.Unknown ]);
    });
  });

  context("When the status is blank", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(record({ path: "/a.txt", revision: "10", status: "", type: "F" }));
    });

    it("keeps the record with status None", () => {
      expect(outcome.result).to.have.lengthOf(1);
      expect(outcome.result![0].status).to.equal(FileChangeStatus.None);
      expect(outcome.result![0].path).to.equal("/a.txt");
    });
  });

  context("When the output contains stray and truncated lines", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        "Some banner cm printed",
        "R:2441",
        ...record({ path: "/keep.txt", revision: "10", status: "C", type: "F" }),
        "S:C",
        "T:F",
        'P:"/truncated.txt"',
        ...record({ path: "/also.txt", revision: "11", status: "A", type: "F" }),
        "S:D",
        "T:F",
      ]);
    });

    it("keeps only the complete records", () => {
      expect(outcome.result!.map(change => change.path)).to.eql([ "/also.txt", "/keep.txt" ]);
    });
  });

  context("When ids are not numeric", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(
        record({ base: "abc", parent: "", path: "/a.txt", revision: "x", status: "C", type: "F" }));
    });

    it("reads them as -1", () => {
      expect(outcome.result![0].revisionId).to.equal(-1);
      expect(outcome.result![0].parentRevisionId).to.equal(-1);
      expect(outcome.result![0].baseRevisionId).to.equal(-1);
    });
  });

  context("When quoting is irregular", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        "S:C", "T:F", "P:/unquoted.txt", "R:1", "PR:-1", "B:-1", 'SP:""', 'DP:""', `RP:"${REPOSITORY}"`,
        "S:C", "T:F", 'P:"/say ""hi"".txt"', "R:2", "PR:-1", "B:-1", 'SP:""', 'DP:""', `RP:"${REPOSITORY}"`,
      ]);
    });

    it("strips exactly one pair of surrounding quotes", () => {
      expect(outcome.result!.map(change => change.path)).to.eql([ '/say ""hi"".txt', "/unquoted.txt" ]);
    });
  });

  context("When paths differ only by case", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([
        ...record({ path: "/b.txt", revision: "1", status: "C", type: "F" }),
        ...record({ path: "/a.txt", revision: "2", status: "C", type: "F" }),
        ...record({ path: "/A.txt", revision: "3", status: "C", type: "F" }),
        ...record({ path: "/B.txt", revision: "4", status: "C", type: "F" }),
      ]);
    });

    it("sorts case-insensitively with a case-sensitive tiebreak", () => {
      expect(outcome.result!.map(change => change.path)).to.eql([ "/A.txt", "/a.txt", "/B.txt", "/b.txt" ]);
    });
  });

  context("When there are error lines", () => {
    const stderr = [ "error1", "error2" ];
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(record({ path: "/a.txt", revision: "1", status: "C", type: "F" }), stderr);
    });

    it("still parses the output", () => {
      expect(outcome.result).to.have.lengthOf(1);
    });

    it("produces an error with the stderr text", () => {
      expect(outcome.error).to.be.not.undefined;
      expect(outcome.error!.message).to.contain("error1");
      expect(outcome.error!.message).to.contain("error2");
    });
  });
});
