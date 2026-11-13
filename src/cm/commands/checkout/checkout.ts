import { assertCmArgument } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/**
 * `cm checkout <paths> --machinereadable`. When the server's lock rules match a
 * path, the checkout is exclusive and takes a lock; if somebody else holds it,
 * cm fails and the caller explains who holds it.
 */
export class Checkout {
  public static run(shell: ICmShell, paths: string[]): Promise<string[]> {
    if (paths.length === 0) {
      return Promise.reject(new Error("There is nothing to check out."));
    }
    paths.forEach(path => assertCmArgument(path, "path"));

    return runMutation(shell, { args: [ ...paths, "--machinereadable" ], command: "checkout", name: "checkout" });
  }
}
