import { assertLabelName } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/** `cm label rename lb:<name> <new_name>`. */
export class RenameLabel {
  public static run(shell: ICmShell, name: string, newName: string): Promise<string[]> {
    assertLabelName(name);
    assertLabelName(newName);

    return runMutation(shell, {
      args: [ "rename", `lb:${name}`, newName ],
      command: "label",
      name: "label rename",
    });
  }
}
