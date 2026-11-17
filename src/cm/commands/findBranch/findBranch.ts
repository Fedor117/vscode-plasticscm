import { assertBranchName, FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { FindBranchParser } from "./findBranchParser";
import { IBranchInfo } from "../../../models";

export class FindBranch {
  /** With `includeHidden`, a branch cm hides is looked up too when no visible one matches, and marked `hidden`. */
  public static async run(
      shell: ICmShell,
      branchName: string,
      options: { includeHidden?: boolean } = {}): Promise<IBranchInfo | undefined> {
    const visible = await FindBranch.find(shell, branchName, "");
    if (visible || !options.includeHidden) {
      return visible;
    }
    const hidden = await FindBranch.find(shell, branchName, " and hidden = 'true'");
    return hidden && { ...hidden, hidden: true };
  }

  private static async find(shell: ICmShell, branchName: string, condition: string): Promise<IBranchInfo | undefined> {
    assertBranchName(branchName);

    // `name` only matches the last path segment, so the query is by short name
    // and the full name is checked on the results (`/main/X` and `/main/a/X` both match `X`).
    const shortName = branchName.substring(branchName.lastIndexOf("/") + 1);
    const parser: ICmParser<IBranchInfo[]> = new FindBranchParser();

    const result: ICmResult<IBranchInfo[]> = await shell.exec(
      "find", [ "branch", `where name='${shortName}'${condition}`, ...FIND_XML_ARGS ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm find branch failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return (result.result ?? []).find(branch => branch.name === branchName);
  }
}
