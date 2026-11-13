import { assertFullBranchName } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/**
 * `cm branch delete <brspec>`. Never passes `--delete-changesets`: a branch
 * that still has changesets is refused by cm rather than emptied.
 */
export class DeleteBranch {
  public static run(shell: ICmShell, branchName: string): Promise<string[]> {
    assertFullBranchName(branchName);

    return runMutation(shell, {
      args: [ "delete", `br:${branchName}` ],
      command: "branch",
      name: "branch delete",
    });
  }
}
