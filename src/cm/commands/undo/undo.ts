import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { UndoParser } from "./undoParser";

/**
 * `cm undo`, which unlike `cm undocheckout` accepts `-r`.
 *
 * cm's own help is explicit about this: "To undo all of the changes below a
 * directory including changes affecting the directory itself, run `cm undo
 * dirpath -r`". Without `-r`, passing a directory reverts the directory item
 * only and silently leaves everything inside it pending.
 */
export class Undo {
  public static async run(
      shell: ICmShell,
      recursive: boolean,
      ...paths: string[]): Promise<string[]> {

    const parser: ICmParser<string[]> = new UndoParser();

    const args: string[] = [...paths];
    if (recursive) {
      args.push("-r");
    }
    args.push("--machinereadable");

    const result: ICmResult<string[]> = await shell.exec("undo", args, parser);

    if (!result.success || result.error) {
      throw result.error ?? new Error("cm undo failed.");
    }

    return result.result ?? [];
  }
}
