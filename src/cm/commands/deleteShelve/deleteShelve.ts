import { assertInteger } from "../findChangesets/findChangesets";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/** `cm shelveset delete sh:<N>`. */
export class DeleteShelve {
  public static run(shell: ICmShell, shelveId: number): Promise<string[]> {
    assertInteger(shelveId, "shelveId");
    return runMutation(shell, {
      args: [ "delete", `sh:${shelveId}` ],
      command: "shelveset",
      name: "shelveset delete",
    });
  }
}
