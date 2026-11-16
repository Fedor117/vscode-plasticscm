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
const FILES = { resultFile: "/tmp/m/result", solvedFile: "/tmp/m/solved" };
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

    it("takes one side for the files cm cannot merge as text, and uses the directory answers", async () => {
      const { calls, shell } = shellPrinting([], 0);
      await Merge.run(shell, "/main/x", { keep: "source", resolutions: FILES });
      await Merge.run(shell, "/main/x", { keep: "destination" });

      expect(calls[0].args).to.eql([
        "br:/main/x", "--merge", "--conflict-markers", "--nointeractiveresolution", "--keepsource",
        "--mergeresultfile=/tmp/m/result", "--solvedconflictsfile=/tmp/m/solved", "--machinereadable", SEP,
      ]);
      expect(calls[1].args).to.include("--keepdestination").and.not.include("--keepsource");
    });

    it("rejects when cm failed before touching the workspace", async () => {
      const said = "Error: Object reference not set to an instance of an object.";
      const error = await failure(() => Merge.run(shellPrinting([said], 1).shell, "/main/dirconf"));
      expect(error?.message).to.equal(said);
    });
  });

  context("When answering a directory conflict", () => {
    const twinLine = line(
      "DIR_CONFLICT", "EVIL", "Evil twin conflict", "explanation", "Added /tw1.txt", "Added /tw1.txt", "87", "False");

    it("records the answer in cm's files and returns the conflicts still open", async () => {
      const { calls, shell } = shellPrinting([twinLine], 0);
      const report = await Merge.resolveDirectoryConflict(shell, "/main/x", 1, { keep: "source" }, FILES);

      expect(calls[0].args).to.eql([
        "br:/main/x", "--resolveconflict", "--conflict=1", "--resolutionoption=src",
        "--mergeresultfile=/tmp/m/result", "--solvedconflictsfile=/tmp/m/solved", "--machinereadable", SEP,
      ]);
      expect(report.directoryConflicts.map(conflict => conflict.source)).to.eql(["Added /tw1.txt"]);
    });

    it("keeps the destination, or both under a new name", async () => {
      const { calls, shell } = shellPrinting([], 0);
      await Merge.resolveDirectoryConflict(shell, "/main/x", 2, { keep: "destination" }, FILES);
      await Merge.resolveDirectoryConflict(shell, "/main/x", 1, { keep: "both", name: "tw2 main.txt" }, FILES);

      expect(calls[0].args.slice(1, 4)).to.eql([ "--resolveconflict", "--conflict=2", "--resolutionoption=dst" ]);
      expect(calls[1].args.slice(1, 5)).to.eql([
        "--resolveconflict", "--conflict=1", "--resolutionoption=rename", "--resolutioninfo=tw2 main.txt",
      ]);
    });

    it("refuses an index or a name cm would misread, without calling it", async () => {
      const { calls, shell } = shellPrinting([], 0);
      for (const index of [ 0, -1, 1.5 ]) {
        expect(await failure(() => Merge.resolveDirectoryConflict(shell, "/main/x", index, { keep: "source" }, FILES)))
          .to.be.instanceOf(Error);
      }
      for (const name of [ "", "a/b", "a\"b", "-x" ]) {
        expect(await failure(
          () => Merge.resolveDirectoryConflict(shell, "/main/x", 1, { keep: "both", name }, FILES)), name)
          .to.be.instanceOf(Error);
      }
      expect(calls).to.have.length(0);
    });

    it("passes on cm's refusal", async () => {
      const error = await failure(() => Merge.resolveDirectoryConflict(
        shellPrinting(["'rename' is not a valid resolution."], 1).shell, "/main/x", 1, { keep: "source" }, FILES));
      expect(error?.message).to.equal("'rename' is not a valid resolution.");
    });
  });

  context("When listing and clearing conflict markers", () => {
    it("lists the files cm names although it exits 1 for them", async () => {
      const { calls, shell } = shellPrinting(["CONFLICT_MARKERS /b.txt"], 1);
      expect(await Merge.conflictMarkers(shell)).to.eql(["/b.txt"]);
      expect(calls[0]).to.include({ command: "merge" });
      expect(calls[0].args).to.eql(["--list-conflict-markers"]);
    });

    it("lists nothing when no file has markers, and fails when cm fails otherwise", async () => {
      expect(await Merge.conflictMarkers(shellPrinting([], 0).shell)).to.eql([]);
      expect(await failure(() => Merge.conflictMarkers(shellPrinting(["Error: no workspace"], 1).shell)))
        .to.be.instanceOf(Error);
    });

    it("marks paths as resolved", async () => {
      const { calls, shell } = shellPrinting([], 0);
      await Merge.markResolved(shell, ["/wk/b.txt"]);
      expect(calls[0].args).to.eql([ "--mark-resolved", "/wk/b.txt" ]);
    });
  });
});
