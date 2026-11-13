import * as xml2js from "xml2js";
import { PLASTIC_QUERY_OPTIONS, readDate, readId, readText } from "../findChangesets/findChangesetsParser";
import { BaseCmParser } from "../baseCmParser";
import { IFileRevision } from "../../../models";

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value && typeof value === "object" ? [value] : [];
}

function field(row: Record<string, unknown>, name: string): unknown {
  return row[name];
}

/**
 * Reads `cm history --xml`: `RevisionHistories > RevisionHistory > Revisions >
 * Revision`. The revisions of every history in the document are returned,
 * newest first. A document with no histories (an item with no revisions) is an
 * empty list.
 */
export class FileHistoryParser extends BaseCmParser<IFileRevision[]> {
  public async parse(): Promise<IFileRevision[] | undefined> {
    try {
      const document: unknown = await xml2js.parseStringPromise(this.mOutputBuffer.join("\n"), PLASTIC_QUERY_OPTIONS);
      const root = (document && typeof document === "object" ? document : {}) as Record<string, unknown>;
      const histories = asArray((root.revisionhistories as Record<string, unknown> | undefined)?.revisionhistory);

      const revisions: IFileRevision[] = [];
      for (const history of histories) {
        const rows = asArray(((history as Record<string, unknown>).revisions as Record<string, unknown> | undefined)
          ?.revision);
        for (const row of rows as Array<Record<string, unknown>>) {
          const repositorySpec = field(row, "repositoryspec") as Record<string, unknown> | undefined;
          revisions.push({
            branch: readText(field(row, "branch")),
            changesetId: readId(field(row, "changesetnumber")),
            comment: readText(field(row, "comment")),
            date: readDate(field(row, "creationdate")),
            itemId: readId(field(row, "itemid")),
            owner: readText(field(row, "owner")),
            repository: readText(field(row, "repository")),
            server: readText(field(row, "server")) || readText(repositorySpec?.server),
            size: Math.max(0, readId(field(row, "size"))),
            spec: readText(field(row, "revisionspec")),
            type: readText(field(row, "revisiontype")),
          });
        }
      }

      return revisions.sort((a, b) => b.date.getTime() - a.date.getTime() || b.changesetId - a.changesetId);
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }
}
