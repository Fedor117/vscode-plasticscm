import { assertBranchName, FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { FindBranchParser } from "./findBranchParser";
import { IBranchInfo } from "../../../models";

export class FindBranch {
  public static async run(shell: ICmShell, branchName: string): Promise<IBranchInfo | undefined> {
    assertBranchName(branchName);

    // `name` only matches the last path segment, so the query is by short name
    // and the full name is checked on the results (`/main/X` and `/main/a/X` both match `X`).
    const shortName = branchName.substring(branchName.lastIndexOf("/") + 1);
    const parser: ICmParser<IBranchInfo[]> = new FindBranchParser();

    const result: ICmResult<IBranchInfo[]> = await shell.exec(
      "find", [ "branch", `where name='${shortName}'`, ...FIND_XML_ARGS ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm find branch failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return (result.result ?? []).find(branch => branch.name === branchName);
  }
}
