import {
  ADDED_PATH,
  ANALYTICS_PATH,
  DELETED_PATH,
  file,
  LAP_TIMER_PATH,
  MERGED_PATH,
  MOVED_PATH,
  PHANTOM_PATH,
} from "./fixtures";
import {
  AUTO_EXPAND_LIMIT,
  buildFileNodes,
  fileDescription,
  FileTreeNode,
  folderDescription,
  IFileTreeFile,
  IFileTreeFolder,
  navigationOrder,
  noDiffReason,
  walk,
} from "../../../reviews/reviewFileTree";
import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../models";
import { expect } from "chai";
import { fileKey } from "../../../reviews/models";
import { loadScenario } from "./viewFixtures";

function rows(...paths: string[]): IChangesetFileChange[] {
  return paths.map((path, index) => file({ path, revisionId: 2080 + index }));
}

function labels(nodes: ReadonlyArray<FileTreeNode<string>>): string[] {
  return nodes.map(node => node.label);
}

function folder(nodes: ReadonlyArray<FileTreeNode<string>>, name: string): IFileTreeFolder<string> {
  const found = nodes.find(node => node.kind === "folder" && node.label === name);
  expect(found, `folder ${name}`).to.not.equal(undefined);
  return found as IFileTreeFolder<string>;
}

/** Every node in display order, as `Label` for files and `Label/` for folders. */
function outline(nodes: ReadonlyArray<FileTreeNode<string>>): string[] {
  const lines: string[] = [];
  walk(nodes, node => lines.push(node.kind === "folder" ? `${node.label}/` : node.label));
  return lines;
}

describe("Review file tree", () => {
  it("groups files by directory: one flat folder per directory, labelled with its whole path", () => {
    const tree = buildFileNodes(rows(
      "/Assets/Code/Events/GhostRuns/Collector.cs",
      "/Assets/Code/Laps/LapTimer.cs",
      "/Assets/Code-Gen/Gen.cs",
      "/Assets/Code/Laps/Checkpoint.cs",
    ), "tree", "p", "g");
    expect(labels(tree.roots)).to.deep.equal([
      "Assets/Code/Events/GhostRuns",
      "Assets/Code/Laps",
      "Assets/Code-Gen",
    ]);
    const laps = folder(tree.roots, "Assets/Code/Laps");
    expect(laps.path).to.equal("/Assets/Code/Laps");
    expect(laps.id).to.equal("p/Assets/Code/Laps/");
    expect(labels(laps.children)).to.deep.equal([ "Checkpoint.cs", "LapTimer.cs" ]);
    expect(laps.children.every(node => node.kind === "file")).to.equal(true);
  });

  it("puts folders first and sorts case-insensitively, numbers by value", () => {
    const tree = buildFileNodes(rows("/b.cs", "/A.cs", "/c10.cs", "/c9.cs", "/B/y.cs", "/a/x.cs"), "tree", "p", "g");
    expect(labels(tree.roots)).to.deep.equal([ "a", "B", "A.cs", "b.cs", "c9.cs", "c10.cs" ]);
  });

  it("lists files by full path in the list layout, with their directory as description", () => {
    const tree = buildFileNodes(rows("/b/Z.cs", "/B/a.cs", "/a.cs", "/Assets/Code/X.cs"), "list", "p", "g");
    expect(tree.roots.every(node => node.kind === "file")).to.equal(true);
    expect(tree.roots.map(node => (node as IFileTreeFile<string>).file.path))
      .to.deep.equal([ "/a.cs", "/Assets/Code/X.cs", "/B/a.cs", "/b/Z.cs" ]);
    expect(labels(tree.roots)).to.deep.equal([ "a.cs", "X.cs", "a.cs", "Z.cs" ]);
    expect(fileDescription((tree.roots[1] as IFileTreeFile<string>).file, "list")).to.equal("Assets/Code");
    expect(fileDescription((tree.roots[0] as IFileTreeFile<string>).file, "list")).to.equal("");
  });

  it("keeps a delete and a re-add of one path as two rows with their own ids", () => {
    const deleted = file({ path: "/Code/A.cs", revisionId: 10, status: FileChangeStatus.Deleted });
    const added = file({ baseRevisionId: -1, path: "/Code/A.cs", revisionId: 20, status: FileChangeStatus.Added });
    const tree = buildFileNodes([ deleted, added ], "tree", "active/wk/5/changes", "g");
    expect(tree.files.map(node => node.id)).to.deep.equal([
      "active/wk/5/changes//Code/A.cs@10",
      "active/wk/5/changes//Code/A.cs@20",
    ]);
    expect(tree.byKey.get(fileKey(added))?.file).to.equal(added);
    // A duplicate row still gets a unique id.
    const twice = buildFileNodes([ deleted, deleted ], "list", "p", "g");
    expect(new Set(twice.files.map(node => node.id)).size).to.equal(2);
  });

  it("shows directory records on folders, never as files", () => {
    const added = file({
      path: "/artifacts", revisionId: 5, revisionType: RevisionType.Directory, status: FileChangeStatus.Added,
    });
    const movedDir = file({
      oldPath: "/Assets/OldArt",
      path: "/Assets/Art",
      revisionId: 6,
      revisionType: RevisionType.Directory,
      status: FileChangeStatus.Moved,
    });
    const inside = file({ path: "/Assets/Art/Sky.png", revisionId: 7, revisionType: RevisionType.BinaryFile });
    const script = file({ path: "/Jenkinsfile", revisionId: 8, status: FileChangeStatus.Added });
    const tree = buildFileNodes([ added, movedDir, inside, script ], "tree", "p", "g");
    expect(outline(tree.roots)).to.deep.equal([ "artifacts/", "Assets/Art/", "Sky.png", "Jenkinsfile" ]);
    expect(tree.files.map(node => node.file)).to.deep.equal([ inside, script ]);
    const art = folder(tree.roots, "Assets/Art");
    expect(art.directories).to.deep.equal([movedDir]);
    expect(folderDescription(art, "tree")).to.equal("← OldArt");
    const artifacts = folder(tree.roots, "artifacts");
    expect(artifacts.children).to.have.length(0);
    expect(artifacts.files).to.have.length(0);
    expect(folderDescription(artifacts, "tree")).to.equal("added");
    const list = buildFileNodes([ added, inside, script ], "list", "p", "g");
    expect(list.files.map(node => node.file)).to.deep.equal([ inside, script ]);
    expect(list.roots.filter(node => node.kind === "folder").map(node => node.path)).to.deep.equal(["/artifacts"]);
  });

  it("puts a directory record on its own directory's folder, even one without files", () => {
    const record = file({
      path: "/Assets/New", revisionId: 1, revisionType: RevisionType.Directory, status: FileChangeStatus.Added,
    });
    const tree = buildFileNodes([ record, file({ path: "/Assets/New/Sub/x.cs", revisionId: 2 }) ], "tree", "p", "g");
    expect(outline(tree.roots)).to.deep.equal([ "Assets/New/", "Assets/New/Sub/", "x.cs" ]);
    expect(folder(tree.roots, "Assets/New").directories).to.deep.equal([record]);
    expect(folder(tree.roots, "Assets/New").children).to.have.length(0);
  });

  it("navigates in display order in both layouts, skipping rows without a text diff", () => {
    const text = rows("/Code/b.cs", "/Code/A.cs", "/Art/readme.txt", "/root.cs");
    const binary = file({ path: "/Art/Sky.png", revisionId: 50, revisionType: RevisionType.BinaryFile });
    const phantom = file({ baseRevisionId: -1, parentRevisionId: -1, path: "/Art/Mat.mat", revisionId: 51 });
    const all = text.concat(binary, phantom);
    for (const layout of [ "tree", "list" ] as const) {
      const tree = buildFileNodes(all, layout, "p", "g");
      const display = tree.files.map(node => node.file);
      expect(navigationOrder(tree.roots)).to.deep.equal(display.filter(row => row !== binary && row !== phantom));
      expect(display).to.include(binary);
      expect(display).to.include(phantom);
    }
    expect(navigationOrder(buildFileNodes(all, "tree", "p", "g").roots).map(row => row.path))
      .to.deep.equal([ "/Art/readme.txt", "/Code/A.cs", "/Code/b.cs", "/root.cs" ]);
  });

  it("expands folders up to the file threshold", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) =>
      file({ path: `/Code/Dir${index % 3}/File${index}.cs`, revisionId: index }));
    const small = buildFileNodes(many(AUTO_EXPAND_LIMIT), "tree", "p", "g");
    const large = buildFileNodes(many(AUTO_EXPAND_LIMIT + 1), "tree", "p", "g");
    expect(folder(small.roots, "Code/Dir0").expanded).to.equal(true);
    expect(folder(large.roots, "Code/Dir0").expanded).to.equal(false);
  });

  it("links every file to its folder, and every folder to the files in it", () => {
    const tree = buildFileNodes(
      rows("/Assets/Code/A.cs", "/Assets/Code/Deep/B.cs", "/Assets/Data/C.asset", "/root.cs"), "tree", "p", "g");
    const deep = tree.files.find(node => node.label === "B.cs")!;
    expect(deep.parent?.label).to.equal("Assets/Code/Deep");
    expect(deep.parent?.parent).to.equal(undefined);
    expect(deep.group).to.equal("g");
    expect(tree.files.find(node => node.label === "root.cs")!.parent).to.equal(undefined);
    expect(folder(tree.roots, "Assets/Code").files.map(row => row.path)).to.deep.equal(["/Assets/Code/A.cs"]);
    expect(folder(tree.roots, "Assets/Code/Deep").files.map(row => row.path)).to.deep.equal(["/Assets/Code/Deep/B.cs"]);
  });

  it("describes moves, binaries, rows without content and discussions", () => {
    const renamed = file({ oldPath: "/Code/Old.cs", path: "/Code/New.cs", status: FileChangeStatus.Moved });
    const moved = file({
      oldPath: "/Other/New.cs", path: "/Code/New.cs", status: FileChangeStatus.Moved | FileChangeStatus.Changed,
    });
    expect(fileDescription(renamed, "tree")).to.equal("← Old.cs");
    expect(fileDescription(moved, "tree", 2)).to.equal("2 discussions · moved");
    expect(fileDescription(moved, "tree", 1, true)).to.equal("1 discussion · same revision as head · moved");
    expect(fileDescription(file({ revisionType: RevisionType.BinaryFile }), "tree", 1))
      .to.equal("1 discussion · binary");
    expect(fileDescription(file({ baseRevisionId: -1, parentRevisionId: -1 }), "list"))
      .to.equal("Code · no content change");
    expect(noDiffReason(file({ baseRevisionId: -1, parentRevisionId: -1 }))).to.equal("No content change recorded");
    expect(noDiffReason(file({ revisionType: RevisionType.Directory }))).to.equal("Directory");
    expect(noDiffReason(file({ status: FileChangeStatus.Deleted }))).to.equal(undefined);
    // A change without a base revision would diff as an addition; the tree, navigation and the editors all skip it.
    const sourceless = file({ baseRevisionId: -1, path: "/Code/Lost.cs" });
    expect(fileDescription(sourceless, "tree")).to.equal("source revision unavailable");
    expect(navigationOrder(buildFileNodes([ file(), sourceless ], "list", "p", "g").roots)).to.deep.equal([file()]);
  });

  it("builds the realistic branch review into Changes and Merged scopes", async () => {
    const scenario = await loadScenario();
    const final = scenario.files.final.files;
    const merged = final.filter(row => scenario.files.mergedKeys.has(fileKey(row)));
    const changes = final.filter(row => !scenario.files.mergedKeys.has(fileKey(row)));
    expect(merged.map(row => row.path)).to.have.members([ MERGED_PATH, PHANTOM_PATH ]);
    const tree = buildFileNodes(changes, "tree", "p", "g");
    expect(outline(tree.roots)).to.deep.equal([
      "Assets/Code/Events/GhostRuns/",
      "GhostRunAnalyticsCollector.cs",
      "Assets/Code/Laps/",
      "LapTimer.cs",
      "LapTimerDisplay.cs",
      "LapTimesStore.cs",
      "Assets/Data/",
      "TyreSet_Soft_Final.asset",
    ]);
    expect(navigationOrder(tree.roots).map(row => row.path))
      .to.deep.equal([ ANALYTICS_PATH, LAP_TIMER_PATH, ADDED_PATH, DELETED_PATH, MOVED_PATH ]);
    expect(fileDescription(tree.byKey.get(fileKey(changes.find(row => row.path === MOVED_PATH)!))!.file, "tree"))
      .to.equal("← TyreSet_Soft_Test.asset");
    expect(navigationOrder(buildFileNodes(merged, "tree", "p", "g").roots).map(row => row.path))
      .to.deep.equal([MERGED_PATH]);
  });
});
