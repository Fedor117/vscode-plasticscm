import { BaseCmParser } from "../baseCmParser";

export class UndoParser extends BaseCmParser<string[]> {
  public parse(): Promise<string[]> {
    return Promise.resolve(this.mOutputBuffer.filter(line => line.trim().length > 0));
  }
}
