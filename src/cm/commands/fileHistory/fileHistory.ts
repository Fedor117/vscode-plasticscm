import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { assertCmArgument } from "../refNames";
import { FileHistoryParser } from "./fileHistoryParser";
import { IFileRevision } from "../../../models";

/**
 * `cm history <path> --xml --encoding=utf-8 --moveddeleted`: the revisions of
 * one file or directory, newest first, including the changesets that moved or
 * removed it.
 */
export class FileHistory {
  public static async run(shell: ICmShell, path: string): Promise<IFileRevision[]> {
    assertCmArgument(path, "path");
    const parser: ICmParser<IFileRevision[]> = new FileHistoryParser();

    const result: ICmResult<IFileRevision[]> = await shell.exec(
      "history", [ path, "--xml", "--encoding=utf-8", "--moveddeleted" ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm history failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }
}
