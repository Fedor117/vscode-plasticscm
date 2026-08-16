import { ADD_ERROR_PREFIX, AddParser } from "./addParser";
import { ICmParser, ICmResult, ICmShell } from "../../shell";

/**
 * `cm add`, which puts a private item under source control — the Plastic
 * equivalent of staging an untracked file.
 *
 * Two things about the command shape are not obvious. It has no
 * `--machinereadable`, unlike undo and status, so the output is pinned with
 * `--format`/`--errorformat` instead. And it has no `--parents`: cm's own
 * remarks make the parent a hard requirement — "The parent directory of the
 * item to add must have been previously added" — so the caller is responsible
 * for ordering shallowest-first.
 *
 * Neither format string contains a space, because the shell wraps every
 * argument in quotes of its own and nested quoting is not worth the risk.
 */
export class Add {
  public static async run(
      shell: ICmShell,
      recursive: boolean,
      ...paths: string[]): Promise<string[]> {

    const parser: ICmParser<string[]> = new AddParser();
    const args: string[] = [...paths];

    if (recursive) {
      args.push("-R");
    }

    args.push("--noinfo", "--format={0}", `--errorformat=${ADD_ERROR_PREFIX}{0}`);

    const result: ICmResult<string[]> = await shell.exec("add", args, parser);

    if (!result.success || result.error) {
      throw result.error ?? new Error("cm add failed.");
    }

    return result.result ?? [];
  }
}
