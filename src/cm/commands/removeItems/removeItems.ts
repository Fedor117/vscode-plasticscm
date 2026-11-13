import { assertCmArgument } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/** `cm remove <paths>`: deletes controlled items from version control and from disk. */
export class RemoveItems {
  public static run(shell: ICmShell, paths: string[]): Promise<string[]> {
    if (paths.length === 0) {
      return Promise.reject(new Error("There is nothing to delete."));
    }
    paths.forEach(path => assertCmArgument(path, "path"));

    return runMutation(shell, { args: [...paths], command: "remove", name: "remove" });
  }
}
