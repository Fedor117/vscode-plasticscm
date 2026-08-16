import * as os from "os";
import { ICmParser } from "../shell";

/**
 * Base parser with shared buffering and error logic.
 * Subclasses only need to implement `parse()`.
 */
export abstract class BaseCmParser<T> implements ICmParser<T> {
  protected readonly mOutputBuffer: string[] = [];
  protected readonly mErrorBuffer: string[] = [];

  public readLineOut(line: string): void {
    this.mOutputBuffer.push(line);
  }

  public readLineErr(line: string): void {
    this.mErrorBuffer.push(line);
  }

  public abstract parse(): Promise<T | undefined>;

  public getError(): Error | undefined {
    return this.mErrorBuffer.length !== 0
      ? new Error(this.mErrorBuffer.join(os.EOL))
      : undefined;
  }

  public getOutputLines(): string[] {
    return this.mOutputBuffer.concat(this.mErrorBuffer);
  }
}
