import { branchComparison, changesetsComparison, isShowChangesetArgs } from "../../../commands/compare";
import {
  COMPARISON_COMMANDS,
  ComparisonTreeProvider,
  IComparison,
  isComparisonFileNode,
  toComparisonNodes,
} from "../../../comparison/comparisonTree";
import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../models";
import { describeComparisonFileDiff } from "../../../history/openChangesetFileDiff";
import { expect } from "chai";
import { parseRevisionQuery } from "../../../revisionContentProvider";

function change(path: string, status = FileChangeStatus.Changed): IChangesetFileChange {
  return {
    baseRevisionId: 100,
    parentRevisionId: 100,
    path,
    repository: "Nimbus/Nimbus@acme-studio@unity",
    revisionId: 200,
    revisionType: RevisionType.TextFile,
    status,
  };
}

const comparison: IComparison = {
  changes: [ change("/b/Zed.cs"), change("/a/Alpha.cs", FileChangeStatus.Added) ],
  description: "cs:10 ↔ cs:25",
  labels: { current: "cs:25", parent: "cs:10" },
  workspaceId: "wk-1",
};

describe("Comparison view", () => {
  it("lists the files by path", () => {
    expect(toComparisonNodes(comparison).map(node => node.change.path)).to.eql([ "/a/Alpha.cs", "/b/Zed.cs" ]);
  });

  it("opens a file's diff from a click, passing the node", () => {
    const provider = new ComparisonTreeProvider();
    provider.set(comparison);
    const [first] = provider.getChildren();
    const item = provider.getTreeItem(first);
    expect(item.label).to.equal("Alpha.cs");
    expect(item.command?.command).to.equal(COMPARISON_COMMANDS.openFile);
    expect(item.command?.arguments?.[0]).to.equal(first);
    expect(isComparisonFileNode(first)).to.equal(true);
    provider.dispose();
  });

  it("empties when cleared", () => {
    const provider = new ComparisonTreeProvider();
    provider.set(comparison);
    provider.set(undefined);
    expect(provider.getChildren()).to.eql([]);
    provider.dispose();
  });

  it("diffs the base revision of cs:A against the revision in cs:B, titled with both labels", () => {
    const diff = describeComparisonFileDiff("wk-1", comparison.labels, change("/b/Zed.cs"))!;
    expect(parseRevisionQuery(diff.left)).to.eql({ rep: "Nimbus/Nimbus@acme-studio@unity", revid: 100, wkId: "wk-1" });
    expect(parseRevisionQuery(diff.right)).to.eql({ rep: "Nimbus/Nimbus@acme-studio@unity", revid: 200, wkId: "wk-1" });
    expect(diff.title).to.equal("Zed.cs (cs:10) ↔ Zed.cs (cs:25)");
  });

  it("names the branch for a branch comparison", () => {
    const labels = branchComparison("wk-1", "/main/task7").labels;
    const diff = describeComparisonFileDiff("wk-1", labels, change("/a/Alpha.cs", FileChangeStatus.Added))!;
    expect(diff.title).to.equal("Alpha.cs (added in br:/main/task7)");
  });
});

describe("Compare commands", () => {
  it("labels two changesets from the base to the target", () => {
    expect(changesetsComparison("wk-1", 10, 25)).to.eql({
      description: "cs:10 ↔ cs:25", labels: { current: "cs:25", parent: "cs:10" }, workspaceId: "wk-1",
    });
  });

  it("describes a branch against its parent", () => {
    expect(branchComparison("wk-1", "/main/task7").description).to.equal("/main/task7 against its parent");
  });

  it("accepts the link arguments of the annotate hover and nothing else", () => {
    expect(isShowChangesetArgs({ changesetId: 4, wkId: "w" })).to.equal(true);
    expect(isShowChangesetArgs({ changesetId: "4", wkId: "w" })).to.equal(false);
    expect(isShowChangesetArgs({ changesetId: 4.5, wkId: "w" })).to.equal(false);
    expect(isShowChangesetArgs(undefined)).to.equal(false);
  });
});
