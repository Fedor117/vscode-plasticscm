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

interface IRevisionQuery {
  /** Workspace id, used to pick the shell that can serve this revision. */
  wkId: string;
  changeset: number;
}

/**
 * Builds the URI that identifies a file's content at a given changeset. The path
 * and extension are preserved so VS Code still picks the right language.
 */
export function toRevisionUri(workspaceId: string, filePath: Uri, changeset: number): Uri {
  const query: IRevisionQuery = {
    changeset,
    wkId: workspaceId,
  };

  return filePath.with({
    query: JSON.stringify(query),
    scheme: revisionScheme,
  });
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
    const query = RevisionContentProvider.parseQuery(uri);
    if (!query) {
      return "";
    }

    const workspace = this.mPlasticScm.workspaces.get(query.wkId);
    if (!workspace) {
      return "";
    }

    try {
      const cachedFile: Uri | undefined = await GetFile.run(
        workspace.info.path, uri.with({ query: "", scheme: "file" }), query.changeset, workspace.shell);

      if (!cachedFile || token.isCancellationRequested) {
        return "";
      }

      return decodeRevision(await fsPromises.readFile(cachedFile.fsPath));
    } catch (e) {
      // An empty left-hand side is a better diff than a failed editor. The real
      // reason goes to the output channel.
      this.mPlasticScm.channel.appendLine(
        `Unable to load ${uri.fsPath} at cs:${query.changeset}: ${(e as Error).message}`);
      return "";
    }
  }

  private static parseQuery(uri: Uri): IRevisionQuery | undefined {
    try {
      return JSON.parse(uri.query) as IRevisionQuery;
    } catch {
      return undefined;
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
