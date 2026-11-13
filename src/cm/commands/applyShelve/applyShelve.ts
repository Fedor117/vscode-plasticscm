import { assertCmArgument } from "../refNames";
import { assertInteger } from "../findChangesets/findChangesets";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

export interface IApplyShelveOptions {
  /** Only print what would be applied; nothing in the workspace changes. */
  preview?: boolean;
  /** Server paths (as `--preview` prints them) of the changes to apply; all when empty. */
  paths?: string[];
}

/** How long an apply may run before the shell gives up on it, which also covers a merge tool nobody answers. */
export const APPLY_SHELVE_TIMEOUT_MILLIS = 10 * 60 * 1000;

/**
 * `cm shelveset apply sh:<N> [<paths>] [--preview] --dontcheckout`.
 *
 * `--dontcheckout` keeps the applied changes as local changes instead of
 * taking an exclusive checkout of every file, so applying a shelve does not
 * lock files other people are working on. cm has no option to skip conflict
 * resolution here, and the shell cannot answer a merge tool; the timeout
 * bounds how long a conflict can hold the workspace.
 */
export class ApplyShelve {
  public static run(shell: ICmShell, shelveId: number, options: IApplyShelveOptions = {}): Promise<string[]> {
    assertInteger(shelveId, "shelveId");
    const paths = options.paths ?? [];
    paths.forEach(path => assertCmArgument(path, "path"));

    const args = [ "apply", `sh:${shelveId}`, ...paths ];
    if (options.preview) {
      args.push("--preview");
    } else {
      args.push("--dontcheckout");
    }

    return runMutation(shell, {
      args,
      command: "shelveset",
      name: "shelveset apply",
      options: { timeoutMillis: APPLY_SHELVE_TIMEOUT_MILLIS },
    });
  }
}
