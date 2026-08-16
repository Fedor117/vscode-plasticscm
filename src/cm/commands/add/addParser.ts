import { BaseCmParser } from "../baseCmParser";

/** Prefix given to `--errorformat`, so a failed item is recognisable without parsing prose. */
export const ADD_ERROR_PREFIX = "ERR:";

/**
 * `cm add` reports per-item outcomes, and its default text is localized — the
 * client picks the language from client.conf, so matching on "was correctly
 * added" would work only on an English install. The formats passed by `Add`
 * make both outcomes machine-readable instead.
 */
export class AddParser extends BaseCmParser<string[]> {
  public parse(): Promise<string[]> {
    const failed = this.getOutputLines()
      .filter(line => line.startsWith(ADD_ERROR_PREFIX))
      .map(line => line.substring(ADD_ERROR_PREFIX.length).trim());

    if (failed.length > 0) {
      this.mParseError = new Error(
        `cm could not add ${failed.length} item(s), starting with ${failed[0]}`);
    }

    return Promise.resolve(this.mOutputBuffer
      .filter(line => line.trim().length > 0 && !line.startsWith(ADD_ERROR_PREFIX)));
  }
}
