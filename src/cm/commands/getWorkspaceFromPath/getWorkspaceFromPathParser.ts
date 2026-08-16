import * as os from "os";
import { BaseCmParser } from "../baseCmParser";
import { CommandInfo } from "./commandInfo";
import { IWorkspaceInfo } from "../../../models";

export class GetWorkspaceFromPathParser extends BaseCmParser<IWorkspaceInfo> {
  public parse(): Promise<IWorkspaceInfo | undefined> {
    const nonEmptyLines: string[] = this.mOutputBuffer.filter(line => line.trim());
    if (nonEmptyLines.length > 1) {
      this.mParseError = new Error(this.mErrorBuffer.concat(
        "Unexpected output:", ...this.mOutputBuffer).join(os.EOL));
      return Promise.resolve(undefined);
    }

    const chunks = nonEmptyLines[0].trim().split(CommandInfo.fieldSeparator);
    if (chunks.length === CommandInfo.numFields) {
      return Promise.resolve({
        id: chunks[CommandInfo.fields.guid.index],
        name: chunks[CommandInfo.fields.wkName.index],
        path: chunks[CommandInfo.fields.wkPath.index],
      });
    }

    this.mParseError = new Error(this.mErrorBuffer.concat(
      [ "Parsing failed:", ...this.mOutputBuffer ]).join(os.EOL));
    return Promise.resolve(undefined);
  }
}
