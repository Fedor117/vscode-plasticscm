import { IChangeInfo, IPendingChanges, WkConfigType } from "../../../models";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { isAbsolute, join, relative } from "path";
import { StatusParser } from "./statusParser";

export class Status {
  public static readonly EmptyChanges: IPendingChanges = {
    changes: new Map<string, IChangeInfo>(),
    changeset: 0,
    workspaceConfig: {
      configType: WkConfigType.Unknown,
      location: "unknown",
      repSpec: "unknown@unknown",
    },
  };

  /**
   * `cmRootDir` is the root as cm prints it, when that is not `rootDir`: status
   * paths come back under it and are restated under `rootDir`.
   */
  public static async run(rootDir: string, shell: ICmShell, cmRootDir = rootDir): Promise<IPendingChanges> {
    const parser: ICmParser<IPendingChanges> = new StatusParser(
      cmRootDir === rootDir ? undefined : path => rebase(path, cmRootDir, rootDir));

    const result: ICmResult<IPendingChanges> = await shell.exec(
      "status",
      [ rootDir, "--xml", "--encoding=utf-8", "--fp" ],
      parser);

    if (!result.success) {
      throw result.error ?? new Error("cm status failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? Status.EmptyChanges;
  }
}

function rebase(path: string, fromRoot: string, toRoot: string): string {
  const inside = relative(fromRoot, path);
  return inside.startsWith("..") || isAbsolute(inside) ? path : join(toRoot, inside);
}
