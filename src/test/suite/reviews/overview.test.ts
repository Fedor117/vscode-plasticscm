import { ageInWords, hasLocation, shortDateTime } from "../../../reviews/reviewPresentation";
import { AUTHOR, CHANGESET_REVIEW_ID, comment, file, LAP_TIMER_PATH, ME } from "./fixtures";
import {
  EMAIL,
  expectEveryGeneralThread,
  expectLinksOpen,
  expectWellFormed,
  HANDLER,
  headings,
  links,
  testLink,
  textLines,
  visible,
} from "./overviewFixtures";
import { FileChangeStatus, RevisionType } from "../../../models";
import {
  fileKey,
  groupReviewThreads,
  IReviewChangeset,
  IReviewComment,
  IReviewDiscussions,
} from "../../../reviews/models";
import {
  groupChangesets,
  IOverviewOptions,
  OverviewLinkTarget,
  renderOverview,
} from "../../../reviews/reviewOverview";
import { IScenario, loadScenario, NOW, readyReview, review } from "./viewFixtures";
import { expect } from "chai";
import { IActiveReview } from "../../../reviews/sessionTypes";
import { parseTimeline } from "../../../reviews/timeline";

/** Server text that would end the HTML block, run a script and draw a link if it were not escaped. */
const EVIL = "</div>\n\n<script>alert(1)</script><img src=x onerror=\"alert(1)\"> & 'q' # *x* [a](javascript:alert(1))";

function evil(field: string): string {
  return `${field}${EVIL}`;
}

function options(overrides: Partial<IOverviewOptions> = {}): IOverviewOptions {
  return { isViewed: () => false, now: NOW, ...overrides };
}

function at(date: string | Date): string {
  return shortDateTime(date, NOW);
}

/** A Conversation entry's date: `22 Sep 17:10, 50 minutes ago`. */
function when(date: string | Date): string {
  return `${at(date)}, ${ageInWords(date, NOW)}`;
}

function ago(minutes: number): string {
  return new Date(NOW - minutes * 60000).toISOString();
}

/** A timeline row `minutes` before the tests' clock, long after the fixture review was opened. */
function event(id: number, minutes: number, text: string, owner = AUTHOR): IReviewComment {
  return comment({ date: ago(minutes), id, location: -1, owner, revisionId: -1, text, type: "timeline" });
}

function reply(id: number, parentId: number, minutes: number, text: string, owner: string): IReviewComment {
  return comment({ date: ago(minutes), id, location: -1, owner, parentId, revisionId: -1, text, type: "comment" });
}

function discussionsOf(rows: IReviewComment[]): IReviewDiscussions {
  const timeline = parseTimeline(rows);
  return { reviewers: [], threads: groupReviewThreads(rows, timeline), timeline };
}

const NO_CHANGESETS: IActiveReview["changesets"] = { state: "ready", value: { hasMore: false, items: [] }};

/** The scenario with these comment rows as its discussions, and no changesets unless `overrides` has some. */
function withComments(scenario: IScenario, rows: IReviewComment[], overrides: Partial<IActiveReview> = {}):
    IActiveReview {
  return readyReview(scenario, {
    changesets: NO_CHANGESETS, discussions: { state: "ready", value: discussionsOf(rows) }, ...overrides,
  });
}

/** A changeset of the branch `minutes` before the tests' clock. */
function branchChangeset(id: number, minutes: number, text: string, owner = AUTHOR,
    extra: Partial<IReviewChangeset> = {}): IReviewChangeset {
  return {
    branch: "/main/feature_lap_timer", comment: text, date: new Date(NOW - minutes * 60000), guid: `guid-${id}`, id,
    isMerge: false, owner, parentId: id - 1, repository: "Nimbus", server: "local", ...extra,
  };
}

function changesetsOf(...items: IReviewChangeset[]): IActiveReview["changesets"] {
  return { state: "ready", value: { hasMore: false, items: items.slice().reverse() }};
}

const HEADINGS = [ "Reviewers", "Open items", "Changeset comment", "Conversation", "Files" ];

/** The lines from a section's heading (`Files 53`) up to the next heading. */
function section(lines: string[], heading: string): string[] {
  const isHeading = (line: string, title: string) => line === title || new RegExp(`^${title} [\\d,]+\\+?$`).test(line);
  const start = lines.findIndex(line => isHeading(line, heading));
  expect(start, heading).to.be.at.least(0);
  const end = lines.findIndex((line, index) => index > start && HEADINGS.some(title => isHeading(line, title)));
  return lines.slice(start, end < 0 ? lines.length : end);
}

/** A line without its date: `erin.author opened the review`. */
function dateless(line: string): string {
  return line.replace(/ · \d{1,2} \w{3}(?: \d{4})? \d\d:\d\d, [^·]*$/, "");
}

/** The Conversation's lines after its heading, without their dates. */
function told(html: string): string[] {
  return section(textLines(html), "Conversation").slice(1).map(dateless);
}

describe("Review overview", () => {
  let scenario: IScenario;
  let changesetScenario: IScenario;
  before(async () => {
    scenario = await loadScenario();
    changesetScenario = await loadScenario(CHANGESET_REVIEW_ID);
  });

  it("renders a branch review as one HTML block: where it stands, then one Conversation, oldest first", () => {
    const active = readyReview(scenario);
    const html = renderOverview(active, options({ link: testLink, whoami: ME }));
    expectWellFormed(html);
    const changesetDate = when(scenario.changesets.items[0].date);
    expect(textLines(html)).to.deep.equal([
      "Branch review · #12831",
      "Lap Timer Accuracy",
      `Under review erin.author → alex.reviewer (you) · opened ${at(scenario.review.date)}, 1 day ago`,
      "/main/feature_lap_timer cs:3471 ↔ cs:3715",
      "Waiting on erin.author (author) alex.reviewer (you) asked for rework. " +
        "1 change request is pending and 1 question is open.",
      "Files viewed: 0 of 5 · 2 more came in through merges",
      "Change requests: 1 pending · 1 applied · 1 discarded",
      "Questions: 1 open · none answered yet",
      "Sign-off: 0 of 1 · reviewers approved",
      "Reviewers 1",
      "alex.reviewer you assignee Rework required",
      "30 minutes ago · no comment",
      "Open items 2",
      "Change request GhostRunAnalyticsCollector.cs:287 Assets/Code/Events/GhostRuns alex.reviewer · " +
        "1 hour ago",
      "Would one shared property on the 'RaceSessionManager' be simpler for callers?",
      "Question SaveSystem.cs:154 Assets/Code/Core alex.reviewer · 1 hour ago",
      "If a third save source turns up, an interface would pay off here.",
      "Conversation",
      // The branch's changesets came before the review: one person within half an hour, one entry.
      `erin.author checked in 3 changesets · ${changesetDate}`,
      "cs:3477 Merge from /main",
      "cs:3699 Merge from /main",
      "cs:3715 Change 3715",
      `erin.author opened the review · ${when(scenario.review.date)}`,
      "erin.author renamed it from “Review of branch /main/feature_lap_timer - Epic: RAC-3861” to " +
        `“Lap Timer Accuracy” · ${when("2026-09-21T16:04:42+01:00")}`,
      // The request is written twice, once per marker format, in the same second: one entry.
      `alex.reviewer joined as a reviewer · ${when("2026-09-22T16:11:21+01:00")}`,
      "Change request GhostRunAnalyticsCollector.cs:287 Assets/Code/Events/GhostRuns",
      `alex.reviewer · ${when("2026-09-22T16:16:24+01:00")}`,
      "Would one shared property on the 'RaceSessionManager' be simpler for callers?",
      "One check for callers.",
      "Question SaveSystem.cs:154 Assets/Code/Core",
      `alex.reviewer · ${when("2026-09-22T16:21:45+01:00")}`,
      "If a third save source turns up, an interface would pay off here.",
      "Change request · applied in cs:3718 LapTimer.cs:41 Assets/Code/Laps",
      `alex.reviewer · ${when("2026-09-22T16:26:45+01:00")}`,
      "Compare against the qualifying end date too.",
      "Change request · discarded LapTimer.cs:13 Assets/Code/Laps",
      `alex.reviewer · ${when("2026-09-22T16:30:00+01:00")}`,
      "This allocates a new List<Sprite> each frame.",
      `erin.author Discarded · ${when("2026-09-22T17:00:00+01:00")}`,
      "Out of scope for this branch.",
      `erin.author · ${when("2026-09-22T17:05:00+01:00")}`,
      "Appreciate the quick look!",
      // A verdict with a reply that is no longer the reviewer's latest.
      `alex.reviewer marked it Reviewed · ${when("2026-09-22T17:10:00+01:00")}`,
      "LGTM, only a few small questions, none blocking.",
      `erin.author · ${when("2026-09-22T17:20:00+01:00")}`,
      "Both points addressed. Cheers!",
      `alex.reviewer asked for rework · ${when("2026-09-22T17:30:00+01:00")}`,
      "Comment LapTimer.cs:56 Assets/Code/Laps",
      `alex.reviewer · ${when("2026-09-22T17:40:00+01:00")}`,
      "This constant was already here.",
      "Comment revision 6411:2",
      `alex.reviewer · ${when("2026-09-22T17:50:00+01:00")}`,
      "Old editor script.",
    ]);
    expect(html).to.contain("<span class=\"pill blue\"><span class=\"dot\" aria-hidden=\"true\"></span>" +
      "Under review</span>");
    expect(html).to.contain("<span class=\"pill orange\">Rework required</span>");
    // Names are plain text with the address in their title; only file references are links.
    expect(html).to.contain("<span class=\"who\" title=\"erin.author@example.com\">erin.author</span>");
    expect(html).to.contain(`<a href="${HANDLER}?thread=12907">GhostRunAnalyticsCollector.cs:287</a>`);
    // Open items, then every thread with a line in the Conversation.
    const located = scenario.discussions.threads.filter(hasLocation).length;
    expect(located).to.equal(6);
    expect(expectLinksOpen(html, active)).to.equal(2 + located);
    expect(visible(html)).to.not.match(EMAIL);
    expectEveryGeneralThread(html, scenario.discussions);
    // Resolved change requests look resolved; every file thread is marked as one.
    expect(html.match(/<li class="tl-item tl-comment on-file resolved">/g)).to.have.length(2);
    expect(html.match(/<li class="tl-item tl-comment on-file/g)).to.have.length(6);
  });

  it("renders a changeset review with its comment before the Conversation, its files after, and no changesets", () => {
    const active = readyReview(changesetScenario);
    const html = renderOverview(active, options({ link: testLink }));
    expectWellFormed(html);
    const lines = textLines(html);
    expect(lines.slice(0, 4)).to.deep.equal([
      "Changeset review · #7551",
      // Plastic's "Review of changeset 3203" says nothing more than the changeset.
      "cs:3203",
      `Under review erin.author → unassigned · opened ${at(changesetScenario.review.date)}, 7 months ago`,
      "cs:3203 cs:3195 ↔ cs:3203",
    ]);
    expect(headings(html)).to.deep.equal([ "Reviewers", "Open items", "Changeset comment", "Conversation", "Files" ]);
    expect(html).to.not.contain("checked in");
    expect(section(lines, "Changeset comment"))
      .to.deep.equal([ "Changeset comment", "TestGenerator: script, prompts and CI pipeline" ]);
    // The directory record is a folder, not a file to review.
    expect(section(lines, "Files")).to.deep.equal([ "Files 1", "A Jenkinsfile_test_generator" ]);
    expect(lines).to.include("Files viewed: 0 of 1 · no merged files");
    const target: OverviewLinkTarget = {
      fileKey: fileKey(changesetScenario.files.final.files.find(row => row.revisionType !== RevisionType.Directory)!),
      kind: "file",
      scope: "changes",
    };
    expect(links(html).map(link => link.href)).to.include(testLink(target));
    const located = changesetScenario.discussions.threads.filter(hasLocation).length;
    expect(expectLinksOpen(html, active)).to.equal(3 + located);
    expect(visible(html)).to.not.match(EMAIL);
  });

  it("leaves tool tags out of changeset comments, and a comment the title already says", () => {
    const tag = "[apply-change:a1c3e5f7-2b4d-4f6a-8c0e-13579bdf2468]";
    const reviewed = { ...changesetScenario.changesets.items[0], comment: `Remove the random order\n ${tag}` };
    const changesets: IActiveReview["changesets"] = { state: "ready", value: { hasMore: false, items: [reviewed] }};
    const html = renderOverview(readyReview(changesetScenario, { changesets }), options());
    expect(section(textLines(html), "Changeset comment"))
      .to.deep.equal([ "Changeset comment", "Remove the random order" ]);
    // Plastic's own title repeats the comment; the page says it once.
    const titled = renderOverview(readyReview(changesetScenario, {
      changesets,
      review: { ...changesetScenario.review, title: "Review of changeset 3203 - Remove the random order" },
    }), options());
    expect(textLines(titled)[1]).to.equal("Remove the random order");
    expect(headings(titled)).to.not.include("Changeset comment");
    const head = { ...scenario.changesets.items[0], comment: `${tag} Clamp the stack size` };
    const applied = { ...scenario.changesets.items[0], comment: "[apply-change:38c85554]", id: 3707 };
    const branch = renderOverview(readyReview(scenario, {
      changesets: { state: "ready", value: { hasMore: false, items: [ head, applied ] }},
    }), options());
    expect(textLines(branch).filter(line => line.startsWith("cs:")))
      .to.deep.equal([ "cs:3707 (applied a change request)", "cs:3715 Clamp the stack size" ]);
    expect(html + titled + branch).to.not.contain("apply-change");
  });

  it("escapes every string from the server, so none of it becomes markup or ends the HTML block", () => {
    const rows = [
      event(2271, 600, `[requested-review-from]${evil("request")}`, evil("owner")),
      event(2272, 590, `[requested-review-from]${evil("reviewer")}`, evil("owner")),
      event(2273, 500, `[status-reviewed]${evil("verdict")}`, evil("reviewer")),
      reply(2274, 2273, 490, evil("reply"), evil("replier")),
      event(2275, 480, `[renamed-title]${evil("previous")}#->#${evil("renamed")}`, evil("owner")),
      event(2276, 470, `[description]${evil("description")}`, evil("owner")),
      event(2277, 460, evil("note"), evil("owner")),
      comment({
        date: ago(450), id: 2278, location: -1, owner: evil("talker"), revisionId: -1, text: evil("conversation"),
        type: "conversation",
      }),
      reply(2279, 2278, 440, evil("answer"), evil("answerer")),
      comment({
        date: ago(430), id: 2280, location: 16, owner: evil("requester"), revisionId: 5, text: evil("change"),
        type: "change",
      }),
      comment({
        date: ago(420), id: 2281, location: 3, owner: evil("asker"), revisionId: 6, text: evil("question"),
        type: "question",
      }),
      // A reply on a file's line, which the Conversation prints in full too.
      comment({
        date: ago(410), id: 2282, location: 16, owner: evil("fileReplier"), parentId: 2280, revisionId: 5,
        text: evil("fileReply"), type: "comment",
      }),
    ];
    const discussions = { ...discussionsOf(rows), message: evil("message") };
    discussions.threads.find(thread => thread.id === 2280)!.path = `/Assets/path${EVIL}/File.cs`;
    const base = scenario.changesets.items[0];
    const active: IActiveReview = {
      changesets: {
        state: "ready",
        value: {
          hasMore: false,
          items: [
            { ...base, comment: evil("csComment"), owner: evil("csOwner") },
            { ...base, id: 3699, isMerge: true, mergeSourceBranch: evil("source") },
          ],
        },
      },
      discussions: { state: "ready", value: discussions },
      files: {
        state: "ready",
        value: {
          ...scenario.files,
          branch: { ...scenario.files.branch!, name: evil("branch") },
          final: { ...scenario.files.final, label: evil("label") },
        },
      },
      review: review({
        assignee: evil("assignee"),
        owner: evil("owner"),
        status: evil("status"),
        title: `Review of branch /main/x - ${evil("title")}`,
      }),
      updates: { comments: [], newComments: 1, removedComments: 0, status: evil("update") },
      workspaceId: "wk",
    };
    const html = renderOverview(active, options({ link: testLink, whoami: evil("owner") }));
    expectWellFormed(html);
    // Open items, and the same two threads in the Conversation.
    expect(expectLinksOpen(html, active)).to.equal(4);
    expectEveryGeneralThread(html, discussions);
    const text = visible(html);
    const fields = [
      "title", "owner", "assignee", "status", "branch", "label", "update", "description", "message", "request",
      "reviewer", "verdict", "replier", "reply", "previous", "renamed", "note", "talker", "conversation", "answerer",
      "answer", "requester", "change", "asker", "question", "path", "csComment", "csOwner", "source",
      "fileReplier", "fileReply",
    ];
    for (const field of fields) {
      expect(text, field).to.contain(`${field}</div>`);
    }
    expect(text).to.contain("<script>alert(1)</script><img src=x onerror=\"alert(1)\"> & 'q' # *x* " +
      "[a](javascript:alert(1))");

    const failed = renderOverview(readyReview(scenario, {
      changesets: { message: evil("changesetsError"), state: "error" },
      discussions: { message: evil("discussionsError"), state: "error" },
      files: { message: evil("filesError"), state: "error" },
      review: active.review,
    }), options());
    expectWellFormed(failed);
    expect(visible(failed)).to.contain("discussionsError</div>").and.contain("changesetsError</div>");
    expect(failed).to.contain("title=\"filesError&lt;/div&gt;&#10;&#10;&lt;script&gt;alert(1)&lt;/script&gt;");

    const csFiles = [file({ path: `/dir${EVIL}/name${EVIL}.cs`, revisionId: 2401 })];
    const changeset = changesetScenario.changesets.items[0];
    const csActive = readyReview(changesetScenario, {
      changesets: {
        state: "ready",
        value: { hasMore: false, items: [{ ...changeset, comment: `${evil("first")}\n\n${evil("second")}` }] },
      },
      files: {
        state: "ready",
        value: { ...changesetScenario.files, final: { ...changesetScenario.files.final, files: csFiles }},
      },
    });
    const csHtml = renderOverview(csActive, options({ link: testLink }));
    expectWellFormed(csHtml);
    const located = changesetScenario.discussions.threads.filter(hasLocation).length;
    expect(expectLinksOpen(csHtml, csActive)).to.equal(3 + located);
    expect(visible(csHtml)).to.contain("first</div>").and.contain("second</div>").and.contain("dir</div>");
  });

  it("keeps blank lines in user text from ending the HTML block", () => {
    const blanks = "one\n\n\n  \n\ntwo\r\n\r\nthree\n \t\nfour";
    const rows = [
      event(2302, 600, `[requested-review-from]${ME}`),
      event(2303, 500, `[status-reviewed]${blanks}`, ME),
      event(2304, 400, `[description]${blanks}`),
      comment({ date: ago(300), id: 2305, location: -1, owner: AUTHOR, revisionId: -1, text: blanks,
        type: "conversation" }),
    ];
    const html = renderOverview(withComments(scenario, rows, {
      review: { ...scenario.review, title: `Review of branch /main/x - Tickets:\n\n${blanks}` },
    }), options());
    expectWellFormed(html);
    // The title's rest and the description open the Conversation, the verdict is quoted under its entry, the
    // comment is in full.
    expect(html.split("<p>one</p><p>two</p><p>three</p><p>four</p>").length - 1).to.equal(4);
    expect(html).to.contain("<blockquote class=\"quote\"><p>one</p><p>two</p><p>three</p><p>four</p></blockquote>");
  });

  it("links the http(s) URLs people wrote, and nothing else", () => {
    const text = [
      "Docs: https://example.com/a?b=1&c=2, and (https://en.wikipedia.org/wiki/Foo_(bar)).",
      "Also https://x.test/end. Quoted: https://example.com/q\"onmouseover=\"alert(1) and <https://example.com/angle>",
      "Not links: javascript:alert(1) file:///etc/passwd command:workbench.action.quit vscode://evil/x http:// ftp://x",
      "Code: `https://example.com/code`",
    ].join("\n");
    const rows = [comment({ date: ago(300), id: 2321, location: -1, owner: AUTHOR, revisionId: -1, text,
      type: "conversation" })];
    const html = renderOverview(withComments(scenario, rows, {
      review: { ...scenario.review, title: "Fix https://example.com/title." },
    }), options());
    expectWellFormed(html);
    expect(links(html)).to.deep.equal([
      "https://example.com/title",
      "https://example.com/a?b=1&c=2",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://x.test/end",
      "https://example.com/q",
      "https://example.com/angle",
    ].map(href => ({ href, text: href })));
    expect(html).to.contain("<h1 class=\"title\">Fix <a href=\"https://example.com/title\">" +
      "https://example.com/title</a>.</h1>");
    expect(html).to.contain("<a href=\"https://example.com/a?b=1&amp;c=2\">https://example.com/a?b=1&amp;c=2</a>,");
    expect(html).to.contain("(<a href=\"https://en.wikipedia.org/wiki/Foo_(bar)\">" +
      "https://en.wikipedia.org/wiki/Foo_(bar)</a>).");
    expect(html).to.contain("<code>https://example.com/code</code>");
    expect(visible(html)).to.contain("javascript:alert(1) file:///etc/passwd command:workbench.action.quit " +
      "vscode://evil/x http:// ftp://x");
  });

  it("links a file reference only to a URI the preview opens, and prints it plain otherwise", () => {
    const active = readyReview(scenario);
    const plain = renderOverview(active, options());
    expect(plain).to.not.contain("<a ");
    expect(plain).to.contain("<span class=\"pill orange\">Change request</span> GhostRunAnalyticsCollector.cs:287 " +
      "<span class=\"dim\">");
    expect(renderOverview(active, options({ link: () => undefined }))).to.equal(plain);
    const refused = [
      "command:plastic-scm.reviews.open", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x",
      "Assets/Code/Core/SaveSystem.cs", "/Assets/Code/Core/SaveSystem.cs", "vscode:extension/x", "",
    ];
    for (const href of refused) {
      expect(renderOverview(active, options({ link: () => href })), href).to.equal(plain);
    }
    const targets: OverviewLinkTarget[] = [];
    const linked = renderOverview(active, options({
      link: target => {
        targets.push(target);
        return testLink(target);
      },
    }));
    // Open items, then the Conversation's threads with a line, oldest first.
    expect(targets).to.deep.equal([ 12907, 12915, 12907, 12915, 12918, 12919, 12961, 12981 ]
      .map(threadId => ({ kind: "thread", threadId })));
    expect(linked).to.contain(`<a href="${HANDLER}?thread=12915">SaveSystem.cs:154</a>`);
    // A URI is an attribute value, escaped as one.
    const quoted = renderOverview(active, options({ link: () => `${HANDLER}?x="><script>` }));
    expectWellFormed(quoted);
    expect(quoted).to.contain(`<a href="${HANDLER}?x=&quot;&gt;&lt;script&gt;">`);
  });

  it("shows each stage loading or failed, without the sections that need it", () => {
    const opened = `Under review erin.author → alex.reviewer · opened ${at(scenario.review.date)}, 1 day ago`;
    const loading = renderOverview(readyReview(scenario, {
      changesets: { state: "loading" },
      discussions: { state: "loading" },
      files: { state: "loading" },
    }), options());
    expectWellFormed(loading);
    expect(textLines(loading)).to.deep.equal([
      "Branch review · #12831",
      "Lap Timer Accuracy",
      opened,
      "loading the branch…",
      "Loading the reviewers…",
      "Files viewed: loading…",
      "Change requests: loading…",
      "Questions: loading…",
      "Sign-off: loading…",
      // The Conversation says what is still loading, in the place its entries will take.
      "Conversation",
      "Loading the discussions…",
      "Loading the changesets…",
      `erin.author opened the review · ${when(scenario.review.date)}`,
    ]);
    const failed = renderOverview(readyReview(scenario, {
      changesets: { message: "cm find changeset failed\nwith detail", state: "error" },
      discussions: { message: "cm failed\nwith detail", state: "error" },
      files: { message: "cm diff failed", state: "error" },
    }), options());
    expectWellFormed(failed);
    expect(textLines(failed)).to.deep.equal([
      "Branch review · #12831",
      "Lap Timer Accuracy",
      opened,
      "couldn't load the branch",
      "Couldn't load the reviewers",
      "Files viewed: couldn't load",
      "Change requests: couldn't load",
      "Questions: couldn't load",
      "Sign-off: couldn't load",
      "Conversation",
      "Couldn't load the discussions: cm failed",
      "Couldn't load the changesets: cm find changeset failed",
      `erin.author opened the review · ${when(scenario.review.date)}`,
    ]);
    // The whole message is the tile's tooltip.
    expect(failed).to.contain("<li class=\"tile\" title=\"cm failed&#10;with detail\">");
    // A failed stage is an error notice, not the blue of the notices that only inform.
    expect(failed).to.contain("<p class=\"notice error\">Couldn't load the discussions: cm failed</p>");
    expect(failed).to.contain("<li class=\"tl-item tl-note\"><p class=\"notice error\">Couldn't load the changesets: " +
      "cm find changeset failed</p></li>");
    // Changesets that load later take the note's place, merged by date with the rest.
    const later = renderOverview(readyReview(scenario, { discussions: { state: "loading" }}), options());
    expect(section(textLines(later), "Conversation").map(dateless)).to.deep.equal([
      "Conversation", "Loading the discussions…", "erin.author checked in 3 changesets", "cs:3477 Merge from /main",
      "cs:3699 Merge from /main", "cs:3715 Change 3715", "erin.author opened the review",
    ]);
    // A first line that only introduces the reason keeps the reason.
    const introduced = renderOverview(readyReview(scenario, {
      discussions: { message: "cm find comment failed:\nThe server is unreachable.\nat line 3", state: "error" },
    }), options());
    expect(textLines(introduced))
      .to.include("Couldn't load the discussions: cm find comment failed: The server is unreachable.");
    // A changeset review says so where its files would be.
    const files = (stage: IActiveReview["files"]) =>
      section(textLines(renderOverview(readyReview(changesetScenario, { files: stage }), options())), "Files");
    expect(files({ state: "loading" })).to.deep.equal([ "Files", "Loading the files…" ]);
    expect(files({ message: "cm diff failed:\nno such changeset", state: "error" }))
      .to.deep.equal([ "Files", "Couldn't load the files: cm diff failed: no such changeset" ]);
  });

  it("marks a hidden branch, and a deleted one with a notice", () => {
    const hidden = renderOverview(readyReview(scenario, {
      files: { state: "ready", value: { ...scenario.files, branch: { ...scenario.files.branch!, hidden: true }}},
    }), options());
    expect(textLines(hidden)[3])
      .to.equal("/main/feature_lap_timer hidden branch cs:3471 ↔ cs:3715");
    // Sized and stroked by its own attributes too, so it stays small without the stylesheet.
    expect(hidden).to.contain("<svg class=\"icon\" width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" " +
      "stroke=\"currentColor\" stroke-width=\"1.2\" aria-hidden=\"true\">");
    const files = scenario.files;
    const deleted = renderOverview(readyReview(scenario, {
      files: {
        state: "ready",
        value: {
          ...files, branch: undefined, branchDeleted: true, final: { ...files.final, files: [] }, head: -1,
          mergedKeys: new Set(),
        },
      },
    }), options());
    expectWellFormed(deleted);
    const lines = textLines(deleted);
    expect(lines.slice(3, 5)).to.deep.equal([
      "branch deleted",
      "The branch no longer exists. Discussions still open their original context.",
    ]);
    // cm's object id is only the chip's title.
    expect(deleted).to.contain("<span class=\"chip\" title=\"Branch id:11931\">");
    expect(lines).to.include("Files viewed: 0 of 0 · the branch no longer exists");
    // A branch without changesets of its own has no sides to name.
    const empty = renderOverview(readyReview(scenario, {
      files: {
        state: "ready",
        value: { ...files, final: { ...files.final, files: [], label: "no changesets yet" }, mergedKeys: new Set() },
      },
    }), options());
    expect(textLines(empty)[3]).to.equal("/main/feature_lap_timer no changesets yet");
    expect(empty).to.contain("<span class=\"chip\">no changesets yet</span>");
  });

  it("says when the server has newer data, under the chips", () => {
    const html = renderOverview(readyReview(scenario, {
      updates: { comments: [], newComments: 2, newHead: 3718, removedComments: 1 },
    }), options());
    expectWellFormed(html);
    expect(textLines(html)[4]).to.equal("Newer data on the server: branch moved to cs:3718 · 2 new comments · " +
      "1 comment removed. Use Load Updates to see it.");
  });

  it("leads with the rest of the title and the latest description", () => {
    const title = "Review of branch /main/feature_lap_timer - Tickets:\n" +
      "https://jira.example/browse/RAC-1\nhttps://jira.example/browse/RAC-2";
    const rows = [
      event(2551, 600, "[description]First take"),
      event(2552, 500, "[description]Ticket: https://jira.example/browse/RAC-3\n\nSecond paragraph"),
    ];
    const titled = { ...scenario.review, title };
    const html = renderOverview(withComments(scenario, rows, { review: titled }), options());
    expectWellFormed(html);
    const link = (id: number) =>
      `<a href="https://jira.example/browse/RAC-${id}">https://jira.example/browse/RAC-${id}</a>`;
    // A first line that only introduces what follows gives way to the branch.
    expect(html).to.contain("<h1 class=\"title\">feature_lap_timer</h1>");
    expect(html).to.contain(`<div class="lead"><p>Tickets:<br>${link(1)}<br>${link(2)}</p>` +
      `<p>Ticket: ${link(3)}</p><p>Second paragraph</p></div>`);
    expect(visible(html)).to.not.contain("First take");
    // The description opens the Conversation as its author's card; the first one is the opening, a later one an edit.
    expect(told(html)).to.deep.equal([
      "erin.author Description", "Tickets:", "https://jira.example/browse/RAC-1", "https://jira.example/browse/RAC-2",
      "Ticket: https://jira.example/browse/RAC-3", "Second paragraph",
      "erin.author opened the review",
      "erin.author edited the description",
    ]);
    // Replies to the description sit under it in the opening card, once.
    const answered = renderOverview(withComments(scenario, [ ...rows, reply(2554, 2552, 450, "Which ticket?",
      ME) ], { review: titled }), options());
    expect(told(answered).slice(5, 9)).to.deep.equal([ "Second paragraph", "alex.reviewer", "Which ticket?",
      "erin.author opened the review" ]);
    expect(visible(answered).split("Which ticket?")).to.have.length(2);
    // An emptied description leaves only the title's rest.
    const cleared = renderOverview(withComments(scenario, [ ...rows, event(2553, 400, "[description]") ],
      { review: titled }), options());
    expect(cleared).to.contain(`<div class="lead"><p>Tickets:<br>${link(1)}<br>${link(2)}</p></div>`);
  });

  it("merges the review's creation, changesets, discussions and events into one Conversation, oldest first", () => {
    const bob = "bob@example.com";
    const rows = [
      event(2341, 600, `[requested-review-from]${bob}`),
      comment({ date: ago(500), id: 2342, location: -1, owner: AUTHOR, revisionId: -1, text: "Kick-off",
        type: "conversation" }),
      // A change request and a verdict written in the same minute keep the order of their ids.
      comment({ date: ago(400), id: 2343, location: 3, owner: bob, revisionId: 11, text: "Rename it",
        type: "change" }),
      event(2344, 400, "[status-rework-required]Please rename", bob),
      reply(2345, 2342, 350, "Welcome", bob),
    ];
    const items = [
      // Before the review was opened.
      branchChangeset(3001, 2000, "Prepare the timer"),
      branchChangeset(3002, 300, "Rename the timer"),
      branchChangeset(3003, 290, "Fix the tests"),
      branchChangeset(3004, 100, "Tidy up", bob),
      branchChangeset(3005, 50, "Last touch"),
    ];
    const changesets = changesetsOf(...items);
    const html = renderOverview(withComments(scenario, rows, { changesets }), options());
    expectWellFormed(html);
    expect(told(html)).to.deep.equal([
      "erin.author checked in cs:3001", "cs:3001 Prepare the timer",
      "erin.author opened the review",
      "erin.author requested a review from bob",
      // Replies stay under their comment, whenever they came.
      "erin.author", "Kick-off", "bob", "Welcome",
      "Change request revision 11:4", "bob", "Rename it",
      "bob asked for rework", "Please rename",
      "erin.author checked in 2 changesets", "cs:3002 Rename the timer", "cs:3003 Fix the tests",
      "bob checked in cs:3004", "cs:3004 Tidy up",
      "erin.author checked in cs:3005", "cs:3005 Last touch",
    ]);
    // The order does not depend on the order cm listed anything in.
    const shuffled = withComments(scenario, rows.slice().reverse(), {
      changesets: changesetsOf(...items.slice().sort((a, b) => a.id % 2 - b.id % 2)),
    });
    expect(renderOverview(shuffled, options())).to.equal(html);
  });

  it("groups a person's changesets within half an hour of each other, marks merges and applied change requests", () => {
    const bob = "bob@example.com";
    const minutes = (...values: number[]) =>
      values.map(value => ({ date: new Date(NOW - value * 60000), owner: AUTHOR }));
    const ids = (groups: Array<Array<{ date: Date }>>) => groups.map(group => group.length);
    // Each within 30 minutes of the one before it, however long the run.
    expect(ids(groupChangesets(minutes(200, 170, 140, 110)))).to.deep.equal([4]);
    expect(ids(groupChangesets(minutes(200, 169, 140)))).to.deep.equal([ 1, 2 ]);
    expect(ids(groupChangesets([ ...minutes(200), { date: new Date(NOW - 190 * 60000), owner: bob },
      ...minutes(180) ]))).to.deep.equal([ 1, 1, 1 ]);
    // cm prints the same address in different cases.
    expect(ids(groupChangesets([ ...minutes(200), { date: new Date(NOW - 190 * 60000), owner: AUTHOR.toUpperCase() }])))
      .to.deep.equal([2]);

    const applied = comment({
      appliedInChangesetId: 3012, date: ago(100), id: 2361, location: 3, revisionId: 11, text: "Rename it",
      type: "change",
    });
    const html = renderOverview(withComments(scenario, [applied], {
      changesets: {
        state: "ready",
        value: {
          hasMore: true,
          items: [
            branchChangeset(3013, 280, "", AUTHOR, { isMerge: true, mergeSourceBranch: "/main" }),
            branchChangeset(3012, 290, "[apply-change:38c85554]"),
            branchChangeset(3011, 300, "Rename the timer\nand say why"),
          ],
        },
      },
    }), options({ link: testLink }));
    expectWellFormed(html);
    const lines = told(html);
    expect(lines.slice(lines.indexOf("Older changesets are in the Review view."))).to.deep.equal([
      "Older changesets are in the Review view.",
      "erin.author checked in 3 changesets",
      "cs:3011 Rename the timer",
      "cs:3012 (applied a change request) · applied the change request on revision 11:4",
      "cs:3013 Merge from /main",
      "Change request · applied in cs:3012 revision 11:4", "Reviewer", "Rename it",
    ]);
    expect(html).to.contain("<span class=\"pill purple\">Merge</span>");
    // The applied change request links to its discussion from the changeset, as from its card.
    expect(links(html).filter(link => link.href === `${HANDLER}?thread=2361`)).to.have.length(2);
  });

  it("lists the newest 50 files of a changeset review and points at the Review view for the rest", () => {
    const many = Array.from({ length: 53 }, (_, index) => file({ path: `/Code/File${100 + index}.cs`,
      revisionId: 2442 + index }));
    const active = readyReview(changesetScenario, {
      files: { state: "ready", value: { ...changesetScenario.files, final: { ...changesetScenario.files.final,
        files: many }}},
    });
    const html = renderOverview(active, options({ link: testLink }));
    expectWellFormed(html);
    const files = section(textLines(html), "Files");
    expect(files).to.have.length(52);
    expect(files[0]).to.equal("Files 53");
    expect(files[1]).to.match(/^\S+ File100\.cs Code$/);
    expect(files[50]).to.match(/^\S+ File149\.cs Code$/);
    expect(files[51]).to.equal("3 more files are in the Review view.");
    const threads = links(html).filter(link => link.href.startsWith(`${HANDLER}?thread=`)).length;
    expect(expectLinksOpen(html, active)).to.equal(50 + threads);
  });

  it("marks the current user in the header and the summary only", () => {
    const asAuthor = textLines(renderOverview(readyReview(scenario), options({ whoami: AUTHOR.toUpperCase() })));
    expect(asAuthor[2]).to.match(/^Under review erin\.author \(you\) → alex\.reviewer · opened /);
    expect(asAuthor[4]).to.match(/^Waiting on erin\.author \(you, author\) alex\.reviewer asked for rework\./);
    expect(asAuthor).to.include("alex.reviewer assignee Rework required");
    const asReviewer = textLines(renderOverview(readyReview(scenario), options({ whoami: ME })));
    expect(asReviewer.filter(line => line.includes("(you)"))).to.have.length(2);
    expect(asReviewer).to.include("alex.reviewer you assignee Rework required");
    const asNobody = renderOverview(readyReview(scenario), options());
    expect(asNobody).to.not.contain("(you").and.not.contain(">you<");
  });

  it("says who the review waits on, from the reviewers' latest verdicts", () => {
    const unassigned = { ...scenario.review, assignee: "" };
    const standing = (rows: IReviewComment[], status = "Under review") => {
      const lines = textLines(renderOverview(withComments(scenario, rows, { review: { ...unassigned, status }}),
        options()));
      return [ lines[4], lines.find(line => line.startsWith("Sign-off"))! ];
    };
    const bob = "bob@example.com";
    const carol = "carol@example.com";
    const requests = [ event(2571, 600, `[requested-review-from]${bob}`), event(2572, 590,
      `[requested-review-from]${carol}`) ];
    const bobReviewed = event(2573, 500, "[status-reviewed]", bob);
    expect(standing([])).to.deep.equal([ "No reviewers requested yet Nothing is open.",
      "Sign-off: None · no reviewers yet" ]);
    expect(standing([ requests[0], bobReviewed ]))
      .to.deep.equal([ "bob marked it Reviewed Nothing is open.", "Sign-off: 1 of 1 · reviewers approved" ]);
    expect(standing([ ...requests, bobReviewed ])).to.deep.equal([
      "Waiting on carol bob marked it Reviewed. Nothing is open.", "Sign-off: 1 of 2 · reviewers approved",
    ]);
    expect(standing([ ...requests, bobReviewed ], "Reviewed")).to.deep.equal([
      "1 of 2 reviewers marked it Reviewed carol has no verdict yet. Nothing is open.",
      "Sign-off: 1 of 2 · reviewers approved",
    ]);
    expect(standing([ ...requests, bobReviewed, event(2574, 400, "[status-reviewed]", carol) ])).to.deep.equal([
      "All 2 reviewers marked it Reviewed Nothing is open.", "Sign-off: 2 of 2 · reviewers approved",
    ]);
    expect(standing([ ...requests, bobReviewed, event(2574, 400, "[status-rework-required]", carol) ])).to.deep.equal([
      "Waiting on erin.author (author) carol asked for rework. Nothing is open.",
      "Sign-off: 1 of 2 · reviewers approved",
    ]);
  });

  it("keeps reviewer cards compact and quotes each verdict with its replies in the Conversation", () => {
    const rows = [
      event(2443, 600, "[requested-review-from]bob@example.com"),
      event(2444, 590, "[requested-review-from]carol@example.com"),
      event(2445, 480, "[status-reviewed]Looks good.\n\nShip it.", "bob@example.com"),
      reply(2446, 2445, 470, "Thanks!", AUTHOR),
      event(2447, 420, "[status-rework-required]Tests fail on iOS.", "carol@example.com"),
      event(2448, 300, "[re-requested-review-from]carol@example.com"),
    ];
    const html = renderOverview(withComments(scenario, rows), options());
    expectWellFormed(html);
    const lines = textLines(html);
    expect(lines[4]).to.equal("Waiting on alex.reviewer and carol (asked again) " +
      "bob marked it Reviewed. Nothing is open.");
    // The assignee has a card although no request names them.
    expect(section(lines, "Reviewers")).to.deep.equal([
      "Reviewers 3",
      "alex.reviewer assignee Requested",
      "No verdict yet",
      "carol Asked again",
      "Asked for rework 7 hours ago · asked to look again 5 hours ago",
      "bob Reviewed",
      "8 hours ago",
    ]);
    expect(told(html)).to.deep.equal([
      "erin.author opened the review",
      "erin.author requested a review from bob",
      "erin.author requested a review from carol",
      "bob marked it Reviewed", "Looks good.", "Ship it.", "erin.author", "Thanks!",
      "carol asked for rework", "Tests fail on iOS.",
      "erin.author asked carol to look again",
    ]);
    // Printed once, under its verdict.
    expect(visible(html).split("Thanks!")).to.have.length(2);
    expect(html).to.contain("<span class=\"tl-mark green\" aria-hidden=\"true\">");
    expect(html).to.contain("<span class=\"tl-mark orange\" aria-hidden=\"true\">");
    expectEveryGeneralThread(html, discussionsOf(rows));
  });

  it("prints every discussion in full: General threads as comments, file threads headed by their line", () => {
    const rows = [
      comment({ date: ago(300), id: 20, location: -1, revisionId: -1, text: "A note on the whole review",
        type: "comment" }),
      comment({ date: ago(200), id: 21, location: -1, parentId: 20, revisionId: -1, text: "Agreed",
        type: "comment" }),
      comment({ date: ago(100), id: 22, location: 3, revisionId: 11, text: "A line comment", type: "comment" }),
      comment({ date: ago(90), id: 23, location: 3, owner: AUTHOR, parentId: 22, revisionId: 11, text: "Fixed",
        type: "comment" }),
    ];
    const html = renderOverview(withComments(scenario, rows), options({ link: testLink }));
    expectWellFormed(html);
    expect(told(html)).to.deep.equal([
      "erin.author opened the review",
      "Reviewer Comment", "A note on the whole review", "Reviewer", "Agreed",
      "Comment revision 11:4", "Reviewer", "A line comment", "erin.author", "Fixed",
    ]);
    expect(html).to.contain("<div class=\"row card-top\"><span class=\"pill grey\">Comment</span> " +
      `<a href="${HANDLER}?thread=22">revision 11:4</a></div>`);
    // A comment on the whole file has no line to open.
    const whole = renderOverview(withComments(scenario, [{ ...rows[2], location: -1 }]), options({ link: testLink }));
    expect(told(whole)).to.include("Comment revision 11");
    expect(links(whole)).to.deep.equal([]);
  });

  it("heads a file thread with its kind and state, and draws resolved change requests as resolved", () => {
    const change = (id: number, applied: number) => comment({
      appliedInChangesetId: applied, date: ago(100 - id), id, location: id, revisionId: 11, text: `Change ${id}`,
      type: "change",
    });
    const rows = [
      change(1, -1),
      change(2, 3718),
      change(3, -1),
      comment({ date: ago(90), id: 4, location: 3, owner: AUTHOR, parentId: 3, revisionId: 11, text: "No",
        type: "discarded" }),
      comment({ date: ago(80), id: 5, location: 4, owner: ME, revisionId: 11, text: "Why?", type: "question" }),
      comment({ date: ago(70), id: 6, location: 4, owner: AUTHOR, parentId: 5, revisionId: 11, text: "Because.",
        type: "comment" }),
      comment({ date: ago(60), id: 7, location: 5, owner: ME, revisionId: 11, text: "And this?", type: "question" }),
    ];
    const html = renderOverview(withComments(scenario, rows), options());
    expectWellFormed(html);
    const heads = told(html).filter(line => / revision 11:\d$/.test(line));
    expect(heads).to.deep.equal([
      "Change request revision 11:2",
      "Change request · applied in cs:3718 revision 11:3",
      "Change request · discarded revision 11:4",
      "Question · answered revision 11:5",
      "Question revision 11:6",
    ]);
    const pills = html.match(/<div class="row card-top"><span class="pill (\w+)">/g)!
      .map(pill => /pill (\w+)/.exec(pill)![1]);
    expect(pills).to.deep.equal([ "orange", "green", "grey", "green", "blue" ]);
    expect(html.match(/<li class="tl-item tl-comment on-file resolved">/g)).to.have.length(2);
    expect(told(html)).to.include.members([ "erin.author Discarded", "No", "erin.author", "Because." ]);
  });

  it("keeps a question open until someone other than the asker replies", () => {
    const rows = [
      comment({ date: ago(120), id: 2402, location: 3, owner: ME, revisionId: 11, text: "Why?", type: "question" }),
      comment({ date: ago(110), id: 2403, location: 3, owner: ME.toUpperCase(), parentId: 2402, revisionId: 11,
        text: "Anyone?", type: "comment" }),
      comment({ date: ago(100), id: 2404, location: 5, owner: ME, revisionId: 11, text: "And this?",
        type: "question" }),
      comment({ date: ago(90), id: 2405, location: 5, owner: AUTHOR, parentId: 2404, revisionId: 11, text: "Because.",
        type: "comment" }),
    ];
    const lines = textLines(renderOverview(withComments(scenario, rows), options()));
    expect(lines).to.include("Questions: 1 open · 1 answered");
    expect(section(lines, "Open items")).to.deep.equal([
      "Open items 1",
      "Question revision 11:4 alex.reviewer · 2 hours ago · 1 reply",
      "Why?",
    ]);
  });

  it("counts files as the Review view does, without directory records", () => {
    const directory = (path: string, revisionId: number) => file({
      path, revisionId, revisionType: RevisionType.Directory, status: FileChangeStatus.Added,
    });
    const merged = directory("/Assets/Code/Track/New", 2402);
    const files = {
      ...scenario.files,
      final: {
        ...scenario.files.final,
        files: scenario.files.final.files.concat(directory("/Assets/New", 2401), merged),
      },
      mergedKeys: new Set([ ...Array.from(scenario.files.mergedKeys), fileKey(merged) ]),
    };
    const active = readyReview(scenario, { files: { state: "ready", value: files }});
    const html = renderOverview(active, options({ isViewed: row => row.path === LAP_TIMER_PATH }));
    expect(textLines(html)).to.include("Files viewed: 1 of 5 · 2 more came in through merges");
    expect(html).to.contain("aria-valuemax=\"5\" aria-valuenow=\"1\"><span style=\"width: 20%\"></span>");
    // Without the viewed state the tile counts the files only.
    expect(textLines(renderOverview(active, { now: NOW }))).to.include("Files: 5 · 2 more came in through merges");
  });

  it("renders text built to make its patterns backtrack in time linear in its length", () => {
    const brackets = `https://a.b/${")".repeat(40000)}`;
    const blanks = `a${" ".repeat(40000)}b\n${" ".repeat(40000)}\nc`;
    const rows = [
      event(2581, 600, `[requested-review-from]${ME}`),
      event(2582, 500, `[status-reviewed]${blanks}`, ME),
      comment({
        date: ago(300), id: 2583, location: -1, owner: AUTHOR, revisionId: -1, text: brackets, type: "conversation",
      }),
    ];
    const title = `${brackets} ${" ".repeat(40000)}[apply-change:38c85554]`;
    const started = Date.now();
    const html = renderOverview(withComments(scenario, rows, { review: { ...scenario.review, title }}), options());
    // Each of these took seconds while a pattern tried every bracket or blank again from each position.
    expect(Date.now() - started).to.be.below(1000);
    expectWellFormed(html);
    expect(links(html).map(link => link.href)).to.deep.equal([ "https://a.b/", "https://a.b/" ]);
    expect(html).to.contain(`<blockquote class="quote"><p>a${" ".repeat(40000)}b</p><p>c</p></blockquote>`);
  });

  it("waits on a reviewer who joined again after their verdict, and on one asked again right after a removal", () => {
    const bob = "bob@example.com";
    const unassigned = { ...scenario.review, assignee: "" };
    const rejoined = textLines(renderOverview(withComments(scenario, [
      event(2587, 600, `[requested-review-from]${bob}`),
      event(2588, 500, "[status-rework-required]Please rename Foo", bob),
      event(2589, 60, `[requested-review-from]${bob}`, bob),
    ], { review: unassigned }), options()));
    expect(rejoined[4]).to.equal("Waiting on bob Nothing is open.");
    // The card says what the verdict was, and quotes it.
    expect(section(rejoined, "Reviewers")).to.deep.equal([
      "Reviewers 1", "bob Reviewing", "Asked for rework 8 hours ago · joined again 1 hour ago",
    ]);
    // A removal between two requests a second apart makes the second a new request, not a copy of the first.
    const start = NOW - 600 * 60000;
    const row = (id: number, offset: number, text: string) => comment({
      date: new Date(start + offset).toISOString(), id, location: -1, owner: AUTHOR, revisionId: -1, text,
      type: "timeline",
    });
    const readded = textLines(renderOverview(withComments(scenario, [
      row(2595, 0, `[requested-review-from]${bob}`),
      row(2596, 1000, `[removed-requested-review-from]${bob}`),
      row(2597, 1500, `[requested-review-from]${bob}`),
    ], { review: unassigned }), options()));
    expect(readded[4]).to.equal("Waiting on bob Nothing is open.");
    expect(section(readded, "Reviewers"))
      .to.deep.equal([ "Reviewers 1", "bob Requested", "Asked 9 hours ago · no verdict yet" ]);
  });

  it("says a reviewer back after their verdict gave that verdict, never that they have none", () => {
    const priya = "priya.nair@example.com";
    const bob = "bob.b@example.com";
    const carol = "carol@example.com";
    const unassigned = { ...scenario.review, assignee: "" };
    const requests = [
      event(2604, 1200, `[requested-review-from]${priya}`),
      event(2605, 1190, `[requested-review-from]${bob}`),
    ];
    const rows = [
      ...requests,
      event(2606, 600, "[status-reviewed]LGTM", priya),
      event(2607, 480, "[status-rework-required]fix it", bob),
      event(2608, 60, `[requested-review-from]${priya}`, priya),
    ];
    const lines = textLines(renderOverview(withComments(scenario, rows, {
      review: { ...unassigned, status: "Rework required" },
    }), options()));
    expect(lines[4]).to.equal("Waiting on erin.author (author) bob.b asked for rework. " +
      "priya.nair marked it Reviewed and joined again. Nothing is open.");
    expect(section(lines, "Reviewers")).to.deep.equal([
      "Reviewers 2",
      "priya.nair Reviewing", "Marked it Reviewed 10 hours ago · joined again 1 hour ago",
      "bob.b Rework required", "8 hours ago",
    ]);
    // Marked Reviewed, the headline names nobody either; each verdict is told apart from the silent reviewers.
    const settled = textLines(renderOverview(withComments(scenario, [
      ...requests,
      event(2609, 1180, `[requested-review-from]${carol}`),
      event(2633, 600, "[status-reviewed]LGTM", priya),
      event(2634, 590, "[status-rework-required]", carol),
      event(2635, 60, `[requested-review-from]${priya}`, priya),
      event(2636, 50, `[requested-review-from]${carol}`, carol),
    ], { review: { ...unassigned, status: "Reviewed" }}), options()));
    expect(settled[4]).to.equal("0 of 3 reviewers marked it Reviewed priya.nair marked it Reviewed and joined again. " +
      "carol asked for rework and joined again. bob.b has no verdict yet. Nothing is open.");
    expect(settled.filter(line => line.includes("no verdict yet"))).to.deep.equal([
      settled[4], "Asked 19 hours ago · no verdict yet",
    ]);
  });

  it("asks a reviewer removed after their verdict and requested again to look again, on the card as in the log", () => {
    const priya = "priya.nair@example.com";
    const rows = [
      event(2652, 1200, `[requested-review-from]${priya}`),
      event(2653, 600, "[status-reviewed]LGTM", priya),
      reply(2654, 2653, 590, "Thanks, merging after the build", AUTHOR),
      event(2655, 300, `[removed-requested-review-from]${priya}`),
      event(2656, 60, `[requested-review-from]${priya}`),
    ];
    const html = renderOverview(withComments(scenario, rows, { review: { ...scenario.review, assignee: "" }}),
      options());
    expectWellFormed(html);
    const lines = textLines(html);
    expect(lines[4]).to.equal("Waiting on priya.nair (asked again) Nothing is open.");
    expect(section(lines, "Reviewers")).to.deep.equal([
      "Reviewers 1",
      "priya.nair Asked again",
      "Marked it Reviewed 10 hours ago · asked to look again 1 hour ago",
    ]);
    expect(told(html)).to.deep.equal([
      "erin.author opened the review",
      "erin.author requested a review from priya.nair",
      "priya.nair marked it Reviewed", "LGTM", "erin.author", "Thanks, merging after the build",
      "erin.author removed priya.nair from the reviewers",
      "erin.author asked priya.nair to look again",
    ]);
    expect(html).to.contain(`<span class="when">· ${when(ago(590))}</span>`);
    expect(visible(html).split("Thanks, merging after the build")).to.have.length(2);
    expectEveryGeneralThread(html, discussionsOf(rows));
  });

  it("gives the author a card only for a verdict of their own, so the counts name the same people", () => {
    // Plastic requested the author when the review was created, once in each format, a second apart.
    const opened = Date.parse(scenario.review.date);
    const early = (id: number, seconds: number, text: string) => comment({
      date: new Date(opened + seconds * 1000).toISOString(), id, location: -1, owner: AUTHOR, revisionId: -1, text,
      type: "timeline",
    });
    const rows = [
      early(2671, 0, `[requested-review-from]${AUTHOR}`),
      early(2672, 1, `[requested-review-from-${AUTHOR}]`),
      event(2673, 600, "[requested-review-from]bob@example.com"),
      event(2674, 500, "[status-reviewed]", "bob@example.com"),
    ];
    const settled = { ...scenario.review, assignee: "", status: "Reviewed" };
    const lines = textLines(renderOverview(withComments(scenario, rows, { review: settled }), options()));
    expect(lines[4]).to.equal("bob marked it Reviewed Nothing is open.");
    expect(lines).to.include("Sign-off: 1 of 1 · reviewers approved");
    expect(section(lines, "Reviewers")).to.deep.equal([ "Reviewers 1", "bob Reviewed", "8 hours ago · no comment" ]);
  });

  it("says who stands when nobody but the author reviews", () => {
    const priya = "priya.nair@example.com";
    // Priya asked for rework, was asked again and removed; the author then approved it herself.
    const rows = [
      event(2691, 900, `[requested-review-from]${priya}`, priya),
      event(2692, 899, "[status-rework-required]Split it", priya),
      event(2693, 800, `[requested-review-from]${priya}`),
      event(2694, 700, `[removed-requested-review-from]${priya}`),
      event(2695, 699, `[requested-review-from]${AUTHOR}`),
      event(2696, 698, "[status-reviewed]", AUTHOR),
    ];
    const owned = { ...scenario.review, assignee: AUTHOR, status: "Reviewed" };
    const html = renderOverview(withComments(scenario, rows, { review: owned }), options());
    const lines = textLines(html);
    expect(lines[4]).to.equal("erin.author (author) marked it Reviewed priya.nair was removed from the reviewers. " +
      "Nothing is open.");
    expect(lines).to.include("Sign-off: None · no reviewers left");
    expect(section(lines, "Reviewers"))
      .to.deep.equal([ "Reviewers 1", "erin.author author assignee Reviewed", "11 hours ago · no comment" ]);
    expect(told(html)).to.deep.equal([
      "erin.author opened the review",
      "priya.nair joined and asked for rework", "Split it",
      "erin.author asked priya.nair to look again",
      "erin.author removed priya.nair from the reviewers",
      "erin.author joined and marked it Reviewed",
    ]);
    expectEveryGeneralThread(html, discussionsOf(rows));
    // Nobody left and no verdict of the author's.
    const gone = textLines(renderOverview(withComments(scenario, rows.slice(0, 4), {
      review: { ...owned, status: "Rework required" },
    }), options()));
    expect(gone[4]).to.equal("No reviewers left priya.nair was removed from the reviewers. Nothing is open.");
    expect(section(gone, "Reviewers")).to.deep.equal([ "Reviewers 0", "No reviewers left." ]);
    // The author, who is also the assignee, approved it and nobody else was ever asked.
    const own = textLines(renderOverview(withComments(scenario, [
      event(2711, 600, `[requested-review-from]${AUTHOR}`),
      event(2712, 599, "[status-reviewed]LGTM", AUTHOR),
    ], { review: owned }), options()));
    expect(own[4]).to.equal("erin.author (author) marked it Reviewed Nothing is open.");
    expect(own).to.include("Sign-off: None · no reviewers yet");
  });

  it("says when someone is asked to look again, and when a rename only dropped Plastic's prefix", () => {
    const bob = "bob@example.com";
    const rows = [
      event(2731, 900, "[renamed-title]Review of changeset 3551 - Make lap times clear#->#Make lap times clear"),
      event(2732, 800, `[requested-review-from]${bob}`),
      event(2733, 700, "[status-reviewed]", bob),
      event(2734, 600, `[requested-review-from]${bob}`),
      event(2735, 500, "[renamed-title]Make lap times clear#->#Lap Timer Accuracy"),
    ];
    expect(told(renderOverview(withComments(scenario, rows), options()))).to.deep.equal([
      "erin.author opened the review",
      "erin.author renamed it to drop the generated prefix",
      "erin.author requested a review from bob",
      "bob marked it Reviewed",
      "erin.author asked bob to look again",
      "erin.author renamed it from “Make lap times clear” to “Lap Timer Accuracy”",
    ]);
  });

  it("words each review event, quotes the text a line leaves out, and keeps replies on rows it leaves out", () => {
    const bob = "bob@example.com";
    const rows = [
      event(2761, 900, "[description]First description"),
      reply(2762, 2761, 890, "Nice summary", bob),
      event(2763, 800, `[requested-review-from]${bob}`),
      event(2764, 700, "[status-under-review]Back to it", bob),
      event(2765, 650, "[status-on-hold]", bob),
      event(2766, 600, `[re-requested-review-from]${bob}`),
      event(2767, 500, `[removed-requested-review-from]${bob}`),
      event(2768, 400, "[renamed-title]Lap Timer Accuracy"),
      event(2769, 300, "[description]Second description"),
      event(2770, 200, "Imported from the old tracker"),
    ];
    const html = renderOverview(withComments(scenario, rows), options());
    expectWellFormed(html);
    expect(told(html)).to.deep.equal([
      "erin.author Description", "Second description",
      "erin.author opened the review",
      // The first description opens the Conversation; its replies stay on the row it was.
      "erin.author Description", "First description", "bob", "Nice summary",
      "erin.author requested a review from bob",
      "bob moved it back to Under review", "Back to it",
      "bob changed the status",
      "erin.author asked bob to look again",
      "erin.author removed bob from the reviewers",
      "erin.author renamed it to “Lap Timer Accuracy”",
      "erin.author edited the description",
      "erin.author updated the review", "Imported from the old tracker",
    ]);
    // Under review: an eye in blue on the line; every line starts with who did it, as a small avatar.
    expect(html).to.match(/<span class="tl-mark blue" aria-hidden="true"><svg[^>]*><path d="M1\.5 8S/);
    expect(html.match(/<p class="tl-line"><span class="av sm"/g)?.length).to.be.greaterThan(5);
    expect(html).not.to.match(/<li class="tl-item[^"]*"><span class="av"/);
    expectEveryGeneralThread(html, discussionsOf(rows));
  });

  it("leaves Open items out when nothing is open, and prints each item's first line only", () => {
    expect(headings(renderOverview(withComments(changesetScenario, []), options()))).to.not.include("Open items");
    const applied = comment({
      appliedInChangesetId: 3718, date: ago(100), id: 2751, location: 3, revisionId: 11, text: "Rename it",
      type: "change",
    });
    const lines = textLines(renderOverview(withComments(scenario, [applied]), options()));
    expect(headings(renderOverview(withComments(scenario, [applied]), options()))).to.not.include("Open items");
    // The tile leaves out what is zero.
    expect(lines).to.include("Change requests: None · 1 applied");
    const question = comment({
      date: ago(100), id: 2752, location: 3, owner: ME, revisionId: 11, text: "Why this?\nAnd that?\n\nMore",
      type: "question",
    });
    const html = renderOverview(withComments(scenario, [question]), options());
    expect(section(textLines(html), "Open items"))
      .to.deep.equal([ "Open items 1", "Question revision 11:4 alex.reviewer · 1 hour ago", "Why this?" ]);
    expect(html).to.contain("<p class=\"text\" title=\"Why this?&#10;And that?&#10;&#10;More\">Why this?</p>");
  });

  it("offers Add me as reviewer under the reviewer cards only when asked to and it has a link", () => {
    const active = readyReview(scenario);
    const offered = renderOverview(active, options({ addMe: true, link: testLink, whoami: ME }));
    expectWellFormed(offered);
    expect(section(textLines(offered), "Reviewers").slice(-1)).to.deep.equal(["Add me as reviewer"]);
    expect(offered).to.contain(`<p class="add-me"><a href="${HANDLER}?addMeAsReviewer">Add me as reviewer</a></p>`);
    expect(links(offered).filter(link => link.text === "Add me as reviewer")).to.have.length(1);
    expectLinksOpen(offered, active);
    const nobody = withComments(scenario, [], { review: { ...scenario.review, assignee: "" }});
    const empty = renderOverview(nobody, options({ addMe: true, link: testLink }));
    expectWellFormed(empty);
    expect(section(textLines(empty), "Reviewers").slice(1))
      .to.deep.equal([ "No reviewers requested yet.", "Add me as reviewer" ]);
    const without = [
      renderOverview(active, options({ link: testLink, whoami: ME })),
      renderOverview(active, options({ addMe: false, link: testLink })),
      renderOverview(active, options({ addMe: true })),
      renderOverview(active, options({ addMe: true, link: () => undefined })),
    ];
    for (const html of without) {
      expect(html).to.not.contain("add-me").and.not.contain("Add me as reviewer");
    }
  });

  it("links Reply, Edit, Delete and Add comment on comments only while posting works", () => {
    const guid = (n: number) => `0a1b2c3d-1111-4222-8333-${String(n).padStart(12, "0")}`;
    const conversation = (id: number, owner: string, text: string, parentId = -1) => comment({
      date: ago(60 - id), guid: guid(id), id, location: -1, owner, parentId, revisionId: -1, text,
      type: parentId < 0 ? "conversation" : "comment",
    });
    const rows = [
      { ...event(9001, 90, "[description]Adds lap splits.", ME), guid: guid(9001) },
      conversation(9002, AUTHOR, "Please look at the reset first."),
      conversation(9003, ME.toUpperCase(), "Done, see cs:3718.", 9002),
      conversation(9004, ME, "One more thing."),
      { ...event(9005, 20, "[status-reviewed]Fine by me.", ME), guid: guid(9005) },
    ];
    const active = withComments(scenario, rows);
    const html = renderOverview(active, options({ commentActions: true, link: testLink, whoami: ME }));
    expectWellFormed(html);
    const actions = links(html).filter(link => /\?(reply|edit|delete|addComment)\b/.test(link.href))
      .map(link => `${link.text} ${link.href.substring(HANDLER.length + 1)}`);
    expect(actions).to.deep.equal([
      "Edit description edit=9001",
      "Reply reply=9002",
      "Edit edit=9003",
      "Delete delete=9003",
      "Reply reply=9004",
      "Edit edit=9004",
      "Delete delete=9004",
      "Write a comment… addComment",
    ]);
    // Someone else's comment, the verdict and every timeline row take no edit or delete.
    expect(actions.some(action => /=900[25]$/.test(action) && !action.startsWith("Reply"))).to.equal(false);

    const off = [
      renderOverview(active, options({ link: testLink, whoami: ME })),
      renderOverview(active, options({ commentActions: true, whoami: ME })),
    ];
    for (const page of off) {
      expect(page).to.not.contain("comment-actions");
    }
    // Before cm has said who the user is, only Reply and Add comment are offered.
    const anonymous = links(renderOverview(active, options({ commentActions: true, link: testLink })))
      .map(link => link.text).filter(text => [ "Reply", "Edit", "Delete", "Edit description" ].includes(text));
    expect(anonymous).to.deep.equal([ "Reply", "Reply" ]);
    // With nothing said on the whole review yet, the Conversation still ends with the comment box.
    const empty = renderOverview(withComments(scenario, []), options({ commentActions: true, link: testLink }));
    expect(told(empty)).to.deep.equal(
      [ "erin.author opened the review", "Add a comment", "Write it in the input box at the top of the window.",
        "Write a comment…" ]);
    // One way to write it: a button to the input box, and nothing drawn as a text field.
    expect(empty).to.contain(`<a class="button primary" href="${HANDLER}?addComment">Write a comment…</a>`);
    expect(empty).to.not.contain("compose-box");
    // Without a cm user, the box has a blank avatar; with one, theirs.
    expect(empty).to.contain("<div class=\"composer\"><span class=\"av anon\"");
    const mine = renderOverview(withComments(scenario, []),
      options({ commentActions: true, link: testLink, whoami: ME }));
    expect(mine).to.match(/<div class="composer"><span class="av" style=/);
    // Threads on a file are answered on the Overview too, as in the desktop app; the user's own are edited and deleted.
    const onFile = withComments(scenario, [
      comment({ date: ago(30), guid: guid(9101), id: 9101, location: 3, owner: ME, revisionId: 11, text: "Mine",
        type: "comment" }),
      comment({ date: ago(20), guid: guid(9102), id: 9102, location: 3, owner: ME, parentId: 9101, revisionId: 11,
        text: "Also mine", type: "comment" }),
    ]);
    const fileActions = links(renderOverview(onFile, options({ commentActions: true, link: testLink, whoami: ME })))
      .filter(link => /\?(reply|edit|delete)=/.test(link.href))
      .map(link => `${link.text} ${link.href.substring(HANDLER.length + 1)}`);
    expect(fileActions).to.deep.equal([
      "Reply reply=9101", "Edit edit=9101", "Delete delete=9101", "Edit edit=9102", "Delete delete=9102",
    ]);
    // Someone else's thread on a file: Reply only.
    const theirs = withComments(scenario, [
      comment({ date: ago(30), guid: guid(9103), id: 9103, location: 3, owner: AUTHOR, revisionId: 11,
        text: "Theirs", type: "question" }),
    ]);
    expect(links(renderOverview(theirs, options({ commentActions: true, link: testLink, whoami: ME })))
      .filter(link => /\?(reply|edit|delete)=/.test(link.href)).map(link => link.text)).to.deep.equal(["Reply"]);
  });
});
