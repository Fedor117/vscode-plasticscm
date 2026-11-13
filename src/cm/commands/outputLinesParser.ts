import { BaseCmParser } from "./baseCmParser";

/**
 * For commands whose output is only reported, never read: it returns every
 * non-blank line cm printed, standard output first. Whether the command worked
 * is decided from the shell's result (cm's exit code), not from these lines.
 */
export class OutputLinesParser extends BaseCmParser<string[]> {
  public parse(): Promise<string[]> {
    return Promise.resolve(this.getOutputLines().filter(line => line.trim().length > 0));
  }
}
