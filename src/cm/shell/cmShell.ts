import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as uuid from "uuid";
import { ChildProcess, spawn } from "child_process";
import { Disposable, OutputChannel } from "vscode";
import { ICmParser, ICmResult, ICmShell } from "./interfaces";
import { IShellConfig } from "../../config";
import { LineStream } from "./lineStream";
import { Readable } from "stream";

const UTF8 = "utf8";
const COMMAND_RESULT_TOKEN = "CommandResult ";

/** Keeps a runaway command's output from being pasted wholesale into a message box. */
const MAX_ERROR_LINES = 50;

export class CmShell implements ICmShell {

  public get isBusy(): boolean {
    return this.mbIsBusy;
  }

  public get isRunning(): boolean {
    return this.mbIsRunning;
  }

  private readonly mStartDir: string;
  private readonly mChannel: OutputChannel;
  private mProcess?: ChildProcess;
  private mbIsRunning = false;
  private readonly mOutStream: LineStream;
  private readonly mErrStream: LineStream;
  private mbIsBusy = true;
  private mDisposables: Disposable;
  private mShellConfig: IShellConfig;

  /**
   * `cm shell` multiplexes every command over a single stdin/stdout pair, so only
   * one command can be in flight at a time. Callers are serialized here instead of
   * being rejected, which is what lets unrelated features share one shell.
   */
  private mQueue: Promise<unknown> = Promise.resolve();

  private mReadOut?: (chunk: any) => void;
  private mReadErr?: (chunk: any) => void;

  public constructor(
      startDir: string,
      channel: OutputChannel,
      config: IShellConfig) {
    this.mStartDir = startDir;
    this.mChannel = channel;
    this.mOutStream = new LineStream(UTF8);
    this.mErrStream = new LineStream(UTF8);
    this.mShellConfig = config;
    this.mDisposables = Disposable.from(
      this.mOutStream,
      this.mErrStream,
    );
  }

  public dispose(): void {
    this.mDisposables.dispose();
    // `isRunning` only says the start handshake completed: a shell that timed out
    // waiting for it still has a spawned cm process, and killing an already
    // exited one is a no-op.
    this.mProcess?.kill();
  }

  public async start(): Promise<boolean> {
    const commFile = path.join(os.tmpdir(), uuid.v4());
    await new Promise<void>(resolve => {
      fs.writeFile(commFile, "", () => resolve());
    });

    this.mProcess = spawn(
      this.mShellConfig.cmPath,
      [
        "shell", "--encoding=UTF-8", `--commfile=${commFile}`, this.mStartDir,
      ],
      {
        cwd: this.mStartDir,
        env: process.env,
        stdio: [ "pipe", "pipe", "pipe" ],
      });

    const logError = (err: Error) => this.mChannel.appendLine(`ERROR: ${err.message}`);
    this.mProcess.on("error", logError);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.mReadOut = chunk => this.mOutStream.write(chunk);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.mReadErr = chunk => this.mErrStream.write(chunk);
    CmShell.bindProcessStream(this.mProcess.stdout, this.mReadOut);
    CmShell.bindProcessStream(this.mProcess.stderr, this.mReadErr);

    if (!await this.waitUntilFileDeleted(commFile, this.mShellConfig.millisToWaitUntilUp)) {
      this.unbindProcessStreams();
      this.mChannel.appendLine(
        `Cm shell didn't respond after ${this.mShellConfig.millisToWaitUntilUp / 1000} seconds. `
         + 'Consider adjusting "plastic-scm.cmConfiguration.millisToWaitUntilUp" setting.');

      if (fs.existsSync(commFile)) {
        await new Promise<void>(resolve => fs.unlink(commFile, () => resolve()));
      }
      return false;
    }
    this.mbIsRunning = true;
    await this.runInfoCommand("version");
    await this.runInfoCommand("location");
    this.mbIsBusy = false;
    return true;
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Give whatever is already queued a bounded chance to finish, so we don't
    // abort a checkin halfway through.
    await Promise.race([
      this.mQueue.then(() => undefined, () => undefined),
      CmShell.delay(this.mShellConfig.millisToStop),
    ]);

    this.mbIsBusy = true;
    this.mbIsRunning = false;
    this.write("exit");
    this.mProcess?.stdin?.end();
    await this.waitForExit(500);
    this.unbindProcessStreams();
  }

  public exec<T>(
      command: string,
      args: string[],
      parser: ICmParser<T>): Promise<ICmResult<T>> {

    const runner = () => this.execSerialized(command, args, parser);
    // Run after whatever is queued, whether it succeeded or not.
    const queued = this.mQueue.then(runner, runner);
    this.mQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async execSerialized<T>(
      command: string,
      args: string[],
      parser: ICmParser<T>): Promise<ICmResult<T>> {

    if (!this.isRunning) {
      this.mChannel.appendLine(
        `Warning: unable to run command '${command}' because the shell isn't running!`);
      return {
        // Naming the command matters: this error is what the user sees in the toast.
        error: new Error(`Unable to run command '${command}' because the shell isn't running`),
        success: false,
      };
    }

    const commandLine = CmShell.buildCommandLine(command, ...args);
    const result: ICmResult<T> = { success: false };

    const parserErrorRead: (line: string) => void = line => parser.readLineErr(line);
    let parserOutRead: ((line: string) => void) | undefined;
    let timeout: NodeJS.Timeout | undefined;

    this.mbIsBusy = true;
    try {
      await new Promise<void>((resolve, reject) => {
        parserOutRead = line => {
          if (!line.startsWith(COMMAND_RESULT_TOKEN)) {
            parser.readLineOut(line);
            return;
          }

          result.success = parseInt(line.substring(COMMAND_RESULT_TOKEN.length), 10) === 0;
          resolve();
        };

        this.mOutStream.on("data", parserOutRead);
        this.mErrStream.on("data", parserErrorRead);

        timeout = setTimeout(
          () => reject(new Error(
            `Command '${command}' timed out after ${this.mShellConfig.millisCommandTimeout} ms`)),
          this.mShellConfig.millisCommandTimeout);

        this.write(commandLine);
      });
    } catch (error) {
      // We never saw the terminating CommandResult, so we can no longer tell which
      // output belongs to which command. The shell has to go.
      this.mChannel.appendLine(`ERROR: ${(error as Error).message}`);
      await this.restart();
      return {
        error: error as Error,
        success: false,
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (parserOutRead) {
        this.mOutStream.off("data", parserOutRead);
      }
      this.mErrStream.off("data", parserErrorRead);
      this.mbIsBusy = false;
    }

    if (result.success) {
      result.result = await parser.parse();
      result.error = parser.getError();
      return result;
    }

    result.error = new Error(CmShell.buildFailureMessage(command, parser));
    return result;
  }

  /**
   * cm reports failures on stdout as often as on stderr, so both are folded into
   * the message. Truncated because `cm help` output is hundreds of lines.
   */
  private static buildFailureMessage<T>(command: string, parser: ICmParser<T>): string {
    const lines = parser.getOutputLines().filter(line => line.trim().length > 0);

    if (lines.length === 0) {
      return `Command '${command}' failed.`;
    }

    const shown = lines.slice(0, MAX_ERROR_LINES);
    if (lines.length > shown.length) {
      shown.push(`... (${lines.length - shown.length} more lines, see the Plastic SCM output channel)`);
    }
    return shown.join(os.EOL);
  }

  private async restart(): Promise<void> {
    // A command still in flight when stop() ran can never see its CommandResult,
    // because stop() unbinds the streams. Its timeout fires minutes later and
    // lands here — without this guard that spawns a fresh cm process for an
    // extension that is already disabled and disposed.
    if (!this.mbIsRunning) {
      return;
    }

    this.mChannel.appendLine("Restarting the cm shell...");

    this.mbIsRunning = false;
    this.unbindProcessStreams();
    try {
      this.mProcess?.kill();
    } catch (error) {
      this.mChannel.appendLine(`Error killing the process: ${(error as Error).message}`);
    }
    await this.waitForExit(500);

    if (!await this.start()) {
      this.mChannel.appendLine("Unable to restart the cm shell.");
    }
  }

  private waitForExit(timeoutMillis: number): Promise<void> {
    const proc = this.mProcess;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>(resolve => {
      const onExit = () => {
        clearTimeout(timeout);
        resolve();
      };

      const timeout = setTimeout(() => {
        proc.off("exit", onExit);
        this.mChannel.appendLine(
          `Shell was alive after ${timeoutMillis}ms, killing it manually`);
        try {
          proc.kill();
        } catch (error) {
          this.mChannel.appendLine(`Error killing the process: ${(error as Error).message}`);
        }
        resolve();
      }, timeoutMillis);

      proc.once("exit", onExit);
    });
  }

  private static bindProcessStream(stream: Readable | null, handler: (chunk: any) => void): void {
    if (stream) {
      stream.on("data", handler);
    }
  }

  private unbindProcessStreams(): void {
    if (this.mReadOut) {
      this.mProcess?.stdout?.off("data", this.mReadOut);
      this.mReadOut = undefined;
    }
    if (this.mReadErr) {
      this.mProcess?.stderr?.off("data", this.mReadErr);
      this.mReadErr = undefined;
    }
  }

  private static buildCommandLine(command: string, ...args: string[]) {
    if (!args || args.length === 0) {
      return command;
    }
    return `${command} ${args.map(arg => `"${arg}"`).join(" ")}`;
  }

  private write(commandLine: string) {
    try {
      this.mChannel.appendLine(`${this.mStartDir}> ${commandLine}`);
      this.mProcess?.stdin?.write(commandLine + os.EOL);
    } catch (e) {
      // While the shell is up a caller is waiting on this command, and a write
      // that never happened would leave it waiting for the command timeout.
      if (this.mbIsRunning) {
        throw e;
      }

      // `stop()` clears that flag before writing `exit`, and it runs at extension
      // teardown where the output channel may already be gone: its `appendLine`
      // then throws "Channel has been closed". There is nowhere left to report
      // that to, and nothing left to tell the shell.
    }
  }

  private async waitUntilFileDeleted(filePath: string, timeout: number): Promise<boolean> {
    const intervalTime = 50;
    let waitTime = 0;

    while (waitTime < timeout) {
      if (!fs.existsSync(filePath)) {
        return true;
      }

      await CmShell.delay(intervalTime);
      waitTime += intervalTime;
    }
    return false;
  }

  private static delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private async runInfoCommand(command: string): Promise<void> {
    const listenResult: Promise<void> = new Promise<void>(resolve => {
      const parserOutRead: (line: string) => void = line => {
        this.mChannel.appendLine(line);
        if (!line.startsWith(COMMAND_RESULT_TOKEN)) {
          return;
        }
        this.mOutStream.off("data", parserOutRead);
        resolve();
      };

      this.mOutStream.on("data", parserOutRead);
    });

    this.mProcess?.stdin?.write(command + os.EOL);
    try {
      await listenResult;
    } catch (error) {
      this.mChannel.appendLine(`ERROR: ${(error as Error).message}`);
    }
  }
}
