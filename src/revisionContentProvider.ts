import {
  CancellationToken,
  Disposable,
  TextDocumentContentProvider,
  Uri,
  workspace as VsCodeWorkspace,
} from "vscode";
import { promises as fsPromises } from "fs";
import { GetFile } from "./cm/commands";
import { PlasticScm } from "./plasticScm";

export const revisionScheme = "plastic";

/** A file at a changeset, addressed by its workspace path (quick diff, SCM view). */
interface IChangesetRevisionQuery {
  /** Workspace id, used to pick the shell that can serve this revision. */
  wkId: string;
  changeset: number;
}

/** A revision by id, addressed by its server path (history diffs). */
interface IRevisionIdQuery {
  wkId: string;
  revid: number;
  /** Repository spec; empty for the workspace's own repository. */
  rep: string;
}

/** The empty side of a diff for an added or deleted item. */
interface IEmptyRevisionQuery {
  wkId: string;
  empty: true;
}

/**
 * Discriminated by which fields are present, because the JSON shape is the
 * document identity: two `plastic:` URIs with the same path and different
 * queries are distinct documents, which is what lets a diff show the same file
 * under its old and new names.
 */
export type RevisionQuery = IChangesetRevisionQuery | IRevisionIdQuery | IEmptyRevisionQuery;

/**
 * Builds the URI that identifies a file's content at a given changeset. The path
 * and extension are preserved so VS Code still picks the right language.
 */
export function toRevisionUri(workspaceId: string, filePath: Uri, changeset: number): Uri {
  const query: IChangesetRevisionQuery = {
    changeset,
    wkId: workspaceId,
  };

  return filePath.with({
    query: JSON.stringify(query),
    scheme: revisionScheme,
  });
}

/**
 * Identifies a file's content by revision id, for history diffs: the item may no
 * longer exist at any workspace path. `serverPath` keeps the extension so VS
 * Code still picks the right language.
 */
export function toRevisionIdUri(
    workspaceId: string, serverPath: string, revisionId: number, repository: string): Uri {
  const query: IRevisionIdQuery = {
    rep: repository,
    revid: revisionId,
    wkId: workspaceId,
  };

  return Uri.from({
    path: serverPath,
    query: JSON.stringify(query),
    scheme: revisionScheme,
  });
}

/** The empty side of a diff for an added or deleted item. */
export function toEmptyRevisionUri(workspaceId: string, serverPath: string): Uri {
  const query: IEmptyRevisionQuery = {
    empty: true,
    wkId: workspaceId,
  };

  return Uri.from({
    path: serverPath,
    query: JSON.stringify(query),
    scheme: revisionScheme,
  });
}

/**
 * Tolerant on purpose: a URI of this scheme that the extension did not build
 * (or built in an older version) yields an empty document, not an exception.
 */
export function parseRevisionQuery(uri: Uri): RevisionQuery | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(uri.query);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.wkId !== "string") {
    return undefined;
  }

  if (candidate.empty === true) {
    return { empty: true, wkId: candidate.wkId };
  }

  if (typeof candidate.revid === "number") {
    return {
      rep: typeof candidate.rep === "string" ? candidate.rep : "",
      revid: candidate.revid,
      wkId: candidate.wkId,
    };
  }

  if (typeof candidate.changeset === "number") {
    return { changeset: candidate.changeset, wkId: candidate.wkId };
  }

  return undefined;
}

function describeQuery(uri: Uri, query: IChangesetRevisionQuery | IRevisionIdQuery): string {
  return "revid" in query
    ? `${uri.path} at revid:${query.revid}`
    : `${uri.fsPath} at cs:${query.changeset}`;
}

/**
 * Serves file contents straight out of the repository, on demand.
 *
 * This is what lets a refresh stay O(1) in cm round trips: nothing is fetched
 * until the user actually opens a diff, and then only the file they opened.
 */
export class RevisionContentProvider implements TextDocumentContentProvider, Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = VsCodeWorkspace.registerTextDocumentContentProvider(revisionScheme, this);
  }

  public dispose(): void {
    this.mDisposable.dispose();
  }

  public async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string> {
    const query = parseRevisionQuery(uri);
    if (!query || "empty" in query) {
      return "";
    }

    const workspace = this.mPlasticScm.workspaces.get(query.wkId);
    if (!workspace) {
      return "";
    }

    try {
      const cachedFile: Uri | undefined = "revid" in query
        ? await GetFile.runRevision(workspace.info.path, query.revid, query.rep, uri.path, workspace.shell)
        : await GetFile.run(
          workspace.info.path, uri.with({ query: "", scheme: "file" }), query.changeset, workspace.shell);

      if (!cachedFile || token.isCancellationRequested) {
        return "";
      }

      return decodeRevision(await fsPromises.readFile(cachedFile.fsPath));
    } catch (e) {
      // An empty left-hand side is a better diff than a failed editor. The real
      // reason goes to the output channel.
      this.mPlasticScm.channel.appendLine(`Unable to load ${describeQuery(uri, query)}: ${(e as Error).message}`);
      return "";
    }
  }
}

/**
 * Decodes a revision the way VS Code decodes the working copy it is diffed
 * against, which a plain utf8 read does not.
 *
 * VS Code detects the encoding of a `file:` document and strips its byte order
 * mark; Node keeps the BOM as a leading U+FEFF. Left alone, that makes line 1
 * differ in every diff of a BOM'd file — the Visual Studio default, so most .cs
 * in a Unity or Unreal workspace — and turns a UTF-16 file into mojibake.
 */
export function decodeRevision(buffer: Buffer): string {
  if (buffer.length >= 3 &&
      buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf8", 3);
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2);
  }

  // Node has no utf16be decoder, so the pairs are swapped into little-endian.
  // swap16 rejects an odd length, and a stray trailing byte is not a character.
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2));
    return Buffer.from(body).swap16().toString("utf16le");
  }

  return buffer.toString("utf8");
}
