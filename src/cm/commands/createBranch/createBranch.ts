import { assertFullBranchName, assertLabelName } from "../refNames";
import { assertInteger } from "../findChangesets/findChangesets";
import { ICmShell } from "../../shell";
import { OutputChannel } from "vscode";
import { runMutation } from "../runMutation";
import { withCommentsFile } from "../commentsFile";

export interface ICreateBranchRequest {
  /** Full name of the new branch, e.g. `/main/task001`. Its parent is the part before the last `/`. */
  name: string;
  /** Start from this changeset, which has to be on the parent branch. */
  fromChangeset?: number;
  /** Start from the changeset this label is on; the label's changeset has to be on the parent branch. */
  fromLabel?: string;
  comment?: string;
}

/**
 * `cm branch create <brspec> [--changeset=<n> | --label=<lbspec>] [-commentsfile=<file>]`.
 * Without a start point cm bases the branch on the last changeset of its parent.
 */
export class CreateBranch {
  public static async run(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      request: ICreateBranchRequest): Promise<string[]> {

    assertFullBranchName(request.name);
    if (request.fromChangeset !== undefined && request.fromLabel !== undefined) {
      throw new Error("A branch starts from a changeset or from a label, not both.");
    }

    const args = [ "create", `br:${request.name}` ];
    if (request.fromChangeset !== undefined) {
      assertInteger(request.fromChangeset, "fromChangeset");
      args.push(`--changeset=${request.fromChangeset}`);
    }
    if (request.fromLabel !== undefined) {
      assertLabelName(request.fromLabel);
      args.push(`--label=lb:${request.fromLabel}`);
    }

    return withCommentsFile(request.comment, channel, commentArgs => runMutation(shell, {
      args: [ ...args, ...commentArgs ],
      command: "branch",
      name: "branch create",
    }));
  }
}
