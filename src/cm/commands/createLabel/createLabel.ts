import { assertInteger } from "../findChangesets/findChangesets";
import { assertLabelName } from "../refNames";
import { ICmShell } from "../../shell";
import { OutputChannel } from "vscode";
import { runMutation } from "../runMutation";
import { withCommentsFile } from "../commentsFile";

export interface ICreateLabelRequest {
  name: string;
  /** The changeset the label is put on. */
  changeset: number;
  comment?: string;
}

/** `cm label create lb:<name> cs:<n> [-commentsfile=<file>]`. */
export class CreateLabel {
  public static async run(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      request: ICreateLabelRequest): Promise<string[]> {

    assertLabelName(request.name);
    assertInteger(request.changeset, "changeset");
    const args = [ "create", `lb:${request.name}`, `cs:${request.changeset}` ];

    return withCommentsFile(request.comment, channel, commentArgs => runMutation(shell, {
      args: [ ...args, ...commentArgs ],
      command: "label",
      name: "label create",
    }));
  }
}
