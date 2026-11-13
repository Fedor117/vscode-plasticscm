import { assertCmArgument } from "../refNames";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/**
 * `cm lock unlock <itemspec>...`: releases the Locked status; with `remove`
 * (`--remove`) deletes the lock record. cm lets users release their own locks;
 * releasing or removing someone else's needs a server administrator.
 */
export class UnlockItems {
  public static run(shell: ICmShell, itemSpecs: string[], remove: boolean): Promise<string[]> {
    if (itemSpecs.length === 0) {
      return Promise.reject(new Error("There is no lock to release."));
    }
    itemSpecs.forEach(spec => assertCmArgument(spec, "item spec"));

    const args = [ "unlock", ...itemSpecs ];
    if (remove) {
      args.push("--remove");
    }

    return runMutation(shell, { args, command: "lock", name: remove ? "lock unlock --remove" : "lock unlock" });
  }
}
