import * as xml2js from "xml2js";
import { BaseCmParser } from "../baseCmParser";
import { IHistoryChangeset } from "../../../models";

/**
 * Shared by the three `cm find --xml` parsers. No value processors on purpose:
 * `parseNumbers` would turn a comment such as `007` or `1e3` into a number that
 * `String()` cannot restore, so every id is converted explicitly instead.
 */
export const PLASTIC_QUERY_OPTIONS: xml2js.OptionsV2 = {
  explicitArray: false,
  explicitRoot: false,
  normalizeTags: true,
  trim: true,
};

/**
 * `cm find` prints one element per row, so xml2js yields an array for many rows,
 * a bare object for one and a string (the root's whitespace) for none.
 */
export function readQueryRows<T extends object>(query: unknown, rowTag: string): T[] {
  if (!query || typeof query !== "object") {
    return [];
  }

  const rows: unknown = (query as Record<string, unknown>)[rowTag];
  if (Array.isArray(rows)) {
    return rows.filter((row): row is T => !!row && typeof row === "object");
  }

  return rows && typeof rows === "object" ? [rows as T] : [];
}

/** cm rows are flat text, so anything xml2js turned into an object (attributes, children) carries no usable text. */
export function readText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/** cm ids are integers; anything else (an empty `<PARENT>`, garbage) becomes -1. */
export function readId(value: unknown): number {
  const id = parseInt(readText(value), 10);
  return isNaN(id) ? -1 : id;
}

export function readDate(value: unknown): Date {
  const date = new Date(readText(value));
  return isNaN(date.getTime()) ? new Date(0) : date;
}

export class FindChangesetsParser extends BaseCmParser<IHistoryChangeset[]> {
  public async parse(): Promise<IHistoryChangeset[] | undefined> {
    try {
      // Comments span several output lines; "\n" keeps the line breaks cm printed.
      const query: unknown = await xml2js.parseStringPromise(
        this.mOutputBuffer.join("\n"), PLASTIC_QUERY_OPTIONS);
      return readQueryRows<IChangesetRow>(query, "changeset").map(row => ({
        branch: readText(row.branch),
        comment: readText(row.comment),
        date: readDate(row.date),
        guid: readText(row.guid),
        id: readId(row.changesetid),
        owner: readText(row.owner),
        parentId: readId(row.parent),
        repository: readText(row.repository),
        server: readText(row.repserver),
      }));
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }
}

interface IChangesetRow {
  branch?: unknown;
  changesetid?: unknown;
  comment?: unknown;
  date?: unknown;
  guid?: unknown;
  owner?: unknown;
  parent?: unknown;
  repository?: unknown;
  repserver?: unknown;
}
