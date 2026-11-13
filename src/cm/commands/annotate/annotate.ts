import { ANNOTATE_DATE_FORMAT, ANNOTATE_SEPARATOR, AnnotateParser } from "./annotateParser";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { assertCmArgument } from "../refNames";
import { IAnnotatedLine } from "../../../models";

/** `{content}` last: it is the only field that may contain anything. */
const ANNOTATE_FORMAT =
  "--format=" + [ "{changeset}", "{line}", "{date}", "{owner}", "{content}" ].join(ANNOTATE_SEPARATOR);

/**
 * `cm annotate <path>`: for every line of the file, the changeset, owner and
 * date that last changed it. cm refuses binary files and files that are not
 * under source control; its message is thrown as is.
 */
export class Annotate {
  public static async run(shell: ICmShell, path: string): Promise<IAnnotatedLine[]> {
    assertCmArgument(path, "path");
    const parser: ICmParser<IAnnotatedLine[]> = new AnnotateParser();

    const result: ICmResult<IAnnotatedLine[]> = await shell.exec(
      "annotate", [ path, ANNOTATE_FORMAT, `--dateformat=${ANNOTATE_DATE_FORMAT}`, "--encoding=utf-8" ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm annotate failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }
}
