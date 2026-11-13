import { ILabelInfo, IListPage, IListQuery } from "../../../models";
import { pageClause, runFind, toPage } from "../listQuery";
import { FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { ICmShell } from "../../shell";
import { ListLabelsParser } from "./listLabelsParser";
import { queryString } from "../../../reviews/commands";

/** Labels of the shell's repository. */
export class ListLabels {
  /** Newest (by creation date) first. */
  public static async run(shell: ICmShell, query: IListQuery): Promise<IListPage<ILabelInfo>> {
    const rows = await runFind<ILabelInfo>(
      shell,
      [ "label", `order by date desc ${pageClause(query)}`, ...FIND_XML_ARGS ],
      new ListLabelsParser(),
      "label");
    return toPage(rows, query.limit);
  }

  /**
   * The label with exactly this name, or undefined. cm compares names
   * case-sensitively. Names with quotes or line breaks are rejected before cm runs.
   */
  public static async runByName(shell: ICmShell, name: string): Promise<ILabelInfo | undefined> {
    const rows = await runFind<ILabelInfo>(
      shell,
      [ "label", `where name = ${queryString(name)}`, ...FIND_XML_ARGS ],
      new ListLabelsParser(),
      "label");
    return rows.find(label => label.name === name);
  }
}
