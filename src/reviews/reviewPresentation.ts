import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../models";
import { IReview, IReviewChangeset, IReviewComment, IReviewThread, IReviewUpdates } from "./models";
import { MarkdownString, QuickPickItem, ThemeColor, ThemeIcon, Uri } from "vscode";
import { noDiffReason, SOURCE_UNAVAILABLE } from "./reviewFileTree";
import { posix } from "path";
import { shortOwner } from "../history/graphModel";

/**
 * Labels, icons, ages and tooltips shared by the review views. Everything here
 * is a pure function of its arguments (the clock is passed in); the only
 * `vscode` values are the MarkdownString tooltips, `themeIcon`, and the URIs
 * of `toneUri` and `avatarUri`.
 */

/** A codicon id and an optional theme colour id, turned into a ThemeIcon by `themeIcon`. */
export interface IIconSpec {
  readonly id: string;
  readonly color?: string;
}

export interface IThreadCounts {
  readonly total: number;
  readonly pending: number;
  readonly applied: number;
  readonly discarded: number;
  readonly questions: number;
}

/** Who a Reviews row names besides the review number (see `reviewDescription`). */
export type ReviewPeople = "author" | "assignee" | "both";

/** A Find Review… row: a listed review, or, without `review`, the row that opens a number typed by ID. */
export interface IReviewPickItem extends QuickPickItem {
  readonly id: number;
  readonly review?: IReview;
}

/** What Find Review… knows besides its reviews (see `reviewPickItems`). */
export interface IReviewPickState {
  /** The reviews are still loading, so any number typed may be a review's. */
  readonly loading?: boolean;
  /** The list stops at its limit, so a review it leaves out may have any number. */
  readonly truncated?: boolean;
  /** Branch names by object id, for the branch reviews whose title does not name the branch. */
  readonly branches?: ReadonlyMap<number, string>;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;
/** Up to this age a row says `12d`; past it, months. The week cut-off the graph uses would hide "8 days old". */
const MAX_DAYS = 30;
const MONTHS = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ];
const MAX_SUMMARY = 80;
/** A code span on one line, as authors write identifiers: `expiresAt`. */
const INLINE_CODE = /`([^`\r\n]+)`/g;

/** Plastic's generated titles; after tags are stripped, `Review of changeset N -` can be all that is left. */
const REVIEW_OF_CHANGESET = /^Review of changeset (\d+)(?: -(?: ([\s\S]*))?)?$/;
const REVIEW_OF_BRANCH = /^Review of branch (\S+)(?: -(?: ([\s\S]*))?)?$/;
/** A bracketed tag on one line; `stripMachineTags` decides from its content whether a tool wrote it. */
const BRACKETED = /\[([^\][\r\n]*)\]/g;
/**
 * What a tool writes in a tag: a GUID anywhere (`[apply-change:<guid>]`), or
 * the short hex id of Plastic's apply-change marker (`[apply-change:38c85554]`).
 * Jira keys such as `[RAC-3791]` and ids people write (`[build:20260923]`)
 * are neither.
 */
const GUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const APPLY_CHANGE_ID = /^apply-change:[0-9a-f]{8,}$/i;
/** A URL and a list marker, left out of a list's first line when it stands in for the title. */
const LIST_URL = /\bhttps?:\/\/\S+/gi;
const LIST_MARKER = /^(?:[-*+\u2022]|\d{1,3}[.)])\s+/;

export function themeIcon(spec: IIconSpec): ThemeIcon {
  return new ThemeIcon(spec.id, spec.color ? new ThemeColor(spec.color) : undefined);
}

/**
 * The text without the tags a tool wrote around an id, as in a review title or
 * a changeset comment, and without the blanks before each. One pass over the
 * text: titles and comments come from anyone who can write to the server.
 */
export function stripMachineTags(text: string): string {
  const pattern = new RegExp(BRACKETED.source, BRACKETED.flags);
  const parts: string[] = [];
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (GUID.test(match[1]) || APPLY_CHANGE_ID.test(match[1])) {
      parts.push(trimBlanksEnd(text.substring(last, match.index)));
      last = match.index + match[0].length;
    }
  }
  parts.push(text.substring(last));
  return parts.join("");
}

function trimBlanksEnd(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) {
    end--;
  }
  return text.substring(0, end);
}

export interface IReviewTitle {
  /** One line, for headings and rows. */
  readonly title: string;
  /** What the title holds beyond that line, for the Overview's lead paragraph; empty when nothing. */
  readonly rest: string;
}

/**
 * The title as people read it. Plastic names reviews it creates "Review of
 * changeset N - <comment>" or "Review of branch /main/x - <comment>"; the
 * prefix repeats what the row already shows, so only the part a person wrote
 * is kept. Tags a tool added around a GUID go, and only the first line stays;
 * a first line that only introduces what follows ("Tickets:", "Epic:") gives
 * way to the changeset or the branch's last segment, or, where neither is
 * known (the Reviews list does not know a branch's name), to the words of the
 * list's first line, or what its URL names. `branch` is the branch's current
 * name, when it is known.
 */
export function splitReviewTitle(
    review: Pick<IReview, "title" | "targetType" | "target">,
    branch?: string): IReviewTitle {
  let text = stripMachineTags(review.title).trim();
  let fallback = review.targetType === "changeset" ? `cs:${review.target.replace(/^cs:/, "")}` : branch && leaf(branch);
  const changeset = REVIEW_OF_CHANGESET.exec(text);
  const ofBranch = REVIEW_OF_BRANCH.exec(text);
  if (changeset) {
    text = changeset[2]?.trim() ?? "";
    fallback = fallback || `cs:${changeset[1]}`;
  } else if (ofBranch) {
    text = ofBranch[2]?.trim() ?? "";
    fallback = fallback || leaf(ofBranch[1]);
  }
  const lines = text.split(/\r\n|\r|\n/);
  const first = lines.findIndex(line => line.trim());
  if (first < 0) {
    return { rest: "", title: fallback || "(untitled review)" };
  }
  const line = lines[first].trim();
  if (line.endsWith(":")) {
    const title = fallback || listedTitle(lines.slice(first + 1));
    if (title) {
      return { rest: text, title };
    }
  }
  return { rest: lines.slice(first + 1).join("\n").trim(), title: line };
}

/** The title's one line, for the Overview, its row and the Reviews list (see `splitReviewTitle`). */
export function cleanReviewTitle(review: Pick<IReview, "title" | "targetType" | "target">, branch?: string): string {
  return splitReviewTitle(review, branch).title;
}

/**
 * The first non-empty line without its URLs and list marker, when words are
 * left: `RAC-1` of `RAC-1 https://…`. A line of URLs alone names what its first
 * URL names: `RAC-3761` of `- https://…/browse/RAC-3761`.
 */
function listedTitle(lines: readonly string[]): string | undefined {
  const line = lines.find(candidate => candidate.trim());
  if (!line) {
    return undefined;
  }
  // The marker first: `1.` of `1. https://…` would pass for words once the URL is gone.
  const words = line.trim().replace(LIST_MARKER, "").replace(LIST_URL, "").trim();
  if (/\w/.test(words)) {
    return words;
  }
  const url = line.match(LIST_URL)?.[0];
  return url ? urlName(url) : undefined;
}

/**
 * A URL's last path segment, or its host when the path is empty, without the
 * punctuation after it. Trimmed by hand: a pattern anchored at the end would
 * try a run of punctuation again from each of its characters.
 */
function urlName(url: string): string | undefined {
  let end = url.length;
  while (end > 0 && ")]}>.,;:!?'\"".includes(url[end - 1])) {
    end--;
  }
  let parsed: URL;
  try {
    parsed = new URL(url.substring(0, end));
  } catch {
    return undefined;
  }
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  let name = parsed.hostname;
  if (segment) {
    try {
      name = decodeURIComponent(segment);
    } catch {
      name = segment;
    }
  }
  name = name.replace(/\s+/g, " ").trim();
  return /\w/.test(name) ? name : undefined;
}

function leaf(branch: string): string {
  return branch.split("/").filter(Boolean).pop() || branch;
}

/** Owner up to the first `@`, as the graph shows it; one definition for the graph and the reviews. */
export { shortOwner };

/** First non-empty line, trimmed; empty when there is none. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.substring(0, max - 1).replace(/\s+$/, "")}…`;
}

/**
 * `just now`, `5m`, `3h`, `8d`, `3mo`, then `2y`; tooltips carry the full
 * date. cm prints dates with offsets that change with daylight saving, so they
 * are compared as instants; a date in the future (clock skew) reads `just now`.
 */
export function relativeAge(date: string | Date, now: number): string {
  const time = toTime(date);
  if (time === undefined) {
    return "";
  }
  const diff = now - time;
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}m`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h`;
  }
  if (diff < MAX_DAYS * DAY) {
    return `${Math.floor(diff / DAY)}d`;
  }
  if (diff < YEAR) {
    return `${Math.floor(diff / MONTH)}mo`;
  }
  return `${Math.floor(diff / YEAR)}y`;
}

/** `8 days ago`, for tooltips next to the full date. */
export function ageInWords(date: string | Date, now: number): string {
  const time = toTime(date);
  if (time === undefined) {
    return "";
  }
  const diff = now - time;
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    return count(Math.floor(diff / MINUTE), "minute");
  }
  if (diff < DAY) {
    return count(Math.floor(diff / HOUR), "hour");
  }
  if (diff < MAX_DAYS * DAY) {
    return count(Math.floor(diff / DAY), "day");
  }
  if (diff < YEAR) {
    return count(Math.floor(diff / MONTH), "month");
  }
  return count(Math.floor(diff / YEAR), "year");
}

/** `14 Sep 2026 15:24` in local time; empty for an unparseable date. */
export function formatDate(date: string | Date): string {
  const time = toTime(date);
  if (time === undefined) {
    return "";
  }
  const value = new Date(time);
  return `${value.getDate()} ${MONTHS[value.getMonth()]} ${value.getFullYear()} ${clockTime(value)}`;
}

/** `21 Sep`, or `21 Sep 2025` in another year: for lists where the day says more than the age. */
export function shortDate(date: string | Date, now: number): string {
  const time = toTime(date);
  if (time === undefined) {
    return "";
  }
  const value = new Date(time);
  const day = `${value.getDate()} ${MONTHS[value.getMonth()]}`;
  return value.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${value.getFullYear()}`;
}

/** `3 Feb 14:49`, or `3 Feb 2025 14:49` in another year: the Overview's dates, where the time of day matters. */
export function shortDateTime(date: string | Date, now: number): string {
  const time = toTime(date);
  return time === undefined ? "" : `${shortDate(new Date(time), now)} ${clockTime(new Date(time))}`;
}

function clockTime(value: Date): string {
  const pad = (part: number) => (part < 10 ? `0${part}` : String(part));
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** `1,204`: counts read the same in the English UI whatever the OS locale. */
export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

export function statusIcon(status: string): IIconSpec {
  switch (statusContext(status)) {
  case "underReview":
    return { color: "charts.blue", id: "eye" };
  case "reworkRequired":
    return { color: "charts.orange", id: "request-changes" };
  case "reviewed":
    return { color: "testing.iconPassed", id: "pass" };
  default:
    return { id: "circle-large-outline" };
  }
}

export function statusContext(status: string): "underReview" | "reworkRequired" | "reviewed" | "unknown" {
  switch (status.trim().toLowerCase()) {
  case "under review":
    return "underReview";
  case "rework required":
    return "reworkRequired";
  case "reviewed":
    return "reviewed";
  default:
    return "unknown";
  }
}

/**
 * Whether two cm status strings name the same status. cm's exact spelling is
 * not verified for every status, so case and surrounding space are ignored, as
 * `statusContext` ignores them.
 */
export function sameStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** cm has branch and changeset reviews only; anything else is listed but cannot be opened. */
export function isSupportedTarget(review: IReview): boolean {
  return review.targetType === "branch" || review.targetType === "changeset";
}

export function reviewTarget(review: IReview): string {
  switch (review.targetType) {
  case "branch":
    return `branch (${review.target})`;
  case "changeset":
    return `changeset cs:${review.target.replace(/^cs:/, "")}`;
  default:
    return `${review.targetType || "unknown target"} (not supported)`;
  }
}

/** The branch path Plastic writes in the titles it generates: `Review of branch /main/task`. */
function titleBranch(review: Pick<IReview, "title">): string | undefined {
  return REVIEW_OF_BRANCH.exec(stripMachineTags(review.title).trim())?.[1];
}

/**
 * The branch object id of a branch review whose title does not name its
 * branch, which only a branch query can name: a review row gives its branch
 * by id alone. Undefined for any other review.
 */
export function unnamedBranchId(review: Pick<IReview, "title" | "targetType" | "target">): number | undefined {
  const id = /^(?:id:)?(\d+)$/.exec(review.target);
  return review.targetType === "branch" && id && titleBranch(review) === undefined ? Number(id[1]) : undefined;
}

/**
 * What a review is of, in a few characters: `cs:3203`, or the branch path
 * Plastic writes in the titles it generates (`Review of branch /main/task`).
 * A review row names a branch only by its object id, so a branch review
 * whose title the author wrote says `branch`, unless `branch` gives its name.
 */
export function reviewTargetName(review: Pick<IReview, "title" | "targetType" | "target">, branch?: string): string {
  switch (review.targetType) {
  case "branch":
    return titleBranch(review) ?? (branch || "branch");
  case "changeset":
    return `cs:${review.target.replace(/^cs:/, "")}`;
  default:
    return `${review.targetType || "unknown target"} (not supported)`;
  }
}

/**
 * `#12831 · lena.park · 8d`. The author's own groups show who the
 * review waits on instead (`#7551 → priya.nair · 3d`), and All Reviews,
 * which lists anyone's, shows both: `#12831 · lena.park → priya.nair · 8d`.
 */
export function reviewDescription(review: IReview, now: number, people: ReviewPeople = "author"): string {
  const author = shortOwner(review.owner);
  const waitingOn = review.assignee ? shortOwner(review.assignee) : "unassigned";
  const who = { assignee: `→ ${waitingOn}`, author: `· ${author}`, both: `· ${author} → ${waitingOn}` }[people];
  const parts = [`#${review.id} ${who}`];
  const age = relativeAge(review.date, now);
  if (age) {
    parts.push(age);
  }
  if (!isSupportedTarget(review)) {
    parts.push(`${review.targetType || "unknown target"} (not supported)`);
  }
  return parts.join(" · ");
}

/**
 * What a screen reader says for a Reviews row: the title, the status its icon
 * shows, then the description in words, as `→` would be read "right arrow"
 * and `1mo` letter by letter.
 */
export function reviewAriaLabel(review: IReview, now: number): string {
  const parts = [
    cleanReviewTitle(review),
    review.status || "unknown status",
    `review ${review.id}`,
    `by ${review.owner ? shortOwner(review.owner) : "unknown"}`,
    review.assignee ? `assigned to ${shortOwner(review.assignee)}` : "unassigned",
  ];
  const age = ageInWords(review.date, now);
  if (age) {
    parts.push(age);
  }
  if (!isSupportedTarget(review)) {
    parts.push(`${review.targetType || "unknown target"} review, not supported`);
  }
  return parts.join(", ");
}

/** `lena.park → priya.nair · 8d`. */
export function reviewPeople(review: IReview, now: number): string {
  const people = `${shortOwner(review.owner)} → ${review.assignee ? shortOwner(review.assignee) : "unassigned"}`;
  const age = relativeAge(review.date, now);
  return age ? `${people} · ${age}` : people;
}

export function reviewTooltip(review: IReview, now: number): MarkdownString {
  const tooltip = markdown();
  tooltip.appendMarkdown("**");
  tooltip.appendText(review.title.trim() || "(untitled review)");
  tooltip.appendMarkdown("**\n\n");
  tooltip.appendMarkdown(`$(${statusIcon(review.status).id}) `);
  tooltip.appendText(review.status || "Unknown status");
  tooltip.appendMarkdown(` · #${review.id}  \nAuthor: `);
  tooltip.appendText(review.owner || "unknown");
  tooltip.appendMarkdown("  \nAssignee: ");
  tooltip.appendText(review.assignee || "unassigned");
  tooltip.appendMarkdown("  \nTarget: ");
  tooltip.appendText(reviewTarget(review));
  const created = formatDate(review.date);
  if (created) {
    tooltip.appendMarkdown(`  \nCreated: ${created} (${ageInWords(review.date, now)})`);
  }
  return tooltip;
}

/** A review number as typed: `12831` or `#12831`; undefined for anything else. */
export function reviewNumber(text: string): number | undefined {
  const match = /^\s*#?(\d{1,15})\s*$/.exec(text);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * The review number `typed`, when Find Review… offers to open it by ID: any
 * number while the reviews load, and once they have, one no listed review has
 * that may still be a review's: newer than every listed review (created since
 * the list loaded), or any number when the list stops at its limit. In a
 * complete list, a lower number, such as a changeset's or a ticket's, is not.
 */
export function openableReviewNumber(
    reviews: readonly IReview[],
    typed: string,
    state: IReviewPickState = {}): number | undefined {
  const id = reviewNumber(typed);
  if (id === undefined || state.loading) {
    return id;
  }
  if (reviews.some(review => review.id === id)) {
    return undefined;
  }
  return state.truncated || reviews.every(review => review.id < id) ? id : undefined;
}

/**
 * The Find Review… rows, in the order of `reviews`: the status icon and the
 * clean title, then `#id · author → assignee · age`, then the target and the
 * status, so the picker's filter matches any of them. A branch review whose
 * title does not name its branch takes the name from `state.branches`. A
 * review a row cannot open has the list's `circle-slash` instead of its status
 * icon, and a `$(` a title contains is escaped, as the picker would draw it as
 * an icon. The number `openableReviewNumber` offers comes last, as "Open
 * review by ID": its label leaves the number out, since the picker puts rows
 * whose label matches first, and it must not come before a review it matches.
 */
export function reviewPickItems(
    reviews: readonly IReview[],
    now: number,
    typed: string,
    state: IReviewPickState = {}): IReviewPickItem[] {
  const items = reviews.map((review): IReviewPickItem => {
    const icon = isSupportedTarget(review) ? statusIcon(review.status).id : "circle-slash";
    const branchId = unnamedBranchId(review);
    const branch = branchId === undefined ? undefined : state.branches?.get(branchId);
    return {
      description: `#${review.id} · ${reviewPeople(review, now)}`,
      detail: `${reviewTargetName(review, branch)} · ${review.status || "Unknown status"}`,
      id: review.id,
      label: `$(${icon}) ${cleanReviewTitle(review).replace(/\$\(/g, "\\$(")}`,
      review,
    };
  });
  const id = openableReviewNumber(reviews, typed, state);
  if (id !== undefined) {
    const description = state.loading ? `#${id}` : `#${id} · not in this list`;
    items.push({ alwaysShow: true, description, id, label: "$(go-to-file) Open review by ID" });
  }
  return items;
}

/**
 * The row Enter should open for a number typed: the listed review with that
 * number, else the newest review of that changeset (`#N` names a review
 * only). Undefined for any other text.
 */
export function exactReviewPick(items: readonly IReviewPickItem[], typed: string): IReviewPickItem | undefined {
  const id = reviewNumber(typed);
  if (id === undefined) {
    return undefined;
  }
  const review = items.find(item => item.review?.id === id);
  if (review || !/^\s*\d+\s*$/.test(typed)) {
    return review;
  }
  return items.find(item =>
    item.review?.targetType === "changeset" && Number(item.review.target.replace(/^cs:/, "")) === id);
}

/**
 * Threads Discussions lists under General: conversations, verdicts and other
 * timeline threads, and comments without an anchor revision. None has a diff
 * to open, so selecting one opens the Overview, which prints each in full.
 */
export function isGeneralThread(thread: IReviewThread): boolean {
  const fileKind = thread.kind === "question" || thread.kind === "change" || thread.kind === "comment";
  return !fileKind || thread.anchor.revisionId <= 0;
}

export function hasLocation(thread: IReviewThread): boolean {
  return thread.kind !== "conversation" && thread.kind !== "status" && thread.kind !== "other" &&
    thread.anchor.revisionId > 0 && thread.anchor.location >= 0;
}

/** `Question`, `Change request · applied in cs:3673`, `Reviewed`… */
export function threadTypeLabel(thread: IReviewThread): string {
  switch (thread.kind) {
  case "question":
    return "Question";
  case "change":
    if (thread.state === "applied") {
      return `Change request · applied in cs:${thread.comments[0].appliedInChangesetId}`;
    }
    return thread.state === "discarded" ? "Change request · discarded" : "Change request";
  case "comment":
    return "Comment";
  case "conversation":
    return "Conversation";
  case "status":
    return thread.event?.status ?? "Status changed";
  default:
    // A timeline row with replies, or a comment of a type cm added after this was written.
    if (thread.event?.kind === "description") {
      return "Description";
    }
    return thread.event ? "Review activity" : "Comment";
  }
}

/**
 * The row label: the root's first non-empty line, code spans shown as their
 * text (a label is not Markdown); a verdict leads with the status it set
 * ("Reviewed · LGTM…").
 */
export function threadSummary(thread: IReviewThread): string {
  const text = firstLine(thread.comments[0]?.text ?? "").replace(INLINE_CODE, "$1");
  if (thread.kind === "status") {
    const status = threadTypeLabel(thread);
    return truncate(text ? `${status} · ${text}` : status, MAX_SUMMARY);
  }
  return truncate(text || `(${threadTypeLabel(thread).toLowerCase()} without text)`, MAX_SUMMARY);
}

export function threadIcon(thread: IReviewThread): IIconSpec {
  switch (thread.kind) {
  case "question":
    return { color: "charts.blue", id: "question" };
  case "change":
    switch (thread.state) {
    case "applied":
      return { color: "testing.iconPassed", id: "pass" };
    case "discarded":
      return { color: "disabledForeground", id: "circle-slash" };
    default:
      return { color: "charts.orange", id: "request-changes" };
    }
  case "comment":
    return { id: "comment" };
  case "conversation":
    return { id: "comment-discussion" };
  case "status":
    return statusIcon(thread.event?.status ?? "");
  default:
    return { id: "info" };
  }
}

export function threadContext(thread: IReviewThread): string {
  return `thread;${thread.kind};${thread.state}`;
}

/** `L58 · priya.nair · 8d · 1 reply · applied in cs:3673`. */
export function threadDescription(thread: IReviewThread, now: number): string {
  const root = thread.comments[0];
  const parts: string[] = [];
  if (hasLocation(thread)) {
    parts.push(`L${thread.anchor.location + 1}`);
  }
  if (root) {
    parts.push(shortOwner(root.owner));
    const age = relativeAge(root.date, now);
    if (age) {
      parts.push(age);
    }
  }
  const replies = thread.comments.length - 1;
  if (replies > 0) {
    parts.push(`${replies} ${replies === 1 ? "reply" : "replies"}`);
  }
  if (thread.state === "applied" && root) {
    parts.push(`applied in cs:${root.appliedInChangesetId}`);
  } else if (thread.state === "discarded") {
    parts.push("discarded");
  }
  return parts.join(" · ");
}

/**
 * The whole thread: each comment as `author · Type · date` and its text, as
 * Markdown the way the diff's threads render it, separated by rules; then
 * where the thread is and what selecting it opens.
 */
export function threadTooltip(thread: IReviewThread): MarkdownString {
  // Without theme icons, so `$(…)` in a comment stays text.
  const tooltip = markdown(false);
  thread.comments.forEach((comment, index) => {
    if (index > 0) {
      tooltip.appendMarkdown("\n\n---\n\n");
    }
    tooltip.appendMarkdown("**");
    tooltip.appendText(shortOwner(comment.owner) || "unknown");
    tooltip.appendMarkdown("** · ");
    tooltip.appendText(index === 0 ? threadTypeLabel(thread) : commentTypeLabel(comment));
    const date = formatDate(comment.date);
    if (date) {
      tooltip.appendMarkdown(` · ${date}`);
    }
    tooltip.appendMarkdown("\n\n");
    const text = comment.text.trim();
    if (text) {
      tooltip.appendMarkdown(reviewCommentMarkdown(text));
    } else {
      tooltip.appendText("(no text)");
    }
  });
  tooltip.appendMarkdown("\n\n---\n\n");
  tooltip.appendText(threadLocation(thread));
  return tooltip;
}

/** `InventorySlot.cs · line 17 · revision 4141 · click to open in the diff`; General threads open the Overview. */
function threadLocation(thread: IReviewThread): string {
  if (isGeneralThread(thread)) {
    return "Click to open the Overview";
  }
  const parts: string[] = [];
  if (thread.path) {
    parts.push(posix.basename(thread.path) || thread.path);
  }
  if (hasLocation(thread)) {
    parts.push(`line ${thread.anchor.location + 1}`);
  }
  if (thread.anchor.revisionId > 0) {
    parts.push(`revision ${thread.anchor.revisionId}`);
  }
  parts.push("click to open in the diff");
  return parts.join(" · ");
}

export function threadCounts(threads: readonly IReviewThread[]): IThreadCounts {
  const change = (state: string) => threads.filter(thread => thread.kind === "change" && thread.state === state).length;
  return {
    applied: change("applied"),
    discarded: change("discarded"),
    pending: change("pending"),
    questions: threads.filter(thread => thread.kind === "question").length,
    total: threads.length,
  };
}

/** `2 discussions`, `1 discussion`. */
export function discussionCount(count: number): string {
  return `${count} ${count === 1 ? "discussion" : "discussions"}`;
}

/** `Changed`, `Moved and changed`, `Added`… */
export function changeKind(file: IChangesetFileChange): string {
  const words: string[] = [];
  if (file.status & FileChangeStatus.Added) {
    words.push("added");
  }
  if (file.status & FileChangeStatus.Moved) {
    words.push("moved");
  }
  if (file.status & FileChangeStatus.Changed) {
    words.push("changed");
  }
  if (file.status & FileChangeStatus.Deleted) {
    words.push("deleted");
  }
  const text = words.length ? words.join(" and ") : "no change recorded";
  return text.charAt(0).toUpperCase() + text.substring(1);
}

/**
 * A file row's tooltip. `sameAsHead` marks a changeset row whose revision is
 * also the review head's, which is why its checkbox follows Changes.
 */
export function fileTooltip(
    file: IChangesetFileChange,
    threads: readonly IReviewThread[] = [],
    sameAsHead = false): MarkdownString {
  const tooltip = markdown();
  tooltip.appendMarkdown("**");
  tooltip.appendText(file.path);
  tooltip.appendMarkdown("**\n\n");
  const revisions = [changeKind(file)];
  if (file.revisionId >= 0) {
    revisions.push(`revision ${file.revisionId}`);
  }
  if (file.baseRevisionId >= 0 && file.baseRevisionId !== file.revisionId) {
    revisions.push(`base revision ${file.baseRevisionId}`);
  }
  tooltip.appendText(revisions.join(" · "));
  if (file.status & FileChangeStatus.Moved && file.oldPath) {
    tooltip.appendMarkdown("  \n");
    tooltip.appendText(`Moved from ${file.oldPath}`);
  }
  if (threads.length) {
    const pending = threadCounts(threads).pending;
    const suffix = pending ? ` (${pending} pending change request${pending === 1 ? "" : "s"})` : "";
    tooltip.appendMarkdown(`  \n${discussionCount(threads.length)}${suffix}`);
  }
  const reason = noDiffReason(file);
  if (reason) {
    tooltip.appendMarkdown("  \n");
    tooltip.appendText(reason);
  }
  if (sameAsHead) {
    tooltip.appendMarkdown("  \nSame revision as the review head: viewed together with Changes.");
  }
  return tooltip;
}

export function changesetTooltip(changeset: IReviewChangeset, now: number, isHead = false): MarkdownString {
  const tooltip = markdown();
  tooltip.appendMarkdown(`**cs:${changeset.id}** · `);
  tooltip.appendText(changeset.owner || "unknown");
  const date = formatDate(changeset.date);
  if (date) {
    tooltip.appendMarkdown(` · ${date} (${ageInWords(changeset.date, now)})`);
  }
  if (isHead) {
    tooltip.appendMarkdown(" · head of this review");
  }
  tooltip.appendMarkdown("\n\n");
  tooltip.appendText(changeset.comment.trim() || "(no comment)");
  if (changeset.isMerge) {
    tooltip.appendMarkdown("\n\n$(git-merge) ");
    tooltip.appendText(changeset.mergeSourceBranch ? `Merge from ${changeset.mergeSourceBranch}.` : "Merge.");
    tooltip.appendMarkdown(" Expanding lists every merged file.");
  }
  return tooltip;
}

/** `branch moved to cs:3733 · 2 new comments · status: Rework required`. */
export function updateSummary(updates: IReviewUpdates): string {
  const parts: string[] = [];
  if (updates.newHead !== undefined) {
    parts.push(updates.newHead < 0 ? "branch deleted" : `branch moved to cs:${updates.newHead}`);
  }
  if (updates.newComments > 0) {
    // Edits and applied change requests count too; the row's tooltip says so.
    parts.push(`${updates.newComments} new comment${updates.newComments === 1 ? "" : "s"}`);
  }
  if (updates.removedComments > 0) {
    parts.push(`${updates.removedComments} comment${updates.removedComments === 1 ? "" : "s"} removed`);
  }
  if (updates.status !== undefined) {
    parts.push(`status: ${updates.status}`);
  }
  return parts.join(" · ") || "changes available";
}

/** Row kinds that have no text diff, for callers that only need the word. */
export function contentKind(file: IChangesetFileChange): "text" | "binary" | "nodiff" {
  if (file.revisionType === RevisionType.BinaryFile) {
    return "binary";
  }
  return noDiffReason(file) ? "nodiff" : "text";
}

/**
 * Why a row opens no diff, as a sentence for Open Changes and the editors;
 * undefined for a row that has a text diff. Built on `noDiffReason`, so it
 * refuses exactly the rows the tree marks.
 */
export function noDiffMessage(file: IChangesetFileChange): string | undefined {
  const reason = noDiffReason(file);
  if (!reason) {
    return undefined;
  }
  const name = file.path.split("/").filter(Boolean).pop() ?? file.path;
  switch (file.revisionType) {
  case RevisionType.BinaryFile:
    return `${name} is a binary file. Plastic SCM has no text diff for it.`;
  case RevisionType.Directory:
    return `${name} is a directory. Its files are listed below it.`;
  case RevisionType.TextFile:
    return reason === SOURCE_UNAVAILABLE
      ? `${name} has no source revision in this comparison, so there is no diff to show.`
      : `${name} has no content change recorded: both sides are the same revision.`;
  default:
    return `${name} has no text diff.`;
  }
}

/** First line of an error message, for a row description; the tooltip keeps the rest. */
export function errorSummary(message: string): string {
  return truncate(firstLine(message) || "Unknown error", 120);
}

/** An error row's tooltip: the message, then how to retry; a one-line message runs on as one sentence. */
export function retryTooltip(message: string): string {
  const text = message.trim() || "Unknown error";
  if (/[\r\n]/.test(text)) {
    return `${text}\n\nSelect to retry.`;
  }
  return `${text}${/[.!?]$/.test(text) ? "" : "."} Select to retry.`;
}

/** How a row that is not a file colours its label: errors, links, loading rows and discarded threads. */
export type RowTone = "error" | "link" | "muted" | "disabled";

/** The scheme of `toneUri`; ReviewDecorations answers it with the tone's colour and nothing else. */
export const ROW_TONE_SCHEME = "plastic-review-tone";

const TONE_COLORS: { [tone in RowTone]: string } = {
  disabled: "disabledForeground",
  error: "list.errorForeground",
  link: "textLink.foreground",
  muted: "descriptionForeground",
};

/**
 * A tree row's `resourceUri` that colours its label: VS Code colours a label
 * only through the FileDecoration of the row's resource. The row keeps its
 * own icon (a ThemeIcon, which hides the resource's file icon) and tooltip.
 */
export function toneUri(tone: RowTone, id: string): Uri {
  return Uri.from({ path: `/${tone}/${id}`, scheme: ROW_TONE_SCHEME });
}

/** The theme colour id `toneUri` stands for; undefined for any other URI. */
export function toneColor(uri: Uri): string | undefined {
  if (uri.scheme !== ROW_TONE_SCHEME) {
    return undefined;
  }
  const tone = uri.path.split("/")[1] as RowTone;
  return Object.prototype.hasOwnProperty.call(TONE_COLORS, tone) ? TONE_COLORS[tone] : undefined;
}

/**
 * Avatar backgrounds: ten hues, so the few people on one review rarely share
 * one, each dark enough for white initials at 5:1 or better.
 */
const AVATAR_COLORS = [
  "#b0385a", "#2f6fc0", "#9a5716", "#7a4fb0", "#1d7586", "#a3452a", "#5b5fc7", "#237257", "#8e4a96", "#4d7a1f",
];
const avatars = new Map<string, Uri>();

/** An author's initials: `TO` for tom.okafor, the first two letters of a one-word name. */
export function avatarInitials(owner: string): string {
  const name = shortOwner(owner).trim() || "?";
  const words = name.split(/[._\-\s]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]) : Array.from(name).slice(0, 2);
  return letters.join("").toUpperCase();
}

/** An author's avatar colour, picked from the name so an author keeps it everywhere. */
export function avatarColor(owner: string): string {
  let hash = 0;
  for (const char of (shortOwner(owner).trim() || "?").toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * A round initials avatar for a comment author, as an inline SVG: the
 * workbench allows data: images, and there is no file to write or prune.
 */
export function avatarUri(owner: string): Uri {
  const name = shortOwner(owner).trim() || "?";
  let uri = avatars.get(name);
  if (!uri) {
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" viewBox=\"0 0 28 28\">" +
      `<circle cx="14" cy="14" r="14" fill="${avatarColor(name)}"/>` +
      "<text x=\"14\" y=\"18.3\" text-anchor=\"middle\" fill=\"#ffffff\" font-size=\"11.5\" font-weight=\"600\" " +
      "font-family=\"-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif\">" +
      `${escapeXml(avatarInitials(name))}</text></svg>`;
    uri = Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`);
    avatars.set(name, uri);
  }
  return uri;
}

/** Untrusted and without HTML: user text only goes in through `appendText` or `reviewCommentMarkdown`. */
function markdown(themeIcons = true): MarkdownString {
  const value = new MarkdownString("", themeIcons);
  value.isTrusted = false;
  value.supportHtml = false;
  return value;
}

/** The type a reply's own header shows: `Question`, `Change request`, `Discarded` or `Comment`. */
export function commentTypeLabel(comment: IReviewComment): string {
  switch (comment.type) {
  case "discarded":
    return "Discarded";
  case "question":
    return "Question";
  case "change":
    return "Change request";
  default:
    return "Comment";
  }
}

function toTime(date: string | Date): number | undefined {
  const time = typeof date === "string" ? Date.parse(date) : date.getTime();
  return isNaN(time) ? undefined : time;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Comment text as Markdown that survives VS Code's renderer, for the diff's
 * threads and the Discussions tooltips alike. Authors write Markdown
 * (backticks are common), but without HTML support the renderer drops anything
 * that parses as a tag, so `List<Sprite>` would lose `<Sprite>`. Angle
 * brackets are escaped outside code spans, code blocks and autolinks
 * (`<https://…>`), and single line breaks become hard breaks, as the Plastic
 * clients show them. A code block still open at the end is closed, so it
 * cannot swallow whatever the caller appends after the text, such as the next
 * comment in a Discussions tooltip.
 */
export function reviewCommentMarkdown(text: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: { indent: string; marker: string } | undefined;
  const flush = () => {
    if (paragraph.length) {
      out.push(escapeParagraph(paragraph.join("\n")));
      paragraph = [];
    }
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      out.push(line);
      if (closesFence(line, fence.marker)) {
        fence = undefined;
      }
      continue;
    }
    const opening = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    // A backtick fence's info string cannot contain a backtick; such a line is inline code instead.
    if (opening && !(opening[2].startsWith("`") && line.substring(opening[0].length).includes("`"))) {
      flush();
      // The indent too: a fence in a list item is closed inside that item, not by a new top-level one.
      fence = { indent: opening[1], marker: opening[2] };
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push(line);
      continue;
    }
    // Indented code starts only where no paragraph is open; inside one it is a continuation line.
    if (!paragraph.length && /^(?: {4}|\t)/.test(line)) {
      out.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  if (fence) {
    out.push(fence.indent + fence.marker);
  }
  return out.join("\n");
}

function closesFence(line: string, fence: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!close && close[1][0] === fence[0] && close[1].length >= fence.length;
}

/** A CommonMark autolink such as `<https://…>`: kept whole, so the renderer links it. */
const AUTOLINK = /^<[a-z][a-z0-9+.-]{1,31}:[^\s<>]*>/i;
/** A bare http(s) URL, up to white space or an angle bracket. */
const BARE_URL = /^https?:\/\/[^\s<>]+/i;

/**
 * Escapes `<` and `>` outside code spans and autolinks, and turns line breaks
 * into hard breaks. A bare URL right before a bracket becomes an autolink:
 * GFM would otherwise take the escaping backslash into the link's address.
 */
function escapeParagraph(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      result += text.substring(index, index + 2);
      index += 2;
    } else if (char === "`") {
      const run = backtickRun(text, index);
      const close = closingRun(text, index + run, run);
      const end = close < 0 ? index + run : close + run;
      result += text.substring(index, end);
      index = end;
    } else if (char === "<" && AUTOLINK.test(text.substring(index))) {
      const link = AUTOLINK.exec(text.substring(index))![0];
      result += link;
      index += link.length;
    } else if ((char === "h" || char === "H") && !/\w/.test(text[index - 1] ?? "") &&
        BARE_URL.test(text.substring(index))) {
      const url = BARE_URL.exec(text.substring(index))![0];
      const next = text[index + url.length];
      result += next === "<" || next === ">" ? `<${url}>` : url;
      index += url.length;
    } else {
      result += char === "<" || char === ">" ? `\\${char}` : char === "\n" ? "  \n" : char;
      index++;
    }
  }
  return result;
}

function backtickRun(text: string, index: number): number {
  let end = index;
  while (text[end] === "`") {
    end++;
  }
  return end - index;
}

/** Where a code span opened by `length` backticks closes: the next run of exactly that length. */
function closingRun(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "`") {
      const run = backtickRun(text, index);
      if (run === length) {
        return index;
      }
      index += run;
    } else {
      index++;
    }
  }
  return -1;
}

/**
 * A paragraph split at its code spans, as CommonMark reads them: a run of
 * backticks opens a span that the next run of the same length closes, and a
 * run nothing closes is plain text. Line breaks in a span read as spaces.
 */
export function splitCodeSpans(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let plain = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      plain += text[index++];
      continue;
    }
    const run = backtickRun(text, index);
    const close = closingRun(text, index + run, run);
    if (close < 0) {
      plain += text.substring(index, index + run);
      index += run;
      continue;
    }
    if (plain) {
      parts.push({ code: false, text: plain });
      plain = "";
    }
    const code = text.substring(index + run, close).replace(/\r\n|\r|\n/g, " ");
    const padded = code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "";
    parts.push({ code: true, text: padded ? code.substring(1, code.length - 1) : code });
    index = close + run;
  }
  if (plain) {
    parts.push({ code: false, text: plain });
  }
  return parts;
}
