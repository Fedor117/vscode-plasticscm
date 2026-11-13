import * as path from "path";
import {
  describeDelete,
  moveDestinationProblem,
  resolveMoveDestination,
  topmostPaths,
} from "../../commands/trackedFiles";
import { expect } from "chai";
import { fileTargetUris } from "../../commands/fileTargets";
import { Uri } from "vscode";

const ROOT = path.resolve(path.sep, "work", "Nimbus");

describe("Tracked delete and move", () => {
  it("drops paths inside another selected path", () => {
    expect(topmostPaths([ "/w/a", "/w/a/b.txt", "/w/ab.txt", "/w/c" ])).to.eql([ "/w/a", "/w/ab.txt", "/w/c" ]);
  });

  it("names a single target and counts several in the delete confirmation", () => {
    expect(describeDelete("Nimbus", ["/w/old.txt"]).message).to.equal("Delete 'old.txt' in 'Nimbus' with Plastic SCM?");
    expect(describeDelete("Nimbus", [ "/w/a", "/w/b" ]).message)
      .to.equal("Delete 2 items in 'Nimbus' with Plastic SCM?");
    expect(describeDelete("Nimbus", ["/w/a"]).detail).to.contain("Undo restores the checked-in revision");
  });

  it("warns that uncommitted edits are lost for good when the delete covers changed files", () => {
    const detail = describeDelete("Nimbus", ["/w/Player.cs"], ["/w/Player.cs"]).detail;
    expect(detail).to.contain("'Player.cs' has uncommitted changes");
    expect(detail).to.contain("lost for good");
    expect(detail).to.not.contain("Undo restores the checked-in revision");
  });

  it("resolves a destination against the workspace root", () => {
    expect(resolveMoveDestination(ROOT, "docs/b.txt")).to.equal(path.join(ROOT, "docs", "b.txt"));
    expect(resolveMoveDestination(ROOT, path.join(ROOT, "x"))).to.equal(path.join(ROOT, "x"));
  });

  it("rejects destinations outside the workspace, empty ones, and ones cm's shell cannot take", () => {
    expect(resolveMoveDestination(ROOT, "../elsewhere/a.txt")).to.equal(undefined);
    expect(resolveMoveDestination(ROOT, "")).to.equal(undefined);
    expect(resolveMoveDestination(ROOT, ".")).to.equal(undefined);
    expect(resolveMoveDestination(ROOT, 'a"b')).to.equal(undefined);
    expect(moveDestinationProblem(ROOT, "ok/a.txt")).to.equal(undefined);
    expect(moveDestinationProblem(ROOT, "../a")).to.contain("inside the workspace");
    expect(moveDestinationProblem(ROOT, "a\nb")).to.contain("quotes");
    expect(moveDestinationProblem(ROOT, "  ")).to.contain("Enter");
  });
});

describe("fileTargetUris", () => {
  const a = Uri.file("/w/a.txt");
  const b = Uri.file("/w/b.txt");

  it("takes the Explorer's selection, whose first argument is the clicked file", () => {
    expect(fileTargetUris([ a, [ a, b ]]).map(u => u.fsPath)).to.eql([ a.fsPath, b.fsPath ]);
  });

  it("takes a single clicked URI, as the editor tab menu passes it", () => {
    expect(fileTargetUris([a]).map(u => u.fsPath)).to.eql([a.fsPath]);
  });

  it("falls back to the active editor, and to nothing", () => {
    expect(fileTargetUris([], b).map(u => u.fsPath)).to.eql([b.fsPath]);
    expect(fileTargetUris([])).to.eql([]);
  });

  it("keeps only file URIs, once each", () => {
    const other = Uri.parse("plastic:/w/c.txt");
    expect(fileTargetUris([ a, [ a, a, other ]]).map(u => u.fsPath)).to.eql([a.fsPath]);
  });
});
