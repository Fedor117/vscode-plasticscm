import { Disposable } from "vscode";
import { ICmParser } from "./cmParser";
import { ICmResult } from "./cmResult";

/** Per-call settings for {@link ICmShell.exec}. */
export interface ICmExecOptions {
  /**
   * Overrides `plastic-scm.cmConfiguration.millisCommandTimeout` for this call.
   * `0`, a negative value or `Infinity` means "never time out": use it for
   * commands that legitimately run for minutes, but prefer a generous bound: a
   * hung cm with no timeout blocks every later command. Values above 2^31-1 are
   * clamped to it. When a
   * command does time out, the shell is restarted, because its remaining
   * output could no longer be told apart from the next command's.
   */
  timeoutMillis?: number;
}

export interface ICmShell extends Disposable {
  readonly isRunning: boolean;
  readonly isBusy: boolean;

  start(): Promise<boolean>;
  exec<T>(
    command: string,
    args: string[],
    parser: ICmParser<T>,
    options?: ICmExecOptions): Promise<ICmResult<T>>;
  stop(): Promise<void>;
}
