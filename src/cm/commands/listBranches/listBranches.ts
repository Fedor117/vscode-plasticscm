import { IBranchInfo, IListPage, IListQuery } from "../../../models";
import { pageClause, runFind, toPage } from "../listQuery";
import { FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { FindBranchParser } from "../findBranch/findBranchParser";
import { ICmShell } from "../../shell";

/**
 * Branches of the shell's repository, newest (by creation date) first.
 * Hidden branches are left out, as cm does by default. For one branch by
 * name use `FindBranch`.
 */
export class ListBranches {
  public static async run(shell: ICmShell, query: IListQuery): Promise<IListPage<IBranchInfo>> {
    const rows = await runFind<IBranchInfo>(
      shell,
      [ "branch", `order by date desc ${pageClause(query)}`, ...FIND_XML_ARGS ],
      new FindBranchParser(),
      "branch");
    return toPage(rows, query.limit);
  }
}
