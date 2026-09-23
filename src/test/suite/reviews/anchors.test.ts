import { comment, file } from "./fixtures";
import {
  fileKey, groupReviewThreads, IReviewComparison, isPhantomChange, sameRepository,
} from "../../../reviews/models";
import { mapReviewLine, splitLines } from "../../../reviews/anchors";
import { expect } from "chai";
import { FileChangeStatus } from "../../../models";
import { reviewDiff } from "../../../reviews/reviewEditors";

describe("Review anchors and comparisons", () => {
  const source = "one\ntwo\nthree\nfour\nfive\nsix\nseven";
  const comparison: IReviewComparison = { files: [], id: "snapshot", kind: "final", label: "cs:1 ↔ cs:2" };

  it("maps the first line and nothing past the last", () => {
    expect(mapReviewLine(source, source, 0)).to.equal(0);
    expect(mapReviewLine(source, source, 50)).to.equal(undefined);
  });

  it("maps an unchanged block after inserted lines", () => {
    expect(mapReviewLine(source, "new\nnewer\n" + source, 3)).to.equal(5);
  });

  it("maps through line-ending changes", () => {
    expect(mapReviewLine(source, source.replace(/\n/g, "\r\n"), 3)).to.equal(3);
  });

  it("splits lines like VS Code, a lone carriage return included", () => {
    expect(splitLines("a\r\nb\nc\rd")).to.deep.equal([ "a", "b", "c", "d" ]);
    expect(splitLines("")).to.deep.equal([""]);
    expect(splitLines("last\n")).to.deep.equal([ "last", "" ]);
    const classicMac = source.replace(/\n/g, "\r");
    expect(splitLines(classicMac)).to.have.length(7);
    expect(mapReviewLine(classicMac, classicMac, 5)).to.equal(5);
    expect(mapReviewLine(classicMac, "new\r" + classicMac, 3)).to.equal(4);
  });

  it("rejects rewritten, deleted, and ambiguous contexts", () => {
    expect(mapReviewLine(source, source.replace("four", "changed"), 3)).to.equal(undefined);
    expect(mapReviewLine(source, source.replace("four\n", ""), 3)).to.equal(undefined);
    expect(mapReviewLine(source, source + "\n" + source, 3)).to.equal(undefined);
    expect(mapReviewLine(source + "\n" + source, source, 3)).to.equal(undefined);
  });

  it("groups replies, conversations, orphans and cycles without dropping comments", () => {
    const threads = groupReviewThreads([
      comment(),
      comment({ id: 2, parentId: 1 }),
      comment({ id: 3, location: -1, revisionId: -1, type: "conversation" }),
      comment({ id: 4, parentId: 99 }),
    ]);
    expect(threads.map(thread => thread.comments.map(item => item.id))).to.deep.equal([[ 1, 2 ], [3], [4]]);
    expect(threads.map(thread => thread.kind)).to.deep.equal([ "question", "conversation", "question" ]);
    expect(groupReviewThreads([ comment({ id: 1, parentId: 2 }), comment({ id: 2, parentId: 1 }) ])).to.have.length(1);
  });

  it("anchors a thread on its first located comment and sorts replies by date", () => {
    const threads = groupReviewThreads([
      comment({ id: 10, location: -1, revisionId: -1 }),
      comment({ date: "2026-09-03T00:00:00Z", id: 12, location: 7, parentId: 10, revisionId: 44 }),
      comment({ date: "2026-09-02T00:00:00Z", id: 11, parentId: 10 }),
    ]);
    expect(threads[0].comments.map(item => item.id)).to.deep.equal([ 10, 11, 12 ]);
    expect(threads[0].anchor.id).to.equal(11);
  });

  it("recognises phantom merge rows and nothing else", () => {
    expect(isPhantomChange(file({ baseRevisionId: -1, parentRevisionId: -1 }))).to.equal(true);
    expect(isPhantomChange(file())).to.equal(false);
    expect(isPhantomChange(file({ baseRevisionId: -1, parentRevisionId: 9 }))).to.equal(false);
    expect(isPhantomChange(file({ baseRevisionId: -1, parentRevisionId: -1, status: FileChangeStatus.Added })))
      .to.equal(false);
    expect(isPhantomChange(file({
      baseRevisionId: -1, oldPath: "/Old.cs", parentRevisionId: -1, status: FileChangeStatus.Moved,
    }))).to.equal(false);
    expect(isPhantomChange(file({
      baseRevisionId: -1, parentRevisionId: -1, status: FileChangeStatus.Changed | FileChangeStatus.Moved,
    }))).to.equal(false);
  });

  it("compares repositories by name, across server aliases", () => {
    expect(sameRepository("Nimbus/Nimbus@acme-studio@unity", "nimbus/Nimbus@1234567890123@cloud"))
      .to.equal(true);
    expect(sameRepository("Nimbus/Nimbus@acme-studio@unity", "Shared/Libs@acme-studio@unity"))
      .to.equal(false);
    expect(sameRepository("repo", "repo@org@cloud")).to.equal(true);
  });

  it("keys a diff row by path and revision", () => {
    expect(fileKey(file())).to.equal("[\"/Code/Test.cs\",11]");
    expect(fileKey(file({ revisionId: 12 }))).not.to.equal(fileKey(file()));
  });

  it("uses base revision rather than previous revision for merge diffs", () => {
    const diff = reviewDiff("wk", 5, comparison, file());
    expect(diff.left.revisionId).to.equal(10);
    expect(diff.right.revisionId).to.equal(11);
  });

  it("handles added, deleted, and purely renamed files", () => {
    const added = reviewDiff("wk", 5, comparison, file({ status: FileChangeStatus.Added }));
    const deleted = reviewDiff("wk", 5, comparison, file({ status: FileChangeStatus.Deleted }));
    const moved = reviewDiff(
      "wk",
      5,
      comparison,
      file({ baseRevisionId: -1, oldPath: "/Old.cs", status: FileChangeStatus.Moved }),
    );
    expect(added.left.revisionId).to.equal(-1);
    expect(deleted.left.revisionId).to.equal(11);
    expect(deleted.right.revisionId).to.equal(-1);
    expect(moved.left.revisionId).to.equal(11);
    expect(moved.left.uri.path).to.equal("/Old.cs");
  });

  it("isolates threads across workspaces, reviews, snapshots, sides and repositories", () => {
    const uris = [
      reviewDiff("wk", 5, comparison, file()).right.uri,
      reviewDiff("wk", 6, comparison, file()).right.uri,
      reviewDiff("wk2", 5, comparison, file()).right.uri,
      reviewDiff("wk", 5, { ...comparison, id: "b" }, file()).right.uri,
      reviewDiff("wk", 5, comparison, file({ repository: "other" })).right.uri,
      reviewDiff("wk", 5, comparison, file()).left.uri,
    ];
    expect(new Set(uris.map(uri => uri.toString())).size).to.equal(6);
  });
});
