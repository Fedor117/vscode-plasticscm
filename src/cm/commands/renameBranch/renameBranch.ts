import { assertBranchShortName, assertFullBranchName } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/** `cm branch rename <brspec> <new_name>`: `newShortName` replaces the last segment; the parent stays. */
export class RenameBranch {
  public static run(shell: ICmShell, branchName: string, newShortName: string): Promise<string[]> {
    assertFullBranchName(branchName);
    assertBranchShortName(newShortName);

    return runMutation(shell, {
      args: [ "rename", `br:${branchName}`, newShortName ],
      command: "branch",
      name: "branch rename",
    });
  }
}
