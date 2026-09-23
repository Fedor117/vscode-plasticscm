import { ANALYTICS_PATH, comment, LAP_TIMER_PATH } from "./fixtures";
import {
  DISCUSSION_COMMANDS,
  DiscussionNode,
  discussionsBadge,
  discussionsDescription,
  DiscussionsProvider,
  groupDiscussions,
  IDiscussionErrorNode,
  IDiscussionGroupNode,
  IDiscussionThreadNode,
} from "../../../reviews/discussionsProvider";
import { FakeSession, iconOf, IScenario, label, loadScenario, plain, readyReview } from "./viewFixtures";
import { groupReviewThreads, IReviewThread } from "../../../reviews/models";
import { expect } from "chai";
import { MarkdownString } from "vscode";
import { toneColor } from "../../../reviews/reviewPresentation";

describe("Discussions view", () => {
  let scenario: IScenario;
  let session: FakeSession;
  let provider: DiscussionsProvider;
  before(async () => {
    scenario = await loadScenario();
  });
  beforeEach(() => {
    session = new FakeSession();
    session.active = readyReview(scenario);
    provider = new DiscussionsProvider(session);
  });
  afterEach(() => {
    provider.dispose();
    session.dispose();
  });

  const groups = () => provider.getChildren() as IDiscussionGroupNode[];
  const threads = (group: DiscussionNode) => provider.getChildren(group) as IDiscussionThreadNode[];

  it("groups threads by server path, files by name, then revisions without a path, then General", () => {
    const items = groups().map(group => provider.getTreeItem(group));
    expect(items.map(label)).to.deep.equal([
      "GhostRunAnalyticsCollector.cs",
      "LapTimer.cs",
      "SaveSystem.cs",
      "Revision 6411",
      "General",
    ]);
    expect(items.map(item => item.description)).to.deep.equal([
      "Assets/Code/Events/GhostRuns",
      "Assets/Code/Laps",
      "Assets/Code/Core",
      undefined,
      undefined,
    ]);
    expect(items[1].resourceUri?.scheme).to.equal("plastic-review");
    expect(items[1].resourceUri?.path).to.equal(LAP_TIMER_PATH);
    expect(JSON.parse(items[1].resourceUri!.query)).to.deep.equal({ kind: "item" });
    expect(items[4].contextValue).to.equal("discussions;general");
    // General has no icon of its own: its threads carry theirs.
    expect(items[4].iconPath).to.equal(undefined);
  });

  it("sorts threads in a file newest first and General by date", () => {
    const lapTimer = groups()[1];
    expect(threads(lapTimer).map(node => node.thread.id)).to.deep.equal([ 12961, 12919, 12918 ]);
    const general = groups()[4];
    expect(threads(general).map(node => node.thread.id)).to.deep.equal([ 12926, 12931 ]);
    expect(threads(general).every(node => node.general)).to.equal(true);
    expect(threads(lapTimer).some(node => node.general)).to.equal(false);
  });

  it("draws a thread row with its summary, line, author, age, replies, state and command", () => {
    const [ , discarded, applied ] = threads(groups()[1]);
    const item = provider.getTreeItem(discarded);
    expect(label(item)).to.equal("This allocates a new List<Sprite> each frame.");
    expect(item.description).to.equal("L13 · alex.reviewer · 1h · 1 reply · discarded");
    expect(iconOf(item)).to.deep.equal({ color: "disabledForeground", id: "circle-slash" });
    // The label is greyed out too, through ReviewDecorations.
    expect(toneColor(item.resourceUri!)).to.equal("disabledForeground");
    expect(item.contextValue).to.equal("thread;change;discarded");
    expect(item.command?.command).to.equal(DISCUSSION_COMMANDS.openDiscussion);
    expect(item.command?.arguments).to.deep.equal([discarded]);
    expect(discarded.workspaceId).to.equal("wk");
    expect(discarded.reviewId).to.equal(12831);
    expect(item.tooltip).to.be.instanceOf(MarkdownString);
    expect(plain(item.tooltip)).to.contain("Out of scope for this branch.");
    const appliedItem = provider.getTreeItem(applied);
    expect(appliedItem.description).to.equal("L41 · alex.reviewer · 1h · applied in cs:3718");
    expect(iconOf(appliedItem)).to.deep.equal({ color: "testing.iconPassed", id: "pass" });
    expect(appliedItem.resourceUri).to.equal(undefined);
    const pending = provider.getTreeItem(threads(groups()[0])[0]);
    expect(iconOf(pending)).to.deep.equal({ color: "charts.orange", id: "request-changes" });
    expect(label(pending)).to.equal("Would one shared property on the 'RaceSessionManager' be simpler for callers?");
    const question = provider.getTreeItem(threads(groups()[2])[0]);
    expect(iconOf(question)).to.deep.equal({ color: "charts.blue", id: "question" });
  });

  it("shows verdicts and conversations in General", () => {
    const [ conversation, verdict ] = threads(groups()[4]);
    const conversationItem = provider.getTreeItem(conversation);
    expect(label(conversationItem)).to.equal("Appreciate the quick look!");
    expect(conversationItem.description).to.equal("erin.author · 55m");
    expect(iconOf(conversationItem)).to.deep.equal({ id: "comment-discussion" });
    const verdictItem = provider.getTreeItem(verdict);
    expect(label(verdictItem)).to.equal("Reviewed · LGTM, only a few small questions, none blocking.");
    expect(verdictItem.description).to.equal("alex.reviewer · 50m · 1 reply");
    expect(iconOf(verdictItem)).to.deep.equal({ color: "testing.iconPassed", id: "pass" });
    expect(verdictItem.contextValue).to.equal("thread;status;none");
  });

  it("badges pending change requests only and describes pending, or applied, and questions", () => {
    expect(provider.badge()).to.deep.equal({ tooltip: "1 pending change request", value: 1 });
    expect(provider.description()).to.equal("1 pending · 1 question");
    const none: IReviewThread[] = groupReviewThreads([comment({ type: "question" })]);
    expect(discussionsBadge(none)).to.equal(undefined);
    expect(discussionsDescription(none)).to.equal("1 question");
    const applied = groupReviewThreads([
      comment({ appliedInChangesetId: 3718, id: 1, type: "change" }),
      comment({ id: 2, type: "question" }),
    ]);
    expect(discussionsDescription(applied)).to.equal("1 applied · 1 question");
    expect(discussionsDescription([])).to.equal(undefined);
    session.active = readyReview(scenario, { discussions: { state: "loading" }});
    expect(provider.badge()).to.equal(undefined);
  });

  it("shows the compatibility notice above the threads, or an empty row", () => {
    session.active = readyReview(scenario, {
      discussions: { state: "ready", value: { ...scenario.discussions, message: "This cm client is too old." }},
    });
    const first = provider.getTreeItem(provider.getChildren()[0]);
    expect(label(first)).to.equal("This cm client is too old.");
    expect(iconOf(first)?.id).to.equal("warning");
    session.active = readyReview(scenario, {
      discussions: { state: "ready", value: { reviewers: [], threads: [], timeline: [] }},
    });
    expect(provider.getChildren().map(node => label(provider.getTreeItem(node))))
      .to.deep.equal(["No discussions in this review yet."]);
  });

  it("shows loading and error rows; retry reloads the discussions", () => {
    session.active = readyReview(scenario, { discussions: { state: "loading" }});
    const loading = provider.getTreeItem(provider.getChildren()[0]);
    expect(label(loading)).to.equal("Loading discussions…");
    expect(iconOf(loading)).to.deep.equal({ color: "descriptionForeground", id: "loading~spin" });
    expect(toneColor(loading.resourceUri!)).to.equal("descriptionForeground");
    session.active = readyReview(scenario, { discussions: { message: "cm exited 1", state: "error" }});
    const error = provider.getChildren()[0] as IDiscussionErrorNode;
    const item = provider.getTreeItem(error);
    expect(label(item)).to.equal("Couldn't load discussions");
    expect(item.tooltip).to.equal("cm exited 1. Select to retry.");
    expect(toneColor(item.resourceUri!)).to.equal("list.errorForeground");
    expect(item.command?.command).to.equal(DISCUSSION_COMMANDS.retry);
    error.retry();
    expect(session.calls).to.deep.equal(["retryStage:discussions"]);
    session.active = undefined;
    expect(provider.getChildren()).to.deep.equal([]);
  });

  it("resolves a thread row's parent group for reveal", () => {
    const row = threads(groups()[0])[0];
    expect(row.thread.id).to.equal(12907);
    expect(row.thread.path).to.equal(ANALYTICS_PATH);
    expect(provider.getParent(row)).to.equal(groups()[0]);
    expect(plain(provider.getTreeItem(groups()[4]).tooltip)).to.contain("read it in the Overview");
  });

  it("keeps a file-level comment with its file and a comment without a revision in General", () => {
    const rows = groupReviewThreads([
      comment({ id: 1, location: -1, revisionId: 11, type: "comment" }),
      comment({ id: 2, location: -1, revisionId: -1, type: "comment" }),
    ]);
    rows[0].path = "/Code/Test.cs";
    const grouped = groupDiscussions(rows, "p");
    expect(grouped.map(group => [ group.label, group.threads.map(item => item.id) ]))
      .to.deep.equal([[ "Test.cs", [1]], [ "General", [2]]]);
  });

  it("lists a review description under General only once someone replied to it: the Overview leads with it", () => {
    const description = comment({ id: 3, location: -1, revisionId: -1,
      text: "[description]Look at the lap reset first.", type: "timeline" });
    expect(groupDiscussions(groupReviewThreads([description]), "p")).to.deep.equal([]);
    const reply = comment({ id: 4, location: -1, parentId: 3, revisionId: -1, text: "Will do.", type: "comment" });
    const grouped = groupDiscussions(groupReviewThreads([ description, reply ]), "p");
    expect(grouped.map(group => [ group.label, group.threads.map(item => item.id) ]))
      .to.deep.equal([[ "General", [3]]]);
  });
});
