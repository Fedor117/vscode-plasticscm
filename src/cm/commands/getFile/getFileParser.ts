import { BaseCmParser } from "../baseCmParser";

export class GetFileParser extends BaseCmParser<void> {
  public async parse(): Promise<void> {
    // getfile writes to --file=, so there is no stdout payload to read.
  }
}
