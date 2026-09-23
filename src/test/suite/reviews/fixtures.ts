import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../../../models";
import { ICmParser, ICmResult, ICmShell } from "../../../cm/shell";
import { IReviewComment } from "../../../reviews/models";

/** A cm stand-in: `answer` returns what cm would print; every call is recorded. */
export class ReviewShell implements ICmShell {
  public isRunning = false;
  public isBusy = false;
  public calls: Array<{ command: string; args: string[] }> = [];
  public answer: (command: string, args: string[]) => string | Promise<string> = () => "<PLASTICQUERY/>";
  public start(): Promise<boolean> {
    this.isRunning = true;
    return Promise.resolve(true);
  }
  public stop(): Promise<void> {
    this.isRunning = false;
    return Promise.resolve();
  }
  public dispose(): void {
    this.isRunning = false;
  }
  public async exec<T>(command: string, args: string[], parser: ICmParser<T>): Promise<ICmResult<T>> {
    this.calls.push({ args, command });
    try {
      const output = await this.answer(command, args);
      output.split("\n").forEach(line => parser.readLineOut(line));
      const result = await parser.parse();
      return { error: parser.getError(), result, success: !parser.getError() };
    } catch (error) {
      return { error: error as Error, success: false };
    }
  }
  /** The `where` clauses of the recorded `cm find <type>` calls. */
  public queries(type: string): string[] {
    return this.calls.filter(call => call.command === "find" && call.args[0] === type).map(call => call.args[1]);
  }
}

// ---------------------------------------------------------------------------
// Simple defaults: one review (5) of branch id:8, one changed file, one comment.
// ---------------------------------------------------------------------------

export function file(overrides: Partial<IChangesetFileChange> = {}): IChangesetFileChange {
  return {
    baseRevisionId: 10,
    parentRevisionId: 9,
    path: "/Code/Test.cs",
    repository: "repo@org@cloud",
    revisionId: 11,
    revisionType: RevisionType.TextFile,
    status: FileChangeStatus.Changed,
    ...overrides,
  };
}
export function comment(overrides: Partial<IReviewComment> = {}): IReviewComment {
  return {
    appliedInChangesetId: -1,
    changesetId: 2,
    date: "2026-09-01T12:00:00Z",
    guid: "comment-guid",
    id: 1,
    location: 3,
    owner: "Reviewer",
    parentId: -1,
    reviewId: 5,
    revisionId: 11,
    text: "Please explain",
    type: "question",
    ...overrides,
  };
}
export const REVIEW_XML =
  "<PLASTICQUERY><REVIEW><ID>5</ID><TITLE>Review &amp; discuss</TITLE><OWNER>Author</OWNER>" +
  "<ASSIGNEE>Reviewer</ASSIGNEE><DATE>2026-09-01</DATE><STATUS>Status Under review</STATUS>" +
  "<TARGETTYPE>Branch</TARGETTYPE><TARGET>id:8</TARGET></REVIEW></PLASTICQUERY>";
export const COMMENT_XML =
  "<PLASTICQUERY><CHANGEREVIEWCOMMENT><ID>1</ID><COMMENT>  first\nsecond &amp; third  </COMMENT><TYPE>question</TYPE>" +
  "<REVIEWID>5</REVIEWID><REVISIONID>11</REVISIONID><LOCATION>3</LOCATION><PARENT>-1</PARENT><CHANGESET>2</CHANGESET>" +
  "<APPLIEDINCHANGESET>-1</APPLIEDINCHANGESET></CHANGEREVIEWCOMMENT></PLASTICQUERY>";
export const REVISION_XML =
  "<PLASTICQUERY><REVISION><ID>11</ID><ITEMID>90</ITEMID><PATH>/Code/Test.cs</PATH><TYPE>txt</TYPE>" +
  "<PARENT>10</PARENT><CHANGESET>2</CHANGESET><BRANCH>br:/main/task</BRANCH><REPNAME>repo</REPNAME>" +
  "<REPSERVER>org@cloud</REPSERVER>" +
  "</REVISION></PLASTICQUERY>";
export const DIFF_OUTPUT = "S:C\nT:F\nP:\"/Code/Test.cs\"\nR:11\nPR:9\nB:10\nSP:\"\"\nDP:\"\"\nRP:repo@org@cloud";
export const EMPTY_QUERY = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<PLASTICQUERY>\n</PLASTICQUERY>";
export function branchXml(head: number): string {
  return `<PLASTICQUERY><BRANCH><ID>8</ID><NAME>/main/task</NAME><PARENT>/main</PARENT><CHANGESET>${head}</CHANGESET>` +
    "<REPOSITORY>repo</REPOSITORY><REPSERVER>org@cloud</REPSERVER></BRANCH></PLASTICQUERY>";
}
export function changesetsXml(count = 1, first = 2): string {
  const rows = Array.from({ length: count }, (_, index) =>
    `<CHANGESET><CHANGESETID>${first - index}</CHANGESETID><PARENT>${first - index - 1}</PARENT>` +
    "<BRANCH>/main/task</BRANCH></CHANGESET>");
  return `<PLASTICQUERY>${rows.join("")}</PLASTICQUERY>`;
}
export function defaultAnswer(command: string, args: string[]): string {
  if (command === "diff") {
    return DIFF_OUTPUT;
  }
  if (command === "codereview") {
    return "";
  }
  if (command === "whoami") {
    return "Reviewer\n";
  }
  switch (args[0]) {
  case "review":
    return REVIEW_XML;
  case "branch":
    // The simple branch is visible: the hidden-only query finds nothing.
    return args[1].includes("hidden") ? EMPTY_QUERY : branchXml(2);
  case "merge":
    return EMPTY_QUERY;
  case "changeset":
    return changesetsXml();
  case "changereviewcomment":
    return COMMENT_XML;
  case "revision":
    return REVISION_XML;
  default:
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  }
}

// ---------------------------------------------------------------------------
// A made-up scenario in the shape of cm 11 output: branch review 12831 of
// /main/feature_lap_timer (object id 11931, head 3715, first changeset 3477
// on base 3471), with two merges from /main, and changeset review 7551 of
// cs:3203 on a hidden branch.
// ---------------------------------------------------------------------------

export const WORKSPACE_ROOT = "/Users/dev/Nimbus";
export const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";
export const ME = "alex.reviewer@example.com";
export const AUTHOR = "erin.author@example.com";
export const BRANCH_ID = 11931;
export const BRANCH_NAME = "/main/feature_lap_timer";
export const HEAD = 3715;
export const BASE = 3471;
export const BRANCH_REVIEW_ID = 12831;
export const CHANGESET_REVIEW_ID = 7551;
export const HIDDEN_BRANCH_ID = 7201;
export const HIDDEN_BRANCH_NAME = "/main/task_RAC-3501_PaymentsSpike";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
}
function query(rows: string[]): string {
  return rows.length
    ? `<?xml version="1.0" encoding="utf-8" ?>\n<PLASTICQUERY>\n${rows.join("\n")}\n</PLASTICQUERY>`
    : EMPTY_QUERY;
}

export interface IReviewRow {
  id: number;
  title?: string;
  owner?: string;
  assignee?: string;
  date?: string;
  status?: string;
  targetType?: "Branch" | "Changeset" | "Label";
  target?: string;
}
function reviewRow(row: IReviewRow): string {
  const status = row.status ?? "Under review";
  return [
    "  <REVIEW>",
    `    <ID>${row.id}</ID>`,
    `    <OWNER>${row.owner ?? AUTHOR}</OWNER>`,
    `    <DATE>${row.date ?? "2026-09-21T16:03:49+01:00"}</DATE>`,
    `    <TITLE>${escapeXml(row.title ?? `Review ${row.id}`)}</TITLE>`,
    "    <MERGEREQUESTSTATUS>MergeRequestStatus None</MERGEREQUESTSTATUS>",
    `    <STATUS>Status ${status}</STATUS>`,
    `    <CODEREVIEWSTATUS>CodeReviewStatus ${status}</CODEREVIEWSTATUS>`,
    `    <ASSIGNEE>${row.assignee ?? ""}</ASSIGNEE>`,
    `    <TARGETTYPE>${row.targetType ?? "Branch"}</TARGETTYPE>`,
    `    <TARGET>${row.target ?? `id:${BRANCH_ID}`}</TARGET>`,
    "    <DESTINATION></DESTINATION>",
    "  </REVIEW>",
  ].join("\n");
}
export function reviewsXml(rows: IReviewRow[]): string {
  return query(rows.map(reviewRow));
}
export const BRANCH_REVIEW_XML = reviewsXml([{
  assignee: ME,
  id: BRANCH_REVIEW_ID,
  title: "Lap Timer Accuracy",
}]);
export const CHANGESET_REVIEW_XML = reviewsXml([{
  date: "2026-02-16T11:10:00+00:00",
  id: CHANGESET_REVIEW_ID,
  target: "3203",
  targetType: "Changeset",
  title: "Review of changeset 3203",
}]);
export const HIDDEN_BRANCH_REVIEW_XML = reviewsXml([{ id: 10071, target: `id:${HIDDEN_BRANCH_ID}` }]);

export function branchRowXml(id: number, name: string, head: number): string {
  return query([[
    "  <BRANCH>",
    `    <ID>${id}</ID>`,
    "    <COMMENT>Epic: https://example.atlassian.net/browse/RAC-3861</COMMENT>",
    "    <DATE>2026-08-06T11:52:42+01:00</DATE>",
    `    <OWNER>${AUTHOR}</OWNER>`,
    `    <NAME>${name}</NAME>`,
    "    <PARENT>/main</PARENT>",
    "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
    "    <REPNAME>Nimbus/Nimbus</REPNAME>",
    "    <REPSERVER>acme-studio@unity</REPSERVER>",
    "    <TYPE>T</TYPE>",
    `    <CHANGESET>${head}</CHANGESET>`,
    "    <GUID>0b5e7a9c-1d2e-4f3a-9b4c-5d6e7f8a9b0c</GUID>",
    "  </BRANCH>",
  ].join("\n")]);
}

interface IDiffRow {
  status: string;
  type?: string;
  path: string;
  revid: number;
  parent?: number;
  base?: number;
  src?: string;
  dst?: string;
}
function diffRecord(row: IDiffRow): string {
  return [
    `S:${row.status}`,
    `T:${row.type ?? "F"}`,
    `P:"${row.path}"`,
    `R:${row.revid}`,
    `PR:${row.parent ?? -1}`,
    `B:${row.base ?? -1}`,
    `SP:"${row.src ?? ""}"`,
    `DP:"${row.dst ?? ""}"`,
    `RP:"${REPOSITORY}"`,
  ].join("\n");
}
export const LAP_TIMER_PATH = "/Assets/Code/Laps/LapTimer.cs";
export const ANALYTICS_PATH = "/Assets/Code/Events/GhostRuns/GhostRunAnalyticsCollector.cs";
export const MERGED_PATH = "/Assets/Code/Track/TrackSettings.cs";
export const PHANTOM_PATH = "/Assets/Art/Circuits/Shared/Materials/Shared_AsphaltDark_Mat.mat";
export const DELETED_PATH = "/Assets/Code/Laps/LapTimesStore.cs";
export const MOVED_PATH = "/Assets/Data/TyreSet_Soft_Final.asset";
export const MOVED_FROM = "/Assets/Data/TyreSet_Soft_Test.asset";
export const ADDED_PATH = "/Assets/Code/Laps/LapTimerDisplay.cs";
const OWN_ROWS: IDiffRow[] = [
  { base: 10851, parent: 12741, path: LAP_TIMER_PATH, revid: 12804, status: "C" },
  { base: 7741, parent: 7741, path: ANALYTICS_PATH, revid: 12797, status: "C" },
  { path: DELETED_PATH, revid: 11911, status: "D" },
  // cm prints a moved-and-edited item twice; the parser folds the pair into one row.
  { base: 11242, parent: 11242, path: MOVED_PATH, revid: 12411, status: "C" },
  { dst: MOVED_PATH, parent: 11242, path: MOVED_PATH, revid: 12411, src: MOVED_FROM, status: "M" },
  { path: ADDED_PATH, revid: 12805, status: "A" },
];
const MERGED_ROWS: IDiffRow[] = [
  // Only /main changed it; the plain diff still lists it, base = the branch base's revision.
  { base: 10001, parent: 10691, path: MERGED_PATH, revid: 11081, status: "C" },
  // A "phantom" merge row: Changed with neither base nor parent, same revision on both sides.
  { path: PHANTOM_PATH, revid: 11561, status: "C" },
];
/** `cm diff br:<name> --format=… --repositorypaths`: the branch base against the head, merges included. */
export const PLAIN_DIFF_OUTPUT = OWN_ROWS.concat(MERGED_ROWS).map(diffRecord).join("\n");
/** The same with `--clean`: plain checkins only, same revisions, after cm's progress preamble. */
export const CLEAN_DIFF_OUTPUT = [
  `Calculating merges to branch br:${BRANCH_NAME}@${REPOSITORY}`,
  "Skipping differences from 2 changesets (merge destinations)",
  `Skipped differences from cs:3477@${REPOSITORY} (50%)`,
  `Skipped differences from cs:3699@${REPOSITORY} (100%)`,
  "Skipped differences from merges",
].concat(OWN_ROWS.map(diffRecord)).join("\n");
/** Rows of the plain diff once parsed: the moved pair is one row. */
export const PLAIN_ROW_COUNT = 7;
export const CHANGESET_DIFF_OUTPUT = [
  { path: "/Jenkinsfile_test_generator", revid: 7581, status: "A" },
  { path: "/artifacts", revid: 7584, status: "A", type: "D" },
].map(diffRecord).join("\n");
export const HEAD_CHANGESET_DIFF_OUTPUT = diffRecord(OWN_ROWS[0]);

export const MERGES_XML = query([
  [ "3476", "3477", "11961" ],
  [ "3690", "3699", "12741" ],
].map(([ source, destination, id ]) => [
  "  <MERGE>",
  `    <ID>${id}</ID>`,
  "    <DATE>2026-08-06T14:41:57+01:00</DATE>",
  `    <OWNER>${AUTHOR}</OWNER>`,
  "    <TYPE>merge</TYPE>",
  `    <SRCCHANGESET>${source}</SRCCHANGESET>`,
  "    <SRCBRANCH>br:/main</SRCBRANCH>",
  `    <DSTCOMMENT>Merge from main to ${BRANCH_NAME.split("/").pop()!}</DSTCOMMENT>`,
  `    <DSTCHANGESET>${destination}</DSTCHANGESET>`,
  `    <DSTBRANCH>br:${BRANCH_NAME}</DSTBRANCH>`,
  "    <BASECHANGESET></BASECHANGESET>",
  `    <SRC>br:/main@${source}</SRC>`,
  `    <DST>br:${BRANCH_NAME}@${destination}</DST>`,
  "  </MERGE>",
].join("\n")));

interface IChangesetRow {
  id: number;
  parent: number;
  branch?: string;
  comment?: string;
}
export function changesetRowsXml(rows: IChangesetRow[]): string {
  return query(rows.map(row => [
    "  <CHANGESET>",
    `    <ID>${row.id + 52000}</ID>`,
    `    <CHANGESETID>${row.id}</CHANGESETID>`,
    `    <COMMENT>${escapeXml(row.comment ?? `Change ${row.id}`)}</COMMENT>`,
    "    <DATE>2026-09-21T14:00:07+01:00</DATE>",
    `    <OWNER>${AUTHOR}</OWNER>`,
    "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
    "    <REPNAME>Nimbus/Nimbus</REPNAME>",
    "    <REPSERVER>acme-studio@unity</REPSERVER>",
    `    <BRANCH>${row.branch ?? BRANCH_NAME}</BRANCH>`,
    `    <PARENT>${row.parent}</PARENT>`,
    "  </CHANGESET>",
  ].join("\n")));
}
export const FIRST_CHANGESET_XML = changesetRowsXml([{ comment: "Merge from main", id: 3477, parent: BASE }]);
export const BRANCH_CHANGESETS_XML = changesetRowsXml([
  { id: HEAD, parent: 3700 },
  { comment: "Merge from main", id: 3699, parent: 3684 },
  { comment: "Merge from main", id: 3477, parent: BASE },
]);
export const HIDDEN_CHANGESET_XML = changesetRowsXml([{
  branch: "/main/feature_TestGenerator",
  comment: "TestGenerator: script, prompts and CI pipeline",
  id: 3203,
  parent: 3195,
}]);

export interface IRevisionRow {
  id: number;
  itemId: number;
  /** Server path; the XML carries it under the workspace root, as cm does. */
  path: string;
  changeset: number;
  parent: number;
  branch: string;
  /** Overrides the local path entirely (an item outside the workspace root). */
  localPath?: string;
}
export const REVISIONS: IRevisionRow[] = [
  { branch: BRANCH_NAME, changeset: 3700, id: 12804, itemId: 6721, parent: 12671, path: LAP_TIMER_PATH },
  { branch: BRANCH_NAME, changeset: 3677, id: 12671, itemId: 6721, parent: 10851, path: LAP_TIMER_PATH },
  { branch: "/main", changeset: 3301, id: 10851, itemId: 6721, parent: 10531, path: LAP_TIMER_PATH },
  { branch: BRANCH_NAME, changeset: 3700, id: 12797, itemId: 7041, parent: 7741, path: ANALYTICS_PATH },
  {
    branch: BRANCH_NAME, changeset: 3699, id: 12771, itemId: 5941, parent: 10461,
    path: "/Assets/Code/Core/SaveSystem.cs",
  },
  {
    branch: "/main", changeset: 3011, id: 6411, itemId: 99, localPath: "/Volumes/Elsewhere/LegacyTrackEditor.cs",
    parent: -1, path: "/LegacyTrackEditor.cs",
  },
];
export function revisionsXml(rows: IRevisionRow[]): string {
  return query(rows.map(row => [
    "  <REVISION>",
    `    <ID>${row.id}</ID>`,
    "    <TYPE>txt</TYPE>",
    `    <CHANGESET>${row.changeset}</CHANGESET>`,
    `    <PARENT>${row.parent}</PARENT>`,
    `    <ITEM>${row.localPath ?? WORKSPACE_ROOT + row.path}</ITEM>`,
    `    <ITEMID>${row.itemId}</ITEMID>`,
    `    <BRANCH>br:${row.branch}</BRANCH>`,
    `    <PATH>${row.localPath ?? WORKSPACE_ROOT + row.path}</PATH>`,
    "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
    "    <REPNAME>Nimbus/Nimbus</REPNAME>",
    "    <REPSERVER>acme-studio@unity</REPSERVER>",
    "  </REVISION>",
  ].join("\n")));
}

export function commentsXml(rows: IReviewComment[]): string {
  return query(rows.map(row => [
    "  <CHANGEREVIEWCOMMENT>",
    `    <ID>${row.id}</ID>`,
    `    <OWNER>${row.owner}</OWNER>`,
    `    <DATE>${row.date}</DATE>`,
    `    <COMMENT>${escapeXml(row.text)}</COMMENT>`,
    `    <REVISIONID>${row.revisionId}</REVISIONID>`,
    `    <REVIEWID>${row.reviewId}</REVIEWID>`,
    `    <LOCATION>${row.location}</LOCATION>`,
    `    <TYPE>${row.type}</TYPE>`,
    `    <PARENT>${row.parentId}</PARENT>`,
    `    <CHANGESET>${row.changesetId}</CHANGESET>`,
    `    <APPLIEDINCHANGESET>${row.appliedInChangesetId}</APPLIEDINCHANGESET>`,
    `    <GUID>${row.guid}</GUID>`,
    "  </CHANGEREVIEWCOMMENT>",
  ].join("\n")));
}
function scenarioComment(overrides: Partial<IReviewComment>): IReviewComment {
  return comment({
    changesetId: -1,
    guid: `guid-${overrides.id ?? 0}`,
    location: -1,
    owner: ME,
    reviewId: BRANCH_REVIEW_ID,
    revisionId: -1,
    type: "comment",
    ...overrides,
  });
}
function timeline(id: number, date: string, text: string, owner = ME): IReviewComment {
  return scenarioComment({ date, id, owner, text, type: "timeline" });
}
/** Every comment row of review 12831, timeline rows included, in cm's order. */
export const SCENARIO_COMMENTS: IReviewComment[] = [
  timeline(12832, "2026-09-21T16:04:42+01:00",
    `[renamed-title]Review of branch ${BRANCH_NAME} - Epic: RAC-3861#->#Lap Timer Accuracy`, AUTHOR),
  // Both request formats occur, written as a pair in the same second.
  timeline(12894, "2026-09-22T16:11:21+01:00", `[requested-review-from]${ME}`),
  timeline(12895, "2026-09-22T16:11:21+01:00", `[requested-review-from-${ME}]`),
  scenarioComment({
    date: "2026-09-22T16:16:24+01:00", id: 12907, location: 286, revisionId: 12797,
    text: "Would one shared property on the 'RaceSessionManager' be simpler for callers?\n\nOne check for callers.",
    type: "change",
  }),
  scenarioComment({
    date: "2026-09-22T16:21:45+01:00", id: 12915, location: 153, revisionId: 12771,
    text: "If a third save source turns up, an interface would pay off here.", type: "question",
  }),
  scenarioComment({
    appliedInChangesetId: 3718, date: "2026-09-22T16:26:45+01:00", id: 12918, location: 40, revisionId: 12804,
    text: "Compare against the qualifying end date too.", type: "change",
  }),
  scenarioComment({
    date: "2026-09-22T16:30:00+01:00", id: 12919, location: 12, revisionId: 12671,
    text: "This allocates a new List<Sprite> each frame.", type: "change",
  }),
  scenarioComment({
    date: "2026-09-22T17:00:00+01:00", id: 12920, owner: AUTHOR, parentId: 12919,
    text: "Out of scope for this branch.", type: "discarded",
  }),
  scenarioComment({ date: "2026-09-22T17:05:00+01:00", id: 12926, owner: AUTHOR, text: "Appreciate the quick look!",
    type: "conversation" }),
  timeline(12931, "2026-09-22T17:10:00+01:00", "[status-reviewed]LGTM, only a few small questions, none blocking."),
  scenarioComment({ date: "2026-09-22T17:20:00+01:00", id: 12932, owner: AUTHOR, parentId: 12931,
    text: "Both points addressed. Cheers!" }),
  timeline(12944, "2026-09-22T17:30:00+01:00", "[status-rework-required]"),
  // A comment on the base (left) side, and one on a file outside the workspace root.
  scenarioComment({ date: "2026-09-22T17:40:00+01:00", id: 12961, location: 55, revisionId: 10851,
    text: "This constant was already here." }),
  scenarioComment({ date: "2026-09-22T17:50:00+01:00", id: 12981, location: 1, revisionId: 6411,
    text: "Old editor script." }),
];
export const SCENARIO_COMMENTS_XML = commentsXml(SCENARIO_COMMENTS);

/** Answers every query the service makes about the scenario reviews. */
export function scenarioAnswer(command: string, args: string[]): string {
  const where = args[1] ?? "";
  if (command === "diff") {
    if (args.includes("--clean")) {
      return CLEAN_DIFF_OUTPUT;
    }
    if (args[0] === "cs:3203") {
      return CHANGESET_DIFF_OUTPUT;
    }
    return args[0].startsWith("br:") ? PLAIN_DIFF_OUTPUT : HEAD_CHANGESET_DIFF_OUTPUT;
  }
  if (command === "whoami") {
    return `${ME}\n`;
  }
  if (command === "codereview") {
    return "";
  }
  switch (args[0]) {
  case "review":
    if (where.includes(`id = ${CHANGESET_REVIEW_ID}`)) {
      return CHANGESET_REVIEW_XML;
    }
    return where.includes(`id = ${BRANCH_REVIEW_ID}`) ? BRANCH_REVIEW_XML : EMPTY_QUERY;
  case "branch":
    return where === `where id = ${BRANCH_ID}` ? branchRowXml(BRANCH_ID, BRANCH_NAME, HEAD) : EMPTY_QUERY;
  case "merge":
    return MERGES_XML;
  case "changeset":
    if (where.includes("order by changesetid asc limit 1")) {
      return FIRST_CHANGESET_XML;
    }
    if (where.includes("changesetid=3203")) {
      return HIDDEN_CHANGESET_XML;
    }
    return BRANCH_CHANGESETS_XML;
  case "changereviewcomment":
    return SCENARIO_COMMENTS_XML;
  case "revision": {
    const item = /itemid = (\d+)/.exec(where);
    if (item) {
      return revisionsXml(REVISIONS.filter(row => row.itemId === Number(item[1])));
    }
    const ids = (where.match(/\bid = \d+/g) ?? []).map(match => Number(match.replace(/\D/g, "")));
    return revisionsXml(REVISIONS.filter(row => ids.includes(row.id)));
  }
  default:
    throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
  }
}
