import { CancellationToken } from "vscode";
import { existsSync } from "fs";
import { spawn } from "child_process";

/** One run of cm: its arguments, where it runs and what it reads. */
export interface ICmRun {
  /** Passed to cm as they are, one argument each; never through a shell. */
  args: readonly string[];
  /** The directory cm runs in, which is how it finds the workspace and its repository. */
  cwd?: string;
  /** Written to cm's standard input, which is then closed; without it, stdin is closed at once. */
  stdin?: string;
  /** Milliseconds after which cm is killed; a minute by default. */
  timeout?: number;
  /** Cancelling kills cm. */
  cancel?: CancellationToken;
}

/** What cm printed, and how it ended. */
export interface ICmOutput {
  /** cm's exit code; undefined when it did not start, or was killed. */
  code: number | undefined;
  stdout: string;
  stderr: string;
  /** cm was not found where the settings say it is. */
  missing?: boolean;
  /**
   * The folder cm was to run in does not exist. The operating system says the
   * same as for a missing cm then, which would send the user to the wrong setting.
   */
  cwdMissing?: boolean;
  /**
   * cm started, so it may have done what it was asked even when `code` is
   * undefined. False when it could not be started, or the run was cancelled
   * before it was.
   */
  started: boolean;
  /** Why cm was killed, when it was. */
  killed?: "timeout" | "cancelled";
}

/**
 * Runs cm once at `cmPath` and resolves how it ended; never rejects. The
 * persistent cm shell writes every command line to the output channel and
 * cannot take text with line breaks, so whatever must stay out of the log, or
 * goes to cm on stdin, runs through this instead. Tests replace it.
 */
export type CmRunner = (cmPath: string, run: ICmRun) => Promise<ICmOutput>;

const DEFAULT_TIMEOUT = 60 * 1000;
const MAX_OUTPUT = 1024 * 1024;

/** cm as a child process of its own: no shell, UTF-8 in and out, killed at the timeout or when cancelled. */
export const spawnCm: CmRunner = (cmPath, run) => new Promise<ICmOutput>(resolve => {
  const output = { stderr: "", stdout: "" };
  if (run.cancel?.isCancellationRequested) {
    resolve({ ...output, code: undefined, killed: "cancelled", started: false });
    return;
  }
  let started = false;
  let killed: ICmOutput["killed"];
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: { dispose(): void } | undefined;
  const settle = (result: ICmOutput) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    listener?.dispose();
    resolve(result);
  };
  try {
    const child = spawn(cmPath, run.args.slice(), {
      cwd: run.cwd,
      env: process.env,
      stdio: [ "pipe", "pipe", "pipe" ],
      windowsHide: true,
    });
    const kill = (why: ICmOutput["killed"]) => {
      killed = killed ?? why;
      child.kill("SIGKILL");
    };
    const collect = (name: "stdout" | "stderr") => (chunk: string) => {
      if (output[name].length < MAX_OUTPUT) {
        output[name] += chunk;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    // Without a process id cm did not start; its `error` event says why.
    started = child.pid !== undefined;
    child.on("error", (error: Error & { code?: string }) => {
      const notFound = !started && error.code === "ENOENT";
      const cwdMissing = notFound && run.cwd !== undefined && !existsSync(run.cwd);
      settle({ ...output, code: undefined, cwdMissing, killed, missing: notFound && !cwdMissing, started });
    });
    child.on("close", code => {
      settle({ ...output, code: killed || code === null ? undefined : code, killed, started: true });
    });
    // A cm that exits without reading its input closes the pipe; that is its exit to report, not an error here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(run.stdin ?? "", "utf8");
    timer = setTimeout(() => kill("timeout"), run.timeout ?? DEFAULT_TIMEOUT);
    listener = run.cancel?.onCancellationRequested(() => kill("cancelled"));
  } catch {
    settle({ ...output, code: undefined, missing: false, started: false });
  }
});
