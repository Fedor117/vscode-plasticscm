import { MERGE_FIELD_SEPARATOR, parseConflictMarkerLines, parseMergeLines } from "../../../../../cm/commands";
import { expect } from "chai";

/** Lines as cm 11.0.16 printed them with `--fieldseparator=|`, rewritten with the separator the extension passes. */
function cm(...lines: string[]): string[] {
  return lines.map(line => line.split("|").join(MERGE_FIELD_SEPARATOR));
}

describe("parseMergeLines", () => {
  it("counts what comes from the merged branch only", () => {
    const report = parseMergeLines(cm(
      "FILE_SRC|/a.txt|1|3|17",
      "FILE_SRC|/dir with space/d.txt|1|3|21",
      "APPLY|ADD|/c.txt",
      "APPLY|RM|/del.txt",
      "APPLY|MV|/mv.txt|/moved.txt"));

    expect(report).to.eql({
      applied: 0,
      changedOnBoth: [],
      directoryConflicts: [],
      incoming: 5,
      nothingToMerge: undefined,
      other: [],
      unresolved: [],
    });
  });

  it("names the files changed on both branches, spaces included", () => {
    const report = parseMergeLines(cm("FILE_CONFLICT|/b.txt|1|4|5|18", "FILE_CONFLICT|/dir with space/d.txt|1|4|5|2"));
    expect(report.changedOnBoth).to.eql([ "/b.txt", "/dir with space/d.txt" ]);
    expect(report.incoming).to.equal(0);
  });

  it("reads a directory conflict", () => {
    const report = parseMergeLines(cm(
      "DIR_CONFLICT|EVIL|Evil twin conflict|An item has been added on the source and on the destination " +
      "with the same name, and they are different items.|Added /twin.txt|Added /twin.txt|60|False|" +
      "ADD|/twin.txt|ADD|/twin.txt",
      "FILE_SRC|/del.txt|6|8|46"));

    expect(report.directoryConflicts).to.eql([
      { destination: "Added /twin.txt", source: "Added /twin.txt", title: "Evil twin conflict", type: "EVIL" },
    ]);
    expect(report.incoming).to.equal(1);
  });

  it("reads cm's words when there is nothing to merge", () => {
    expect(parseMergeLines(cm("STATUS|ALREADY_CONNECTED|No merges detected")).nothingToMerge)
      .to.equal("No merges detected");
    expect(parseMergeLines(cm("STATUS|SOMETHING")).nothingToMerge).to.equal("SOMETHING");
  });

  it("separates what a merge did from what it left unresolved", () => {
    const report = parseMergeLines(cm(
      "FILE_CONFLICT|/b.txt|1|4|5|18",
      "DO_MERGE|/private/tmp/wk/b.txt",
      "DO_DELETED|/private/tmp/wk/del.txt",
      "CONFLICT_MARKERS|/b.txt",
      "UNRESOLVED|/logo.png|binary",
      "UNRESOLVED|/link"));

    expect(report.applied).to.equal(2);
    expect(report.unresolved).to.eql([
      { path: "/b.txt", reason: "markers" },
      { path: "/logo.png", reason: "binary" },
      { path: "/link", reason: "unknown" },
    ]);
  });

  it("keeps lines of an unknown kind and skips blank ones", () => {
    const report = parseMergeLines([ "", "  ", "Error: Object reference not set to an instance of an object." ]);
    expect(report.other).to.eql(["Error: Object reference not set to an instance of an object."]);
  });
});

describe("parseConflictMarkerLines", () => {
  it("reads the paths cm lists, spaces included, and nothing else", () => {
    expect(parseConflictMarkerLines([
      "CONFLICT_MARKERS /b.txt",
      "CONFLICT_MARKERS /dir with space/d.txt",
      "",
      "Error: something",
    ])).to.eql([ "/b.txt", "/dir with space/d.txt" ]);
    expect(parseConflictMarkerLines([])).to.eql([]);
  });
});
