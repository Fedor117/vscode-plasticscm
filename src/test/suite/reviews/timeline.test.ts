import {
  collapseTimeline,
  currentReviewers,
  IReviewer,
  isWaitingOn,
  parseTimeline,
  parseTimelineEvent,
  pendingReviewRequests,
  removedReviewers,
  reviewerBlock,
  reviewerStates,
  reviewerStatus,
  reviewHistory,
  ReviewHistoryEntry,
} from "../../../reviews/timeline";
import { comment, ME, SCENARIO_COMMENTS } from "./fixtures";
import { groupReviewThreads, IReviewComment } from "../../../reviews/models";
import { expect } from "chai";

let nextId = 2080;
function row(text: string, overrides: Partial<IReviewComment> = {}): IReviewComment {
  nextId++;
  return comment({
    changesetId: -1,
    date: `2026-09-22T16:${(`0${nextId % 60}`).slice(-2)}:00+01:00`,
    id: nextId,
    location: -1,
    owner: "priya.reviewer@example.com",
    revisionId: -1,
    text,
    type: "timeline",
    ...overrides,
  });
}

describe("Review timeline", () => {
  describe("markers", () => {
    it("reads status changes with and without a verdict", () => {
      expect(parseTimelineEvent(row("[status-reviewed]LGTM, only a few small questions.\nNone blocking.  ")))
        .to.include({ kind: "status", status: "Reviewed", text: "LGTM, only a few small questions.\nNone blocking." });
      expect(parseTimelineEvent(row("[status-rework-required]"))).to.include({
        kind: "status", status: "Rework required", text: "",
      });
      expect(parseTimelineEvent(row("[status-under-review]"))).to.include({ kind: "status", status: "Under review" });
      const unknown = parseTimelineEvent(row("[status-archived]old"));
      expect(unknown).to.include({ kind: "status", text: "old" });
      expect(unknown.status).to.equal(undefined);
    });

    it("reads both review-request formats, removals and re-requests", () => {
      expect(parseTimelineEvent(row("[requested-review-from]priya.nair@example.com"))).to.include({
        kind: "reviewRequested", text: "", user: "priya.nair@example.com",
      });
      expect(parseTimelineEvent(row("[requested-review-from-priya.nair@example.com]"))).to.include({
        kind: "reviewRequested", text: "", user: "priya.nair@example.com",
      });
      expect(parseTimelineEvent(row("[requested-review-from-Nimbus Client Engineers]"))).to.include({
        kind: "reviewRequested", user: "Nimbus Client Engineers",
      });
      expect(parseTimelineEvent(row("[removed-requested-review-from]dana@example.com"))).to.include({
        kind: "reviewRequestRemoved", user: "dana@example.com",
      });
      expect(parseTimelineEvent(row("[re-requested-review-from]dana@example.com"))).to.include({
        kind: "reviewReRequested", user: "dana@example.com",
      });
      expect(parseTimelineEvent(row("[requested-review-from]")).user).to.equal(undefined);
    });

    it("keeps both titles of a rename, descriptions and unknown text", () => {
      expect(parseTimelineEvent(row("[renamed-title]Review of changeset 3271 - Fix it#->#Fix it"))).to.include({
        kind: "renamed", previous: "Review of changeset 3271 - Fix it", text: "Fix it",
      });
      const plain = parseTimelineEvent(row("[renamed-title]New title"));
      expect(plain).to.include({ kind: "renamed", text: "New title" });
      expect(plain.previous).to.equal(undefined);
      expect(parseTimelineEvent(row("[description]High level overview:\n- one\n- two"))).to.include({
        kind: "description", text: "High level overview:\n- one\n- two",
      });
      expect(parseTimelineEvent(row("that's a really neat trick"))).to.include({
        kind: "other", text: "that's a really neat trick",
      });
      expect(parseTimelineEvent(row("[merged]into /main"))).to.include({ kind: "other", text: "[merged]into /main" });
    });

    it("carries the row's id, owner and date", () => {
      const source = row("[status-reviewed]", { owner: "someone@example.com" });
      expect(parseTimelineEvent(source)).to.include({ date: source.date, id: source.id, owner: "someone@example.com" });
    });

    it("orders events by instant, not by text, and ignores other comment types", () => {
      const summer = row("[status-reviewed]", { date: "2026-10-25T01:30:00+01:00", id: 2 });
      const winter = row("[status-rework-required]", { date: "2026-10-25T01:10:00+00:00", id: 1 });
      const question = row("Why?", { type: "question" });
      expect(parseTimeline([ winter, question, summer ]).map(event => event.id)).to.deep.equal([ 2, 1 ]);
    });
  });

  describe("reviewers", () => {
    it("keeps requested reviewers until a later removal, the latest event winning", () => {
      const events = parseTimeline([
        row("[requested-review-from]Priya@example.com"),
        row("[requested-review-from-priya@example.com]"),
        row("[requested-review-from]dana@example.com"),
        row("[removed-requested-review-from]dana@example.com"),
        row("[requested-review-from]sam@example.com"),
        row("[removed-requested-review-from]sam@example.com"),
        row("[re-requested-review-from]sam@example.com"),
        row("[status-reviewed]LGTM"),
      ]);
      expect(currentReviewers(events)).to.deep.equal([ "Priya@example.com", "sam@example.com" ]);
    });

    it("finds the reviews where a user is still requested, across reviews", () => {
      const rows = [
        row(`[requested-review-from]${ME}`, { reviewId: 1 }),
        row(`[requested-review-from-${ME}]`, { reviewId: 2 }),
        row(`[removed-requested-review-from]${ME}`, { reviewId: 2 }),
        row(`[requested-review-from]${ME.toUpperCase()}`, { reviewId: 3 }),
        row("[requested-review-from]someone.else@example.com", { reviewId: 4 }),
        row(`[requested-review-from]${ME}`, { reviewId: 5, type: "comment" }),
      ];
      expect(pendingReviewRequests(rows, ME)).to.deep.equal([ 1, 3 ]);
    });

    it("blocks adding the author, the assignee and someone still requested; a verdict or a removal does not", () => {
      const other = { assignee: "", owner: "sam.rivera@example.com" };
      const block = (rows: IReviewComment[], review = other) => reviewerBlock(parseTimeline(rows), review, ME);
      expect(block([])).to.equal(undefined);
      expect(block([], { assignee: "", owner: ME.toUpperCase() })).to.equal("author");
      expect(block([row(`[requested-review-from]${ME}`)], { assignee: "", owner: ME })).to.equal("author");
      expect(block([], { assignee: ME, owner: other.owner })).to.equal("assignee");
      expect(block([], { assignee: " ", owner: other.owner })).to.equal(undefined);
      expect(block([row(`[requested-review-from]${ME.toUpperCase()}`)])).to.equal("requested");
      expect(block([row(`[requested-review-from-${ME}]`)])).to.equal("requested");
      const removed = [ row(`[requested-review-from]${ME}`), row(`[removed-requested-review-from]${ME}`) ];
      expect(block(removed)).to.equal(undefined);
      expect(block(removed.concat(row(`[re-requested-review-from]${ME}`)))).to.equal("requested");
      // A verdict nobody asked for leaves the user free to be added.
      expect(block([row("[status-reviewed]LGTM", { owner: ME })])).to.equal(undefined);
      expect(block([row("[requested-review-from]dana.kim@example.com")])).to.equal(undefined);
    });

    it("reads the user's own status from their card: their verdict while it stands, Under review otherwise", () => {
      const other = { assignee: "", owner: "sam.rivera@example.com" };
      const status = (rows: IReviewComment[]) => reviewerStatus(parseTimeline(rows), other, ME);
      expect(status([])).to.equal("Under review");
      expect(status([row(`[requested-review-from]${ME}`)])).to.equal("Under review");
      expect(status([row("[status-reviewed]LGTM", { owner: ME.toUpperCase() })])).to.equal("Reviewed");
      expect(status([ row("[status-reviewed]", { owner: ME }), row("[status-rework-required]", { owner: ME }) ]))
        .to.equal("Rework required");
      // Someone else's verdict is not the user's.
      expect(status([row("[status-reviewed]", { owner: "dana.kim@example.com" })])).to.equal("Under review");
    });
  });

  describe("reviewer states", () => {
    const DANA = "dana.kim@example.com";
    const SAM = "sam.rivera@example.com";
    const PRIYA = "priya.nair@example.com";
    const LENA = "lena.park@example.com";
    const NOOR = "noor.haddad@example.com";
    let id = 2442;
    const at = (owner: string, date: string, text: string) => comment({
      changesetId: -1, date, id: ++id, location: -1, owner, revisionId: -1, text, type: "timeline",
    });
    const review = (owner: string, assignee = "") => ({ assignee, date: "2026-01-29T14:42:00+00:00", owner });
    const states = (rows: IReviewComment[], owner: string, assignee = "") =>
      reviewerStates(parseTimeline(rows), review(owner, assignee));
    const brief = (reviewer: IReviewer) => [
      reviewer.user.split("@")[0],
      reviewer.state,
      ...(reviewer.author ? ["author"] : []),
      ...(reviewer.assignee ? ["assignee"] : []),
    ].join(" ");
    const history = (rows: IReviewComment[], owner: string) =>
      reviewHistory(parseTimeline(rows), review(owner)).map(historyBrief);

    // The author asked sam; priya and lena joined and approved; sam never answered.
    const samNeverAnswered = () => [
      at(DANA, "2026-01-29T14:43:00+00:00", `[requested-review-from]${SAM}`),
      at(PRIYA, "2026-02-02T11:32:54+00:00", `[requested-review-from]${PRIYA}`),
      at(PRIYA, "2026-02-02T11:33:21+00:00", "[status-reviewed]"),
      at(LENA, "2026-02-03T14:49:42+00:00", `[requested-review-from-${LENA}]`),
      at(LENA, "2026-02-03T14:49:49+00:00", "[status-reviewed]LGTM"),
    ];

    it("waits on the one requested reviewer of three without a verdict", () => {
      const reviewers = states(samNeverAnswered(), DANA, SAM);
      expect(reviewers.map(brief)).to.deep.equal([
        "sam.rivera requested assignee", "priya.nair reviewed", "lena.park reviewed",
      ]);
      expect(reviewers.filter(isWaitingOn).map(reviewer => reviewer.user)).to.deep.equal([SAM]);
      expect(reviewers[2].verdict?.text).to.equal("LGTM");
      expect(reviewers[0].request?.owner).to.equal(DANA);
    });

    it("folds self-requests into the verdict that follows and the author's first requests into the opening", () => {
      expect(history(samNeverAnswered(), DANA)).to.deep.equal([
        "opened by dana.kim, requested sam.rivera",
        "priya.nair joined: status Reviewed",
        "lena.park joined: status Reviewed LGTM",
      ]);
      // Past ten minutes the join is its own line; another person's verdict never absorbs it.
      expect(history([
        at(PRIYA, "2026-02-02T11:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(LENA, "2026-02-02T11:01:00+00:00", "[status-reviewed]"),
        at(PRIYA, "2026-02-02T11:10:01+00:00", "[status-rework-required]"),
      ], DANA)).to.deep.equal([
        "opened by dana.kim",
        "priya.nair: reviewRequested priya.nair",
        "lena.park: status Reviewed",
        "priya.nair: status Rework required",
      ]);
      // A plain request for someone who has given a verdict asks them to look again.
      const again = reviewHistory(parseTimeline([
        at(PRIYA, "2026-02-02T11:00:00+00:00", "[status-reviewed]"),
        at(DANA, "2026-02-03T11:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(DANA, "2026-02-03T11:00:00+00:00", `[requested-review-from]${SAM}`),
      ]), review(DANA)).map(entry => entry.kind === "event" && entry.again);
      expect(again).to.deep.equal([ false, false, true, false ]);
    });

    it("shows a self-request without a verdict as reviewing", () => {
      const rows = [
        at(LENA, "2026-09-21T16:04:42+01:00", "[renamed-title]Review of branch /main/x - Epic#->#Lap Timer"),
        at(PRIYA, "2026-09-22T16:11:21+01:00", `[requested-review-from]${PRIYA}`),
        at(PRIYA, "2026-09-22T16:11:21+01:00", `[requested-review-from-${PRIYA}]`),
      ];
      const reviewers = states(rows, LENA, PRIYA);
      expect(reviewers.map(brief)).to.deep.equal(["priya.nair reviewing assignee"]);
      expect(reviewers.filter(isWaitingOn)).to.have.length(1);
      // The request written in both formats is one line.
      expect(history(rows, LENA)).to.deep.equal([
        "opened by lena.park",
        "lena.park: renamed Lap Timer",
        "priya.nair: reviewRequested priya.nair",
      ]);
    });

    it("asks a reviewer again after rework, until their next verdict", () => {
      const rows = [
        at(NOOR, "2026-07-01T10:00:00+01:00", `[requested-review-from]${PRIYA}`),
        at(PRIYA, "2026-07-06T10:00:00+01:00", "[status-rework-required]Split the lap reset"),
        at(NOOR, "2026-07-07T10:00:00+01:00", `[re-requested-review-from]${PRIYA}`),
        at(PRIYA, "2026-07-08T10:00:00+01:00", "[status-reviewed]"),
      ];
      const after = (count: number) => states(rows.slice(0, count), NOOR);
      expect(after(1).map(brief)).to.deep.equal(["priya.nair requested"]);
      // Rework waits on the author, not on the reviewer.
      expect(after(2).map(brief)).to.deep.equal(["priya.nair reworkRequired"]);
      expect(after(2).filter(isWaitingOn)).to.deep.equal([]);
      const again = after(3);
      expect(again.map(brief)).to.deep.equal(["priya.nair askedAgain"]);
      expect(again[0].verdict?.text).to.equal("Split the lap reset");
      expect(again.filter(isWaitingOn)).to.have.length(1);
      expect(after(4).map(brief)).to.deep.equal(["priya.nair reviewed"]);
      // Joining again after their own verdict makes them a reviewer again too, with that verdict still known.
      const rejoin = at(PRIYA, "2026-07-07T10:00:00+01:00", `[requested-review-from]${PRIYA}`);
      const rejoined = states([ ...rows.slice(0, 2), rejoin ], NOOR);
      expect(rejoined.map(brief)).to.deep.equal(["priya.nair reviewing"]);
      expect(rejoined[0].verdict?.text).to.equal("Split the lap reset");
      expect(rejoined.filter(isWaitingOn)).to.have.length(1);
    });

    it("never waits on the author, and ignores the author's verdict unless the author was requested", () => {
      // The author was requested too.
      const requested = states([
        at(SAM, "2026-03-01T10:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(PRIYA, "2026-03-01T10:05:00+00:00", `[requested-review-from]${SAM.toUpperCase()}`),
        at(PRIYA, "2026-03-02T10:00:00+00:00", "[status-reviewed]"),
      ], SAM);
      expect(requested.map(brief)).to.deep.equal([ "SAM.RIVERA requested author", "priya.nair reviewed" ]);
      expect(requested.filter(isWaitingOn)).to.deep.equal([]);
      const unrequested = states([
        at(SAM, "2026-03-01T10:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(SAM, "2026-03-02T10:00:00+00:00", "[status-reviewed]"),
      ], SAM);
      expect(unrequested.map(brief)).to.deep.equal(["priya.nair requested"]);
    });

    it("keeps the verdict with text when Plastic writes it twice in one second", () => {
      const pair = [
        at(LENA, "2026-06-09T11:31:04+01:00", "[status-reviewed]"),
        at(LENA, "2026-06-09T11:31:04+01:00", "[status-reviewed]LGTM, two TODOs left for later"),
      ];
      for (const rows of [ pair, pair.slice().reverse() ]) {
        const events = parseTimeline(rows);
        expect(collapseTimeline(events).map(event => event.text)).to.deep.equal(["LGTM, two TODOs left for later"]);
        expect(states(rows, DANA)[0].verdict?.text).to.equal("LGTM, two TODOs left for later");
      }
      // An identical pair keeps the first row, also when the second row falls in the next second; a few seconds
      // later it is a new action.
      const same = parseTimeline([
        at(LENA, "2026-06-09T11:31:04+01:00", "[status-reviewed]"),
        at(LENA, "2026-06-09T11:31:04+01:00", "[status-reviewed]"),
        at(LENA, "2026-06-09T11:31:05+01:00", "[status-reviewed]"),
        at(LENA, "2026-06-09T11:31:08+01:00", "[status-reviewed]"),
      ]);
      expect(collapseTimeline(same).map(event => event.id)).to.deep.equal([ same[0].id, same[3].id ]);
      // A request's two marker formats written a second apart: History has one entry.
      const request = [
        at(DANA, "2026-04-28T15:44:54+01:00", `[requested-review-from]${DANA}`),
        at(DANA, "2026-04-28T15:44:55+01:00", `[requested-review-from-${DANA}]`),
      ];
      expect(collapseTimeline(parseTimeline(request))).to.have.length(1);
    });

    it("drops removed reviewers, adds an unrequested assignee, and lists pending reviewers first", () => {
      const reviewers = states([
        at(DANA, "2026-03-01T10:00:00+00:00", `[requested-review-from]${LENA}`),
        at(DANA, "2026-03-01T11:00:00+00:00", `[requested-review-from]${NOOR}`),
        at(LENA, "2026-03-02T10:00:00+00:00", "[status-reviewed]"),
        at(DANA, "2026-03-03T10:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(DANA, "2026-03-03T11:00:00+00:00", `[removed-requested-review-from]${NOOR}`),
        at(PRIYA, "2026-03-04T10:00:00+00:00", "[status-rework-required]"),
      ], DANA, SAM);
      expect(reviewers.map(brief)).to.deep.equal([
        "sam.rivera requested assignee", "lena.park reviewed", "priya.nair reworkRequired",
      ]);
      // An assignee who was requested and then removed has no row; neither has an author who is the assignee.
      expect(states([
        at(DANA, "2026-03-01T10:00:00+00:00", `[requested-review-from]${SAM}`),
        at(DANA, "2026-03-01T11:00:00+00:00", `[removed-requested-review-from]${SAM}`),
      ], DANA, SAM)).to.deep.equal([]);
      expect(states([], DANA, DANA)).to.deep.equal([]);
    });

    it("keeps a verdict across a removal, so a new request asks the reviewer again as History says", () => {
      const rows = [
        at(DANA, "2026-03-01T10:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(PRIYA, "2026-03-02T10:00:00+00:00", "[status-reviewed]LGTM"),
        at(DANA, "2026-03-03T10:00:00+00:00", `[removed-requested-review-from]${PRIYA}`),
        at(DANA, "2026-03-04T10:00:00+00:00", `[requested-review-from]${PRIYA}`),
      ];
      const again = (events: IReviewComment[]) => reviewHistory(parseTimeline(events), review(DANA))
        .map(entry => entry.kind === "event" && entry.again);
      // The removal drops the row, verdict and all.
      expect(states(rows.slice(0, 3), DANA)).to.deep.equal([]);
      const back = states(rows, DANA);
      expect(back.map(brief)).to.deep.equal(["priya.nair askedAgain"]);
      expect(back[0].verdict?.text).to.equal("LGTM");
      expect(back[0].request?.owner).to.equal(DANA);
      expect(back.filter(isWaitingOn)).to.have.length(1);
      expect(again(rows)).to.deep.equal([ false, false, false, false, true ]);
      // Joining again after the removal: reviewing, with the verdict still known.
      const rejoin = at(PRIYA, "2026-03-04T10:00:00+00:00", `[requested-review-from]${PRIYA}`);
      const rejoined = states([ ...rows.slice(0, 3), rejoin ], DANA);
      expect(rejoined.map(brief)).to.deep.equal(["priya.nair reviewing"]);
      expect(rejoined[0].verdict?.text).to.equal("LGTM");
      // The author's verdict before anyone requested the author is History only, until a request asks again.
      const author = [
        at(DANA, "2026-03-01T10:00:00+00:00", "[status-reviewed]"),
        at(PRIYA, "2026-03-02T10:00:00+00:00", `[requested-review-from]${DANA}`),
      ];
      expect(states(author.slice(0, 1), DANA)).to.deep.equal([]);
      expect(states(author, DANA).map(brief)).to.deep.equal(["dana.kim askedAgain author"]);
      expect(states(author, DANA).filter(isWaitingOn)).to.deep.equal([]);
      expect(again(author)).to.deep.equal([ false, false, true ]);
    });

    it("keeps a request, its removal and a new request within two seconds as three actions", () => {
      const rows = [
        at(DANA, "2026-03-01T10:00:00.000+00:00", `[requested-review-from]${PRIYA}`),
        at(DANA, "2026-03-01T10:00:01.000+00:00", `[removed-requested-review-from]${PRIYA}`),
        at(DANA, "2026-03-01T10:00:01.500+00:00", `[requested-review-from]${PRIYA}`),
      ];
      const events = parseTimeline(rows);
      expect(collapseTimeline(events)).to.have.length(3);
      expect(states(rows, DANA).map(brief)).to.deep.equal(["priya.nair requested"]);
      // The queue reads the same rows the same way.
      expect(currentReviewers(events)).to.deep.equal([PRIYA]);
      // Another person's action between the two rows of one request does not keep them apart.
      expect(collapseTimeline(parseTimeline([
        at(DANA, "2026-03-01T10:00:00+00:00", `[requested-review-from]${PRIYA}`),
        at(DANA, "2026-03-01T10:00:00+00:00", `[requested-review-from]${LENA}`),
        at(DANA, "2026-03-01T10:00:01+00:00", `[requested-review-from-${PRIYA}]`),
      ]))).to.have.length(2);
    });

    it("names the people someone removed who have no row now", () => {
      const rows = [
        at(PRIYA, "2026-06-01T10:00:00+01:00", `[requested-review-from]${PRIYA}`),
        at(PRIYA, "2026-06-01T10:01:00+01:00", "[status-rework-required]"),
        at(NOOR, "2026-06-10T10:00:00+01:00", `[requested-review-from]${PRIYA}`),
        at(NOOR, "2026-07-20T10:00:00+01:00", `[removed-requested-review-from]${PRIYA}`),
        at(NOOR, "2026-07-20T10:00:01+01:00", `[requested-review-from]${NOOR}`),
        at(NOOR, "2026-07-20T10:00:02+01:00", "[status-reviewed]"),
        at(NOOR, "2026-07-21T10:00:00+01:00", `[requested-review-from]${LENA}`),
        at(NOOR, "2026-07-21T10:00:05+01:00", `[removed-requested-review-from]${LENA}`),
        at(LENA, "2026-07-22T10:00:00+01:00", "[status-reviewed]"),
      ];
      const events = parseTimeline(rows);
      const owned = review(NOOR, NOOR);
      expect(reviewerStates(events, owned).map(brief))
        .to.deep.equal([ "noor.haddad reviewed author assignee", "lena.park reviewed" ]);
      // Lena's verdict after her removal gives her a row again; priya has none, and the author never counts.
      expect(removedReviewers(events, owned)).to.deep.equal([PRIYA]);
      expect(removedReviewers(events.slice(0, 3), owned)).to.deep.equal([]);
      expect(removedReviewers(parseTimeline([
        at(DANA, "2026-03-01T10:00:00+00:00", `[requested-review-from]${NOOR}`),
        at(DANA, "2026-03-01T11:00:00+00:00", `[removed-requested-review-from]${NOOR}`),
      ]), owned)).to.deep.equal([]);
    });
  });


  describe("threads", () => {
    it("turns verdicts into status threads and keeps replies to timeline rows with them", () => {
      const threads = groupReviewThreads(SCENARIO_COMMENTS);
      const status = threads.find(thread => thread.id === 12931)!;
      expect(status.kind).to.equal("status");
      expect(status.state).to.equal("none");
      expect(status.event).to.include({ status: "Reviewed", text: "LGTM, only a few small questions, none blocking." });
      expect(status.comments.map(item => item.id)).to.deep.equal([ 12931, 12932 ]);
      expect(status.comments[0].text).to.equal("LGTM, only a few small questions, none blocking.");
      // Requests, renames and a status change without text stay in the activity log.
      for (const id of [ 12832, 12894, 12895, 12944 ]) {
        expect(threads.some(thread => thread.id === id)).to.equal(false);
      }
    });

    it("makes a thread of a text-less timeline row that has replies", () => {
      const verdict = row("[status-rework-required]");
      const reply = comment({ id: 2401, location: -1, parentId: verdict.id, revisionId: -1, type: "comment" });
      const rename = row("[renamed-title]Old#->#New");
      const renameReply = comment({ id: 2402, location: -1, parentId: rename.id, revisionId: -1, type: "comment" });
      const threads = groupReviewThreads([ verdict, reply, rename, renameReply ]);
      expect(threads.map(thread => [ thread.id, thread.kind ])).to.deep.equal([
        [ verdict.id, "status" ], [ rename.id, "other" ],
      ]);
      expect(threads[0].comments[0].text).to.equal("");
    });

    it("makes a thread of a description only when someone replied to it", () => {
      const description = row("[description]Please look at the lap reset first.");
      expect(groupReviewThreads([description])).to.deep.equal([]);
      const reply = comment({ id: 2403, location: -1, parentId: description.id, revisionId: -1, type: "comment" });
      const threads = groupReviewThreads([ description, reply ]);
      expect(threads).to.have.length(1);
      expect(threads[0]).to.include({ kind: "other", state: "none" });
      expect(threads[0].event?.kind).to.equal("description");
    });

    it("derives change request state from applied changesets and discarded replies", () => {
      const threads = groupReviewThreads(SCENARIO_COMMENTS);
      const state = (id: number) => threads.find(thread => thread.id === id)!;
      expect(state(12907)).to.include({ kind: "change", state: "pending" });
      expect(state(12918)).to.include({ kind: "change", state: "applied" });
      expect(state(12919)).to.include({ kind: "change", state: "discarded" });
      expect(state(12915)).to.include({ kind: "question", state: "none" });
      expect(state(12926)).to.include({ kind: "conversation", state: "none" });
      expect(state(12961)).to.include({ kind: "comment", state: "none" });
    });

    it("uses a given timeline instead of parsing the rows again", () => {
      const verdict = row("[status-reviewed]raw");
      const threads = groupReviewThreads([verdict], [{ ...parseTimelineEvent(verdict), text: "given" }]);
      expect(threads[0].comments[0].text).to.equal("given");
    });
  });
});

/** `priya.nair joined: status Reviewed LGTM`, `opened by dana.kim, requested sam.rivera`. */
function historyBrief(entry: ReviewHistoryEntry): string {
  const short = (user: string) => user.split("@")[0];
  if (entry.kind === "opened") {
    const requested = entry.requested.length ? `, requested ${entry.requested.map(short).join(", ")}` : "";
    return `opened by ${short(entry.owner)}${requested}`;
  }
  const event = entry.event;
  const subject = event.status ?? (event.user ? short(event.user) : "");
  const what = [ event.kind, subject, event.text ].filter(Boolean).join(" ");
  return `${short(event.owner)}${entry.joined ? " joined" : ""}: ${what}`;
}
