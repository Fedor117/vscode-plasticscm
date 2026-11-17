import { assertPage, pageClause, runFind, toPage } from "../listQuery";
import { IBranchInfo, IListPage, IListQuery } from "../../../models";
import { FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { FindBranchParser } from "../findBranch/findBranchParser";
import { ICmShell } from "../../shell";

export interface IListBranchesOptions {
  /** Also list the branches cm hides, each marked `hidden`. */
  includeHidden?: boolean;
}

/**
 * Branches of the shell's repository, newest (by creation date) first.
 * Hidden branches are left out, as cm does by default, unless asked for. For
 * one branch by name use `FindBranch`.
 */
export class ListBranches {
  public static async run(
      shell: ICmShell, query: IListQuery, options: IListBranchesOptions = {}): Promise<IListPage<IBranchInfo>> {
    if (!options.includeHidden) {
      const rows = await ListBranches.find(shell, `order by date desc ${pageClause(query)}`);
      return toPage(rows, query.limit);
    }

    // `where hidden = 'true'` returns only the hidden branches, and cm has no
    // query for both kinds (an `or` of the two returns only the hidden ones too),
    // so the page is cut from the newest rows of each query, merged by date.
    assertPage(query);
    const offset = query.offset ?? 0;
    const wanted = `order by date desc limit ${offset + query.limit + 1}`;
    const visible = await ListBranches.find(shell, wanted);
    const hidden = await ListBranches.find(shell, `where hidden = 'true' ${wanted}`);
    const merged = mergeNewestFirst(visible, hidden.map(branch => ({ ...branch, hidden: true })));
    return toPage(merged.slice(offset, offset + query.limit + 1), query.limit);
  }

  private static find(shell: ICmShell, query: string): Promise<IBranchInfo[]> {
    return runFind<IBranchInfo>(shell, [ "branch", query, ...FIND_XML_ARGS ], new FindBranchParser(), "branch");
  }
}

function mergeNewestFirst(a: IBranchInfo[], b: IBranchInfo[]): IBranchInfo[] {
  const merged: IBranchInfo[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const takeA = j >= b.length || (i < a.length && a[i].date.getTime() >= b[j].date.getTime());
    merged.push(takeA ? a[i++] : b[j++]);
  }
  return merged;
}
