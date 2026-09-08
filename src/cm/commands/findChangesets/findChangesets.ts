import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { FindChangesetsParser } from "./findChangesetsParser";
import { IHistoryChangeset } from "../../../models";

export interface IChangesetQuery {
  /** Full branch name, e.g. `/main/task001`. */
  branch: string;
  /** Only changesets strictly older than this id, for paging. */
  beforeChangesetId?: number;
  limit: number;
}

/** Arguments every `cm find` in this module passes after the query. */
export const FIND_XML_ARGS: readonly string[] = [ "--xml", "--nototal", "--encoding=utf-8" ];

/**
 * cm's query parser strips `"` and offers no escape for `'`, so a name with
 * either would silently query a different branch (or break the query).
 */
export function assertBranchName(branchName: string): void {
  if (branchName.includes("'") || branchName.includes("\"")) {
    throw new Error(`Branch name '${branchName}' contains quotes, which cm queries cannot express.`);
  }
}

/** Ids are interpolated into a query string, so anything but an integer is rejected up front. */
export function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${String(value)}.`);
  }
}

export class FindChangesets {
  public static async run(shell: ICmShell, query: IChangesetQuery): Promise<IHistoryChangeset[]> {
    assertBranchName(query.branch);
    assertInteger(query.limit, "limit");
    if (query.limit <= 0) {
      throw new Error(`limit must be positive, got ${query.limit}.`);
    }

    let where = `where branch='${query.branch}'`;
    if (query.beforeChangesetId !== undefined) {
      assertInteger(query.beforeChangesetId, "beforeChangesetId");
      where += ` and changesetid < ${query.beforeChangesetId}`;
    }
    where += ` order by changesetid desc limit ${query.limit}`;

    return FindChangesets.find(shell, where);
  }

  public static async runById(shell: ICmShell, changesetId: number): Promise<IHistoryChangeset | undefined> {
    assertInteger(changesetId, "changesetId");

    const changesets = await FindChangesets.find(shell, `where changesetid=${changesetId}`);
    return changesets[0];
  }

  private static async find(shell: ICmShell, where: string): Promise<IHistoryChangeset[]> {
    const parser: ICmParser<IHistoryChangeset[]> = new FindChangesetsParser();

    const result: ICmResult<IHistoryChangeset[]> = await shell.exec(
      "find", [ "changeset", where, ...FIND_XML_ARGS ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm find changeset failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }
}
