import { ICmResult, ICmShell } from "../../shell";
import {
  LOCK_FIELD_SEPARATOR,
  LOCK_LINE_END,
  LOCK_LINE_START,
  LocksParser,
} from "./locksParser";
import { assertCmArgument } from "../refNames";
import { ILockInfo } from "../../../models";

export interface IListLocksOptions {
  /** Only the locks the current user holds. */
  onlyCurrentUser?: boolean;
  /** Only the locks of this repository (`org/repo@server`); every repository of the server when absent. */
  repository?: string;
}

/**
 * `cm lock list --machinereadable --smartlocks --anystatus`, with explicit
 * separators so that paths with spaces read back unambiguously. Lists the locks
 * of every repository on the workspace's server; callers filter by repository.
 */
export class ListLocks {
  public static async run(shell: ICmShell, options: IListLocksOptions = {}): Promise<ILockInfo[]> {
    const args = [
      "list",
      "--machinereadable",
      "--smartlocks",
      "--anystatus",
      "--dateformat=yyyy-MM-dd HH:mm:ss",
      `--startlineseparator=${LOCK_LINE_START}`,
      `--endlineseparator=${LOCK_LINE_END}`,
      `--fieldseparator=${LOCK_FIELD_SEPARATOR}`,
    ];
    if (options.repository) {
      assertCmArgument(options.repository, "repository");
      args.push(`--repository=${options.repository}`);
    }
    if (options.onlyCurrentUser) {
      args.push("--onlycurrentuser");
    }

    const result: ICmResult<ILockInfo[]> = await shell.exec("lock", args, new LocksParser());
    if (!result.success || result.error) {
      throw result.error ?? new Error("cm lock list failed.");
    }

    return result.result ?? [];
  }
}
