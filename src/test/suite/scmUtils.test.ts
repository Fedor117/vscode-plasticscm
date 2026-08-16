import { ChangeType, IChangeInfo, RevisionType } from "../../models";
import { getSelectedResources, isPathInside } from "../../commands/scmUtils";
import { IMock, Mock } from "typemoq";
import { expect } from "chai";
import { PlasticScmResource } from "../../plasticScmResource";
import { pruneDescendants } from "../../commands/discardPrivate";
import { Uri } from "vscode";
import { Workspace } from "../../workspace";

function buildResource(fsPath: string, type: ChangeType = ChangeType.Changed): PlasticScmResource {
  const workspaceMock: IMock<Workspace> = Mock.ofType<Workspace>();
  const changeInfo: IChangeInfo = {
    path: Uri.file(fsPath),
    revisionType: RevisionType.TextFile,
    type,
  };

  return new PlasticScmResource(changeInfo, workspaceMock.object);
}

describe("getSelectedResources", () => {
  it("takes every resource, because the SCM view spreads them as separate arguments", () => {
    const args = [ buildResource("/wk/a.cs"), buildResource("/wk/b.cs"), buildResource("/wk/c.cs") ];

    expect(getSelectedResources(args).map(r => r.resourceUri.fsPath))
      .to.deep.equal([ "/wk/a.cs", "/wk/b.cs", "/wk/c.cs" ]);
  });

  it("drops arguments that are not ours, such as the Unreal levels rows", () => {
    const args = [
      buildResource("/wk/a.cs"),
      { decorations: {}, resourceUri: Uri.file("/wk/Level.umap") },
      Uri.file("/wk/b.cs"),
    ];

    expect(getSelectedResources(args).map(r => r.resourceUri.fsPath)).to.deep.equal(["/wk/a.cs"]);
  });

  it("de-duplicates, since a hybrid folder row is collected alongside its own children", () => {
    const duplicate = buildResource("/wk/dir");
    const args = [ duplicate, buildResource("/wk/dir/a.cs"), duplicate ];

    expect(getSelectedResources(args)).to.have.lengthOf(2);
  });

  it("returns an empty list rather than undefined when invoked with nothing", () => {
    expect(getSelectedResources([])).to.deep.equal([]);
  });
});

describe("isPathInside", () => {
  it("requires a separator boundary, so a sibling prefix is not a match", () => {
    expect(isPathInside("/dev/ProjectAlt/a.cs", "/dev/Project")).to.be.false;
    expect(isPathInside("/dev/Project/a.cs", "/dev/Project")).to.be.true;
  });

  it("counts the root itself as inside", () => {
    expect(isPathInside("/dev/Project", "/dev/Project")).to.be.true;
  });

  it("tolerates a trailing separator on the root", () => {
    expect(isPathInside("/dev/Project/a.cs", "/dev/Project/")).to.be.true;
  });
});

describe("pruneDescendants", () => {
  it("keeps only the top-most path, because deleting it takes the rest with it", () => {
    const uris = [
      Uri.file("/wk/dir"),
      Uri.file("/wk/dir/a.cs"),
      Uri.file("/wk/dir/nested"),
      Uri.file("/wk/dir/nested/b.cs"),
      Uri.file("/wk/other.cs"),
    ];

    expect(pruneDescendants(uris).map(u => u.fsPath))
      .to.deep.equal([ "/wk/dir", "/wk/other.cs" ]);
  });

  it("leaves unrelated siblings alone", () => {
    const uris = [ Uri.file("/wk/a"), Uri.file("/wk/ab") ];

    expect(pruneDescendants(uris)).to.have.lengthOf(2);
  });
});
