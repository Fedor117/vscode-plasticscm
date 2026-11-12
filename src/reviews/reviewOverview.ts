import {
  ageInWords,
  avatarColor,
  avatarInitials,
  canReplyToThread,
  changeKind,
  commentTypeLabel,
  firstLine,
  formatCount,
  hasLocation,
  isGeneralThread,
  isOwnComment,
  isOwnDescription,
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
  | { kind: "file"; scope: FileScope; fileKey: string }
  /** Add Me as Reviewer, on the review the page shows. */
  | { kind: "addMeAsReviewer" }
  /** Reply to, edit or delete a comment of the review, by its id; the description's edit names its row. */
  | { kind: "comment"; action: CommentLinkAction; commentId: number }
  /** A new comment on the whole review. */
  | { kind: "addComment" };

/** What a comment link does; see `OverviewLinkTarget`. */
export type CommentLinkAction = "reply" | "edit" | "delete";

export interface IOverviewOptions {
  /** The clock for relative ages. */
  now: number;
  isViewed?: (file: IChangesetFileChange) => boolean;
  /** The `cm whoami` user, marked "you" on the page. */
  whoami?: string;
  /** The cm user can be added to the reviewers: the Reviewers section links Add me as reviewer. */
  addMe?: boolean;
  /**
   * Review writes work: review-level threads link Reply, the cm
   * user's own comments on the whole review Edit and Delete, their
   * description Edit description, and the end of the Conversation Add comment.
   */
  commentActions?: boolean;
  /**
   * An absolute URI that opens the target, or undefined when it cannot be
   * opened. Without one the only links are the URLs people wrote.
   */
  link?: (target: OverviewLinkTarget) => string | undefined;
}

/**
 * Changesets by one person this close together are one Conversation entry,
 * as GitHub lists a push of several commits: each changeset within this long
 * of the one before it.
 */
const CHANGESET_GROUP_WINDOW = 30 * 60 * 1000;
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
/** A timeline entry's kind, drawn on the line as GitHub draws a pull request's: 16px, stroked. */
const TIMELINE_ICONS = {
  change: "<path d=\"M3.5 1.5h6l3 3v10h-9z\"/><path d=\"M8 5.5v4M6 7.5h4M6 11.5h4\"/>",
  check: "<path d=\"M3 8.5l3 3 7-7\"/>",
  comment: "<path d=\"M2.5 3h11v7.5h-6L4.5 13v-2.5h-2z\"/>",
  commit: "<circle cx=\"8\" cy=\"8\" r=\"2.5\"/><path d=\"M1 8h4.5M10.5 8H15\"/>",
  description: "<path d=\"M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5\"/>",
  dot: "<circle cx=\"8\" cy=\"8\" r=\"2\" fill=\"currentColor\"/>",
  eye: "<path d=\"M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z\"/>" +
    "<circle cx=\"8\" cy=\"8\" r=\"2\"/>",
  opened: "<circle cx=\"4.5\" cy=\"3.5\" r=\"1.5\"/><circle cx=\"4.5\" cy=\"12.5\" r=\"1.5\"/>" +
    "<circle cx=\"11.5\" cy=\"12.5\" r=\"1.5\"/><path d=\"M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7M8.5 3 7 4.5 8.5 6\"/>",
  pencil: "<path d=\"M11 2.5 13.5 5l-8 8H3v-2.5z\"/>",
  person: "<circle cx=\"8\" cy=\"5.5\" r=\"2.5\"/><path d=\"M3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5\"/>",
  question: "<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4\"/>" +
    "<circle cx=\"8\" cy=\"11.6\" r=\".5\" fill=\"currentColor\" stroke=\"none\"/>",
};
type TimelineIcon = keyof typeof TIMELINE_ICONS;
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
  readonly addMe: boolean;
  readonly commentActions: boolean;
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
}

/** One entry of the Conversation: oldest first, then by `rank`, then by `id`, so equal times keep one order. */
interface ITimelineItem {
  readonly time: number;
  /** 0 the review's creation, 1 changesets and notes about them, 2 discussions and review events. */
  readonly rank: number;
  readonly id: number;
  readonly html: string;
}

export function renderOverview(active: IActiveReview, options: IOverviewOptions): string {
  const discussions = ready(active.discussions);
  const reviewers = discussions ? reviewerStates(discussions.timeline, active.review) : [];
  // A self-request of the author's (Plastic writes one when some reviews are created) is not a review.
  const cards = reviewers.filter(reviewer => !reviewer.author || hasVerdict(reviewer));
  const page: IPage = {
    active,
    addMe: !!options.addMe,
    cards,
    commentActions: !!options.commentActions,
    discussions,
    isViewed: options.isViewed,
    link: target => {
      const href = options.link?.(target);
      return href && OPENABLE.test(href) ? href : undefined;
    },
    now: options.now,
    removed: discussions ? removedReviewers(discussions.timeline, active.review) : [],
    reviewers,
    whoami: options.whoami,
  };
  // As a GitHub pull request reads: where it stands, then the whole conversation in order, then the files.
  const changesetReview = active.review.targetType === "changeset";
  const lines = [
    "<div class=\"plastic-review\">",
    ...header(page),
    ...summary(page),
    ...(discussions ? [ ...reviewersSection(page), ...openItemsSection(page) ] : []),
    ...(changesetReview ? changesetComment(page) : []),
    ...conversationSection(page),
    ...(changesetReview ? filesSection(page) : []),
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

function latestDescription(page: IPage): IReviewTimelineEvent | undefined {
  const descriptions = (page.discussions?.timeline ?? []).filter(event => event.kind === "description");
  return descriptions[descriptions.length - 1];
}

/** Edit description, when the latest description is the cm user's own; see `isOwnDescription`. */
function descriptionEdit(page: IPage): string {
  const latest = latestDescription(page);
  if (!page.commentActions || !isOwnDescription(latest, page.whoami)) {
    return "";
  }
  return actionLink(page, { action: "edit", commentId: latest.id, kind: "comment" }, "Edit description");
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
  // Back after a verdict of their own, which the Conversation quotes: they are not without one.
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

/** The reviewer cards, and Add me as reviewer when the page offers it and can link it. */
function reviewersSection(page: IPage): string[] {
  const heading = `<h2>Reviewers ${countBadge(page.cards.length)}</h2>`;
  const addMe = page.addMe ? page.link({ kind: "addMeAsReviewer" }) : undefined;
  const action = addMe ? [`<p class="add-me"><a href="${escapeHtml(addMe)}">Add me as reviewer</a></p>`] : [];
  if (!page.cards.length) {
    const empty = page.removed.length ? "No reviewers left." : "No reviewers requested yet.";
    return [ heading, `<p class="empty dim">${empty}</p>`, ...action ];
  }
  return [
    heading, "<ul class=\"people\">", ...page.cards.map(reviewer => reviewerCard(page, reviewer)), "</ul>", ...action,
  ];
}

/** A reviewer's state and when they reached it; their verdict's text and replies are in the Conversation. */
function reviewerCard(page: IPage, reviewer: IReviewer): string {
  const [ label, tone ] = REVIEWER_PILLS[reviewer.state];
  const tags = [ isMe(page, reviewer.user) && "you", reviewer.author && "author", reviewer.assignee && "assignee" ]
    .filter(Boolean).map(tag => `<span class="tag">${tag}</span>`);
  const row = [ name(reviewer.user, "name"), ...tags, `<span class="pill ${tone}">${label}</span>` ].join(" ");
  return `<li class="person">${avatar(reviewer.user)}<div class="body"><div class="row">${row}</div>` +
    `<div class="when">${escapeHtml(whenLine(page, reviewer))}</div></div></li>`;
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

/** `marked it Reviewed` or `asked for rework`, as the Conversation says it. */
function verdictWords(verdict: IReviewTimelineEvent): string {
  return verdict.status === "Reviewed" ? "marked it Reviewed" : "asked for rework";
}

/** Whether a reviewer's latest word is a verdict, not a request still waiting for one. */
function hasVerdict(reviewer: IReviewer): boolean {
  return reviewer.state === "reviewed" || reviewer.state === "reworkRequired";
}

/**
 * Pending change requests and open questions, one line each, change requests
 * first, then the oldest first: what is left to do, while the Conversation
 * below has every discussion in full. Left out when nothing is open, as the
 * summary says.
 */
function openItemsSection(page: IPage): string[] {
  const open = page.discussions!.threads.filter(thread => isPendingChange(thread) || isOpenQuestion(thread))
    .sort((a, b) => Number(isPendingChange(b)) - Number(isPendingChange(a)) || byRootDate(a, b));
  if (!open.length) {
    return [];
  }
  return [
    `<h2>Open items ${countBadge(open.length)}</h2>`,
    "<ul class=\"items\">", ...open.map(thread => openItem(page, thread)), "</ul>",
  ];
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
  const folder = path ? posix.dirname(path).replace(/^\/+/, "") : "";
  return ` ${fileReference(page, thread)}${folder ? ` <span class="dim">${escapeHtml(folder)}</span>` : ""}`;
}

/** `File.cs:18`, linked to the discussion on its line when it has one; see `location`. */
function fileReference(page: IPage, thread: IReviewThread): string {
  const path = thread.path;
  const located = hasLocation(thread);
  const line = located ? `:${thread.anchor.location + 1}` : "";
  const label = path ? `${posix.basename(path) || path}${line}` : `revision ${thread.anchor.revisionId}${line}`;
  const text = escapeHtml(label);
  return located ? linkTo(page, { kind: "thread", threadId: thread.id }, text) : text;
}

/**
 * The Conversation, as on a GitHub pull request: the description first, then
 * everything that happened, oldest first. The review's creation, its
 * changesets (a branch review's), every discussion in full (on the whole
 * review or on a file's line) and every review event, merged by date; equal
 * dates keep one order (creation, changesets, then by comment id). Add
 * comment ends it while posting works.
 */
function conversationSection(page: IPage): string[] {
  const lines = ["<h2>Conversation</h2>"];
  if (!page.discussions) {
    lines.push(stageNote(page.active.discussions, "the discussions"));
  } else if (page.discussions.message) {
    lines.push(`<p class="stage dim">${escapeHtml(page.discussions.message)}</p>`);
  }
  const items = [ ...discussionItems(page), ...changesetItems(page) ]
    .sort((a, b) => a.time - b.time || a.rank - b.rank || a.id - b.id);
  const opening = openingCard(page);
  const rows = [ ...(opening ? [opening] : []), ...items.map(item => item.html) ];
  if (rows.length) {
    lines.push("<ul class=\"timeline\">", ...rows, "</ul>");
  }
  if (page.commentActions && page.discussions) {
    lines.push(...composer(page));
  }
  return lines;
}

/**
 * Where the Conversation ends: under a rule that closes the timeline, the cm
 * user's avatar and a card with one button, which opens the input box that
 * writes a comment on the whole review. The preview has no text field, and
 * nothing here looks like one: the text is typed at the top of the window.
 */
function composer(page: IPage): string[] {
  const href = page.link({ kind: "addComment" });
  if (!href) {
    return [];
  }
  const link = escapeHtml(href);
  const me = page.whoami ? avatar(page.whoami) : "<span class=\"av anon\" aria-hidden=\"true\"></span>";
  return [
    `<div class="composer">${me}<div class="card"><div class="card-top"><strong>Add a comment</strong></div>` +
      "<div class=\"body compose\"><p class=\"dim\">Write it in the input box at the top of the window.</p>" +
      `<a class="button primary" href="${link}">Write a comment…</a></div></div></div>`,
  ];
}

/**
 * The rest of the title and the latest description, as the comment that
 * opens the Conversation, with Edit description when it is the cm user's and
 * the replies people wrote to it.
 */
function openingCard(page: IPage): string {
  const review = page.active.review;
  const title = splitReviewTitle(review, ready(page.active.files)?.branch?.name);
  const latest = latestDescription(page);
  const lead = [ title.rest, latest?.text ?? "" ].filter(Boolean).map(richText).join("");
  const edit = descriptionEdit(page);
  if (!lead && !edit) {
    return "";
  }
  // The title's rest is the author's, from when the review was opened.
  const by = latest?.text ? latest : { date: review.date, owner: review.owner };
  const head = `<div class="head">${avatar(by.owner, true)}${name(by.owner, "name")} ` +
    `<span class="kind">Description</span>${stamp(page, by.date)}</div>`;
  const thread = latest?.text ? page.discussions?.threads.find(candidate => candidate.id === latest.id) : undefined;
  return `<li class="tl-item tl-comment opening">${timelineMark("description", "blue")}` +
    `<div class="card"><div class="body">${head}` +
    `${lead ? `<div class="lead">${lead}</div>` : NO_TEXT}${edit ? `<p class="comment-actions">${edit}</p>` : ""}` +
    `${thread ? replyList(page, thread.comments.slice(1)) : ""}</div></div></li>`;
}

/**
 * The review's creation, its timeline rows as `reviewHistory` tells them (one entry
 * for a request written twice, a self-request folded into the verdict that
 * follows it) and every other discussion. The first description is the
 * opening card's, so only later edits are entries. A row someone replied to
 * carries the replies; a thread on a row the history leaves out is a card of
 * its own.
 */
function discussionItems(page: IPage): ITimelineItem[] {
  const review = page.active.review;
  const discussions = page.discussions;
  const opened: ReviewHistoryEntry[] = isNaN(Date.parse(review.date)) ? []
    : [{ date: review.date, kind: "opened", owner: review.owner, requested: [] }];
  const entries = discussions ? reviewHistory(discussions.timeline, review) : opened;
  const threads = new Map((discussions?.threads ?? []).map(thread => [ thread.id, thread ]));
  // The description the opening card prints, with its replies.
  const opening = latestDescription(page)?.text ? latestDescription(page)!.id : undefined;
  const told = new Set<number>();
  let described = false;
  const items: ITimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "opened") {
      items.push({ html: eventItem(page, entry), id: 0, rank: 0, time: instant(entry.date) });
      continue;
    }
    const event = entry.event;
    if (event.kind === "description" && !described) {
      described = true;
      if (event.id === opening) {
        told.add(event.id);
      }
      continue;
    }
    told.add(event.id);
    const thread = event.id === opening ? undefined : threads.get(event.id);
    // Text the line does not say: a verdict's, an unknown row's, and that of a row people replied to.
    const quoted = !!event.text && (event.kind === "status" || event.kind === "other" ||
      (!!thread && event.kind !== "renamed"));
    items.push({ html: eventItem(page, entry, thread, quoted), id: event.id, rank: 2, time: instant(event.date) });
  }
  for (const thread of discussions?.threads ?? []) {
    if (!thread.event || !told.has(thread.id)) {
      items.push({ html: threadItem(page, thread), id: thread.id, rank: 2, time: instant(thread.comments[0]?.date) });
    }
  }
  return items;
}

function eventItem(page: IPage, entry: ReviewHistoryEntry, thread?: IReviewThread, quoted = false): string {
  const [ tone, text, icon ] = historyText(entry, page.active.review);
  const date = entry.kind === "opened" ? entry.date : entry.event.date;
  const owner = entry.kind === "opened" ? entry.owner : entry.event.owner;
  const quote = quoted && entry.kind === "event"
    ? `<blockquote class="quote">${richText(entry.event.text)}</blockquote>` : "";
  const replies = thread ? replyList(page, thread.comments.slice(1)) : "";
  return `<li class="tl-item tl-event">${timelineMark(icon, tone)}` +
    `<div class="tl-body"><p class="tl-line">${avatar(owner, true)}${text}${stamp(page, date)}</p>` +
    `${quote}${replies}</div></li>`;
}

/**
 * A discussion that is not a timeline row's: a comment on the whole review
 * as a card with its replies and links, or a thread on a file headed by its
 * kind and state and by `File.cs:18`, which opens the discussion at its line.
 * Applied and discarded change requests are drawn as resolved.
 */
function threadItem(page: IPage, thread: IReviewThread): string {
  const root = thread.comments[0];
  const general = isGeneralThread(thread);
  // A file thread is answered here too, as in the desktop app's overview: cm puts a reply on its parent's line.
  const reply = page.commentActions && canReplyToThread(thread)
    ? actionLink(page, { action: "reply", commentId: root.id, kind: "comment" }, "Reply") : "";
  const actions = commentActions(page, root, reply);
  const label = !general || thread.kind === "conversation" ? "" : threadTypeLabel(thread);
  const top = general ? "" : `<div class="row card-top">${threadPill(thread)}${location(page, thread)}</div>`;
  const resolved = thread.state === "applied" || thread.state === "discarded" ? " resolved" : "";
  return `<li class="tl-item tl-comment${general ? "" : " on-file"}${resolved}">${threadMark(thread)}` +
    `<div class="card">${top}<div class="body">${commentHead(page, root, label)}` +
    `<div class="text">${richText(root.text) || NO_TEXT}</div>${actions}` +
    `${replyList(page, thread.comments.slice(1))}</div></div></li>`;
}

/** A thread's mark on the line: its kind, coloured while it waits on someone as its pill is. */
function threadMark(thread: IReviewThread): string {
  if (thread.kind === "change") {
    const tone = thread.state === "pending" ? "orange" : thread.state === "applied" ? "green" : "grey";
    return timelineMark("change", tone);
  }
  if (thread.kind === "question") {
    return timelineMark("question", isOpenQuestion(thread) ? "blue" : "green");
  }
  return timelineMark("comment", "grey");
}

/** A file thread's kind and state: `Change request · applied in cs:3673`, `Question · answered`… */
function threadPill(thread: IReviewThread): string {
  let tone = "grey";
  let label = threadTypeLabel(thread);
  if (thread.kind === "change") {
    tone = thread.state === "pending" ? "orange" : thread.state === "applied" ? "green" : "grey";
  } else if (thread.kind === "question") {
    const open = isOpenQuestion(thread);
    tone = open ? "blue" : "green";
    label = open ? "Question" : "Question · answered";
  }
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

/**
 * A branch review's changesets, oldest first: one entry per run of
 * changesets by one person, each within `CHANGESET_GROUP_WINDOW` of the one
 * before it, as GitHub lists a push. While the changesets load or after they
 * failed, a note stands first in their place.
 */
function changesetItems(page: IPage): ITimelineItem[] {
  if (page.active.review.targetType !== "branch") {
    return [];
  }
  const stage = page.active.changesets;
  if (stage.state !== "ready") {
    return [{ html: `<li class="tl-item tl-note">${stageNote(stage, "the changesets")}</li>`, id: 0, rank: 1,
      time: -Infinity }];
  }
  const changesets = stage.value.items.slice().sort((a, b) => instant(a.date) - instant(b.date) || a.id - b.id);
  const applied = appliedChanges(page);
  const items = groupChangesets(changesets).map(group => ({
    html: changesetGroup(page, group, applied), id: group[0].id, rank: 1, time: instant(group[0].date),
  }));
  if (stage.value.hasMore && changesets.length) {
    items.push({
      html: "<li class=\"tl-item tl-note\"><p class=\"stage dim\">Older changesets are in the Review view.</p></li>",
      id: 0, rank: 1, time: instant(changesets[0].date),
    });
  }
  return items;
}

/** Consecutive changesets by one person, each within `CHANGESET_GROUP_WINDOW` of the previous one. */
export function groupChangesets<T extends Pick<IReviewChangeset, "owner" | "date">>(changesets: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const changeset of changesets) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    if (last && sameUser(last.owner, changeset.owner) &&
        Math.abs(instant(changeset.date) - instant(last.date)) <= CHANGESET_GROUP_WINDOW) {
      group.push(changeset);
    } else {
      groups.push([changeset]);
    }
  }
  return groups;
}

/** The change requests applied in each changeset, by changeset id. */
function appliedChanges(page: IPage): Map<number, IReviewThread[]> {
  const applied = new Map<number, IReviewThread[]>();
  for (const thread of page.discussions?.threads ?? []) {
    const id = thread.comments[0]?.appliedInChangesetId ?? -1;
    if (thread.kind === "change" && thread.state === "applied" && id > 0) {
      applied.set(id, [ ...(applied.get(id) ?? []), thread ]);
    }
  }
  return applied;
}

function changesetGroup(page: IPage, group: readonly IReviewChangeset[], applied: Map<number, IReviewThread[]>):
    string {
  const what = group.length === 1 ? `cs:${group[0].id}` : count(group.length, "changeset");
  const line = `${avatar(group[0].owner, true)}${name(group[0].owner)} checked in ${what}${stamp(page, group[0].date)}`;
  const rows = group.map(changeset => changesetRow(page, changeset, applied.get(changeset.id) ?? []));
  return `<li class="tl-item tl-changesets">${timelineMark("commit", "grey")}` +
    `<div class="tl-body"><p class="tl-line">${line}</p><ul class="cs-list">${rows.join("")}</ul></div></li>`;
}

/**
 * The links under a comment while posting works: `first` (a thread's
 * Reply), then Edit and Delete on a comment of the cm user's own. Each goes
 * through the extension's URI handler, which asks for the text or a
 * confirmation before cm writes anything.
 */
function commentActions(page: IPage, comment: IReviewComment, first = ""): string {
  const links = first ? [first] : [];
  if (page.commentActions && isOwnComment(comment, page.whoami)) {
    links.push(
      actionLink(page, { action: "edit", commentId: comment.id, kind: "comment" }, "Edit"),
      actionLink(page, { action: "delete", commentId: comment.id, kind: "comment" }, "Delete"));
  }
  const shown = links.filter(Boolean);
  return shown.length ? `<p class="comment-actions">${shown.join(" · ")}</p>` : "";
}

/** A link that only exists as a link: without a URI to open, the action is left out. */
function actionLink(page: IPage, target: OverviewLinkTarget, text: string): string {
  const href = page.link(target);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` : "";
}

/** Replies, each with Edit and Delete when it is the cm user's and `actions` allows them. */
function replyList(page: IPage, replies: readonly IReviewComment[], actions = true): string {
  if (!replies.length) {
    return "";
  }
  const items = replies.map(reply => {
    const type = commentTypeLabel(reply);
    return `<li class="reply">${commentHead(page, reply, type === "Comment" ? "" : type)}` +
      `<div class="text">${richText(reply.text) || NO_TEXT}</div>${actions ? commentActions(page, reply) : ""}</li>`;
  });
  return `<ul class="replies">${items.join("")}</ul>`;
}

function commentHead(page: IPage, comment: IReviewComment, label: string): string {
  const kind = label ? ` <span class="kind">${escapeHtml(label)}</span>` : "";
  return `<div class="head">${avatar(comment.owner, true)}${name(comment.owner, "name")}${kind}` +
    `${stamp(page, comment.date)}</div>`;
}

/** ` · 3 Feb 14:49, 2 hours ago`: when, both as a date and as an age; empty for a date cm did not give. */
function stamp(page: IPage, date: string | Date): string {
  const at = shortDateTime(date, page.now);
  return at ? ` <span class="when">· ${at}, ${escapeHtml(ageInWords(date, page.now))}</span>` : "";
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

/** `cs:3715 Clamp the stack size`, a merge marked and where it came from, and the change requests it applied. */
function changesetRow(page: IPage, changeset: IReviewChangeset, applied: readonly IReviewThread[]): string {
  // A merge's comment is Plastic's own "Merge from …"; where it came from says it already.
  const branch = changeset.mergeSourceBranch;
  const source = branch ? ` <span class="dim">from ${escapeHtml(branch)}</span>` : "";
  const comment = firstLine(stripMachineTags(changeset.comment));
  const none = APPLIED_CHANGE.test(changeset.comment) ? "(applied a change request)" : "(no comment)";
  const what = changeset.isMerge ? `<span class="pill purple">Merge</span>${source}`
    : comment ? inlineText(comment) : `<span class="dim">${none}</span>`;
  const on = applied.map(thread => fileReference(page, thread));
  const changes = on.length ? ` <span class="applied dim">· applied the change request${on.length === 1 ? "" : "s"} ` +
    `on</span> ${on.join(", ")}` : "";
  return `<li class="cs"><code>cs:${changeset.id}</code> <span class="what">${what}</span>${changes}</li>`;
}

/**
 * The marker's colour (verdict colours; grey for the rest) and the line:
 * `priya.nair joined and marked it Reviewed`. A line is one line of text:
 * a verdict's or an unknown row's text is quoted under it.
 */
function historyText(entry: ReviewHistoryEntry, review: IReview): [ string, string, TimelineIcon ] {
  if (entry.kind === "opened") {
    const requested = entry.requested.map(user => name(user));
    const also = requested.length ? ` and requested ${joinWords(requested)}` : "";
    return [ "grey", `${name(entry.owner)} opened the review${also}`, "opened" ];
  }
  const event = entry.event;
  const actor = name(event.owner);
  const user = event.user ? name(event.user) : "someone";
  const joined = entry.joined ? "joined and " : "";
  switch (event.kind) {
  case "status":
    switch (event.status) {
    case "Reviewed":
      return [ "green", `${actor} ${joined}marked it <strong>Reviewed</strong>`, "check" ];
    case "Rework required":
      return [ "orange", `${actor} ${joined}asked for <strong>rework</strong>`, "change" ];
    case "Under review":
      return [ "blue", `${actor} moved it back to <strong>Under review</strong>`, "eye" ];
    default:
      return [ "grey", `${actor} changed the status`, "eye" ];
    }
  case "reviewRequested":
    if (event.user && sameUser(event.user, event.owner)) {
      return [ "grey", entry.again ? `${actor} joined again` : `${actor} joined as a reviewer`, "person" ];
    }
    if (entry.again) {
      // A request for someone who has given a verdict is Plastic's other way of asking them to look again.
      return [ "grey", `${actor} asked ${user} to look again`, "eye" ];
    }
    return [ "grey", `${actor} requested a review from ${user}`, "eye" ];
  case "reviewReRequested":
    return [ "grey", `${actor} asked ${user} to look again`, "eye" ];
  case "reviewRequestRemoved":
    return [ "grey", `${actor} removed ${user} from the reviewers`, "person" ];
  case "renamed":
    if (event.previous && droppedPrefix(review, event.previous, event.text)) {
      return [ "grey", `${actor} renamed it to drop the generated prefix`, "pencil" ];
    }
    return [ "grey", event.previous
      ? `${actor} renamed it from “${linkify(oneLine(event.previous))}” to “${linkify(oneLine(event.text))}”`
      : `${actor} renamed it to “${linkify(oneLine(event.text))}”`, "pencil" ];
  case "description":
    return [ "grey", `${actor} edited the description`, "pencil" ];
  default:
    return [ "grey", `${actor} updated the review`, "dot" ];
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

/** A person's initials in their colour; `small` beside their name in a line. */
function avatar(user: string, small = false): string {
  return `<span class="av${small ? " sm" : ""}" style="background-color: ${avatarColor(user)}" aria-hidden="true">` +
    `${escapeHtml(avatarInitials(user))}</span>`;
}

/** A timeline entry's kind on the line: a circle with its icon, in `tone`. */
function timelineMark(icon: TimelineIcon, tone: string): string {
  return `<span class="tl-mark ${tone}" aria-hidden="true"><svg class="icon" width="16" height="16" ` +
    `viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">${TIMELINE_ICONS[icon]}</svg></span>`;
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

function countBadge(value: number): string {
  return `<span class="count">${formatCount(value)}</span>`;
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

/** A date as an instant, 0 when it is not one: cm's dates carry offsets that change with daylight saving. */
function instant(date: string | Date | undefined): number {
  const time = date === undefined ? NaN : typeof date === "string" ? Date.parse(date) : date.getTime();
  return isNaN(time) ? 0 : time;
}

function ready<T>(stage: Stage<T>): T | undefined {
  return stage.state === "ready" ? stage.value : undefined;
}

function byRootDate(a: IReviewThread, b: IReviewThread): number {
  return instant(a.comments[0]?.date) - instant(b.comments[0]?.date) || a.id - b.id;
}
