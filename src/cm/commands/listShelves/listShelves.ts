import { assertInteger, FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { assertPage, runFind } from "../listQuery";
import { IListPage, IListQuery, IShelveInfo } from "../../../models";
import { ICmShell } from "../../shell";
import { ListShelvesParser } from "./listShelvesParser";

/** Shelves of the shell's repository. */
export class ListShelves {
  /**
   * Newest (highest shelve number) first. cm 11 cannot `order by` anything for
   * shelves and returns them oldest first, so `limit` would keep the oldest
   * ones: every shelve is read and the page is cut here. One query of a few
   * hundred rows; fine for the shelve counts teams keep.
   */
  public static async run(shell: ICmShell, query: IListQuery): Promise<IListPage<IShelveInfo>> {
    assertPage(query);
    const rows = await runFind<IShelveInfo>(
      shell, [ "shelve", ...FIND_XML_ARGS ], new ListShelvesParser(), "shelve");

    const offset = query.offset ?? 0;
    const newestFirst = rows.slice().sort((a, b) => b.shelveId - a.shelveId);
    return {
      hasMore: newestFirst.length > offset + query.limit,
      items: newestFirst.slice(offset, offset + query.limit),
    };
  }

  /** The shelve `sh:<shelveId>`, or undefined. */
  public static async runById(shell: ICmShell, shelveId: number): Promise<IShelveInfo | undefined> {
    assertInteger(shelveId, "shelveId");
    const rows = await runFind<IShelveInfo>(
      shell,
      [ "shelve", `where shelveid = ${shelveId}`, ...FIND_XML_ARGS ],
      new ListShelvesParser(),
      "shelve");
    return rows.find(shelve => shelve.shelveId === shelveId);
  }
}
