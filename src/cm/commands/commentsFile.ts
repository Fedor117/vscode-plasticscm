import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as uuid from "uuid";
import { OutputChannel } from "vscode";

/**
 * Runs `action` with the `-commentsfile=<path>` argument for `comment`, or with
 * no argument when the comment is empty. The comment travels in a file because
 * the shell wraps arguments in double quotes without escaping, so free text
 * cannot be an argument. The file is removed afterwards, also after a failure.
 */
export async function withCommentsFile<T>(
    comment: string | undefined,
    channel: Pick<OutputChannel, "appendLine">,
    action: (commentArgs: string[]) => Promise<T>): Promise<T> {

  if (comment === undefined || comment.trim().length === 0) {
    return action([]);
  }

  return withTextFile(comment, channel, file => action([`-commentsfile=${file}`]));
}

/**
 * Runs `action` with the path of a temporary file holding `text`, for the
 * options that read free text from a file (`--descriptionfile=`, and
 * `-commentsfile=` through {@link withCommentsFile}). The file is removed
 * afterwards, also after a failure.
 */
export async function withTextFile<T>(
    text: string,
    channel: Pick<OutputChannel, "appendLine">,
    action: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), uuid.v4());
  // A text that cannot be saved must not be silently dropped: the user typed it.
  fs.writeFileSync(file, text);
  try {
    return await action(file);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      channel.appendLine(`Unable to remove comments file '${file}': ${(error as Error).message}`);
    }
  }
}
