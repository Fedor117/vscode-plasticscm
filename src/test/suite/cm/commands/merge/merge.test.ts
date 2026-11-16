import { ICmExecOptions, ICmParser, ICmResult, ICmShell } from "../../../../../cm/shell";
import { Merge, MERGE_FIELD_SEPARATOR } from "../../../../../cm/commands";
import { expect } from "chai";

interface ICall {
  command: string;
  args: string[];
  options?: ICmExecOptions;
}

/** A shell that prints `lines` to the parser and ends with `exitCode`, the way CmShell does. */
function shellPrinting(lines: string[], exitCode: number): { shell: ICmShell; calls: ICall[] } {
  const calls: ICall[] = [];
  const shell = {
    exec: async <T>(
      command: string, args: string[], parser: ICmParser<T>, options?: ICmExecOptions): Promise<ICmResult<T>> => {
      calls.push({ args, command, options });
      lines.forEach(line => parser.readLineOut(line));
      return exitCode === 0
        ? { result: await parser.parse(), success: true }
        : { error: new Error(lines.join("\n") || `Command '${command}' failed.`), success: false };
    },
  } as unknown as ICmShell;
  return { calls, shell };
}

async function failure(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

const SEP = `--fieldseparator=${MERGE_FIELD_SEPARATOR}`;
const line = (...fields: string[]) => fields.join(MERGE_FIELD_SEPARATOR);

describe("Merge command", () => {
  context("When previewing", () => {
    it("asks cm what the merge would do, without --merge", async () => {
      const { calls, shell } = shellPrinting([line("FILE_SRC", "/a.txt", "1", "3", "17")], 0);
      const report = await Merge.preview(shell, "/main/feature");

      expect(calls.map(call => [ call.command, call.args ])).to.eql([
        [ "merge", [ "br:/main/feature", "--machinereadable", SEP ]],
      ]);
      expect(report.incoming).to.equal(1);
    });

    it("explains the failure cm gives no words for", async () => {
      const error = await failure(() => Merge.preview(shellPrinting([], 1).shell, "/main/feature"));
      expect(error?.message).to.contain("pending changes");
    });

    it("passes on what cm said when it said something", async () => {
      const said = "The specified branch /main/nope can't be found.";
      const error = await failure(() => Merge.preview(shellPrinting([said], 1).shell, "/main/nope"));
      expect(error?.message).to.equal(said);
    });

    it("refuses a name cm would misread before calling it", async () => {
      const { calls, shell } = shellPrinting([], 0);
      expect(await failure(() => Merge.preview(shell, "feature"))).to.be.instanceOf(Error);
      expect(await failure(() => Merge.preview(shell, "/main/--merge"))).to.be.instanceOf(Error);
      expect(calls).to.have.length(0);
    });
  });

  context("When merging", () => {
    it("never lets cm open a merge tool or ask a question", async () => {
      const { calls, shell } = shellPrinting([line("DO_MERGE", "/wk/a.txt")], 0);
      const result = await Merge.run(shell, "/main/feature");

      expect(calls[0].args).to.eql([
        "br:/main/feature", "--merge", "--conflict-markers", "--nointeractiveresolution", "--machinereadable", SEP,
      ]);
      expect(calls[0].options?.timeoutMillis).to.be.greaterThan(0);
      expect(result.succeeded).to.equal(true);
      expect(result.report.applied).to.equal(1);
    });

    it("reports the files cm could not merge instead of failing", async () => {
      const { shell } = shellPrinting([
        line("FILE_CONFLICT", "/b.txt", "1", "4", "5", "18"),
        line("DO_MERGE", "/wk/b.txt"),
        line("CONFLICT_MARKERS", "/b.txt"),
      ], 1);
      const result = await Merge.run(shell, "/main/conflict");

      expect(result.succeeded).to.equal(false);
      expect(result.report.unresolved).to.eql([{ path: "/b.txt", reason: "markers" }]);
    });

    it("reports a failure that left changes behind, so they can be undone", async () => {
      const { shell } = shellPrinting([ line("DO_DELETED", "/wk/del.txt"), "Error: something broke" ], 1);
      const result = await Merge.run(shell, "/main/feature");

      expect(result.succeeded).to.equal(false);
      expect(result.report.unresolved).to.eql([]);
      expect(result.error?.message).to.contain("something broke");
    });

    it("rejects when cm failed before touching the workspace", async () => {
      const said = "Error: Object reference not set to an instance of an object.";
      const error = await failure(() => Merge.run(shellPrinting([said], 1).shell, "/main/dirconf"));
      expect(error?.message).to.equal(said);
    });
  });
});
