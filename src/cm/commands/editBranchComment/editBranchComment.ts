import { assertFullBranchName } from "../refNames";
import { ICmShell } from "../../shell";
import { OutputChannel } from "vscode";
import { runMutation } from "../runMutation";
import { withCommentsFile } from "../commentsFile";

/**
 * `cm branch editcomment <brspec> -commentsfile=<file>`, or `<brspec> ""` to
 * clear the comment (cm help: an empty comment clears it).
 */
export class EditBranchComment {
  public static run(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      branchName: string,
      comment: string): Promise<string[]> {

    assertFullBranchName(branchName);
    const base = [ "editcomment", `br:${branchName}` ];

    return withCommentsFile(comment, channel, commentArgs => runMutation(shell, {
      // withCommentsFile passes no argument for an empty comment, which cm takes as "clear".
      args: commentArgs.length > 0 ? [ ...base, ...commentArgs ] : [ ...base, "" ],
      command: "branch",
      name: "branch editcomment",
    }));
  }
}
