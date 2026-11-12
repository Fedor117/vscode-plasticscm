import { CmRunner, ICmOutput, ICmRun } from "../../../reviews/cmRunner";

/** One run the fake cm received. */
export interface IFakeCmCall {
  cmPath: string;
  args: string[];
  cwd?: string;
  stdin?: string;
}

/** What `cm codereview comment --usage` prints from 11.0.16.10512 on. */
export const COMMENT_USAGE = [
  "Allows the user to manage the comments of a code review.",
  "",
  "Usage:",
  "",
  "    cm codereview | cr comment <command> [options]",
  "",
  "Commands:",
  "",
  "    - add | mk",
  "    - reply",
  "    - edit",
  "    - delete | rm",
  "",
].join("\n");

/** What an older cm prints for the same: the usage of `cm codereview`, which has no comment commands. */
export const OLD_USAGE = "Usage:\n\n    cm codereview | cr <spec> <title> [--status=<status_name>]\n";

/** The GUID the fake cm prints for its `index`th comment or reply; made up. */
export function commentGuid(index: number): string {
  return `0c0ffee0-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function exited(code: number, stdout = "", stderr = ""): ICmOutput {
  return { code, started: true, stderr, stdout };
}

/**
 * Stands in for the one-shot cm runner: it runs nothing. It answers the
 * capability probe with `usage`, a comment or a reply with a new GUID, and any
 * other write with a clean exit; `answer` can say otherwise for a run.
 */
export class FakeCm {
  public readonly calls: IFakeCmCall[] = [];
  public usage: ICmOutput = exited(0, COMMENT_USAGE);
  public answer?: (call: IFakeCmCall, run: ICmRun) => ICmOutput | undefined | Promise<ICmOutput | undefined>;
  private posted = 0;

  public readonly run: CmRunner = async (cmPath, run) => {
    const call: IFakeCmCall = { args: run.args.slice(), cmPath, cwd: run.cwd, stdin: run.stdin };
    this.calls.push(call);
    if (isProbe(call)) {
      return this.usage;
    }
    const answer = await this.answer?.(call, run);
    if (answer) {
      return answer;
    }
    return call.args[1] === "comment" ? exited(0, `${commentGuid(++this.posted)}\n`) : exited(0);
  };

  /** Every run but the capability probes. */
  public writes(): IFakeCmCall[] {
    return this.calls.filter(call => !isProbe(call));
  }

  public probes(): IFakeCmCall[] {
    return this.calls.filter(isProbe);
  }
}

function isProbe(call: IFakeCmCall): boolean {
  return call.args.join(" ") === "codereview comment --usage";
}
