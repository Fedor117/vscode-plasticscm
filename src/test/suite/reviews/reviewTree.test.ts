import {
  ADDED_PATH,
  ANALYTICS_PATH,
  CHANGESET_REVIEW_ID,
  DELETED_PATH,
  file,
  LAP_TIMER_PATH,
  MOVED_PATH,
  PHANTOM_PATH,
} from "./fixtures";
import { FakeSession, iconOf, IScenario, label, loadScenario, plain, readyReview } from "./viewFixtures";
import {
  IReviewChangesetNode,
  IReviewRootNode,
  IReviewTreeErrorNode,
  IReviewTreeMessageNode,
  REVIEW_TREE_COMMANDS,
  ReviewFileNode,
  ReviewTreeNode,
  ReviewTreeProvider,
} from "../../../reviews/reviewTreeProvider";
import { IReviewComparison, IReviewFiles } from "../../../reviews/models";
import { MarkdownString, ThemeIcon, TreeItemCheckboxState, TreeItemCollapsibleState } from "vscode";
import { expect } from "chai";
import { IChangesetFileChange } from "../../../models";
import { reviewDiff } from "../../../reviews/reviewEditors";
import { revisionKey } from "../../../reviews/viewedStore";
import { toneColor } from "../../../reviews/reviewPresentation";

describe("Review view", () => {
  let scenario: IScenario;
  let session: FakeSession;
  let provider: ReviewTreeProvider;
  let fired: Array<ReviewTreeNode | undefined>;
  before(async () => {
    scenario = await loadScenario();
  });
  beforeEach(() => {
    session = new FakeSession();
    session.active = readyReview(scenario);
    provider = new ReviewTreeProvider(session);
    fired = [];
    provider.onDidChangeTreeData(node => fired.push(node));
  });
  afterEach(() => {
    provider.dispose();
    session.dispose();
  });

  const roots = () => provider.getChildren() as IReviewRootNode[];
  const root = (kind: string) => {
    const node = roots().find(item => item.kind === kind);
    expect(node, kind).to.not.equal(undefined);
    return node!;
  };
  const row = (path: string): IChangesetFileChange => scenario.files.final.files.find(item => item.path === path)!;
  const node = (path: string): ReviewFileNode => {
    const found = provider.fileNode("changes", row(path));
    expect(found, path).to.not.equal(undefined);
    return found!;
  };
  const messages = (nodes: ReviewTreeNode[]) => nodes.map(item => (item as IReviewTreeMessageNode).label);

  it("shows nothing without an active review", () => {
    session.active = undefined;
    expect(provider.getChildren()).to.deep.equal([]);
    expect(provider.title()).to.equal("Review");
    expect(provider.description()).to.equal(undefined);
  });

  it("shows loading rows until the stages arrive", () => {
    session.active = readyReview(scenario, {
      changesets: { state: "idle" },
      discussions: { state: "loading" },
      files: { state: "loading" },
    });
    expect(roots().map(item => item.kind)).to.deep.equal([ "overview", "changes", "changesets" ]);
    const loading = provider.getChildren(root("changes"));
    expect(messages(loading)).to.deep.equal(["Loading changes…"]);
    const loadingItem = provider.getTreeItem(loading[0]);
    expect(iconOf(loadingItem)).to.deep.equal({ color: "descriptionForeground", id: "loading~spin" });
    expect(toneColor(loadingItem.resourceUri!)).to.equal("descriptionForeground");
    expect(provider.getTreeItem(root("changes")).description).to.equal(undefined);
    // The collapsed Changesets row shows its own stage is still filling in.
    const changesetsRoot = provider.getTreeItem(root("changesets"));
    expect(changesetsRoot.description).to.equal("Loading…");
    expect(iconOf(changesetsRoot)).to.deep.equal({ color: "descriptionForeground", id: "loading~spin" });
    expect(messages(provider.getChildren(root("changesets")))).to.deep.equal(["Loading changesets…"]);
  });

  it("lays out a branch review: Overview, Changes, Merged from other branches, Changesets", () => {
    expect(roots().map(item => item.kind)).to.deep.equal([ "overview", "changes", "merged", "changesets" ]);
    const overview = provider.getTreeItem(root("overview"));
    expect(label(overview)).to.equal("Lap Timer Accuracy");
    expect(overview.description).to.equal("erin.author → alex.reviewer · 1d");
    expect(iconOf(overview)?.id).to.equal("book");
    expect(overview.command?.command).to.equal(REVIEW_TREE_COMMANDS.openOverview);
    expect(plain(overview.tooltip)).to.contain("Select to open the overview.");
    const changes = provider.getTreeItem(root("changes"));
    expect(label(changes)).to.equal("Changes");
    expect(changes.collapsibleState).to.equal(TreeItemCollapsibleState.Expanded);
    expect(changes.description).to.equal("0/5 viewed · cs:3471 ↔ cs:3715");
    expect(changes.contextValue).to.equal("changes");
    expect(changes.tooltip).to.contain("from the branch base cs:3471 to cs:3715");
    expect(changes.tooltip).to.contain("listed under Merged from other branches");
    const merged = provider.getTreeItem(root("merged"));
    expect(label(merged)).to.equal("Merged from other branches");
    expect(merged.collapsibleState).to.equal(TreeItemCollapsibleState.Collapsed);
    expect(merged.description).to.equal("2 files");
    expect(merged.tooltip).to.equal(
      "Files that changed on this branch only through merges (from /main or child branches). " +
      "Their diffs still compare the branch base cs:3471 with the head cs:3715. " +
      "Plastic's own review groups these under 'Merged from cs:N'.");
    const changesets = provider.getTreeItem(root("changesets"));
    expect(changesets.description).to.equal("3");
    expect(iconOf(changesets)).to.deep.equal({ id: "git-commit" });
    expect(changesets.collapsibleState).to.equal(TreeItemCollapsibleState.Collapsed);
    expect(provider.title()).to.equal("Review #12831");
    expect(provider.description()).to.equal("Under review");
  });

  it("shows the update row first, only while the server has changes", () => {
    expect(roots().map(item => item.kind)).to.not.include("updates");
    session.active = readyReview(scenario, { updates: { newComments: 2, newHead: 3733, removedComments: 0 }});
    expect(roots()[0].kind).to.equal("updates");
    const updates = provider.getTreeItem(roots()[0]);
    expect(label(updates)).to.equal("Review updated");
    expect(updates.description).to.equal("branch moved to cs:3733 · 2 new comments");
    expect(updates.tooltip).to.equal(
      "This review is pinned to cs:3715. Select to load the latest. Open diffs keep their revisions. " +
      "New comments include edited ones and applied change requests.");
    expect(iconOf(updates)).to.deep.equal({ color: "charts.blue", id: "sync" });
    expect(updates.command?.command).to.equal(REVIEW_TREE_COMMANDS.loadUpdates);
    expect(updates.contextValue).to.equal("updates");
  });

  it("lays out a changeset review without Merged or Changesets", async () => {
    const changesetReview = await loadScenario(CHANGESET_REVIEW_ID);
    session.active = readyReview(changesetReview);
    expect(roots().map(item => item.kind)).to.deep.equal([ "overview", "changes" ]);
    const changes = provider.getTreeItem(root("changes"));
    expect(label(changes)).to.equal("Changes in cs:3203");
    expect(changes.tooltip).to.equal("Changes in cs:3203 compared with its parent cs:3195.");
    expect(changes.description).to.equal("0/1 viewed · cs:3195 ↔ cs:3203");
    const children = provider.getChildren(root("changes"));
    const items = children.map(item => provider.getTreeItem(item));
    expect(items.map(label)).to.deep.equal([ "artifacts", "Jenkinsfile_test_generator" ]);
    // An added directory is a folder row with its record, not a file to view.
    expect(items[0].collapsibleState).to.equal(TreeItemCollapsibleState.None);
    expect(items[0].checkboxState).to.equal(undefined);
    expect(items[0].description).to.equal("added");
    expect(items[1].contextValue).to.equal("file;text;unviewed");
  });

  it("draws file rows with the diff's right-side URI, viewed checkbox, discussions and command", () => {
    const lapTimer = node(LAP_TIMER_PATH);
    const item = provider.getTreeItem(lapTimer);
    const right = reviewDiff("wk", 12831, scenario.files.final, row(LAP_TIMER_PATH)).right.uri;
    expect(item.resourceUri?.toString()).to.equal(right.toString());
    expect(item.id).to.equal(`active/wk/12831/changes/${LAP_TIMER_PATH}@12804`);
    expect(label(item)).to.equal("LapTimer.cs");
    expect(item.description).to.equal("3 discussions");
    expect(item.checkboxState).to.deep.equal({
      accessibilityInformation: { label: "Mark LapTimer.cs as viewed" },
      state: TreeItemCheckboxState.Unchecked,
      tooltip: "Mark as viewed",
    });
    expect(item.contextValue).to.equal("file;text;unviewed");
    expect(item.command?.command).to.equal(REVIEW_TREE_COMMANDS.openChanges);
    expect(item.command?.arguments).to.deep.equal([lapTimer]);
    expect(lapTimer.group.scope).to.equal("changes");
    expect(lapTimer.group.comparison).to.equal(scenario.files.final);
    const analytics = provider.getTreeItem(node(ANALYTICS_PATH));
    expect(plain(analytics.tooltip)).to.contain("1 discussion (1 pending change request)");
    expect((analytics.tooltip as MarkdownString).isTrusted).to.not.equal(true);
    expect(provider.getTreeItem(node(MOVED_PATH)).description).to.equal("← TyreSet_Soft_Test.asset");

    session.viewed.add(revisionKey(row(LAP_TIMER_PATH)));
    const viewed = provider.getTreeItem(lapTimer);
    expect(viewed.checkboxState).to.deep.equal({
      accessibilityInformation: { label: "LapTimer.cs viewed" },
      state: TreeItemCheckboxState.Checked,
      tooltip: "Viewed",
    });
    expect(viewed.contextValue).to.equal("file;text;viewed");
    expect(provider.getTreeItem(root("changes")).description).to.equal("1/5 viewed · cs:3471 ↔ cs:3715");
    expect(provider.progress()).to.deep.equal({ total: 5, viewed: 1 });
  });

  it("gives rows without a text diff a URI with the same scheme and path", () => {
    const merged = provider.getChildren(root("merged"));
    const files: ReviewFileNode[] = [];
    const collect = (nodes: ReviewTreeNode[]) => nodes.forEach(item => {
      if (item.kind === "file") {
        files.push(item);
      } else if (item.kind === "folder") {
        collect(item.children);
      }
    });
    collect(merged);
    const phantom = files.find(item => item.file.path === PHANTOM_PATH)!;
    const item = provider.getTreeItem(phantom);
    expect(item.resourceUri?.scheme).to.equal("plastic-review");
    expect(item.resourceUri?.path).to.equal(PHANTOM_PATH);
    // The decoration is keyed by this exact string, as it is for rows that open a diff.
    expect(item.resourceUri?.toString())
      .to.equal(reviewDiff("wk", 12831, scenario.files.final, phantom.file).right.uri.toString());
    expect(item.contextValue).to.equal("file;nodiff;unviewed");
    expect(item.description).to.equal("no content change");
    expect(plain(item.tooltip)).to.contain("No content change recorded");
    // Merged rows stay out of the review's progress.
    expect(provider.progress()?.total).to.equal(5);
  });

  it("applies a folder checkbox to every file in it", () => {
    const laps = node(LAP_TIMER_PATH).parent!;
    const folder = provider.getTreeItem(laps);
    expect(label(folder)).to.equal("Assets/Code/Laps");
    expect(folder.collapsibleState).to.equal(TreeItemCollapsibleState.Expanded);
    expect(JSON.parse(folder.resourceUri!.query)).to.deep.equal({ kind: "folder" });
    expect(folder.checkboxState).to.deep.equal({
      accessibilityInformation: { label: "Mark Assets/Code/Laps as viewed" },
      state: TreeItemCheckboxState.Unchecked,
      tooltip: "Mark all files in this folder as viewed",
    });
    provider.handleCheckboxes({ items: [[ laps, TreeItemCheckboxState.Checked ]] });
    expect(session.calls).to.include(`setViewed:true:${LAP_TIMER_PATH},${ADDED_PATH},${DELETED_PATH}`);
    expect(fired).to.include(undefined);
    expect(provider.getTreeItem(laps).checkboxState).to.deep.equal({
      accessibilityInformation: { label: "Assets/Code/Laps viewed" },
      state: TreeItemCheckboxState.Checked,
      tooltip: "All files viewed",
    });
    expect(provider.getTreeItem(laps).contextValue).to.equal("folder;viewed");
    expect(provider.getTreeItem(node(ADDED_PATH)).contextValue).to.equal("file;text;viewed");
    provider.handleCheckboxes({ items: [[ node(ADDED_PATH), TreeItemCheckboxState.Unchecked ]] });
    expect(session.calls).to.include(`setViewed:false:${ADDED_PATH}`);
    expect(provider.getTreeItem(laps).checkboxState).to.deep.include({ state: TreeItemCheckboxState.Unchecked });
  });

  it("separates thousands in a folder's file count", () => {
    const many = Array.from({ length: 1204 }, (_, index) =>
      file({ path: `/Assets/Big/File${index}.cs`, revisionId: 4302 + index }));
    session.active = readyReview(scenario, { files: { state: "ready", value: {
      ...scenario.files,
      final: { ...scenario.files.final, files: many },
      mergedKeys: new Set<string>(),
    }}});
    const folder = provider.fileNode("changes", many[0])!.parent!;
    session.setViewed(many.slice(0, 1001), true);
    expect(provider.getTreeItem(folder).tooltip).to.equal("/Assets/Big\n1,204 files · 1,001 viewed");
  });

  it("resolves every file's parents up to its root, for reveal", () => {
    const analytics = node(ANALYTICS_PATH);
    const chain: string[] = [];
    let current: ReviewTreeNode | undefined = analytics;
    while (current) {
      chain.push(current.kind === "folder" || current.kind === "file" ? current.label : current.kind);
      current = provider.getParent(current);
    }
    expect(chain).to.deep.equal([ "GhostRunAnalyticsCollector.cs", "Assets/Code/Events/GhostRuns", "changes" ]);
    const top = provider.getChildren(root("changes"));
    expect(top.map(item => item.kind === "folder" && item.label))
      .to.deep.equal([ "Assets/Code/Events/GhostRuns", "Assets/Code/Laps", "Assets/Data" ]);
  });

  it("lists changesets newest first, marks merges and the head, and loads their files once when expanded", () => {
    const changesets = provider.getChildren(root("changesets")) as IReviewChangesetNode[];
    expect(changesets.map(item => item.changeset.id)).to.deep.equal([ 3715, 3699, 3477 ]);
    const head = provider.getTreeItem(changesets[0]);
    expect(label(head)).to.equal("Change 3715");
    expect(head.description).to.equal("cs:3715 · erin.author · 1d · head");
    expect(iconOf(head)?.id).to.equal("git-commit");
    expect(head.contextValue).to.equal("changeset");
    const merge = provider.getTreeItem(changesets[1]);
    expect(merge.description).to.equal("cs:3699 · merge from /main · 1d");
    expect(iconOf(merge)?.id).to.equal("git-merge");
    expect(merge.contextValue).to.equal("changeset;merge");
    expect(plain(merge.tooltip)).to.contain("Expanding lists every merged file.");
    expect(session.calls.filter(call => call.startsWith("changesetFiles"))).to.deep.equal([]);

    expect(messages(provider.getChildren(changesets[0]))).to.deep.equal(["Loading files…"]);
    const comparison: IReviewComparison = {
      baseChangesetId: 3700,
      files: [
        file({ path: LAP_TIMER_PATH, repository: scenario.files.final.files[0].repository, revisionId: 12804 }),
      ],
      headChangesetId: 3715,
      id: `${scenario.files.final.id}:cs:3715`,
      kind: "changeset",
      label: "cs:3700 ↔ cs:3715",
    };
    session.changesetStages.set(3715, { state: "ready", value: comparison });
    const children = provider.getChildren(changesets[0]);
    provider.getChildren(changesets[0]);
    expect(session.calls.filter(call => call === "loadChangeset:3715")).to.have.length(1);
    expect(children.map(item => item.kind === "folder" && item.label)).to.deep.equal(["Assets/Code/Laps"]);
    const inChangeset = provider.fileNode({ changesetId: 3715 }, comparison.files[0])!;
    expect(inChangeset.group.scope).to.deep.equal({ changesetId: 3715 });
    expect(inChangeset.group.comparison).to.equal(comparison);
    expect(provider.getTreeItem(inChangeset).resourceUri?.toString())
      .to.equal(reviewDiff("wk", 12831, comparison, comparison.files[0]).right.uri.toString());
    expect(provider.navigationOrder({ changesetId: 3715 })).to.deep.equal(comparison.files);
    expect(provider.getParent(inChangeset.parent!)).to.equal(changesets[0]);
    // The head has this revision too, so the row follows the Changes row's checkbox and says why.
    const sameItem = provider.getTreeItem(inChangeset);
    expect(sameItem.description).to.equal("3 discussions · same revision as head");
    expect(plain(sameItem.tooltip)).to.contain("Same revision as the review head: viewed together with Changes.");

    session.changesetStages.set(3477, { message: "diff failed", state: "error" });
    const error = provider.getChildren(changesets[2])[0] as IReviewTreeErrorNode;
    expect(label(provider.getTreeItem(error))).to.equal("Couldn't load files");
    error.retry();
    expect(session.calls).to.include("retryChangesetFiles:3477");
  });

  it("offers Load More Changesets when a page is full", () => {
    session.active = readyReview(scenario, {
      changesets: { state: "ready", value: { hasMore: true, items: scenario.changesets.items }},
    });
    const children = provider.getChildren(root("changesets"));
    const more = provider.getTreeItem(children[children.length - 1]);
    expect(label(more)).to.equal("Load More Changesets…");
    expect(more.tooltip).to.equal("Load the next 50 changesets.");
    expect((more.iconPath as ThemeIcon).id).to.equal("blank");
    expect(toneColor(more.resourceUri!)).to.equal("textLink.foreground");
    expect(more.command?.command).to.equal(REVIEW_TREE_COMMANDS.loadMoreChangesets);
    expect(provider.getTreeItem(root("changesets")).description).to.equal("3+");
    // While the next page loads, the row says so and a second click does nothing.
    session.loadingMoreChangesets = true;
    const loadingMore = provider.getTreeItem(children[children.length - 1]);
    expect(label(loadingMore)).to.equal("Loading changesets…");
    expect(iconOf(loadingMore)).to.deep.equal({ color: "descriptionForeground", id: "loading~spin" });
    expect(loadingMore.command).to.equal(undefined);
  });

  it("retries a failed stage from its error row", () => {
    session.active = readyReview(scenario, {
      changesets: { message: "find failed", state: "error" },
      files: { message: "diff failed\ndetails", state: "error" },
    });
    const files = provider.getChildren(root("changes"))[0] as IReviewTreeErrorNode;
    const item = provider.getTreeItem(files);
    expect(label(item)).to.equal("Couldn't load changes");
    expect(item.description).to.equal("diff failed");
    expect(item.tooltip).to.equal("diff failed\ndetails\n\nSelect to retry.");
    expect(toneColor(item.resourceUri!)).to.equal("list.errorForeground");
    expect(item.command?.command).to.equal(REVIEW_TREE_COMMANDS.retry);
    const changesetsRoot = provider.getTreeItem(root("changesets"));
    expect(changesetsRoot.description).to.equal("Couldn't load");
    expect(iconOf(changesetsRoot)).to.deep.equal({ color: "list.errorForeground", id: "error" });
    files.retry();
    (provider.getChildren(root("changesets"))[0] as IReviewTreeErrorNode).retry();
    expect(session.calls).to.deep.equal([ "retryStage:files", "retryStage:changesets" ]);
  });

  it("says so when the branch no longer exists", () => {
    const deleted: IReviewFiles = {
      ...scenario.files,
      branch: undefined,
      branchDeleted: true,
      final: { ...scenario.files.final, files: [], label: "branch deleted" },
      head: -1,
      mergedKeys: new Set<string>(),
    };
    session.active = readyReview(scenario, { files: { state: "ready", value: deleted }});
    // A deleted branch has no changesets to list.
    expect(roots().map(item => item.kind)).to.deep.equal([ "overview", "changes" ]);
    expect(provider.getTreeItem(root("changes")).description).to.equal("branch deleted");
    const warning = provider.getChildren(root("changes"));
    const item = provider.getTreeItem(warning[0]);
    expect(label(item)).to.equal("The branch no longer exists");
    expect(item.description).to.equal("discussions open their original context");
    expect(item.tooltip).to.equal("The branch no longer exists. Discussions still open their original context.");
    expect(iconOf(item)).to.deep.equal({ color: "list.warningForeground", id: "warning" });
  });

  it("navigates in display order and follows the layout setting", () => {
    const order = [ ANALYTICS_PATH, LAP_TIMER_PATH, ADDED_PATH, DELETED_PATH, MOVED_PATH ];
    expect(provider.navigationOrder("changes").map(item => item.path)).to.deep.equal(order);
    session.fileLayout = "list";
    provider.refresh();
    const list = provider.getChildren(root("changes"));
    expect(list.every(item => item.kind === "file")).to.equal(true);
    expect(list.map(item => (item as ReviewFileNode).file.path)).to.deep.equal(order);
    expect(provider.getTreeItem(list[1]).description).to.equal("Assets/Code/Laps · 3 discussions");
    expect(provider.navigationOrder("changes").map(item => item.path)).to.deep.equal(order);
    expect(provider.getParent(list[0])).to.equal(root("changes"));
  });

  it("notes a hidden branch in the view description", () => {
    session.active = readyReview(scenario, {
      files: { state: "ready", value: { ...scenario.files, branch: { ...scenario.files.branch!, hidden: true }}},
    });
    expect(provider.description()).to.equal("Under review (hidden)");
    expect(provider.getTreeItem(root("changes")).tooltip).to.contain("(hidden)");
  });

  it("keeps its nodes across redraws and drops the rows of a replaced review", async () => {
    const first = provider.getChildren(root("changes"));
    session.viewedChanged.fire();
    session.activeChanged.fire();
    expect(fired).to.deep.equal([ undefined, undefined ]);
    const again = provider.getChildren(root("changes"));
    expect(again).to.have.length(first.length);
    expect(again.every((item, index) => item === first[index])).to.equal(true);
    const oldChanges = root("changes");
    session.active = readyReview(await loadScenario(CHANGESET_REVIEW_ID));
    expect(provider.getChildren(oldChanges)).to.deep.equal([]);
    expect(provider.fileNode("changes", row(LAP_TIMER_PATH))).to.equal(undefined);
  });

  it("names each scope's comparison and explains why changesets wait after a failed files stage", () => {
    expect(provider.comparison("changes")).to.equal(scenario.files.final);
    expect(provider.comparison("merged")).to.equal(scenario.files.final);
    session.active = readyReview(scenario, { changesets: { state: "idle" }, files: { message: "x", state: "error" }});
    expect(messages(provider.getChildren(root("changesets"))))
      .to.deep.equal(["Changesets load after the changes. Retry the changes first."]);
    expect(provider.comparison("changes")).to.equal(undefined);
    expect(provider.navigationOrder("changes")).to.deep.equal([]);
    expect(provider.progress()).to.equal(undefined);
  });
});
