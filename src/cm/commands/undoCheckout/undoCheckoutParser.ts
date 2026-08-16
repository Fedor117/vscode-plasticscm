import { BaseCmParser } from "../baseCmParser";

export class UndoCheckoutParser extends BaseCmParser<string[]> {
  public parse(): Promise<string[]> {
    const result = this.mOutputBuffer.filter(line => line.trim().length > 0);
    return Promise.resolve(result);
  }
}
