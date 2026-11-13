import { assertCmArgument } from "../refNames";
import { ICmShell } from "../../shell";
import { OutputChannel } from "vscode";
import { runMutation } from "../runMutation";
import { withCommentsFile } from "../commentsFile";

export interface ICreateShelveRequest {
  /** Workspace paths to shelve, as the SCM view lists them. At least one. */
  paths: string[];
  comment?: string;
}

export interface ICreateShelveResult {
  /** The N of the created `sh:N`; undefined when cm's output carried no `sh:N`. */
  shelveId?: number;
  /** Everything cm printed. */
  lines: string[];
}

/** The shelve number in `--summaryformat` output, which cm documents as printing the created spec. */
export function parseCreatedShelve(lines: readonly string[]): number | undefined {
  for (const line of lines) {
    const match = /\bsh:(\d+)/.exec(line);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return undefined;
}

/**
 * `cm shelveset create <paths> --all --summaryformat [-commentsfile=<file>]`.
 * `--all` includes items changed, moved or deleted locally rather than only
 * checked-out ones, which is how the extension's pending changes look. Success
 * is cm's exit code; the shelve number is read from the printed spec when there
 * is one.
 */
export class CreateShelve {
  public static async run(
      shell: ICmShell,
      channel: Pick<OutputChannel, "appendLine">,
      request: ICreateShelveRequest): Promise<ICreateShelveResult> {

    if (request.paths.length === 0) {
      throw new Error("There is nothing to shelve.");
    }
    request.paths.forEach(path => assertCmArgument(path, "path"));

    const lines = await withCommentsFile(request.comment, channel, commentArgs => runMutation(shell, {
      args: [ "create", ...request.paths, "--all", "--summaryformat", ...commentArgs ],
      command: "shelveset",
      name: "shelveset create",
    }));

    return { lines, shelveId: parseCreatedShelve(lines) };
  }
}
