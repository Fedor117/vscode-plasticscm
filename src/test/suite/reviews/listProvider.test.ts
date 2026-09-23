import { FakeSession, iconOf, label, plain, review } from "./viewFixtures";
import {
  IReviewListErrorNode,
  IReviewListGroupNode,
  IReviewListReviewNode,
  REVIEW_LIST_COMMANDS,
  ReviewListNode,
  ReviewListProvider,
} from "../../../reviews/reviewListProvider";
import { MarkdownString, ThemeIcon, TreeItemCollapsibleState } from "vscode";
import { expect } from "chai";
import { ReviewGroupKey } from "../../../reviews/sessionTypes";
import { toneColor } from "../../../reviews/reviewPresentation";

describe("Reviews list view", () => {
  let session: FakeSession;
  let provider: ReviewListProvider;
  let fired: Array<ReviewListNode | undefined>;
  beforeEach(() => {
    session = new FakeSession();
    provider = new ReviewListProvider(session);
    fired = [];
    provider.onDidChangeTreeData(node => fired.push(node));
  });
  afterEach(() => {
    provider.dispose();
    session.dispose();
  });

  const roots = () => provider.getChildren() as IReviewListGroupNode[];
  const group = (key: ReviewGroupKey) => {
    const node = roots().find(root => root.key === key);
    expect(node, key).to.not.equal(undefined);
    return node!;
  };
  const children = (key: ReviewGroupKey) => provider.getChildren(group(key));

  it("starts the personal queries on its first render, and nothing else", () => {
    expect(roots().map(root => label(provider.getTreeItem(root))))
      .to.deep.equal([ "Needs My Review", "All Open", "All Reviews" ]);
    expect(session.calls).to.deep.equal([
      "expandGroup:needsMyReview",
      "expandGroup:reworkRequested",
      "expandGroup:waitingForReviewers",
    ]);
    expect(children("needsMyReview").map(node => node.kind === "message" && node.label))
      .to.deep.equal(["Loading reviews…"]);
  });

  it("queries All Open and All Reviews only when expanded", () => {
    for (const key of [ "needsMyReview", "reworkRequested", "waitingForReviewers" ] as const) {
      session.setGroup(key, []);
    }
    roots();
    expect(session.calls).to.deep.equal([]);
    const allOpen = group("allOpen");
    expect(provider.getTreeItem(allOpen).collapsibleState).to.equal(TreeItemCollapsibleState.Collapsed);
    expect(session.calls).to.deep.equal([]);
    const loading = provider.getChildren(allOpen);
    expect(session.calls).to.deep.equal(["expandGroup:allOpen"]);
    expect(loading).to.have.length(1);
    const loadingItem = provider.getTreeItem(loading[0]);
    expect(iconOf(loadingItem)).to.deep.equal({ color: "descriptionForeground", id: "loading~spin" });
    expect(toneColor(loadingItem.resourceUri!)).to.equal("descriptionForeground");
    children("allReviews");
    expect(session.calls).to.deep.equal([ "expandGroup:allOpen", "expandGroup:allReviews" ]);
    // Once loaded, expanding again queries nothing.
    session.setGroup("allOpen", []);
    session.calls.length = 0;
    expect(children("allOpen").map(node => node.kind === "message" && node.label)).to.deep.equal(["No open reviews"]);
    expect(session.calls).to.deep.equal([]);
  });

  it("hides Rework Requested and Waiting for Reviewers while they are empty", () => {
    session.setGroup("needsMyReview", []);
    session.setGroup("reworkRequested", []);
    session.setGroup("waitingForReviewers", [review({ id: 7551 })]);
    expect(roots().map(root => root.key))
      .to.deep.equal([ "needsMyReview", "waitingForReviewers", "allOpen", "allReviews" ]);
    expect(children("needsMyReview").map(node => node.kind === "message" && node.label))
      .to.deep.equal(["Nothing needs your review"]);
  });

  it("shows Needs My Review's error on its own, and your own reviews' error once, under Waiting for Reviewers", () => {
    const failed = { loadedOnce: false, stage: { message: "cm: connection refused", state: "error" as const }};
    for (const key of [ "needsMyReview", "reworkRequested", "waitingForReviewers" ] as const) {
      session.setGroup(key, [], failed);
    }
    expect(roots().map(root => root.key))
      .to.deep.equal([ "needsMyReview", "waitingForReviewers", "allOpen", "allReviews" ]);
    expect(children("needsMyReview").map(node => node.kind)).to.deep.equal(["error"]);
    expect(children("waitingForReviewers").map(node => node.kind)).to.deep.equal(["error"]);
    // One failing part never blanks the other.
    session.setGroup("needsMyReview", [review({ id: 1 })]);
    expect(children("needsMyReview").map(node => node.kind)).to.deep.equal(["review"]);
    expect(provider.getTreeItem(group("needsMyReview")).description).to.equal("1");
    expect(children("waitingForReviewers").map(node => node.kind)).to.deep.equal(["error"]);
    // Reviews from an earlier load stay listed under the error; Rework Requested shows no second error row.
    session.setGroup("waitingForReviewers", [review({ id: 7551 })], { ...failed, loadedOnce: true });
    const rework = review({ id: 8, status: "Rework required" });
    session.setGroup("reworkRequested", [rework], { ...failed, loadedOnce: true });
    expect(children("waitingForReviewers").map(node => node.kind)).to.deep.equal([ "error", "review" ]);
    expect(children("reworkRequested").map(node => node.kind)).to.deep.equal(["review"]);
  });

  it("shows a review once, in the first personal group that has it", () => {
    const selfAssigned = review({ id: 7 });
    session.setGroup("needsMyReview", [selfAssigned]);
    session.setGroup("reworkRequested", [ selfAssigned, review({ id: 8, status: "Rework required" }) ]);
    session.setGroup("waitingForReviewers", [selfAssigned]);
    const ids = (key: ReviewGroupKey) => provider.reviews(key).map(item => item.id);
    expect(ids("needsMyReview")).to.deep.equal([7]);
    expect(ids("reworkRequested")).to.deep.equal([8]);
    expect(ids("waitingForReviewers")).to.deep.equal([]);
    expect(roots().map(root => root.key)).to.not.include("waitingForReviewers");
    expect(provider.getTreeItem(group("reworkRequested")).description).to.equal("1");
  });

  it("draws review rows with the cleaned title, people, age, status icon and command", () => {
    const row = review({ assignee: "priya.nair@example.com", title: "Review of changeset 3651 - Tyre wear fix" });
    session.setGroup("needsMyReview", [row]);
    session.setGroup("waitingForReviewers", [review({ id: 7551, status: "Rework required" })]);
    const node = children("needsMyReview")[0] as IReviewListReviewNode;
    const item = provider.getTreeItem(node);
    expect(item.id).to.equal("list/wk/needsMyReview/12831");
    expect(label(item)).to.equal("Tyre wear fix");
    expect(item.description).to.equal("#12831 · erin.author · 1d");
    expect(iconOf(item)).to.deep.equal({ color: "charts.blue", id: "eye" });
    expect(item.contextValue).to.equal("review;underReview");
    expect(item.command?.command).to.equal(REVIEW_LIST_COMMANDS.open);
    expect(item.command?.arguments).to.deep.equal([node]);
    expect(node.workspaceId).to.equal("wk");
    expect(item.tooltip).to.be.instanceOf(MarkdownString);
    expect((item.tooltip as MarkdownString).isTrusted).to.not.equal(true);
    expect(plain(item.tooltip)).to.contain("Review of changeset 3651 - Tyre wear fix");
    const owned = provider.getTreeItem(children("waitingForReviewers")[0]);
    expect(owned.description).to.equal("#7551 → unassigned · 1d");
    expect(iconOf(owned)).to.deep.equal({ color: "charts.orange", id: "request-changes" });
    expect(owned.contextValue).to.equal("review;reworkRequired");
  });

  it("lists reviews of unsupported targets without a command", () => {
    session.setGroup("needsMyReview", [review({ targetType: "label" })]);
    const item = provider.getTreeItem(children("needsMyReview")[0]);
    expect(iconOf(item)?.id).to.equal("circle-slash");
    expect(item.command).to.equal(undefined);
    expect(item.description).to.match(/· label \(not supported\)$/);
  });

  it("offers Load More when a page is full", () => {
    session.setGroup("allOpen", [ review({ id: 1 }), review({ id: 2 }) ], { hasMore: true });
    const nodes = children("allOpen");
    expect(nodes.map(node => node.kind)).to.deep.equal([ "review", "review", "loadMore" ]);
    const more = provider.getTreeItem(nodes[2]);
    expect(label(more)).to.equal("Load More…");
    expect(more.description).to.equal("next 50");
    expect(more.tooltip).to.equal("Load the next 50 open reviews.");
    // A link-coloured label, with blank icon space so it lines up with the reviews.
    expect((more.iconPath as ThemeIcon).id).to.equal("blank");
    expect(toneColor(more.resourceUri!)).to.equal("textLink.foreground");
    expect(more.command?.command).to.equal(REVIEW_LIST_COMMANDS.loadMore);
    expect(provider.getTreeItem(group("allOpen")).description).to.equal("2+");
    expect(provider.getParent(nodes[2])).to.equal(group("allOpen"));
  });

  it("counts every group once loaded, with a + while more pages exist", () => {
    expect(provider.getTreeItem(group("allReviews")).description).to.equal(undefined);
    session.setGroup("allReviews", [ review({ id: 1 }), review({ id: 2 }) ], { hasMore: true });
    session.setGroup("allOpen", [review({ id: 3 })]);
    expect(provider.getTreeItem(group("allReviews")).description).to.equal("2+");
    expect(provider.getTreeItem(group("allOpen")).description).to.equal("1");
    session.setGroup("allReviews", [ review({ id: 1 }), review({ id: 2 }) ]);
    expect(provider.getTreeItem(group("allReviews")).description).to.equal("2");
  });

  it("lists All Reviews collapsed, naming author and assignee, paged by Load More", () => {
    const item = provider.getTreeItem(group("allReviews"));
    expect(label(item)).to.equal("All Reviews");
    expect(item.tooltip).to.equal("Every review in this repository, newest first, whatever its status.");
    expect(item.collapsibleState).to.equal(TreeItemCollapsibleState.Collapsed);
    expect(item.contextValue).to.equal("group;allReviews");
    session.setGroup("allReviews", []);
    expect(children("allReviews").map(node => node.kind === "message" && node.label)).to.deep.equal(["No reviews"]);

    const others = review({ assignee: "priya.nair@example.com", id: 13071, status: "Reviewed" });
    session.setGroup("allReviews", [ others, review({ id: 7551 }) ], { hasMore: true });
    const nodes = children("allReviews");
    expect(nodes.map(node => node.kind)).to.deep.equal([ "review", "review", "loadMore" ]);
    const row = provider.getTreeItem(nodes[0]);
    expect(row.id).to.equal("list/wk/allReviews/13071");
    expect(row.description).to.equal("#13071 · erin.author → priya.nair · 1d");
    expect(iconOf(row)).to.deep.equal({ color: "testing.iconPassed", id: "pass" });
    expect(row.command?.command).to.equal(REVIEW_LIST_COMMANDS.open);
    // A screen reader hears whose review it is, in words: the description's arrow and short age read badly.
    expect(row.accessibilityInformation?.label).to.equal(
      "Lap Timer Accuracy, Reviewed, review 13071, by erin.author, assigned to priya.nair, 1 day ago");
    expect(provider.getTreeItem(nodes[1]).description).to.equal("#7551 · erin.author → unassigned · 1d");
    const more = provider.getTreeItem(nodes[2]);
    expect(label(more)).to.equal("Load More…");
    expect(more.description).to.equal("next 50");
    expect(more.tooltip).to.equal("Load the next 50 reviews.");
    expect(more.command?.command).to.equal(REVIEW_LIST_COMMANDS.loadMore);
    expect(more.command?.arguments).to.deep.equal([nodes[2]]);
    expect((nodes[2] as { key: ReviewGroupKey }).key).to.equal("allReviews");
    // A review can be in All Reviews and in a personal group: only the personal groups share their reviews out.
    session.setGroup("needsMyReview", [others]);
    expect(provider.reviews("allReviews").map(shown => shown.id)).to.deep.equal([ 13071, 7551 ]);
    expect(provider.getTreeItem(group("allReviews")).description).to.equal("2+");
  });

  it("shows Load More as loading while the next page loads, and not while a Refresh reloads the first", () => {
    const shown = [ review({ id: 1 }), review({ id: 2 }) ];
    session.setGroup("allReviews", shown, { hasMore: true, loadingMore: true, stage: { state: "loading" }});
    const nodes = children("allReviews");
    expect(nodes.map(node => node.kind)).to.deep.equal([ "review", "review", "loadMore" ]);
    const loading = provider.getTreeItem(nodes[2]);
    expect(label(loading)).to.equal("Loading more reviews…");
    expect(loading.id, "the row turns back into Load More in place").to.equal("list/wk/allReviews/more");
    expect(loading.tooltip).to.equal("Loading the next 50 reviews.");
    expect(iconOf(loading)).to.deep.equal({ color: "descriptionForeground", id: "loading~spin" });
    expect(toneColor(loading.resourceUri!)).to.equal("descriptionForeground");
    expect(loading.contextValue).to.equal("message");
    expect(loading.command).to.equal(undefined);
    session.setGroup("allReviews", shown, { hasMore: true, stage: { state: "loading" }});
    const more = provider.getTreeItem(children("allReviews")[2]);
    expect(label(more)).to.equal("Load More…");
    expect(more.command?.command).to.equal(REVIEW_LIST_COMMANDS.loadMore);
  });

  it("separates thousands in a group's count", () => {
    const many = Array.from({ length: 1050 }, (_, index) => review({ id: index + 1 }));
    session.setGroup("allOpen", many, { hasMore: true });
    expect(provider.getTreeItem(group("allOpen")).description).to.equal("1,050+");
  });

  it("shows a failing group's error with retry and leaves the other groups alone", () => {
    session.setGroup("needsMyReview", [review()]);
    session.groups.set("allOpen", {
      hasMore: false,
      key: "allOpen",
      loadedOnce: false,
      loadingMore: false,
      reviews: [],
      stage: { message: "cm: connection refused\nat line 2", state: "error" },
    });
    const error = children("allOpen")[0] as IReviewListErrorNode;
    const item = provider.getTreeItem(error);
    expect(label(item)).to.equal("Couldn't load reviews");
    expect(item.description).to.equal("cm: connection refused");
    expect(item.tooltip).to.equal("cm: connection refused\nat line 2\n\nSelect to retry.");
    expect(iconOf(item)).to.deep.equal({ color: "list.errorForeground", id: "error" });
    expect(toneColor(item.resourceUri!)).to.equal("list.errorForeground");
    expect(item.contextValue).to.equal("error");
    expect(item.command?.command).to.equal(REVIEW_LIST_COMMANDS.retry);
    error.retry();
    expect(session.calls).to.include("retryGroup:allOpen");
    expect(children("needsMyReview").map(node => node.kind)).to.deep.equal(["review"]);
  });

  it("badges the reviews that need the user's review", () => {
    expect(provider.badge()).to.equal(undefined);
    session.setGroup("needsMyReview", [ review({ id: 1 }), review({ id: 2 }) ]);
    session.setGroup("reworkRequested", [review({ id: 3, status: "Rework required" })]);
    session.setGroup("waitingForReviewers", [review({ id: 4 })]);
    session.setGroup("allOpen", [review({ id: 5 })]);
    expect(provider.badge()).to.deep.equal({ tooltip: "2 reviews need your review", value: 2 });
    session.setGroup("needsMyReview", [review({ id: 1 })]);
    expect(provider.badge()).to.deep.equal({ tooltip: "1 review needs your review", value: 1 });
    session.setGroup("needsMyReview", []);
    expect(provider.badge()).to.equal(undefined);
  });

  it("names the workspace only when there are several", () => {
    expect(provider.description()).to.equal(undefined);
    session.multipleWorkspaces = true;
    expect(provider.description()).to.equal("Nimbus");
  });

  it("refreshes a lazy group alone and everything for the personal groups", () => {
    const allOpen = group("allOpen");
    const allReviews = group("allReviews");
    session.listChanged.fire("allOpen");
    session.listChanged.fire("allReviews");
    session.listChanged.fire("needsMyReview");
    session.listChanged.fire(undefined);
    expect(fired).to.deep.equal([ allOpen, allReviews, undefined, undefined ]);
  });

  it("shows nothing without a workspace", () => {
    session.workspaceId = undefined;
    expect(provider.getChildren()).to.deep.equal([]);
    expect(session.calls).to.deep.equal([]);
  });
});
