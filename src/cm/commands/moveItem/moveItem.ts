import { assertCmArgument } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/** `cm move <src> <dst>`: moves or renames a controlled item, on disk too. */
export class MoveItem {
  public static run(shell: ICmShell, source: string, destination: string): Promise<string[]> {
    assertCmArgument(source, "source path");
    assertCmArgument(destination, "destination path");

    return runMutation(shell, { args: [ source, destination ], command: "move", name: "move" });
  }
}
