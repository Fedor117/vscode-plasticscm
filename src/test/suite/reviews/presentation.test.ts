import {
  ageInWords,
  avatarColor,
  avatarInitials,
  avatarUri,
  changeKind,
  changesetTooltip,
  cleanReviewTitle,
  commentTypeLabel,
  contentKind,
  exactReviewPick,
  fileTooltip,
  formatCount,
  formatDate,
  isGeneralThread,
  noDiffMessage,
  openableReviewNumber,
  relativeAge,
  retryTooltip,
  reviewAriaLabel,
  reviewDescription,
  reviewPeople,
  reviewPickItems,
  reviewTargetName,
  reviewTooltip,
  ROW_TONE_SCHEME,
  sameStatus,
  shortDate,
  shortDateTime,
  shortOwner,
  splitCodeSpans,
  splitReviewTitle,
  statusContext,
  statusIcon,
  stripMachineTags,
  threadContext,
  threadCounts,
  threadDescription,
  threadIcon,
  threadSummary,
  threadTooltip,
  threadTypeLabel,
  toneColor,
  toneUri,
  unnamedBranchId,
  updateSummary,
} from "../../../reviews/reviewPresentation";
import { BRANCH_NAME, comment, file } from "./fixtures";
import { FileChangeStatus, RevisionType } from "../../../models";
import { groupReviewThreads, IReviewChangeset, IReviewComment, IReviewThread } from "../../../reviews/models";
import { NOW, plain, review } from "./viewFixtures";
import { expect } from "chai";

/** The Find Review… row that opens a number typed by ID. */
const OPEN_BY_ID = "$(go-to-file) Open review by ID";

function thread(root: Partial<IReviewComment>, replies: Array<Partial<IReviewComment>> = []): IReviewThread {
  const rows = [comment({ id: 2080, ...root })].concat(replies.map((reply, index) =>
    comment({ date: "2026-09-22T17:00:00+01:00", id: 2241 + index, parentId: 2080, ...reply })));
  const threads = groupReviewThreads(rows);
  expect(threads).to.have.length(1);
  return threads[0];
}

describe("Review presentation", () => {
  it("puts every thread without an anchor revision under General", () => {
    expect(isGeneralThread(thread({ type: "change" }))).to.equal(false);
    expect(isGeneralThread(thread({ location: -1, type: "comment" }))).to.equal(false);
    expect(isGeneralThread(thread({ location: -1, revisionId: -1, type: "comment" }))).to.equal(true);
    expect(isGeneralThread(thread({ location: -1, revisionId: -1, type: "conversation" }))).to.equal(true);
    expect(isGeneralThread(thread({ text: "[status-reviewed]LGTM", type: "timeline" }))).to.equal(true);
  });

  describe("cleanReviewTitle", () => {
    const branchReview = (title: string) => review({ title });
    const changesetReview = (title: string) => review({ target: "3171", targetType: "changeset", title });
    it("keeps what the author wrote after Plastic's generated prefix", () => {
      expect(cleanReviewTitle(changesetReview("Review of changeset 3651 - Guard against a null lap time")))
        .to.equal("Guard against a null lap time");
      expect(cleanReviewTitle(branchReview("Review of branch /main/feature_x - Epic: RAC-3861")))
        .to.equal("Epic: RAC-3861");
    });
    it("falls back to the changeset or the branch's last segment when nothing follows the prefix", () => {
      expect(cleanReviewTitle(branchReview("Review of changeset 3203"))).to.equal("cs:3203");
      expect(cleanReviewTitle(branchReview("Review of branch /main/task_RAC-3501_PaymentsSpike")))
        .to.equal("task_RAC-3501_PaymentsSpike");
      // The branch's current name wins over the one the title was written with.
      expect(cleanReviewTitle(branchReview("Review of branch /main/old"), "/main/renamed")).to.equal("renamed");
    });

    it("drops tags a tool wrote around a GUID and keeps the first line", () => {
      const title = "Review of changeset 3171 - Garage: simplify slot assignment\n\n" +
        " [apply-change:a1c3e5f7-2b4d-4f6a-8c0e-13579bdf2468]";
      expect(splitReviewTitle(changesetReview(title)))
        .to.deep.equal({ rest: "", title: "Garage: simplify slot assignment" });
      expect(cleanReviewTitle(branchReview("Fix [apply-change:A1C3E5F7-2B4D-4F6A-8C0E-13579BDF2468] crash")))
        .to.equal("Fix crash");
      // A changeset made by applying a change request carries a short id, digits only at times.
      expect(stripMachineTags("[apply-change:38c85554] Clamp it")).to.equal(" Clamp it");
      expect(cleanReviewTitle(branchReview("Clamp it [apply-change:38185554]"))).to.equal("Clamp it");
      // Jira keys and the ids people write are not machine tags, digits being hex digits too.
      const jira = "[RAC-3791] Fix the garage @ RAC-3891";
      expect(stripMachineTags("[RAC-3791] [build:2026] Fix")).to.equal("[RAC-3791] [build:2026] Fix");
      expect(cleanReviewTitle(branchReview("Fix date [date:20260923]"))).to.equal("Fix date [date:20260923]");
      expect(cleanReviewTitle(branchReview("Fix crash [build:20260923]"))).to.equal("Fix crash [build:20260923]");
      expect(stripMachineTags("[PR:12345678] [build:38c85554] Fix")).to.equal("[PR:12345678] [build:38c85554] Fix");
      expect(cleanReviewTitle(branchReview(jira))).to.equal(jira);
      expect(splitReviewTitle(branchReview("First line\nsecond line\n\nthird")))
        .to.deep.equal({ rest: "second line\n\nthird", title: "First line" });
      // Plastic's prefix with only a tag after it leaves the changeset or the branch, not `Review of changeset 2227 -`.
      expect(cleanReviewTitle(branchReview("Review of changeset 2227 - [apply-change:38c85554]"))).to.equal("cs:2227");
      expect(cleanReviewTitle(changesetReview("Review of changeset 3171 - [apply-change:38c85554]")))
        .to.equal("cs:3171");
      const guid = "a1c3e5f7-2b4d-4f6a-8c0e-13579bdf2468";
      expect(cleanReviewTitle(branchReview(`Review of branch /main/x - [apply-change:${guid}]`)))
        .to.equal("x");
      expect(cleanReviewTitle(branchReview("Review of changeset 2227 - Fix [apply-change:38c85554]"))).to.equal("Fix");
    });

    it("strips tags in time linear in the text, however many blanks come before a bracket", () => {
      const blanks = " ".repeat(40000);
      const guids = "0c5d1a2b-1111-2222-3333-444455556666 ".repeat(1000);
      const started = Date.now();
      expect(stripMachineTags(`${blanks}x`)).to.equal(`${blanks}x`);
      expect(stripMachineTags(`a${blanks}[apply-change:38c85554]${blanks}[RAC-1`)).to.equal(`a${blanks}[RAC-1`);
      expect(stripMachineTags(`[${guids}`)).to.equal(`[${guids}`);
      expect(cleanReviewTitle(branchReview(`${blanks}x${blanks}`))).to.equal("x");
      const dots = ".".repeat(40000);
      expect(cleanReviewTitle(branchReview(`Tickets:\n- https://x.net/RAC-1${dots}x${dots}`)))
        .to.equal(`RAC-1${dots}x`);
      // Each took up to a second while the pattern tried a run of blanks again from each of its characters.
      expect(Date.now() - started).to.be.below(500);
    });

    it("gives a first line that only introduces a list to the description", () => {
      const tickets =
        "Review of branch /main/task_RAC-3761_Pits - Tickets: \n- https://x.net/RAC-3761\n- https://x.net/RAC-3766";
      expect(splitReviewTitle(branchReview(tickets))).to.deep.equal({
        rest: "Tickets: \n- https://x.net/RAC-3761\n- https://x.net/RAC-3766",
        title: "task_RAC-3761_Pits",
      });
      expect(cleanReviewTitle(changesetReview("Epic:\nhttps://x.net/RAC-1"))).to.equal("cs:3171");
      expect(cleanReviewTitle(branchReview("Epic:\nhttps://x.net/RAC-1"), "/main/feature_epic"))
        .to.equal("feature_epic");
      // With nothing to fall back to, the list's first line says what the review is about, when it has words
      // (the Reviews list does not know a branch's name).
      expect(splitReviewTitle(branchReview("Tickets:\nRAC-1 https://x"))).to.deep.equal({
        rest: "Tickets:\nRAC-1 https://x",
        title: "RAC-1",
      });
      const store = "Tickets:\n\n- RAC-2 Garage https://x.net/RAC-2\n- RAC-3";
      expect(cleanReviewTitle(branchReview(store))).to.equal("RAC-2 Garage");
      // A list of URLs alone names what its first URL names: a ticket key, as the Reviews list shows it.
      const urls = review({ target: "id:5", title: "Tickets: \n- https://example.atlassian.net/browse/RAC-3761" });
      expect(splitReviewTitle(urls)).to.deep.equal({
        rest: "Tickets: \n- https://example.atlassian.net/browse/RAC-3761",
        title: "RAC-3761",
      });
      expect(cleanReviewTitle(branchReview("Epic:\nhttps://x.net/RAC-1"))).to.equal("RAC-1");
      expect(cleanReviewTitle(branchReview("Tickets:\n- https://x.net/RAC-1\n- RAC-2"))).to.equal("RAC-1");
      expect(cleanReviewTitle(branchReview("Tickets:\n* https://x.net/browse/RAC-7?focus=1#c2)."))).to.equal("RAC-7");
      expect(cleanReviewTitle(branchReview("Tickets:\n1. https://x.net/RAC-8/ https://y.net/RAC-9"))).to.equal("RAC-8");
      expect(cleanReviewTitle(branchReview("Links:\n- https://docs.example.com/"))).to.equal("docs.example.com");
      expect(cleanReviewTitle(branchReview("Links:\n- https://x.net/Garage%20Fix"))).to.equal("Garage Fix");
      expect(cleanReviewTitle(branchReview("Tickets:\n- https://x.net/%E0%A4%A"))).to.equal("%E0%A4%A");
      expect(cleanReviewTitle(branchReview("Tickets:\n2) RAC-3 https://x.net/RAC-3"))).to.equal("RAC-3");
      // Nothing to name: the line stays.
      expect(cleanReviewTitle(branchReview("Tickets:\n- -"))).to.equal("Tickets:");
    });

    it("leaves titles people wrote alone", () => {
      expect(cleanReviewTitle(branchReview("Lap Timer Accuracy")))
        .to.equal("Lap Timer Accuracy");
      expect(cleanReviewTitle(branchReview("Review of the build scripts"))).to.equal("Review of the build scripts");
      expect(cleanReviewTitle(branchReview("   "))).to.equal("(untitled review)");
      expect(cleanReviewTitle(changesetReview("   "))).to.equal("cs:3171");
    });
  });

  it("shortens owners to the part before the @", () => {
    expect(shortOwner("lena.park@example.com")).to.equal("lena.park");
    expect(shortOwner("builder")).to.equal("builder");
  });

  describe("relativeAge", () => {
    const age = (date: string) => relativeAge(date, NOW);

    it("counts minutes, hours and days across time zone offsets", () => {
      expect(age("2026-09-22T17:59:30+01:00")).to.equal("just now");
      expect(age("2026-09-22T17:00:01+01:00")).to.equal("59m");
      expect(age("2026-09-22T17:00:00+01:00")).to.equal("1h");
      // The same instant written in UTC.
      expect(age("2026-09-22T16:00:00Z")).to.equal("1h");
      expect(age("2026-09-21T18:00:01+01:00")).to.equal("23h");
      expect(age("2026-09-21T18:00:00+01:00")).to.equal("1d");
      expect(age("2026-09-14T15:24:00+01:00")).to.equal("8d");
      expect(age("2026-08-23T18:00:01+01:00")).to.equal("29d");
    });

    it("counts months past 30 days, then years", () => {
      expect(age("2026-08-01T12:00:00Z")).to.equal("1mo");
      expect(age("2026-06-10T12:00:00Z")).to.equal("3mo");
      expect(age("2025-09-14T12:00:00Z")).to.equal("1y");
      expect(age("2023-09-14T12:00:00Z")).to.equal("3y");
    });

    it("treats a future date as just now and an unparseable one as unknown", () => {
      expect(age("2026-09-22T18:05:00+01:00")).to.equal("just now");
      expect(age("not a date")).to.equal("");
      expect(relativeAge(new Date(NOW - 3 * 60 * 1000), NOW)).to.equal("3m");
    });

    it("spells ages out for tooltips", () => {
      expect(ageInWords("2026-09-14T15:24:00+01:00", NOW)).to.equal("8 days ago");
      expect(ageInWords("2026-09-22T17:00:00+01:00", NOW)).to.equal("1 hour ago");
      expect(ageInWords("2026-06-22T18:00:00+01:00", NOW)).to.equal("3 months ago");
      expect(ageInWords("2026-09-22T17:59:59+01:00", NOW)).to.equal("just now");
    });

    it("formats full dates in local time", () => {
      expect(formatDate(new Date(2026, 8, 14, 15, 4))).to.equal("14 Sep 2026 15:04");
      expect(formatDate("nonsense")).to.equal("");
    });

    it("gives short dates, with the year only when it differs", () => {
      expect(shortDate(new Date(2026, 8, 21, 10, 12), NOW)).to.equal("21 Sep");
      expect(shortDate(new Date(2025, 8, 21, 10, 12), NOW)).to.equal("21 Sep 2025");
      expect(shortDate("nonsense", NOW)).to.equal("");
    });

    it("gives short dates with the time, the year only when it differs", () => {
      expect(shortDateTime(new Date(2026, 1, 3, 14, 49), NOW)).to.equal("3 Feb 14:49");
      expect(shortDateTime(new Date(2025, 0, 29, 9, 2), NOW)).to.equal("29 Jan 2025 09:02");
      expect(shortDateTime("nonsense", NOW)).to.equal("");
    });

    it("formats counts with thousands separators", () => {
      expect(formatCount(1204)).to.equal("1,204");
      expect(formatCount(38)).to.equal("38");
    });
  });

  it("gives each status its icon, colour and context value", () => {
    expect(statusIcon("Under review")).to.deep.equal({ color: "charts.blue", id: "eye" });
    expect(statusIcon("Rework required")).to.deep.equal({ color: "charts.orange", id: "request-changes" });
    expect(statusIcon("Reviewed")).to.deep.equal({ color: "testing.iconPassed", id: "pass" });
    expect(statusIcon("Pending merge")).to.deep.equal({ id: "circle-large-outline" });
    expect([ "Under review", "Rework required", "Reviewed", "Other" ].map(statusContext))
      .to.deep.equal([ "underReview", "reworkRequired", "reviewed", "unknown" ]);
    expect(sameStatus("Rework required", " rework Required ")).to.equal(true);
    expect(sameStatus("Reviewed", "Under review")).to.equal(false);
    // Two statuses the icons do not know are still told apart.
    expect(sameStatus("Pending merge", "Merged")).to.equal(false);
  });

  it("describes review rows by author, by assignee in the author's own groups, or by both in All Reviews", () => {
    const row = review({ assignee: "priya.nair@example.com" });
    expect(reviewDescription(row, NOW)).to.equal("#12831 · erin.author · 1d");
    expect(reviewDescription(row, NOW, "assignee")).to.equal("#12831 → priya.nair · 1d");
    expect(reviewDescription(review(), NOW, "assignee")).to.equal("#12831 → unassigned · 1d");
    expect(reviewDescription(row, NOW, "both")).to.equal("#12831 · erin.author → priya.nair · 1d");
    expect(reviewDescription(review(), NOW, "both")).to.equal("#12831 · erin.author → unassigned · 1d");
    expect(reviewDescription(review({ targetType: "label" }), NOW))
      .to.equal("#12831 · erin.author · 1d · label (not supported)");
    expect(reviewPeople(row, NOW)).to.equal("erin.author → priya.nair · 1d");
  });

  it("names a review's target by the branch path of a generated title, a looked-up name, or its changeset", () => {
    expect(reviewTargetName(review({ title: "Review of branch /main/PartnerDemo" }))).to.equal("/main/PartnerDemo");
    expect(reviewTargetName(review({ title: "[apply-change:38c85554] Review of branch /main/task - Fixes" })))
      .to.equal("/main/task");
    // A title the author wrote does not name the branch, and a review row only has the branch's object id.
    expect(reviewTargetName(review())).to.equal("branch");
    expect(reviewTargetName(review(), BRANCH_NAME)).to.equal(BRANCH_NAME);
    expect(reviewTargetName(review({ target: "3671", targetType: "changeset" }))).to.equal("cs:3671");
    expect(reviewTargetName(review({ targetType: "label" }))).to.equal("label (not supported)");
    // Only a branch review whose title does not name the branch needs a branch query.
    expect(unnamedBranchId(review())).to.equal(11931);
    expect(unnamedBranchId(review({ title: "Review of branch /main/PartnerDemo" }))).to.equal(undefined);
    expect(unnamedBranchId(review({ target: "3671", targetType: "changeset" }))).to.equal(undefined);
  });

  it("builds the Find Review… rows so a filter matches title, number, people, branch and status", () => {
    const reviews = [
      review({ assignee: "priya.nair@example.com", id: 13141, title: "Review of branch /main/PartnerDemo" }),
      review({ id: 12511, status: "Reviewed", target: "3671", targetType: "changeset",
        title: "Review of changeset 3671 - Tentative fix @ RAC-3951" }),
      review({ status: "Rework required" }),
      review({ id: 7, target: "BL1", targetType: "label", title: "Cost $(mono) labels" }),
    ];
    const items = reviewPickItems(reviews, NOW, "");
    expect(items.map(item => item.label)).to.deep.equal([
      "$(eye) PartnerDemo",
      "$(pass) Tentative fix @ RAC-3951",
      "$(request-changes) Lap Timer Accuracy",
      // The list's icon for a review it cannot open; a `$(` of the title's own is not drawn as an icon.
      "$(circle-slash) Cost \\$(mono) labels",
    ]);
    expect(items.map(item => item.description)).to.deep.equal([
      "#13141 · erin.author → priya.nair · 1d",
      "#12511 · erin.author → unassigned · 1d",
      "#12831 · erin.author → unassigned · 1d",
      "#7 · erin.author → unassigned · 1d",
    ]);
    expect(items.map(item => item.detail)).to.deep.equal([
      "/main/PartnerDemo · Under review",
      "cs:3671 · Reviewed",
      "branch · Rework required",
      "label (not supported) · Under review",
    ]);
    expect(items.map(item => item.review)).to.deep.equal(reviews);
    expect(items.map(item => item.id)).to.deep.equal([ 13141, 12511, 12831, 7 ]);
    expect(items.some(item => item.alwaysShow)).to.equal(false);

    // A looked-up branch name takes the place of `branch`, so typing the branch finds the review.
    const named = reviewPickItems(reviews, NOW, "", { branches: new Map([[ 11931, BRANCH_NAME ]]) });
    expect(named[2].detail).to.equal(`${BRANCH_NAME} · Rework required`);
    expect(named.filter((_, index) => index !== 2)).to.deep.equal(items.filter((_, index) => index !== 2));
    // A deleted branch has no name.
    expect(reviewPickItems(reviews, NOW, "", { branches: new Map([[ 99, "/main/other" ]]) })).to.deep.equal(items);

    // A number newer than every listed review may be one created since: it comes last, and opens by ID.
    const typed = reviewPickItems(reviews, NOW, " #13301 ");
    expect(typed.slice(0, -1)).to.deep.equal(items);
    expect(typed[4]).to.deep.equal(
      { alwaysShow: true, description: "#13301 · not in this list", id: 13301, label: OPEN_BY_ID });
    expect(openableReviewNumber(reviews, " #13301 ")).to.equal(13301);
    // In a complete list, a listed number, a lower one (a changeset's, a ticket's) or other text adds nothing.
    for (const text of [ "12831", "#12511", "3671", "3981", "Partner", "0", "12a", "-5" ]) {
      expect(reviewPickItems(reviews, NOW, text), text).to.deep.equal(items);
      expect(openableReviewNumber(reviews, text), text).to.equal(undefined);
    }
    // A list cut at its limit may leave any number out; a listed one still adds nothing.
    expect(reviewPickItems(reviews, NOW, "3981", { truncated: true }).map(item => item.id))
      .to.deep.equal([ 13141, 12511, 12831, 7, 3981 ]);
    expect(reviewPickItems(reviews, NOW, "12831", { truncated: true })).to.deep.equal(items);
    // Before the reviews arrive, any number can be opened; in a repository without reviews, any number is newer.
    expect(reviewPickItems([], NOW, "5", { loading: true }))
      .to.deep.equal([{ alwaysShow: true, description: "#5", id: 5, label: OPEN_BY_ID }]);
    expect(openableReviewNumber([], "5")).to.equal(5);
  });

  it("gives Enter the review a number names, else that changeset's newest review", () => {
    const items = reviewPickItems([
      review({ id: 13141, title: "Review of branch /main/PartnerDemo" }),
      review({ id: 12511, status: "Reviewed", target: "3671", targetType: "changeset" }),
      review({ id: 11011, target: "cs:3671", targetType: "changeset" }),
      review({ id: 3671, title: "A review numbered like the changeset" }),
    ], NOW, "");
    expect(exactReviewPick(items, "13141")).to.equal(items[0]);
    expect(exactReviewPick(items, " #12511 ")).to.equal(items[1]);
    // Wherever the picker's fuzzy match puts the rows, Enter opens the review of changeset 3671.
    expect(exactReviewPick(items.slice(0, 3), "3671")).to.equal(items[1]);
    expect(exactReviewPick(items.slice(2, 3), "3671")).to.equal(items[2]);
    // The review with that number comes first, and `#N` names a review only.
    expect(exactReviewPick(items, "3671")).to.equal(items[3]);
    expect(exactReviewPick(items.slice(0, 3), "#3671")).to.equal(undefined);
    for (const text of [ "", "Partner", "3981", "0", "cs:3671" ]) {
      expect(exactReviewPick(items, text), text).to.equal(undefined);
    }
  });

  it("reads a review row out in words, naming the author, the assignee and the age", () => {
    expect(reviewAriaLabel(review({ assignee: "priya.nair@example.com", status: "Reviewed" }), NOW)).to.equal(
      "Lap Timer Accuracy, Reviewed, review 12831, by erin.author, assigned to priya.nair, 1 day ago");
    expect(reviewAriaLabel(review({ date: "", owner: "", status: "", targetType: "label" }), NOW)).to.equal(
      "Lap Timer Accuracy, unknown status, review 12831, by unknown, unassigned, " +
      "label review, not supported");
  });

  describe("threads", () => {
    it("labels and colours change requests by state", () => {
      const pending = thread({ type: "change" });
      const applied = thread({ appliedInChangesetId: 3673, type: "change" });
      const discarded = thread({ type: "change" }, [{ owner: "Author", text: "Not now", type: "discarded" }]);
      expect([ pending, applied, discarded ].map(item => item.state))
        .to.deep.equal([ "pending", "applied", "discarded" ]);
      expect(threadTypeLabel(pending)).to.equal("Change request");
      expect(threadTypeLabel(applied)).to.equal("Change request · applied in cs:3673");
      expect(threadTypeLabel(discarded)).to.equal("Change request · discarded");
      // A comment type cm added later is still a comment; only a timeline row is review activity.
      expect(threadTypeLabel(thread({ type: "suggestion" }))).to.equal("Comment");
      expect(threadIcon(pending)).to.deep.equal({ color: "charts.orange", id: "request-changes" });
      expect(threadIcon(applied)).to.deep.equal({ color: "testing.iconPassed", id: "pass" });
      expect(threadIcon(discarded)).to.deep.equal({ color: "disabledForeground", id: "circle-slash" });
      expect(threadContext(discarded)).to.equal("thread;change;discarded");
      expect(threadDescription(applied, NOW)).to.equal("L4 · Reviewer · 21d · applied in cs:3673");
      expect(threadDescription(discarded, NOW)).to.equal("L4 · Reviewer · 21d · 1 reply · discarded");
    });

    it("labels questions, comments and conversations", () => {
      const question = thread({ type: "question" });
      const note = thread({ type: "comment" });
      const conversation = thread({ location: -1, revisionId: -1, type: "conversation" });
      expect(threadIcon(question)).to.deep.equal({ color: "charts.blue", id: "question" });
      expect(threadIcon(note)).to.deep.equal({ id: "comment" });
      expect(threadIcon(conversation)).to.deep.equal({ id: "comment-discussion" });
      expect(threadContext(conversation)).to.equal("thread;conversation;none");
      // Conversations have no line.
      expect(threadDescription(conversation, NOW)).to.equal("Reviewer · 21d");
    });

    it("leads a verdict with the status it set", () => {
      const verdict = thread({
        location: -1, revisionId: -1, text: "[status-reviewed]LGTM, none blocking.", type: "timeline",
      });
      expect(verdict.kind).to.equal("status");
      expect(threadSummary(verdict)).to.equal("Reviewed · LGTM, none blocking.");
      expect(threadIcon(verdict)).to.deep.equal({ color: "testing.iconPassed", id: "pass" });
      const rework = thread(
        { location: -1, revisionId: -1, text: "[status-rework-required]", type: "timeline" },
        [{ location: -1, revisionId: -1, text: "Fixed it", type: "comment" }]);
      expect(threadSummary(rework)).to.equal("Rework required");
      expect(threadIcon(rework)).to.deep.equal({ color: "charts.orange", id: "request-changes" });
      expect(threadContext(rework)).to.equal("thread;status;none");
    });

    it("summarises the root's first non-empty line, up to 80 characters", () => {
      expect(threadSummary(thread({ text: "\n\n  First line  \nsecond" }))).to.equal("First line");
      // A label is not Markdown: code spans show as their text.
      expect(threadSummary(thread({ text: "Clamp to `MaxStack` here" }))).to.equal("Clamp to MaxStack here");
      const long = threadSummary(thread({ text: "x".repeat(100) }));
      expect(long).to.have.length(80);
      expect(long.endsWith("…")).to.equal(true);
      expect(threadSummary(thread({ text: "  ", type: "change" }))).to.equal("(change request without text)");
    });

    it("counts pending, applied and discarded change requests and questions", () => {
      const counts = threadCounts([
        thread({ type: "change" }),
        thread({ appliedInChangesetId: 3, type: "change" }),
        thread({ type: "question" }),
        thread({ location: -1, revisionId: -1, type: "conversation" }),
      ]);
      expect(counts).to.deep.equal({ applied: 1, discarded: 0, pending: 1, questions: 1, total: 4 });
    });

    it("puts the whole thread in an untrusted tooltip, with where it is and what a click opens", () => {
      const discarded = thread(
        { owner: "priya.nair@example.com", text: "Use `List<Sprite>`\nhere", type: "change" },
        [{ owner: "Author", text: "Out of scope <b>here</b>", type: "discarded" }]);
      discarded.path = "/Code/Inventory/InventorySlot.cs";
      const tooltip = threadTooltip(discarded);
      expect(tooltip.isTrusted).to.not.equal(true);
      expect(tooltip.supportHtml).to.not.equal(true);
      expect(tooltip.supportThemeIcons).to.not.equal(true);
      const text = plain(tooltip);
      expect(text).to.match(/^\*\*priya\.nair\*\* · Change request · discarded · /);
      expect(text).to.not.contain("@example.com");
      // The comment renders as Markdown, as in the diff: the code span stays one.
      expect(tooltip.value).to.contain("`List<Sprite>`");
      expect(tooltip.value).to.contain("\n\n---\n\n**Author** · Discarded · ");
      // HTML is escaped, so the tag stays text instead of vanishing.
      expect(tooltip.value).to.contain("Out of scope \\<b\\>here\\</b\\>");
      expect(text).to.match(/\n---\n\nInventorySlot\.cs · line 4 · revision 11 · click to open in the diff$/);
      const general = plain(threadTooltip(thread({ location: -1, revisionId: -1, type: "conversation" })));
      expect(general).to.match(/Click to open the Overview$/);
    });

    it("closes a code block a comment leaves open, so it cannot swallow the rest of the thread", () => {
      const reply: Partial<IReviewComment> = { owner: "Author", text: "Fixed", type: "comment" };
      const open = thread({ text: "```\nvar x = new List<int>();" }, [reply]);
      const tooltip = threadTooltip(open);
      expect(tooltip.value).to.contain("```\nvar x = new List<int>();\n```\n\n---\n\n**Author** · Comment · ");
      // The fence count is even, so the location footer is text again.
      expect(tooltip.value.match(/^```$/gm)).to.have.length(2);
      expect(plain(tooltip)).to.match(/\n---\n\nline 4 · revision 11 · click to open in the diff$/);
    });

    it("labels a reply by its own type", () => {
      expect([ "discarded", "question", "change", "comment", "conversation" ].map(type =>
        commentTypeLabel(comment({ type: type as never }))))
        .to.deep.equal([ "Discarded", "Question", "Change request", "Comment", "Comment" ]);
    });
  });

  it("summarises updates", () => {
    expect(updateSummary({ newComments: 2, newHead: 3733, removedComments: 0, status: "Rework required" }))
      .to.equal("branch moved to cs:3733 · 2 new comments · status: Rework required");
    expect(updateSummary({ newComments: 1, newHead: -1, removedComments: 1 }))
      .to.equal("branch deleted · 1 new comment · 1 comment removed");
    expect(updateSummary({ newComments: 0, removedComments: 0 })).to.equal("changes available");
  });

  it("offers a retry in error tooltips and colours rows through tone URIs", () => {
    expect(retryTooltip("Connection to the server was lost")).to.equal(
      "Connection to the server was lost. Select to retry.");
    expect(retryTooltip("Access denied.")).to.equal("Access denied. Select to retry.");
    expect(retryTooltip("cm failed\nat line 2")).to.equal("cm failed\nat line 2\n\nSelect to retry.");
    const uri = toneUri("link", "list/wk/allOpen/more");
    expect(uri.scheme).to.equal(ROW_TONE_SCHEME);
    expect(toneColor(uri)).to.equal("textLink.foreground");
    expect(toneColor(toneUri("error", "x"))).to.equal("list.errorForeground");
    expect(toneColor(toneUri("muted", "x"))).to.equal("descriptionForeground");
    expect(toneColor(toneUri("disabled", "x"))).to.equal("disabledForeground");
    expect(toneColor(avatarUri("tom.okafor"))).to.equal(undefined);
  });

  it("draws an initials avatar per author, the same everywhere", () => {
    const avatar = avatarUri("tom.okafor@example.com");
    expect(avatar.scheme).to.equal("data");
    expect(avatarUri("tom.okafor")).to.equal(avatar);
    const svg = Buffer.from(avatar.path.substring(avatar.path.indexOf(",") + 1), "base64").toString("utf8");
    expect(svg).to.contain(">TO</text>");
    const single = avatarUri("<admin>");
    const singleSvg = Buffer.from(single.path.substring(single.path.indexOf(",") + 1), "base64").toString("utf8");
    expect(singleSvg).to.contain(">&lt;A</text>");
  });

  it("picks avatar initials and a colour from the name alone", () => {
    expect(avatarInitials("tom.okafor@example.com")).to.equal("TO");
    expect(avatarInitials("build")).to.equal("BU");
    expect(avatarInitials("")).to.equal("?");
    expect(avatarColor("Tom.Okafor@example.com")).to.equal(avatarColor("tom.okafor"));
    expect(avatarColor("tom.okafor")).to.match(/^#[0-9a-f]{6}$/);
  });

  it("gives avatars ten colours that white initials read on at 4.5:1 or better", () => {
    const colours = new Set(Array.from({ length: 500 }, (_, index) => avatarColor(`user${index}@example.com`)));
    expect(colours.size).to.equal(10);
    colours.forEach(colour => expect(contrastWithWhite(colour), colour).to.be.at.least(4.5));
    // The people of each artboard get colours of their own.
    expect(new Set([ "tom.okafor", "leo.brandt", "maya.chen" ].map(owner => avatarColor(owner))).size).to.equal(3);
    expect(new Set([ "alex.moreau", "sara.nyberg", "jonas.berg" ].map(owner => avatarColor(owner))).size).to.equal(3);
  });

  it("splits text at its code spans as CommonMark does", () => {
    expect(splitCodeSpans("Clamp to `MaxStack` now")).to.deep.equal([
      { code: false, text: "Clamp to " }, { code: true, text: "MaxStack" }, { code: false, text: " now" },
    ]);
    expect(splitCodeSpans("``a ` b`` and `c\nd`")).to.deep.equal([
      { code: true, text: "a ` b" }, { code: false, text: " and " }, { code: true, text: "c d" },
    ]);
    expect(splitCodeSpans("an `unclosed span")).to.deep.equal([{ code: false, text: "an `unclosed span" }]);
  });

  describe("tooltips", () => {
    it("escapes user text in the review tooltip", () => {
      const tooltip = reviewTooltip(review({ assignee: "", title: "$(alert) **[a](b)** <b>" }), NOW);
      expect(tooltip.isTrusted).to.not.equal(true);
      expect(tooltip.supportThemeIcons).to.equal(true);
      // The status icon is ours; the one in the title is escaped.
      expect(tooltip.value).to.match(/^\*\*/);
      expect(tooltip.value).to.contain("$(eye)");
      expect(tooltip.value).to.not.contain("$(alert)");
      expect(plain(tooltip)).to.contain("$(alert)");
      expect(tooltip.value).to.contain("\\*\\*\\[a\\]\\(b\\)\\*\\*");
      const text = plain(tooltip);
      expect(text).to.contain("Under review · #12831");
      expect(text).to.contain("Author: erin.author@example.com");
      expect(text).to.contain("Assignee: unassigned");
      expect(text).to.contain("Target: branch (id:11931)");
      expect(text).to.contain("(1 day ago)");
    });

    it("describes a file row's revisions, move, discussions and diff support", () => {
      const moved = file({
        baseRevisionId: 11242,
        oldPath: "/Assets/Data/Old.asset",
        path: "/Assets/Data/New.asset",
        revisionId: 12411,
        status: FileChangeStatus.Changed | FileChangeStatus.Moved,
      });
      const text = plain(fileTooltip(moved, [ thread({ type: "change" }), thread({ type: "question" }) ]));
      expect(text).to.contain("/Assets/Data/New.asset");
      expect(text).to.contain("Moved and changed · revision 12411 · base revision 11242");
      expect(text).to.contain("Moved from /Assets/Data/Old.asset");
      expect(text).to.contain("2 discussions (1 pending change request)");
      const binary = plain(fileTooltip(file({ revisionType: RevisionType.BinaryFile })));
      expect(binary).to.contain("Binary file: no text diff");
      expect(changeKind(file({ status: FileChangeStatus.Deleted }))).to.equal("Deleted");
      expect(contentKind(file({ revisionType: RevisionType.BinaryFile }))).to.equal("binary");
      expect(contentKind(file({ baseRevisionId: -1, parentRevisionId: -1 }))).to.equal("nodiff");
      expect(contentKind(file())).to.equal("text");
      expect(noDiffMessage(file({ path: "/Art/Sky.png", revisionType: RevisionType.BinaryFile })))
        .to.equal("Sky.png is a binary file. Plastic SCM has no text diff for it.");
      expect(noDiffMessage(file({ baseRevisionId: -1, parentRevisionId: -1 })))
        .to.equal("Test.cs has no content change recorded: both sides are the same revision.");
      expect(noDiffMessage(file())).to.equal(undefined);
      const sameAsHead = plain(fileTooltip(file(), [], true));
      expect(sameAsHead).to.contain("Same revision as the review head: viewed together with Changes.");
    });

    it("notes merges in the changeset tooltip", () => {
      const changeset: IReviewChangeset = {
        branch: "/main/feature_x",
        comment: "Merge from main",
        date: new Date("2026-09-21T14:00:07+01:00"),
        guid: "",
        id: 3699,
        isMerge: true,
        mergeSourceBranch: "/main",
        owner: "erin.author@example.com",
        parentId: 3684,
        repository: "Nimbus/Nimbus",
        server: "unity",
      };
      const text = plain(changesetTooltip(changeset, NOW, false));
      expect(text).to.contain("cs:3699");
      expect(text).to.contain("Merge from main");
      expect(text).to.contain("Merge from /main.");
      expect(text).to.contain("Expanding lists every merged file.");
      expect(plain(changesetTooltip({ ...changeset, isMerge: false }, NOW, true))).to.contain("head of this review");
    });
  });
});

/** The WCAG contrast of white text on `colour` (`#rrggbb`). */
function contrastWithWhite(colour: string): number {
  const channel = (index: number) => {
    const value = parseInt(colour.substring(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return 1.05 / (luminance + 0.05);
}
