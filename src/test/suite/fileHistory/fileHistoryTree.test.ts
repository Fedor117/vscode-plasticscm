import {
  describeRevisionDiff,
  describeWorkspaceDiff,
  FILE_REVISION_CONTEXT,
  hasTextContent,
  IFileHistoryTarget,
  isRevisionNode,
  revisionItem,
  toRevisionNodes,
} from "../../../fileHistory/fileHistoryTree";
import { describeRevert } from "../../../commands/fileHistory";
import { expect } from "chai";
import { IFileRevision } from "../../../models";
import { parseRevisionQuery } from "../../../revisionContentProvider";
import { Uri } from "vscode";

function revision(changesetId: number, type = "txt"): IFileRevision {
  return {
    branch: "/main",
    changesetId,
    comment: "Tune the jump\n\nlonger body",
    date: new Date("2026-03-01T10:00:00Z"),
    itemId: 9001,
    owner: "someone@example.com",
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
    size: 10,
    spec: `./Player.cs#cs:${changesetId}`,
    type,
  };
}

const target: IFileHistoryTarget = {
  uri: Uri.file("/work/Nimbus/Assets/Player.cs"),
  workspaceId: "wk-1",
  workspacePath: "/work/Nimbus",
};

describe("File History tree", () => {
  const nodes = toRevisionNodes(target, [ revision(57), revision(40), revision(12) ]);

  it("links each row to the revision before it", () => {
    expect(nodes.map(node => node.previous?.changesetId)).to.eql([ 40, 12, undefined ]);
  });

  it("recognises its own nodes only", () => {
    expect(isRevisionNode(nodes[0])).to.equal(true);
    expect(isRevisionNode({ kind: "message", text: "x" })).to.equal(false);
    expect(isRevisionNode(undefined)).to.equal(false);
  });

  it("describes a row with the changeset, the first line of the comment and the owner", () => {
    const item = revisionItem(nodes[0]);
    expect(item.label).to.equal("cs:57");
    expect(item.description).to.contain("Tune the jump");
    expect(item.description).to.not.contain("longer body");
    expect(item.description).to.contain("someone@example.com");
    expect(item.contextValue).to.equal(FILE_REVISION_CONTEXT);
    expect(item.tooltip).to.contain("longer body");
  });

  it("compares a revision with the previous one by changeset", () => {
    const diff = describeRevisionDiff(nodes[0]);
    expect(parseRevisionQuery(diff.left)).to.eql({ changeset: 40, wkId: "wk-1" });
    expect(parseRevisionQuery(diff.right)).to.eql({ changeset: 57, wkId: "wk-1" });
    expect(diff.left.path).to.equal(diff.right.path);
    expect(diff.title).to.equal("Player.cs (cs:40) ↔ (cs:57)");
  });

  it("compares the first revision with an empty side", () => {
    const diff = describeRevisionDiff(nodes[2]);
    expect(parseRevisionQuery(diff.left)).to.eql({ empty: true, wkId: "wk-1" });
    expect(diff.title).to.equal("Player.cs (empty) ↔ (cs:12)");
  });

  it("compares a revision with the file in the workspace", () => {
    const diff = describeWorkspaceDiff(nodes[1]);
    expect(parseRevisionQuery(diff.left)).to.eql({ changeset: 40, wkId: "wk-1" });
    expect(diff.right.toString()).to.equal(target.uri.toString());
    expect(diff.title).to.equal("Player.cs (cs:40) ↔ (workspace)");
  });

  it("offers text diffs for text revisions only", () => {
    expect(hasTextContent(revision(1, "txt"))).to.equal(true);
    expect(hasTextContent(revision(1, "bin"))).to.equal(false);
    expect(hasTextContent(revision(1, "dir"))).to.equal(false);
  });
});

describe("Revert to This Revision confirmation", () => {
  it("names the file and the changeset", () => {
    const text = describeRevert("Player.cs", revision(40), false);
    expect(text.message).to.equal("Revert 'Player.cs' to cs:40?");
    expect(text.detail).to.not.contain("WARNING");
  });

  it("warns that pending changes of the file are lost", () => {
    expect(describeRevert("Player.cs", revision(40), true).detail).to.contain("WARNING");
  });
});
