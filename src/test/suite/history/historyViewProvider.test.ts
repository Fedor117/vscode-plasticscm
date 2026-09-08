import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../models";
import { findFileChange, toFileRow } from "../../../history/historyViewProvider";
import { expect } from "chai";

function change(overrides: Partial<IChangesetFileChange> = {}): IChangesetFileChange {
  return {
    baseRevisionId: 10,
    parentRevisionId: 10,
    path: "/Assets/Foo.cs",
    repository: "rep@server",
    revisionId: 11,
    revisionType: RevisionType.TextFile,
    status: FileChangeStatus.Changed,
    ...overrides,
  };
}

describe("findFileChange", () => {
  const deleted = change({ revisionId: 41, status: FileChangeStatus.Deleted });
  const added = change({ baseRevisionId: -1, parentRevisionId: -1, revisionId: 42, status: FileChangeStatus.Added });
  const files = [ deleted, added ];

  it("picks the record the revision id names, not the first one sharing the path", () => {
    expect(findFileChange(files, "/Assets/Foo.cs", 42)).to.equal(added);
    expect(findFileChange(files, "/Assets/Foo.cs", 41)).to.equal(deleted);
  });

  it("falls back to the path when no revision id is given, as an old webview sends", () => {
    expect(findFileChange(files, "/Assets/Foo.cs")).to.equal(deleted);
  });

  it("falls back to the path when the revision id no longer matches a reloaded list", () => {
    expect(findFileChange(files, "/Assets/Foo.cs", 2441)).to.equal(deleted);
  });

  it("returns undefined for a path the changeset does not carry", () => {
    expect(findFileChange(files, "/Assets/Bar.cs", 42)).to.be.undefined;
  });
});

describe("toFileRow", () => {
  it("carries the revision id so the row can be addressed unambiguously", () => {
    expect(toFileRow(change({ revisionId: 77 })).revisionId).to.equal(77);
  });

  it("splits the server path into a name and a directory", () => {
    const row = toFileRow(change({ path: "/Assets/Code/Boot.cs" }));

    expect(row.name).to.equal("Boot.cs");
    expect(row.directory).to.equal("Assets/Code");
  });

  it("marks a text file with content changes as diffable", () => {
    const row = toFileRow(change());

    expect(row.canDiff).to.be.true;
    expect(row.status).to.equal("C");
    expect(row.reason).to.be.undefined;
  });

  it("spells a moved and edited file with both letters", () => {
    const row = toFileRow(change({
      oldPath: "/Assets/Old.cs",
      status: FileChangeStatus.Changed | FileChangeStatus.Moved,
    }));

    expect(row.status).to.equal("CM");
    expect(row.statusTooltip).to.equal("Changed, moved from /Assets/Old.cs");
  });

  it("explains why a binary file has no diff", () => {
    const row = toFileRow(change({ revisionType: RevisionType.BinaryFile }));

    expect(row.canDiff).to.be.false;
    expect(row.reason).to.equal("Binary file: no text diff");
  });

  it("leaves the directory empty at the repository root", () => {
    expect(toFileRow(change({ path: "/Foo.cs" })).directory).to.equal("");
  });
});
