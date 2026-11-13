import { assertLabelName } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/** `cm label delete lb:<name>`. */
export class DeleteLabel {
  public static run(shell: ICmShell, name: string): Promise<string[]> {
    assertLabelName(name);

    return runMutation(shell, {
      args: [ "delete", `lb:${name}` ],
      command: "label",
      name: "label delete",
    });
  }
}
