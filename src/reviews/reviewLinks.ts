import { fileKey } from "./models";
import { FileScope } from "./sessionTypes";
import { OverviewLinkTarget } from "./reviewOverview";
import { Uri } from "vscode";

/**
 * The Overview's links to discussions and files: `vscode://<extension id>/thread?…`
 * and `/file?…` URIs, which the extension's URI handler opens. The Markdown
 * preview opens only http(s), mailto and vscode(-insiders) links, and a click
 * and a Cmd/Ctrl+click on one both reach the handler.
 *
 * VS Code decodes a URI's query once before the handler sees it, and a URI
 * that comes from a browser may take another route, so every value is written
 * in characters no encoding changes: decimal ids, a word for the scope, and
 * base64url for the workspace id and the file key.
 */

/** A thread or a file row of one review. */
export interface IReviewLink {
  workspaceId: string;
  reviewId: number;
  target: OverviewLinkTarget;
}

/** Where the links point: the product's URI scheme (`vscode.env.uriScheme`) and the extension's id. */
export interface IReviewLinkBase {
  scheme: string;
  authority: string;
}

export type ParsedReviewLink =
  | { kind: "link"; link: IReviewLink }
  /** One of the handler's paths, with a query that is not one the Overview writes. */
  | { kind: "malformed"; reason: string }
  /** Any other path: nothing of ours. */
  | { kind: "unknown" };

const PATHS: { [kind in OverviewLinkTarget["kind"]]: string } = { file: "/file", thread: "/thread" };
const PARAMETERS: { [kind in OverviewLinkTarget["kind"]]: readonly string[] } = {
  file: [ "workspace", "review", "scope", "file" ],
  thread: [ "workspace", "review", "thread" ],
};
const ID = /^[1-9]\d{0,14}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,4096}$/;
const CHANGESET_SCOPE = /^cs([1-9]\d{0,14})$/;

export function reviewLinkUri(base: IReviewLinkBase, link: IReviewLink): string {
  const { target } = link;
  const query = [ `workspace=${encode(link.workspaceId)}`, `review=${link.reviewId}` ];
  if (target.kind === "thread") {
    query.push(`thread=${target.threadId}`);
  } else {
    query.push(`scope=${scopeName(target.scope)}`, `file=${encode(target.fileKey)}`);
  }
  return `${base.scheme}://${base.authority}${PATHS[target.kind]}?${query.join("&")}`;
}

/**
 * Reads a URI the handler received. Anything may send one, so the query must
 * be exactly what `reviewLinkUri` writes: the path's parameters, each once,
 * in their canonical form, and nothing else.
 */
export function parseReviewLink(uri: Uri): ParsedReviewLink {
  const kind = uri.path === PATHS.thread ? "thread" : uri.path === PATHS.file ? "file" : undefined;
  if (!kind) {
    return { kind: "unknown" };
  }
  if (uri.fragment) {
    return malformed("a fragment");
  }
  const values = new Map<string, string>();
  for (const part of uri.query.split("&")) {
    const [ key, value, extra ] = part.split("=");
    if (value === undefined || extra !== undefined || values.has(key)) {
      return malformed(`the parameter "${part.substring(0, 40)}"`);
    }
    values.set(key, value);
  }
  const names = PARAMETERS[kind];
  const missing = names.filter(name => !values.has(name));
  if (missing.length || values.size !== names.length) {
    return malformed(missing.length ? `no ${missing.join(", ")}` : "an unknown parameter");
  }
  const workspaceId = decode(values.get("workspace")!);
  const reviewId = id(values.get("review")!);
  if (workspaceId === undefined || reviewId === undefined) {
    return malformed(workspaceId === undefined ? "a malformed workspace" : "a malformed review id");
  }
  if (kind === "thread") {
    const threadId = id(values.get("thread")!);
    return threadId === undefined
      ? malformed("a malformed thread id")
      : { kind: "link", link: { reviewId, target: { kind, threadId }, workspaceId }};
  }
  const scope = parseScope(values.get("scope")!);
  const key = decode(values.get("file")!);
  if (!scope || key === undefined || !isFileKey(key)) {
    return malformed(scope ? "a malformed file" : "an unknown scope");
  }
  return { kind: "link", link: { reviewId, target: { fileKey: key, kind, scope }, workspaceId }};
}

function malformed(reason: string): ParsedReviewLink {
  return { kind: "malformed", reason };
}

function id(text: string): number | undefined {
  const value = ID.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

function scopeName(scope: FileScope): string {
  return typeof scope === "string" ? scope : `cs${scope.changesetId}`;
}

function parseScope(text: string): FileScope | undefined {
  if (text === "changes" || text === "merged") {
    return text;
  }
  const changeset = CHANGESET_SCOPE.exec(text);
  const changesetId = changeset ? id(changeset[1]) : undefined;
  return changesetId === undefined ? undefined : { changesetId };
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The text of a base64url token, or undefined unless the token is exactly what `encode` writes for it. */
function decode(token: string): string | undefined {
  if (!TOKEN.test(token)) {
    return undefined;
  }
  const text = Buffer.from(token, "base64url").toString("utf8");
  return encode(text) === token ? text : undefined;
}

/** `fileKey()` of some row: a JSON pair of a path and a revision id, written as `fileKey` writes it. */
function isFileKey(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }
  const [ path, revisionId ] = value as unknown[];
  return typeof path === "string" && Number.isSafeInteger(revisionId) &&
    fileKey({ path, revisionId: revisionId as number }) === text;
}
