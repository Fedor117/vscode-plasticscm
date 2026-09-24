// Types only: models.ts calls into this module, so a value import back would be a cycle.
import { IReview, IReviewComment, IReviewTimelineEvent, ReviewStatus, ReviewTimelineEventKind } from "./models";

/**
 * Plastic records review activity as `timeline` comments whose text starts with
 * a marker. None of this is documented. The formats below are the ones the
 * code reads; both request formats occur, often as a pair written in
 * the same second:
 *   [status-reviewed]<optional verdict>    [status-rework-required]…    [status-under-review]…
 *   [requested-review-from]<user>          [requested-review-from-<user>]
 *   [removed-requested-review-from]<user>  [re-requested-review-from]<user>
 *   [renamed-title]<old title>#->#<new title>
 *   [description]<text>
 * Anything else, including text without a marker, is kept as an `other` event.
 */
const STATUS_MARKERS: { [marker: string]: ReviewStatus } = {
  "status-reviewed": "Reviewed",
  "status-rework-required": "Rework required",
  "status-under-review": "Under review",
};

/** Matched as `[<marker>]<user>` or `[<marker>-<user>]`; no marker starts another. */
const REQUEST_MARKERS: Array<[string, ReviewTimelineEventKind]> = [
  [ "removed-requested-review-from", "reviewRequestRemoved" ],
  [ "re-requested-review-from", "reviewReRequested" ],
  [ "requested-review-from", "reviewRequested" ],
];

const RENAME_SEPARATOR = "#->#";
const MARKER = /^\[([^\]\r\n]*)\]([\s\S]*)$/;

export function parseTimelineEvent(comment: IReviewComment): IReviewTimelineEvent {
  const event = (kind: ReviewTimelineEventKind, text: string, extra: Partial<IReviewTimelineEvent> = {}) => ({
    date: comment.date,
    id: comment.id,
    kind,
    owner: comment.owner,
    text: text.trim(),
    ...extra,
  });
  const match = MARKER.exec(comment.text.trim());
  if (!match) {
    return event("other", comment.text);
  }
  const [ , marker, rest ] = match;
  if (marker.startsWith("status-")) {
    const status: ReviewStatus | undefined = STATUS_MARKERS[marker];
    return event("status", rest, status ? { status } : {});
  }
  for (const [ prefix, kind ] of REQUEST_MARKERS) {
    if (marker === prefix) {
      return event(kind, "", userOf(rest));
    }
    if (marker.startsWith(`${prefix}-`)) {
      return event(kind, rest, userOf(marker.substring(prefix.length + 1)));
    }
  }
  if (marker === "renamed-title") {
    const separator = rest.lastIndexOf(RENAME_SEPARATOR);
    if (separator < 0) {
      return event("renamed", rest);
    }
    const previous = rest.substring(0, separator).trim();
    return event("renamed", rest.substring(separator + RENAME_SEPARATOR.length), previous ? { previous } : {});
  }
  if (marker === "description") {
    return event("description", rest);
  }
  return event("other", comment.text);
}

/** The timeline rows among `comments`, as events in the order they happened. */
export function parseTimeline(comments: readonly IReviewComment[]): IReviewTimelineEvent[] {
  return comments
    .filter(comment => comment.type === "timeline")
    .map(parseTimelineEvent)
    .sort(compareEvents);
}

/**
 * The timeline without the rows Plastic writes twice. One action often comes
 * as two rows in the same second, or a second apart: a review
 * request once in each marker format, a verdict once without its text and
 * once with it. A row is left out when another row of the same
 * kind, owner, user and status within two seconds says as much: the same
 * text written before it, or text where it has none. Another action on the
 * same person between the two rows makes them two actions: a request, its
 * removal and a new request a second later stay three rows.
 */
export function collapseTimeline(timeline: readonly IReviewTimelineEvent[]): IReviewTimelineEvent[] {
  const events = timeline.slice().sort(compareEvents);
  return events.filter((event, index) => !partners(events, index).some(other => (event.text
    ? events[other].text === event.text && other < index
    : !!events[other].text || other < index)));
}

/** One line of the review's history, oldest first. */
export type ReviewHistoryEntry =
  /** The review was created; the reviewers its author requested right away are folded in. */
  | { kind: "opened"; owner: string; date: string; requested: string[] }
  /**
   * A timeline row; `joined` when the owner's self-request just before a verdict was folded into it, `again` for
   * a request for someone who has given a verdict before it: they are asked to look again.
   */
  | { kind: "event"; event: IReviewTimelineEvent; joined: boolean; again: boolean };

/**
 * The review's history for people to read: the collapsed timeline after an
 * `opened` entry at the review's date. A reviewer usually requests themselves
 * seconds before giving a verdict, so a self-request followed by the same
 * person's verdict within ten minutes is one entry, and so are the author's
 * requests made within ten minutes of opening the review.
 */
export function reviewHistory(
    timeline: readonly IReviewTimelineEvent[],
    review: Pick<IReview, "owner" | "date">): ReviewHistoryEntry[] {
  const events = collapseTimeline(timeline);
  const entries: ReviewHistoryEntry[] = [];
  let start = 0;
  const opened = Date.parse(review.date);
  if (!isNaN(opened)) {
    const requested: string[] = [];
    for (; start < events.length; start++) {
      const event = events[start];
      const early = instant(event.date) - opened <= FOLD_WINDOW;
      if (!early || event.kind !== "reviewRequested" || !event.user || !sameUser(event.owner, review.owner) ||
          sameUser(event.user, event.owner)) {
        break;
      }
      requested.push(event.user);
    }
    entries.push({ date: review.date, kind: "opened", owner: review.owner, requested });
  }
  const joined = new Set<number>();
  // Whoever has given a verdict so far: a request for them asks them to look again.
  const judged = new Set<string>();
  events.slice(start).forEach((event, index, rest) => {
    if (isVerdict(event)) {
      judged.add(event.owner.toLowerCase());
    }
    if (isSelfRequest(event)) {
      const verdict = rest.slice(index + 1).find(next => isVerdict(next) && sameUser(next.owner, event.owner));
      if (verdict && !joined.has(verdict.id) && instant(verdict.date) - instant(event.date) <= FOLD_WINDOW) {
        joined.add(verdict.id);
        return;
      }
    }
    const again = event.kind === "reviewRequested" && !!event.user && judged.has(event.user.toLowerCase());
    entries.push({ again, event, joined: joined.has(event.id), kind: "event" });
  });
  return entries;
}

/**
 * Where a reviewer stands. Pending: `requested` (asked by someone else),
 * `reviewing` (joined by requesting themselves, also after a verdict of their
 * own) or `askedAgain` (someone else's request newer than their verdict).
 * Done: their latest verdict.
 */
export type ReviewerState = "requested" | "reviewing" | "askedAgain" | "reworkRequired" | "reviewed";

export interface IReviewer {
  /** As the timeline or the review first wrote it: usually an e-mail address. */
  user: string;
  state: ReviewerState;
  author: boolean;
  assignee: boolean;
  /** The latest request or re-request; undefined for an assignee nobody requested. */
  request?: IReviewTimelineEvent;
  /** The latest Reviewed or Rework required row, still set when a newer request asks again. */
  verdict?: IReviewTimelineEvent;
}

/**
 * Each reviewer's state, derived from the timeline: cm keeps one status per
 * review and none per reviewer. A reviewer is someone currently requested or
 * anyone who gave a verdict; a removal drops them, and the author's own
 * verdict makes the author a reviewer only when the author was requested. A
 * verdict outlives a removal: requested again, a person who gave one is asked
 * to look again, as History says. An assignee nobody requested still gets a
 * row, unless the assignee is the author. Pending reviewers come first, the
 * longest waiting first; then the others by the date of their verdict. Names
 * compare case-insensitively.
 */
export function reviewerStates(
    timeline: readonly IReviewTimelineEvent[],
    review: Pick<IReview, "owner" | "assignee">): IReviewer[] {
  const rows = new Map<string, { user: string; request?: IReviewTimelineEvent; verdict?: IReviewTimelineEvent }>();
  const named = new Set<string>();
  // Each person's latest verdict, the author's too; a removal does not clear it.
  const verdicts = new Map<string, IReviewTimelineEvent>();
  for (const event of collapseTimeline(timeline)) {
    const active = requestState(event);
    if (active !== undefined && event.user) {
      const key = event.user.toLowerCase();
      named.add(key);
      if (active) {
        const verdict = verdicts.get(key);
        rows.set(key, { ...(verdict ? { verdict } : {}), request: event, user: rows.get(key)?.user ?? event.user });
      } else {
        rows.delete(key);
      }
    } else if (isVerdict(event)) {
      const key = event.owner.toLowerCase();
      verdicts.set(key, event);
      if (rows.has(key) || !sameUser(event.owner, review.owner)) {
        rows.set(key, { ...rows.get(key), user: rows.get(key)?.user ?? event.owner, verdict: event });
      }
    }
  }
  const assignee = review.assignee.trim();
  if (assignee && !named.has(assignee.toLowerCase()) && !rows.has(assignee.toLowerCase()) &&
      !sameUser(assignee, review.owner)) {
    rows.set(assignee.toLowerCase(), { user: assignee });
  }
  return Array.from(rows.values())
    .map(row => ({
      ...row,
      assignee: !!assignee && sameUser(row.user, assignee),
      author: sameUser(row.user, review.owner),
      state: reviewerState(row.request, row.verdict),
    }))
    .sort((a, b) => Number(isPending(b)) - Number(isPending(a)) || compareReviewers(a, b));
}

/** A reviewer the review waits on: pending, and not the author, who never reviews their own change. */
export function isWaitingOn(reviewer: IReviewer): boolean {
  return !reviewer.author && isPending(reviewer);
}

/**
 * People once requested whom someone removed and who have no row now: the
 * latest request row for them is a removal and no verdict of theirs followed.
 * The author is left out, as `reviewerStates` leaves the author out.
 */
export function removedReviewers(
    timeline: readonly IReviewTimelineEvent[],
    review: Pick<IReview, "owner" | "assignee">): string[] {
  const rows = new Set(reviewerStates(timeline, review).map(reviewer => reviewer.user.toLowerCase()));
  const latest = new Map<string, IReviewTimelineEvent>();
  for (const event of collapseTimeline(timeline)) {
    if (requestState(event) !== undefined && event.user) {
      latest.set(event.user.toLowerCase(), event);
    }
  }
  return Array.from(latest.values())
    .filter(event => event.kind === "reviewRequestRemoved" && !rows.has(event.user!.toLowerCase()) &&
      !sameUser(event.user!, review.owner))
    .map(event => event.user!);
}

/** Whether two cm user names are one person: cm prints the same address in different cases. */
export function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Requested reviewers still pending: requests and re-requests minus later
 * removals, the latest event per user winning. In the order they were first
 * requested; names compare case-insensitively.
 */
export function currentReviewers(timeline: readonly IReviewTimelineEvent[]): string[] {
  const reviewers = new Map<string, { user: string; active: boolean }>();
  for (const event of timeline.slice().sort(compareEvents)) {
    const active = requestState(event);
    if (active === undefined || !event.user) {
      continue;
    }
    const key = event.user.toLowerCase();
    const known = reviewers.get(key);
    reviewers.set(key, { active, user: known?.user ?? event.user });
  }
  return Array.from(reviewers.values())
    .filter(reviewer => reviewer.active)
    .map(reviewer => reviewer.user);
}

/** Why someone cannot be added to a review's reviewers; see `reviewerBlock`. */
export type ReviewerBlock = "author" | "assignee" | "requested";

/**
 * Why `user` cannot be added to a review's reviewers: they wrote it (authors
 * do not review their own change), they are its assignee (already a
 * reviewer), or someone's request for them is still active. Undefined when
 * they can be added, which includes someone who gave a verdict nobody asked
 * for, or whose request was removed.
 */
export function reviewerBlock(
    timeline: readonly IReviewTimelineEvent[],
    review: Pick<IReview, "owner" | "assignee">,
    user: string): ReviewerBlock | undefined {
  if (sameUser(user, review.owner)) {
    return "author";
  }
  if (review.assignee.trim() && sameUser(user, review.assignee)) {
    return "assignee";
  }
  return currentReviewers(timeline).some(reviewer => sameUser(reviewer, user))
    ? "requested"
    : undefined;
}

/**
 * The status `user` gave the review, as their reviewer card shows it: their
 * latest verdict while it stands, Under review otherwise, including for
 * someone who is not a reviewer.
 */
export function reviewerStatus(
    timeline: readonly IReviewTimelineEvent[],
    review: Pick<IReview, "owner" | "assignee">,
    user: string): ReviewStatus {
  const state = reviewerStates(timeline, review).find(reviewer => sameUser(reviewer.user, user))?.state;
  return state === "reviewed" ? "Reviewed" : state === "reworkRequired" ? "Rework required" : "Under review";
}

/**
 * Review ids where `user` is currently a requested reviewer, from timeline rows
 * of any number of reviews (the queue's `comment like` query).
 */
export function pendingReviewRequests(comments: readonly IReviewComment[], user: string): number[] {
  const byReview = new Map<number, IReviewTimelineEvent[]>();
  for (const comment of comments) {
    if (comment.type !== "timeline") {
      continue;
    }
    const events = byReview.get(comment.reviewId) ?? [];
    events.push(parseTimelineEvent(comment));
    byReview.set(comment.reviewId, events);
  }
  const me = user.toLowerCase();
  const ids: number[] = [];
  byReview.forEach((events, reviewId) => {
    if (currentReviewers(events).some(reviewer => reviewer.toLowerCase() === me)) {
      ids.push(reviewId);
    }
  });
  return ids;
}

function requestState(event: IReviewTimelineEvent): boolean | undefined {
  switch (event.kind) {
  case "reviewRequested":
  case "reviewReRequested":
    return true;
  case "reviewRequestRemoved":
    return false;
  default:
    return undefined;
  }
}

/** How soon a verdict must follow a self-request, or a request the opening, to be read as one step. */
const FOLD_WINDOW = 10 * 60 * 1000;
/** How far apart the two rows Plastic writes for one action can be. */
const PAIR_WINDOW = 2 * 1000;

function isSelfRequest(event: IReviewTimelineEvent): boolean {
  return event.kind === "reviewRequested" && !!event.user && sameUser(event.user, event.owner);
}

/** A status row that says what its owner thinks of the change; Under review is not a verdict. */
function isVerdict(event: IReviewTimelineEvent): boolean {
  return event.kind === "status" && (event.status === "Reviewed" || event.status === "Rework required");
}

function sameAction(a: IReviewTimelineEvent, b: IReviewTimelineEvent): boolean {
  return a.kind === b.kind && a.status === b.status && sameUser(a.owner, b.owner) &&
    sameUser(a.user ?? "", b.user ?? "") && Math.abs(instant(a.date) - instant(b.date)) <= PAIR_WINDOW;
}

/**
 * The rows that may be the other half of `events[index]`'s pair: the same
 * action within two seconds, up to another action on the same person.
 */
function partners(events: readonly IReviewTimelineEvent[], index: number): number[] {
  const event = events[index];
  const found: number[] = [];
  for (const step of [ -1, 1 ]) {
    for (let other = index + step; other >= 0 && other < events.length; other += step) {
      const candidate = events[other];
      if (Math.abs(instant(candidate.date) - instant(event.date)) > PAIR_WINDOW) {
        break;
      }
      if (sameAction(event, candidate)) {
        found.push(other);
      } else if (subject(candidate) === subject(event)) {
        break;
      }
    }
  }
  return found;
}

/** Whom a row is about: the requested person of a request row, the owner of any other row, per kind. */
function subject(event: IReviewTimelineEvent): string {
  return requestState(event) === undefined
    ? `${event.kind}:${event.owner.trim().toLowerCase()}`
    : `request:${(event.user ?? "").trim().toLowerCase()}`;
}

function reviewerState(request?: IReviewTimelineEvent, verdict?: IReviewTimelineEvent): ReviewerState {
  if (verdict && (!request || compareEvents(verdict, request) > 0)) {
    return verdict.status === "Reviewed" ? "reviewed" : "reworkRequired";
  }
  if (request && isSelfRequest(request)) {
    return "reviewing";
  }
  return verdict ? "askedAgain" : "requested";
}

function isPending(reviewer: IReviewer): boolean {
  return reviewer.state === "requested" || reviewer.state === "reviewing" || reviewer.state === "askedAgain";
}

/** Pending reviewers by their request (an assignee nobody requested first), the others by their verdict. */
function compareReviewers(a: IReviewer, b: IReviewer): number {
  const event = (reviewer: IReviewer) => (isPending(reviewer) ? reviewer.request : reviewer.verdict);
  const first = event(a);
  const second = event(b);
  if (!first || !second) {
    return Number(!!first) - Number(!!second);
  }
  return compareEvents(first, second);
}

function userOf(text: string): Partial<IReviewTimelineEvent> {
  const user = text.trim();
  return user ? { user } : {};
}

/**
 * By time, then by id: comment ids are allocated in creation order, and two
 * rows of one request pair share a timestamp. Dates carry offsets that change
 * with daylight saving, so they are compared as instants, not strings.
 */
function compareEvents(a: IReviewTimelineEvent, b: IReviewTimelineEvent): number {
  const byTime = instant(a.date) - instant(b.date);
  return byTime || a.id - b.id;
}

function instant(date: string): number {
  const time = Date.parse(date);
  return isNaN(time) ? 0 : time;
}
