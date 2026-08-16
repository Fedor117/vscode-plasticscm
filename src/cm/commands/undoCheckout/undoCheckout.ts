import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { UndoCheckoutParser } from "./undoCheckoutParser";

export class UndoCheckout {
  public static async run(
      shell: ICmShell,
      ...paths: string[]): Promise<string[]> {
    const parser: ICmParser<string[]> = new UndoCheckoutParser();

    const result: ICmResult<string[]> = await shell.exec(
      "undocheckout",
      [ "--all", "--machinereadable", ...paths ],
      parser);

    if (!result.success || result.error) {
      throw result.error ?? Error("Undo checkout failed - unknown error");
    }

    return result.result ?? [];
  }
}
