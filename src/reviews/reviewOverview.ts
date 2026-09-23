import {
  ageInWords,
  avatarColor,
  avatarInitials,
  changeKind,
  commentTypeLabel,
  firstLine,
  formatCount,
  hasLocation,
  isGeneralThread,
  shortDateTime,
  shortOwner,
  splitCodeSpans,
  splitReviewTitle,
  statusContext,
  stripMachineTags,
  threadCounts,
  threadTypeLabel,
  updateSummary,
} from "./reviewPresentation";
import { FileChangeStatus, IChangesetFileChange } from "../models";
import {
  fileKey,
  IReview,
  IReviewChangeset,
  IReviewComment,
  IReviewDiscussions,
  IReviewThread,
  IReviewTimelineEvent,
  scopeRows,
  viewableRows,
} from "./models";
import { FileScope, IActiveReview, Stage } from "./sessionTypes";
import {
  IReviewer,
  isWaitingOn,
  removedReviewers,
  ReviewerState,
  reviewerStates,
  reviewHistory,
  ReviewHistoryEntry,
  sameUser,
} from "./timeline";
import { compareNames } from "./reviewFileTree";
import { posix } from "path";
import { toFileRow } from "../history/historyViewProvider";

/**
 * The Overview document: the active review as one block of HTML in a Markdown
 * document, shown in the built-in Markdown preview and styled by
 * media/reviews/overview.css. That stylesheet is contributed through
 * `markdown.previewStyles` and so loads in every preview, which is why the
 * page sits in one `.plastic-review` element and every rule is scoped to it.
 *
 * The preview renders HTML as it comes (markdown-it with `html: true`, no
 * sanitiser; its CSP blocks scripts), so every string from the server is
 * escaped, and user text becomes <p> and <br> without a newline of its own:
 * markdown-it ends an HTML block at the first blank line and renders the rest
 * as Markdown. In user text, http(s) URLs become links and code spans stay
 * code; nothing else a user wrote has any meaning here.
 */

/** Where a link on the page leads; `IOverviewOptions.link` turns it into a URI the preview can open. */
export type OverviewLinkTarget =
  | { kind: "thread"; threadId: number }
  | { kind: "file"; scope: FileScope; fileKey: string };

export interface IOverviewOptions {
  /** The clock for relative ages. */
  now: number;
  isViewed?: (file: IChangesetFileChange) => boolean;
  /** The `cm whoami` user, marked "you" on the page. */
  whoami?: string;
  /**
   * An absolute URI that opens the target, or undefined when it cannot be
   * opened. Without one the only links are the URLs people wrote.
   */
  link?: (target: OverviewLinkTarget) => string | undefined;
}

/** Newest History entries listed; older ones fold into a <details>. */
const HISTORY_SHOWN = 8;
/** Newest changesets listed; the Review view lists them all. */
const CHANGESETS_SHOWN = 4;
/** Files a changeset review lists; the Review view lists them all. */
const FILES_SHOWN = 50;
/** The schemes the Markdown preview opens on a click (its media/index.js); a link to anything else does nothing. */
const OPENABLE = /^(?:https?|vscode|vscode-insiders):\/\//i;
/** An http(s) URL in user text, up to white space, a quote, an angle bracket or a backtick. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const NO_TEXT = "<p class=\"dim\">(no text)</p>";
/** The whole comment of a changeset made by applying a change request. */
const APPLIED_CHANGE = /\[apply-change:[0-9a-f-]+\]/i;
/** Sized and stroked by its attributes too, so it stays a small icon when the stylesheet does not load. */
const BRANCH_ICON = "<svg class=\"icon\" width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" " +
  "stroke=\"currentColor\" stroke-width=\"1.2\" aria-hidden=\"true\">" +
  "<circle cx=\"4.5\" cy=\"3.5\" r=\"1.5\"/><circle cx=\"4.5\" cy=\"12.5\" r=\"1.5\"/>" +
  "<circle cx=\"11.5\" cy=\"5.5\" r=\"1.5\"/><path d=\"M4.5 5v6M11.5 7c0 2.5-3 2.5-5.6 4.4\"/></svg>";
/** A closing bracket and the one that opens it, for `trimUrl`. */
const BRACKETS: { [close: string]: string } = { ")": "(", "]": "[", "}": "{" };

const STATUS_TONES: { [status in ReturnType<typeof statusContext>]: string } = {
  reviewed: "green",
  reworkRequired: "orange",
  underReview: "blue",
  unknown: "grey",
};

const REVIEWER_PILLS: { [state in ReviewerState]: [ string, string ] } = {
  askedAgain: [ "Asked again", "grey" ],
  requested: [ "Requested", "grey" ],
  reviewed: [ "Reviewed", "green" ],
  reviewing: [ "Reviewing", "grey" ],
  reworkRequired: [ "Rework required", "orange" ],
};

/** What every section reads. */
interface IPage {
  readonly active: IActiveReview;
  readonly now: number;
  readonly whoami?: string;
  readonly isViewed?: (file: IChangesetFileChange) => boolean;
  /** The caller's link builder, limited to URIs the preview opens. */
  readonly link: (target: OverviewLinkTarget) => string | undefined;
  /** Set once the discussions stage is ready. */
  readonly discussions?: IReviewDiscussions;
  readonly reviewers: readonly IReviewer[];
  /** The reviewers with a card: all but the author, who has one only for a verdict they gave. */
  readonly cards: readonly IReviewer[];
  /** People removed from the reviewers who have no row now. */
  readonly removed: readonly string[];
  /** The verdict threads the reviewer cards print, by thread id (the verdict row's id). */
  readonly verdictThreads: ReadonlyMap<number, IReviewThread>;
}

export function renderOverview(active: IActiveReview, options: IOverviewOptions): string {
  const discussions = ready(active.discussions);
  const reviewers = discussions ? reviewerStates(discussions.timeline, active.review) : [];
  // A self-request of the author's (Plastic writes one when some reviews are created) is not a review.
  const cards = reviewers.filter(reviewer => !reviewer.author || hasVerdict(reviewer));
  const threads = new Map((discussions?.threads ?? []).map(thread => [ thread.id, thread ]));
  const verdictThreads = new Map<number, IReviewThread>();
  for (const reviewer of cards) {
    const thread = reviewer.verdict && threads.get(reviewer.verdict.id);
    if (thread) {
      verdictThreads.set(thread.id, thread);
    }
  }
  const page: IPage = {
    active,
    cards,
    discussions,
    isViewed: options.isViewed,
    link: target => {
      const href = options.link?.(target);
      return href && OPENABLE.test(href) ? href : undefined;
    },
    now: options.now,
    removed: discussions ? removedReviewers(discussions.timeline, active.review) : [],
    reviewers,
    verdictThreads,
    whoami: options.whoami,
  };
  // The artboards: a changeset review reads its comment and files first, a branch review its changesets last.
  const lines = [
    "<div class=\"plastic-review\">",
    ...header(page),
    ...summary(page),
    ...(active.review.targetType === "changeset" ? [ ...changesetComment(page), ...filesSection(page) ] : []),
    ...discussionSections(page),
    ...(active.review.targetType === "branch" ? changesetsSection(page) : []),
    ...historySection(page),
    "</div>",
  ];
  return `${lines.join("\n")}\n`;
}

function header(page: IPage): string[] {
  const review = page.active.review;
  const files = ready(page.active.files);
  const title = splitReviewTitle(review, files?.branch?.name);
  const kind = review.targetType === "branch" ? "Branch review"
    : review.targetType === "changeset" ? "Changeset review" : "Review";
  const assignee = review.assignee.trim() ? who(page, review.assignee) : "unassigned";
  const meta = [ statusPill(review.status), `<span>${who(page, review.owner)} → ${assignee}</span>` ];
  const opened = shortDateTime(review.date, page.now);
  if (opened) {
    meta.push(`<span class="dim">· opened ${opened}, ${ageInWords(review.date, page.now)}</span>`);
  }
  const lines = [
    `<p class="eyebrow">${kind} · #${review.id}</p>`,
    `<h1 class="title">${linkify(title.title)}</h1>`,
    `<div class="meta">${meta.join(" ")}</div>`,
    `<div class="meta chips">${chips(page).join(" ")}</div>`,
  ];
  if (page.active.updates) {
    lines.push(`<p class="notice">Newer data on the server: ${escapeHtml(updateSummary(page.active.updates))}. ` +
      "Use Load Updates to see it.</p>");
  }
  if (files?.branchDeleted) {
    lines.push("<p class=\"notice\">The branch no longer exists. Discussions still open their original context.</p>");
  }
  const lead = [ title.rest, description(page) ].filter(Boolean).map(richText).join("");
  if (lead) {
    lines.push(`<div class="lead">${lead}</div>`);
  }
  return lines;
}

/** The branch and both sides of the comparison, or the changeset and its parent. */
function chips(page: IPage): string[] {
  const review = page.active.review;
  const stage = page.active.files;
  const files = ready(stage);
  const chip = (html: string, mono = false, title = "") =>
    `<span class="chip${mono ? " mono" : ""}"${title ? ` title="${escapeHtml(title)}"` : ""}>${html}</span>`;
  // `cs:3471 ↔ cs:3715`, or words when there is no changeset to name (a branch without changesets yet).
  const label = files && !files.branchDeleted ? files.final.label : "";
  const sides = label ? [chip(escapeHtml(label), label.includes("cs:"))] : [];
  if (review.targetType === "changeset") {
    return [ chip(`cs:${escapeHtml(review.target.replace(/^cs:/, ""))}`, true), ...sides ];
  }
  if (review.targetType !== "branch") {
    return [chip(`${escapeHtml(review.targetType || "unknown target")} (not supported)`)];
  }
  if (!files) {
    return [chip(stage.state === "error" ? "couldn't load the branch" : "loading the branch…")];
  }
  if (files.branchDeleted || !files.branch) {
    // cm's object id means nothing to a reader: it is only the chip's title.
    return [chip(`${BRANCH_ICON}branch <span class="marker">deleted</span>`, false, `Branch ${review.target}`)];
  }
  const hidden = files.branch.hidden ? " <span class=\"marker\">hidden branch</span>" : "";
  return [ chip(`${BRANCH_ICON}${escapeHtml(files.branch.name)}${hidden}`), ...sides ];
}

/** The latest `[description]` row's text; empty when there is none or it was cleared. */
function description(page: IPage): string {
  const descriptions = (page.discussions?.timeline ?? []).filter(event => event.kind === "description");
  return descriptions.length ? descriptions[descriptions.length - 1].text : "";
}

function summary(page: IPage): string[] {
  const { headline, facts } = standing(page);
  return [
    "<section class=\"stand\" aria-label=\"Where it stands\">",
    `<p class="stand-head"><strong>${headline}</strong>${facts ? ` <span class="dim">${facts}</span>` : ""}</p>`,
    "<ul class=\"tiles\">",
    filesTile(page),
    changeRequestsTile(page),
    questionsTile(page),
    signOffTile(page),
    "</ul>",
    "</section>",
  ];
}

/**
 * Who the review waits on, and the facts behind it. Plastic seems to mark a
 * review Reviewed once every requested reviewer's latest verdict is Reviewed,
 * but that is observed, not documented, so the page states only facts.
 */
function standing(page: IPage): { headline: string; facts: string } {
  const stage = page.active.discussions;
  if (stage.state !== "ready") {
    // The notice below says why the discussions are missing; this line says what that leaves out.
    const headline = stage.state === "error" ? "Couldn't load the reviewers" : "Loading the reviewers…";
    return { facts: "", headline };
  }
  const reviewers = page.reviewers.filter(reviewer => !reviewer.author);
  const approved = reviewers.filter(reviewer => reviewer.state === "reviewed");
  const rework = reviewers.filter(reviewer => reviewer.state === "reworkRequired");
  const waiting = reviewers.filter(isWaitingOn);
  const facts: string[] = [];
  let headline: string;
  // Whether the headline already names everyone the review waits on.
  let named = false;
  if (!reviewers.length) {
    headline = nobodyReviews(page);
    if (page.removed.length) {
      const removed = joinWords(page.removed.map(user => who(page, user)));
      facts.push(`${removed} ${page.removed.length === 1 ? "was" : "were"} removed from the reviewers.`);
    }
  } else if (statusContext(page.active.review.status) === "reviewed" || (!waiting.length && !rework.length)) {
    headline = approved.length < reviewers.length
      ? `${formatCount(approved.length)} of ${formatCount(reviewers.length)} reviewers marked it Reviewed`
      : reviewers.length === 1 ? `${names(page, approved)} marked it Reviewed`
        : `All ${formatCount(reviewers.length)} reviewers marked it Reviewed`;
  } else if (rework.length) {
    headline = `Waiting on ${who(page, page.active.review.owner, "author")}`;
  } else {
    // A reviewer asked to look again is marked beside their name rather than named twice.
    headline = `Waiting on ${names(page, waiting, reviewer => (reviewer.state === "askedAgain" ? "asked again" : ""))}`;
    named = true;
    if (approved.length) {
      facts.push(`${names(page, approved)} marked it Reviewed.`);
    }
  }
  if (rework.length) {
    facts.push(`${names(page, rework)} asked for rework.`);
  }
  const again = waiting.filter(reviewer => reviewer.state === "askedAgain");
  if (again.length && !named) {
    facts.push(`${names(page, again)} ${again.length === 1 ? "was" : "were"} asked to look again.`);
  }
  // Back after a verdict of their own, which their card quotes: they are not without one.
  const rejoined = waiting.filter(reviewer => reviewer.state === "reviewing" && reviewer.verdict);
  for (const status of [ "Reviewed", "Rework required" ]) {
    const back = rejoined.filter(reviewer => reviewer.verdict!.status === status);
    if (back.length && !named) {
      facts.push(`${names(page, back)} ${verdictWords(back[0].verdict!)} and joined again.`);
    }
  }
  const silent = waiting.filter(reviewer => reviewer.state !== "askedAgain" && !reviewer.verdict);
  if (silent.length && !named) {
    facts.push(`${names(page, silent)} ${silent.length === 1 ? "has" : "have"} no verdict yet.`);
  }
  facts.push(openFact(page.discussions!.threads));
  return { facts: facts.join(" "), headline };
}

/**
 * The headline when nobody but the author reviews: the author's own verdict,
 * or that everyone requested was removed, or that nobody was ever requested.
 */
function nobodyReviews(page: IPage): string {
  const author = page.cards.find(reviewer => reviewer.author);
  if (author?.verdict) {
    return `${who(page, author.user, "author")} ${verdictWords(author.verdict)}`;
  }
  return page.removed.length ? "No reviewers left" : "No reviewers requested yet";
}

function openFact(threads: readonly IReviewThread[]): string {
  const pending = threads.filter(isPendingChange).length;
  const open = threads.filter(isOpenQuestion).length;
  const parts: string[] = [];
  if (pending) {
    parts.push(`${count(pending, "change request")} ${pending === 1 ? "is" : "are"} pending`);
  }
  if (open) {
    parts.push(`${count(open, "question")} ${open === 1 ? "is" : "are"} open`);
  }
  return parts.length ? `${parts.join(" and ")}.` : "Nothing is open.";
}

/** Changes' own files, directory records left out: the counts the Review view shows. */
function filesTile(page: IPage): string {
  const stage = page.active.files;
  if (stage.state !== "ready") {
    return stageTile("Files viewed", stage);
  }
  const files = stage.value;
  const changes = viewableRows(scopeRows(files, "changes"));
  const merged = viewableRows(scopeRows(files, "merged")).length;
  const sub = files.branchDeleted ? "the branch no longer exists"
    : merged ? `${formatCount(merged)} more came in through merges` : "no merged files";
  const isViewed = page.isViewed;
  if (!isViewed) {
    return tile("Files", formatCount(changes.length), sub);
  }
  const viewed = changes.filter(file => isViewed(file)).length;
  const percent = changes.length ? Math.round(viewed / changes.length * 100) : 0;
  const bar = " <span class=\"bar\" role=\"progressbar\" aria-label=\"Files viewed\" aria-valuemin=\"0\" " +
    `aria-valuemax="${changes.length}" aria-valuenow="${viewed}"><span style="width: ${percent}%"></span></span>`;
  const value = `${formatCount(viewed)} <span class="of">of ${formatCount(changes.length)}</span>`;
  return tile("Files viewed", value, sub, { bar });
}

function changeRequestsTile(page: IPage): string {
  if (!page.discussions) {
    return stageTile("Change requests", page.active.discussions);
  }
  const counts = threadCounts(page.discussions.threads);
  const resolved: string[] = [];
  if (counts.applied) {
    resolved.push(`${formatCount(counts.applied)} applied`);
  }
  if (counts.discarded) {
    resolved.push(`${formatCount(counts.discarded)} discarded`);
  }
  const sub = resolved.length ? resolved.join(" · ") : counts.pending ? "none resolved yet" : "nothing pending";
  return counts.pending
    ? tile("Change requests", `${formatCount(counts.pending)} pending`, sub, { tone: "orange" })
    : tile("Change requests", "None", sub);
}

/** A question is open until someone other than the asker replies. */
function questionsTile(page: IPage): string {
  if (!page.discussions) {
    return stageTile("Questions", page.active.discussions);
  }
  const questions = page.discussions.threads.filter(thread => thread.kind === "question");
  const open = questions.filter(isOpenQuestion).length;
  const answered = questions.length - open;
  const sub = answered ? `${formatCount(answered)} answered` : open ? "none answered yet" : "nothing open";
  return open ? tile("Questions", `${formatCount(open)} open`, sub, { tone: "blue" }) : tile("Questions", "None", sub);
}

function signOffTile(page: IPage): string {
  if (!page.discussions) {
    return stageTile("Sign-off", page.active.discussions);
  }
  const reviewers = page.reviewers.filter(reviewer => !reviewer.author);
  if (!reviewers.length) {
    return tile("Sign-off", "None", page.removed.length ? "no reviewers left" : "no reviewers yet");
  }
  const approved = reviewers.filter(reviewer => reviewer.state === "reviewed").length;
  return tile("Sign-off", `${formatCount(approved)} <span class="of">of ${formatCount(reviewers.length)}</span>`,
    "reviewers approved", approved === reviewers.length ? { tone: "green" } : {});
}

/** One summary tile. `value` and `sub` are HTML; the hidden separators keep it readable without the stylesheet. */
function tile(key: string, value: string, sub: string, options: { tone?: string; bar?: string; title?: string } = {}):
    string {
  const title = options.title ? ` title="${escapeHtml(options.title)}"` : "";
  const tone = options.tone ? ` ${options.tone}` : "";
  return `<li class="tile"${title}><span class="k">${key}</span><span class="sep">: </span>` +
    `<span class="v${tone}">${value}</span>${options.bar ?? ""}` +
    `${sub ? `<span class="sep"> · </span><span class="s">${sub}</span>` : ""}</li>`;
}

function stageTile(key: string, stage: Stage<unknown>): string {
  return stage.state === "error"
    ? tile(key, "couldn't load", "", { title: stage.message, tone: "dim" })
    : tile(key, "loading…", "", { tone: "dim" });
}

function discussionSections(page: IPage): string[] {
  const stage = page.active.discussions;
  if (!page.discussions) {
    return [stageNote(stage, "the discussions")];
  }
  const general = page.discussions.threads.filter(isGeneralThread).sort(byRootDate);
  return [
    ...(page.discussions.message ? [`<p class="stage dim">${escapeHtml(page.discussions.message)}</p>`] : []),
    ...reviewersSection(page),
    ...openItemsSection(page),
    ...conversationSection(page, general),
    ...otherDiscussions(page, general),
  ];
}

function reviewersSection(page: IPage): string[] {
  const heading = `<h2>Reviewers ${countBadge(page.cards.length)}</h2>`;
  if (!page.cards.length) {
    const empty = page.removed.length ? "No reviewers left." : "No reviewers requested yet.";
    return [ heading, `<p class="empty dim">${empty}</p>` ];
  }
  return [ heading, "<ul class=\"people\">", ...page.cards.map(reviewer => reviewerCard(page, reviewer)), "</ul>" ];
}

/** A reviewer's state; a verdict's replies sit under its quote, the only place the page prints that thread. */
function reviewerCard(page: IPage, reviewer: IReviewer): string {
  const [ label, tone ] = REVIEWER_PILLS[reviewer.state];
  const tags = [ isMe(page, reviewer.user) && "you", reviewer.author && "author", reviewer.assignee && "assignee" ]
    .filter(Boolean).map(tag => `<span class="tag">${tag}</span>`);
  const verdict = reviewer.verdict;
  const thread = verdict && page.verdictThreads.get(verdict.id);
  const row = [ name(reviewer.user, "name"), ...tags, `<span class="pill ${tone}">${label}</span>` ].join(" ");
  return `<li class="person">${avatar(reviewer.user)}<div class="body"><div class="row">${row}</div>` +
    `<div class="when">${escapeHtml(whenLine(page, reviewer))}</div>` +
    `${verdict?.text ? `<blockquote class="quote">${richText(verdict.text)}</blockquote>` : ""}` +
    `${thread ? replyList(page, thread.comments.slice(1)) : ""}</div></li>`;
}

function whenLine(page: IPage, reviewer: IReviewer): string {
  const age = (event?: IReviewTimelineEvent) => (event ? ageInWords(event.date, page.now) : "");
  // What their latest verdict was and when, for the states that follow one: `Asked for rework 3 days ago`.
  const verdict = reviewer.verdict ? `${capitalize(verdictWords(reviewer.verdict))} ${age(reviewer.verdict)}` : "";
  switch (reviewer.state) {
  case "requested":
    return reviewer.request ? `Asked ${age(reviewer.request)} · no verdict yet` : "No verdict yet";
  case "reviewing":
    // Back after a verdict of their own, or joined for the first time.
    if (verdict) {
      return `${verdict} · joined again ${age(reviewer.request)}`;
    }
    return `Joined ${age(reviewer.request)} · no verdict yet`;
  case "askedAgain":
    return `${verdict} · asked to look again ${age(reviewer.request)}`;
  default: {
    const when = capitalize(age(reviewer.verdict));
    return reviewer.verdict?.text ? when : `${when} · no comment`;
  }
  }
}

/** `marked it Reviewed` or `asked for rework`, as History says it. */
function verdictWords(verdict: IReviewTimelineEvent): string {
  return verdict.status === "Reviewed" ? "marked it Reviewed" : "asked for rework";
}

/** Whether a reviewer's latest word is a verdict, not a request still waiting for one. */
function hasVerdict(reviewer: IReviewer): boolean {
  return reviewer.state === "reviewed" || reviewer.state === "reworkRequired";
}

/** Pending change requests and open questions: change requests first, then the oldest first. */
function openItemsSection(page: IPage): string[] {
  const threads = page.discussions!.threads;
  const open = threads.filter(thread => isPendingChange(thread) || isOpenQuestion(thread))
    .sort((a, b) => Number(isPendingChange(b)) - Number(isPendingChange(a)) || byRootDate(a, b));
  const hint = discussionsHint(threads);
  if (!open.length && !hint) {
    // The summary says that nothing is open; as on the Changeset artboard, the section is left out.
    return [];
  }
  const lines = [`<h2>Open items ${countBadge(open.length)}</h2>`];
  if (open.length) {
    lines.push("<ul class=\"items\">", ...open.map(thread => openItem(page, thread)), "</ul>");
  } else {
    lines.push("<p class=\"empty dim\">Nothing open.</p>");
  }
  if (hint) {
    lines.push(`<p class="hint dim">${hint}</p>`);
  }
  return lines;
}

function openItem(page: IPage, thread: IReviewThread): string {
  const root = thread.comments[0];
  const change = isPendingChange(thread);
  const replies = thread.comments.length - 1;
  const when = [ name(root.owner), escapeHtml(ageInWords(root.date, page.now)) ];
  if (replies) {
    when.push(count(replies, "reply", "replies"));
  }
  const text = root.text.trim();
  // One line per card, as on the artboard; the whole comment is the title, and one click away.
  const first = firstLine(paragraphs(text)[0] ?? "");
  const title = text !== first ? ` title="${escapeHtml(text)}"` : "";
  return `<li class="item"><div class="row"><span class="pill ${change ? "orange" : "blue"}">` +
    `${change ? "Change request" : "Question"}</span>${location(page, thread)} ` +
    `<span class="when dim">${when.filter(Boolean).join(" · ")}</span></div>` +
    `<p class="text"${title}>${first ? inlineText(first) : "<span class=\"dim\">(no text)</span>"}</p></li>`;
}

/**
 * `File.cs:18` and its folder; the name opens the discussion on its line. A
 * comment on the whole file has no line to open, so its name stays plain, and
 * General threads have no file at all.
 */
function location(page: IPage, thread: IReviewThread): string {
  if (thread.anchor.revisionId <= 0) {
    return "";
  }
  const path = thread.path;
  const located = hasLocation(thread);
  const line = located ? `:${thread.anchor.location + 1}` : "";
  const label = path ? `${posix.basename(path) || path}${line}` : `revision ${thread.anchor.revisionId}${line}`;
  const folder = path ? posix.dirname(path).replace(/^\/+/, "") : "";
  const text = escapeHtml(label);
  const reference = located ? linkTo(page, { kind: "thread", threadId: thread.id }, text) : text;
  return ` ${reference}${folder ? ` <span class="dim">${escapeHtml(folder)}</span>` : ""}`;
}

/**
 * `1 applied and 1 discarded change requests, and 2 comments are in
 * Discussions.`: the file threads the list above leaves out. The change
 * requests always carry their noun, so what follows them is not read as applied.
 */
function discussionsHint(threads: readonly IReviewThread[]): string {
  const inFiles = threads.filter(thread => !isGeneralThread(thread));
  const counts = threadCounts(inFiles);
  const answered = inFiles.filter(thread => thread.kind === "question" && !isOpenQuestion(thread)).length;
  const comments = inFiles.filter(thread => thread.kind === "comment").length;
  const resolved: string[] = [];
  if (counts.applied) {
    resolved.push(`${formatCount(counts.applied)} applied`);
  }
  if (counts.discarded) {
    resolved.push(`${formatCount(counts.discarded)} discarded`);
  }
  const parts: string[] = [];
  if (resolved.length) {
    const changes = counts.applied + counts.discarded;
    parts.push(`${joinWords(resolved)} ${changes === 1 ? "change request" : "change requests"}`);
  }
  if (answered) {
    parts.push(count(answered, "answered question"));
  }
  if (comments) {
    parts.push(count(comments, "comment"));
  }
  if (!parts.length) {
    return "";
  }
  const total = counts.applied + counts.discarded + answered + comments;
  // `1 applied and 1 discarded change requests, and 2 comments`: a comma keeps the two "and"s apart.
  const list = resolved.length > 1 && parts.length > 1
    ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : joinWords(parts);
  return `${list} ${total === 1 ? "is" : "are"} in Discussions.`;
}

function conversationSection(page: IPage, general: readonly IReviewThread[]): string[] {
  const conversation = general.filter(thread => thread.kind === "conversation");
  if (!conversation.length) {
    return [];
  }
  return [
    `<h2>Conversation ${countBadge(conversation.length)}</h2>`,
    "<ul class=\"comments\">",
    ...conversation.map(thread => commentCard(page, thread)),
    "</ul>",
  ];
}

/**
 * The General threads printed nowhere else, in full: Discussions opens this
 * page for every General thread. A timeline row without replies is fully
 * told by its History line, and a verdict a reviewer card quotes sits there.
 */
function otherDiscussions(page: IPage, general: readonly IReviewThread[]): string[] {
  const others = general.filter(thread => thread.kind !== "conversation" && !page.verdictThreads.has(thread.id) &&
    !(thread.event && thread.comments.length === 1));
  if (!others.length) {
    return [];
  }
  return [
    `<h2>Other discussions ${countBadge(others.length)}</h2>`,
    "<ul class=\"comments\">",
    ...others.map(thread => commentCard(page, thread, threadTypeLabel(thread))),
    "</ul>",
  ];
}

function commentCard(page: IPage, thread: IReviewThread, label = ""): string {
  const root = thread.comments[0];
  return `<li class="comment">${avatar(root.owner)}<div class="body">${commentHead(page, root, label)}` +
    `<div class="text">${richText(root.text) || NO_TEXT}</div>${replyList(page, thread.comments.slice(1))}</div></li>`;
}

function replyList(page: IPage, replies: readonly IReviewComment[]): string {
  if (!replies.length) {
    return "";
  }
  const items = replies.map(reply => {
    const type = commentTypeLabel(reply);
    return `<li class="reply">${commentHead(page, reply, type === "Comment" ? "" : type)}` +
      `<div class="text">${richText(reply.text) || NO_TEXT}</div></li>`;
  });
  return `<ul class="replies">${items.join("")}</ul>`;
}

function commentHead(page: IPage, comment: IReviewComment, label: string): string {
  const date = shortDateTime(comment.date, page.now);
  const kind = label ? ` <span class="kind">${escapeHtml(label)}</span>` : "";
  const when = date ? ` <span class="dim">· ${date}</span>` : "";
  return `<div class="head">${name(comment.owner, "name")}${kind}${when}</div>`;
}

/**
 * A changeset review's changeset comment, in full, unless the title says the
 * same: Plastic titles the reviews it creates "Review of changeset N - <comment>".
 * cm does not return the comment for every changeset.
 */
function changesetComment(page: IPage): string[] {
  const id = Number(page.active.review.target.replace(/^cs:/, ""));
  const changeset = ready(page.active.changesets)?.items.find(item => item.id === id);
  const comment = stripMachineTags(changeset?.comment ?? "");
  const [ first, ...rest ] = paragraphs(comment);
  const title = splitReviewTitle(page.active.review);
  if (!first || oneLine(comment) === oneLine(`${title.title}\n${title.rest}`)) {
    return [];
  }
  const more = rest.map(paragraph => `<p>${inlineText(paragraph)}</p>`).join("");
  return [ "<h2>Changeset comment</h2>", `<div class="msg"><p class="first">${inlineText(first)}</p>${more}</div>` ];
}

/** A changeset review's files, each opening its diff as a click on its row in the Review view does. */
function filesSection(page: IPage): string[] {
  const stage = page.active.files;
  if (stage.state !== "ready") {
    return [ "<h2>Files</h2>", stageNote(stage, "the files") ];
  }
  const files = stage.value;
  const rows = viewableRows(scopeRows(files, "changes")).sort((a, b) => compareNames(a.path, b.path));
  const heading = `<h2>Files ${countBadge(rows.length)}</h2>`;
  if (!rows.length) {
    return [ heading, "<p class=\"empty dim\">No files changed.</p>" ];
  }
  const lines = [ heading, "<ul class=\"list files\">", ...rows.slice(0, FILES_SHOWN).map(row => fileRow(page, row)) ];
  const more = rows.length - FILES_SHOWN;
  if (more > 0) {
    const rest = `${count(more, "more file")} ${more === 1 ? "is" : "are"}`;
    lines.push(`<li class="more dim">${rest} in the Review view.</li>`);
  }
  lines.push("</ul>");
  return lines;
}

function fileRow(page: IPage, file: IChangesetFileChange): string {
  const row = toFileRow(file);
  const link = linkTo(page, { fileKey: fileKey(file), kind: "file", scope: "changes" }, escapeHtml(row.name));
  const folder = row.directory ? ` <span class="dim">${escapeHtml(row.directory)}</span>` : "";
  return `<li class="li"><span class="st ${statusTone(file.status)}" title="${escapeHtml(changeKind(file))}">` +
    `${escapeHtml(row.status.substring(0, 2) || "·")}</span> ${link}${folder}</li>`;
}

/** The Review view's decoration colours: added, deleted, changed, then moved. */
function statusTone(status: FileChangeStatus): string {
  if (status & FileChangeStatus.Added) {
    return "added";
  }
  if (status & FileChangeStatus.Deleted) {
    return "deleted";
  }
  return status & FileChangeStatus.Changed ? "changed" : "moved";
}

function changesetsSection(page: IPage): string[] {
  const stage = page.active.changesets;
  if (stage.state !== "ready") {
    return [ "<h2>Changesets</h2>", stageNote(stage, "the changesets") ];
  }
  const { items, hasMore } = stage.value;
  if (!items.length) {
    return [];
  }
  const lines = [
    `<h2>Changesets ${countBadge(items.length, hasMore)}</h2>`,
    "<ul class=\"list changesets\">",
    ...items.slice(0, CHANGESETS_SHOWN).map(changeset => changesetRow(page, changeset)),
  ];
  const older = Math.max(0, items.length - CHANGESETS_SHOWN);
  if (older || hasMore) {
    const many = older !== 1 || hasMore;
    const changesets = `${formatCount(older)}${hasMore ? "+" : ""} older changeset${many ? "s are" : " is"}`;
    lines.push(`<li class="more dim">${changesets} in the Review view.</li>`);
  }
  lines.push("</ul>");
  return lines;
}

function changesetRow(page: IPage, changeset: IReviewChangeset): string {
  // A merge's comment is Plastic's own "Merge from …"; where it came from says it already.
  const branch = changeset.mergeSourceBranch;
  const source = branch ? ` <span class="dim">from ${escapeHtml(branch)}</span>` : "";
  const comment = firstLine(stripMachineTags(changeset.comment));
  const none = APPLIED_CHANGE.test(changeset.comment) ? "(applied a change request)" : "(no comment)";
  const what = changeset.isMerge ? `<span class="pill purple">Merge</span>${source}`
    : comment ? inlineText(comment) : `<span class="dim">${none}</span>`;
  const by = [ name(changeset.owner), shortDateTime(changeset.date, page.now) ].filter(Boolean).join(" · ");
  return `<li class="li"><code>cs:${changeset.id}</code> <span class="what">${what}</span> ` +
    `<span class="dim">${by}</span></li>`;
}

/** Newest first; past the newest few, the rest fold into a <details>, which the preview keeps open across refreshes. */
function historySection(page: IPage): string[] {
  if (!page.discussions) {
    return [];
  }
  const entries = reviewHistory(page.discussions.timeline, page.active.review).reverse();
  if (!entries.length) {
    return [];
  }
  const lines = [
    "<h2>History</h2>",
    "<ul class=\"tl\">",
    ...entries.slice(0, HISTORY_SHOWN).map(entry => historyLine(page, entry)),
    "</ul>",
  ];
  const earlier = entries.slice(HISTORY_SHOWN);
  if (earlier.length) {
    lines.push(
      "<details class=\"earlier\">",
      `<summary>${count(earlier.length, "earlier event")}</summary>`,
      "<ul class=\"tl\">",
      ...earlier.map(entry => historyLine(page, entry)),
      "</ul>",
      "</details>");
  }
  return lines;
}

function historyLine(page: IPage, entry: ReviewHistoryEntry): string {
  const date = shortDateTime(entry.kind === "opened" ? entry.date : entry.event.date, page.now);
  const [ tone, text ] = historyText(entry, page.active.review);
  return `<li><span class="dot ${tone}" aria-hidden="true"></span><span class="date">${date}</span> ` +
    `<span class="what">${text}</span></li>`;
}

/**
 * The dot's colour (verdict colours; grey for the rest) and the line:
 * `priya.nair joined and marked it Reviewed`. A line is one line of text:
 * the reviewer card or Discussions has the full comment.
 */
function historyText(entry: ReviewHistoryEntry, review: IReview): [ string, string ] {
  if (entry.kind === "opened") {
    const requested = entry.requested.map(user => name(user));
    const also = requested.length ? ` and requested ${joinWords(requested)}` : "";
    return [ "grey", `${name(entry.owner)} opened the review${also}` ];
  }
  const event = entry.event;
  const actor = name(event.owner);
  const user = event.user ? name(event.user) : "someone";
  const text = event.text ? `: ${inlineText(oneLine(event.text))}` : "";
  const joined = entry.joined ? "joined and " : "";
  switch (event.kind) {
  case "status":
    switch (event.status) {
    case "Reviewed":
      return [ "green", `${actor} ${joined}marked it <strong>Reviewed</strong>${text}` ];
    case "Rework required":
      return [ "orange", `${actor} ${joined}asked for <strong>rework</strong>${text}` ];
    case "Under review":
      return [ "blue", `${actor} moved it back to <strong>Under review</strong>${text}` ];
    default:
      return [ "grey", `${actor} changed the status${text}` ];
    }
  case "reviewRequested":
    if (event.user && sameUser(event.user, event.owner)) {
      return [ "grey", entry.again ? `${actor} joined again` : `${actor} joined as a reviewer` ];
    }
    if (entry.again) {
      // A request for someone who has given a verdict is Plastic's other way of asking them to look again.
      return [ "grey", `${actor} asked ${user} to look again` ];
    }
    return [ "grey", `${actor} requested a review from ${user}` ];
  case "reviewReRequested":
    return [ "grey", `${actor} asked ${user} to look again` ];
  case "reviewRequestRemoved":
    return [ "grey", `${actor} removed ${user} from the reviewers` ];
  case "renamed":
    if (event.previous && droppedPrefix(review, event.previous, event.text)) {
      return [ "grey", `${actor} renamed it to drop the generated prefix` ];
    }
    return [ "grey", event.previous
      ? `${actor} renamed it from “${linkify(oneLine(event.previous))}” to “${linkify(oneLine(event.text))}”`
      : `${actor} renamed it to “${linkify(oneLine(event.text))}”` ];
  case "description":
    return [ "grey", `${actor} edited the description` ];
  default:
    return [ "grey", event.text ? `${actor}${text}` : `${actor} updated the review` ];
  }
}

/**
 * Whether a rename only took Plastic's "Review of changeset N - " off the
 * title: the page shows the same title before and after.
 */
function droppedPrefix(review: IReview, previous: string, title: string): boolean {
  const generated = /^\s*Review of (?:changeset|branch) /;
  const before = splitReviewTitle({ ...review, title: previous });
  const after = splitReviewTitle({ ...review, title });
  return generated.test(previous) && !generated.test(title) && before.title === after.title &&
    before.rest === after.rest;
}

/**
 * Line breaks and the blank lines between paragraphs as single spaces. Line by
 * line: a pattern that starts with a run of blanks would try the run again from
 * each of its characters.
 */
function oneLine(text: string): string {
  return text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).join(" ");
}

function stageNote(stage: Stage<unknown>, what: string): string {
  return stage.state === "error"
    ? `<p class="notice error">Couldn't load ${what}: ${escapeHtml(errorLine(stage.message))}</p>`
    : `<p class="stage dim">Loading ${what}…</p>`;
}

/** An error's first line, and the next one when the first only introduces it: `cm find comment failed:`. */
function errorLine(message: string): string {
  const lines = message.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) {
    return "unknown error";
  }
  return lines.length > 1 && lines[0].endsWith(":") ? `${lines[0]} ${lines[1]}` : lines[0];
}

function statusPill(status: string): string {
  return `<span class="pill ${STATUS_TONES[statusContext(status)]}"><span class="dot" aria-hidden="true"></span>` +
    `${escapeHtml(status || "Unknown status")}</span>`;
}

function avatar(user: string): string {
  return `<span class="av" style="background-color: ${avatarColor(user)}" aria-hidden="true">` +
    `${escapeHtml(avatarInitials(user))}</span>`;
}

/** A short name; the full address only in its `title`. Names are never links. */
function name(user: string, className = "who"): string {
  const full = user.trim();
  const short = shortOwner(full) || full || "unknown";
  const title = short !== full ? ` title="${escapeHtml(full)}"` : "";
  return `<span class="${className}"${title}>${escapeHtml(short)}</span>`;
}

/**
 * A name marked `(you)` for the current user, and with `role` when given:
 * `maya.chen (you, author)`. Only the header and the summary mark names;
 * the reviewer cards have a `you` tag.
 */
function who(page: IPage, user: string, role?: string): string {
  const marks = [ isMe(page, user) ? "you" : "", role ?? "" ].filter(Boolean);
  return `${name(user)}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

/** Reviewers' names, each with the mark `mark` gives it: `leo.brandt (asked again)`. */
function names(page: IPage, reviewers: readonly IReviewer[], mark?: (reviewer: IReviewer) => string): string {
  return joinWords(reviewers.map(reviewer => who(page, reviewer.user, mark?.(reviewer))));
}

function isMe(page: IPage, user: string): boolean {
  return !!page.whoami && !!user.trim() && sameUser(user, page.whoami);
}

/** The target's URI as a link, or the plain text when it cannot open: nothing looks like a link that is not one. */
function linkTo(page: IPage, target: OverviewLinkTarget, html: string): string {
  const href = page.link(target);
  return href ? `<a href="${escapeHtml(href)}">${html}</a>` : html;
}

function isPendingChange(thread: IReviewThread): boolean {
  return thread.kind === "change" && thread.state === "pending";
}

function isOpenQuestion(thread: IReviewThread): boolean {
  const asker = thread.comments[0]?.owner ?? "";
  return thread.kind === "question" && thread.comments.slice(1).every(reply => sameUser(reply.owner, asker));
}

/** User text as paragraphs: blank lines split them, single line breaks become <br>. */
function richText(text: string): string {
  return paragraphs(text).map(paragraph => `<p>${inlineText(paragraph)}</p>`).join("");
}

function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
}

/** One paragraph of user text: code spans as <code>, URLs as links, line breaks as <br>. */
function inlineText(text: string): string {
  return splitCodeSpans(text.trim())
    .map(part => (part.code ? `<code>${escapeHtml(part.text)}</code>` : linkify(part.text)))
    .join("");
}

/** Escaped text whose http(s) URLs are links; line breaks become <br>. */
function linkify(text: string): string {
  return text.split(/\r\n|\r|\n/).map(linkLine).join("<br>");
}

function linkLine(line: string): string {
  const pattern = new RegExp(URL_PATTERN.source, URL_PATTERN.flags);
  let html = "";
  let last = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const url = trimUrl(match[0]);
    if (!/^https?:\/\/[^/?#]/i.test(url)) {
      continue;
    }
    html += `${escapeHtml(line.substring(last, match.index))}<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = match.index + url.length;
  }
  return html + escapeHtml(line.substring(last));
}

/**
 * Leaves out the punctuation that ends a sentence and a closing bracket the URL
 * did not open. The brackets are counted once: anyone can end a URL in a
 * comment with thousands of them, and the page renders on every refresh.
 */
function trimUrl(url: string): string {
  const counts: { [bracket: string]: number } = {};
  for (const bracket of "()[]{}") {
    counts[bracket] = url.split(bracket).length - 1;
  }
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    const opener = BRACKETS[char];
    if (opener !== undefined && counts[char] > counts[opener]) {
      counts[char]--;
    } else if (!/[.,;:!?*]/.test(char)) {
      break;
    }
    end--;
  }
  return url.substring(0, end);
}

/** Text for HTML content and attribute values alike. Line breaks become references, so no raw newline is left. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r\n|\r|\n/g, "&#10;");
}

function countBadge(value: number, more = false): string {
  return `<span class="count">${formatCount(value)}${more ? "+" : ""}</span>`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function joinWords(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.substring(1);
}

function ready<T>(stage: Stage<T>): T | undefined {
  return stage.state === "ready" ? stage.value : undefined;
}

function byRootDate(a: IReviewThread, b: IReviewThread): number {
  const time = (thread: IReviewThread) => {
    const value = Date.parse(thread.comments[0]?.date ?? "");
    return isNaN(value) ? 0 : value;
  };
  return time(a) - time(b) || a.id - b.id;
}
