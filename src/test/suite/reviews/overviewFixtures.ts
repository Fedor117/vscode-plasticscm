import { fileKey, IReviewDiscussions, scopeRows, viewableRows } from "../../../reviews/models";
import { FileScope, IActiveReview } from "../../../reviews/sessionTypes";
import { hasLocation, isGeneralThread } from "../../../reviews/reviewPresentation";
import { IReviewLink, parseReviewLink } from "../../../reviews/reviewLinks";
import { expect } from "chai";
import { OverviewLinkTarget } from "../../../reviews/reviewOverview";
import { Uri } from "vscode";

/** The URI the tests' link builder writes, as the extension's URI handler would receive it. */
export const HANDLER = "vscode://plastic.test/open";

/** A full e-mail address, which the page shows only in a name's title. */
export const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

export function testLink(target: OverviewLinkTarget): string {
  return target.kind === "thread"
    ? `${HANDLER}?thread=${target.threadId}`
    : `${HANDLER}?scope=${scopeName(target.scope)}&file=${encodeURIComponent(target.fileKey)}`;
}

function scopeName(scope: FileScope): string {
  return typeof scope === "string" ? scope : `cs${scope.changesetId}`;
}

/** Every tag the page writes, and every attribute; nothing else may reach the preview. */
const TAGS = new Set([
  "a", "blockquote", "br", "circle", "code", "details", "div", "h1", "h2", "li", "p", "path", "section", "span",
  "strong", "summary", "svg", "ul",
]);
const SELF_CLOSING = new Set([ "circle", "path" ]);
const ATTRIBUTES = new Set([
  "aria-hidden", "aria-label", "aria-valuemax", "aria-valuemin", "aria-valuenow", "class", "cx", "cy", "d", "fill",
  "height", "href", "r", "role", "stroke", "stroke-width", "style", "title", "viewBox", "width",
]);
const STYLES = /^(?:background-color: #[0-9a-f]{6}|width: \d{1,3}%)$/;
const TAG = /^<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z][\w-]*="[^"<>]*")*)\s*(\/?)>$/i;
const ATTRIBUTE = /\s+([a-z][\w-]*)="([^"]*)"/gi;

/**
 * One HTML block as markdown-it reads it: the wrapper opens on the first line
 * and closes on the last, no line is blank (a blank line would end the block),
 * every tag and attribute is one the page writes, tags balance, links use a
 * scheme the preview opens, and text and values are escaped.
 */
export function expectWellFormed(html: string): void {
  expect(html.startsWith("<div class=\"plastic-review\">\n"), "opens with the wrapper").to.equal(true);
  expect(html.endsWith("\n</div>\n"), "closes with the wrapper").to.equal(true);
  html.slice(0, -1).split("\n").forEach((line, index) => {
    expect(line.trim(), `line ${index + 1} is blank`).to.not.equal("");
  });
  expect(html.replace(/&(?:amp|lt|gt|quot|#39|#10);/g, ""), "a bare ampersand").to.not.contain("&");
  const open: string[] = [];
  html.split(/(<[^>]*>)/).forEach((part, index) => {
    if (index % 2 === 0) {
      expect(part, "text holds no markup").to.not.match(/[<>]/);
      return;
    }
    const match = TAG.exec(part);
    expect(match, `a malformed tag: ${part}`).to.not.equal(null);
    const [ , closing, name, attributes, selfClosing ] = match!;
    expect(TAGS.has(name), `an unexpected tag: ${part}`).to.equal(true);
    const pattern = new RegExp(ATTRIBUTE.source, ATTRIBUTE.flags);
    for (let attribute = pattern.exec(attributes); attribute; attribute = pattern.exec(attributes)) {
      const [ , key, value ] = attribute;
      expect(ATTRIBUTES.has(key), `an unexpected attribute: ${part}`).to.equal(true);
      if (key === "href") {
        expect(decode(value), "a link the preview opens").to.match(/^(?:https?|vscode):\/\/[^/?#]/i);
      }
      if (key === "style") {
        expect(value, "a style the page sets").to.match(STYLES);
      }
    }
    if (closing) {
      expect(open.pop(), `an unbalanced ${part}`).to.equal(name);
    } else if (selfClosing) {
      expect(SELF_CLOSING.has(name), `a self-closed ${name}`).to.equal(true);
    } else if (name !== "br") {
      open.push(name);
    }
  });
  expect(open, "unclosed tags").to.deep.equal([]);
}

export function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

/** Decorative text left out: avatars' initials are `aria-hidden`. */
const DECORATIVE = /<span [^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g;

/** The text a reader sees: tags (and so every title) and decorations removed, line breaks kept. */
export function visible(html: string): string {
  return decode(html.replace(DECORATIVE, "").replace(/<br>/g, "\n").replace(/<[^>]*>/g, ""));
}

/** The page as lines of text: one per block element or line break, white space collapsed. */
export function textLines(html: string): string[] {
  return decode(html.replace(DECORATIVE, "").replace(/<\/(?:blockquote|div|h1|h2|li|p|summary)>|<br>/g, "\n")
    .replace(/<[^>]*>/g, ""))
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The section headings, without their counts. */
export function headings(html: string): string[] {
  const pattern = /<h2>([^<]*)/g;
  const result: string[] = [];
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    result.push(decode(match[1]).trim());
  }
  return result;
}

/** Every link's decoded href and text. */
export function links(html: string): Array<{ href: string; text: string }> {
  const pattern = /<a href="([^"]*)">([\s\S]*?)<\/a>/g;
  const result: Array<{ href: string; text: string }> = [];
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    result.push({ href: decode(match[1]), text: visible(match[2]) });
  }
  return result;
}

/**
 * Every link is a URL someone wrote or a `testLink` that resolves to a thread
 * with a line or a file row of the review. Returns how many handler links there are.
 */
export function expectLinksOpen(html: string, active: IActiveReview): number {
  const threads = active.discussions.state === "ready" ? active.discussions.value.threads : [];
  const files = active.files.state === "ready" ? active.files.value : undefined;
  let handled = 0;
  for (const { href } of links(html)) {
    if (/^https?:\/\/[^/?#]/i.test(href)) {
      continue;
    }
    handled++;
    const thread = /^vscode:\/\/plastic\.test\/open\?thread=(\d+)$/.exec(href);
    if (thread) {
      const named = threads.find(candidate => candidate.id === Number(thread[1]));
      expect(!!named && hasLocation(named), `${href} names a thread with a line`).to.equal(true);
      continue;
    }
    const file = /^vscode:\/\/plastic\.test\/open\?scope=(changes|merged)&file=([^&]+)$/.exec(href);
    expect(file, `${href} is a URL or a handler link`).to.not.equal(null);
    const key = decodeURIComponent(file![2]);
    const rows = files ? scopeRows(files, file![1] as "changes" | "merged") : [];
    expect(rows.some(row => fileKey(row) === key), `${href} names a file row`).to.equal(true);
  }
  return handled;
}

/**
 * Every link is a URL someone wrote or a link to the extension's URI handler
 * (`prefix` is its scheme and authority) that `parseReviewLink` reads as a
 * thread with a line, or a listed file row, of this very review: what the
 * handler opens. Returns the handler links.
 */
export function expectHandlerLinksOpen(html: string, active: IActiveReview, prefix: string): IReviewLink[] {
  const threads = active.discussions.state === "ready" ? active.discussions.value.threads : [];
  const files = active.files.state === "ready" ? active.files.value : undefined;
  const found: IReviewLink[] = [];
  for (const { href } of links(html)) {
    if (/^https?:\/\/[^/?#]/i.test(href)) {
      continue;
    }
    expect(href.startsWith(prefix), `${href} addresses the handler`).to.equal(true);
    const parsed = parseReviewLink(Uri.parse(href));
    expect(parsed.kind, `${href} is a link the handler reads`).to.equal("link");
    const link = (parsed as { link: IReviewLink }).link;
    expect([ link.workspaceId, link.reviewId ], href).to.deep.equal([ active.workspaceId, active.review.id ]);
    const target = link.target;
    if (target.kind === "thread") {
      const thread = threads.find(candidate => candidate.id === target.threadId);
      expect(!!thread && hasLocation(thread), `${href} names a thread with a line`).to.equal(true);
    } else {
      expect(target.scope, href).to.be.oneOf([ "changes", "merged" ]);
      const rows = files ? viewableRows(scopeRows(files, target.scope as "changes" | "merged")) : [];
      expect(rows.some(row => fileKey(row) === target.fileKey), `${href} names a file row`).to.equal(true);
    }
    found.push(link);
  }
  return found;
}

/** Discussions opens the Overview for every General thread, so each is on the page in full. */
export function expectEveryGeneralThread(html: string, discussions: IReviewDiscussions): void {
  expectThreadsOnPage(html, discussions.threads.filter(isGeneralThread));
}

/** Every paragraph of every comment of the threads is on the page, as its visible text. */
export function expectThreadsOnPage(
    html: string,
    threads: ReadonlyArray<{ id: number; comments: ReadonlyArray<{ id: number; text: string }> }>): void {
  const flat = (text: string) => text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const page = flat(visible(html));
  for (const thread of threads) {
    for (const comment of thread.comments) {
      for (const paragraph of comment.text.split(/\n[ \t]*\n/).map(flat).filter(Boolean)) {
        expect(page, `thread ${thread.id}, comment ${comment.id}`).to.contain(paragraph);
      }
    }
  }
}
