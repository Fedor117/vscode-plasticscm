import {
  ANNOTATE_DATE_FORMAT,
  AnnotateParser,
  parseAnnotateLine,
} from "../../../../../cm/commands/annotate/annotateParser";
import { Annotate } from "../../../../../cm/commands/annotate/annotate";
import { expect } from "chai";
import { IAnnotatedLine } from "../../../../../models";
import { mockShell } from "../findChangesets/shellMock";

const FORMAT = "--format={changeset}<|>{line}<|>{date}<|>{owner}<|>{content}";

/** The shape `cm annotate --format=...` prints, with invented values. */
const OUTPUT = [
  "40<|>1<|>2026-03-01T10:00:00<|>someone@example.com<|>using System;",
  "57<|>2<|>2026-03-09T16:30:00<|>admin<|>  var a = b <|> c; // the separator inside the content",
  "40<|>3<|>2026-03-01T10:00:00<|>someone@example.com<|>",
];

describe("AnnotateParser", () => {
  it("reads one record per line", async () => {
    const parser = new AnnotateParser();
    OUTPUT.forEach(line => parser.readLineOut(line));
    const lines = (await parser.parse())!;

    expect(lines).to.have.length(3);
    expect(lines[0]).to.eql({
      changesetId: 40,
      content: "using System;",
      date: new Date("2026-03-01T10:00:00"),
      line: 1,
      owner: "someone@example.com",
    });
  });

  it("keeps the separator when it appears in the content, because content is the last field", () => {
    expect(parseAnnotateLine(OUTPUT[1])?.content).to.equal("  var a = b <|> c; // the separator inside the content");
  });

  it("reads an empty line of the file", () => {
    expect(parseAnnotateLine(OUTPUT[2])?.content).to.equal("");
  });

  it("drops a trailing carriage return from the content", () => {
    expect(parseAnnotateLine("40<|>1<|>2026-03-01T10:00:00<|>admin<|>text\r")?.content).to.equal("text");
  });

  it("skips lines that are not annotations", () => {
    expect(parseAnnotateLine("Loading revisions...")).to.equal(undefined);
    expect(parseAnnotateLine("x<|>1<|>2026-03-01T10:00:00<|>admin<|>text")).to.equal(undefined);
  });

  it("uses the epoch for a date it cannot read", () => {
    expect(parseAnnotateLine("40<|>1<|>soon<|>admin<|>text")?.date.getTime()).to.equal(0);
  });
});

describe("Annotate command", () => {
  it("asks for the fixed-format output with content last", async () => {
    const result: IAnnotatedLine[] = [];
    const shell = mockShell({ result, success: true });
    await Annotate.run(shell.mock.object, "/work/Nimbus/a.cs");

    expect(shell.calls).to.eql([{
      args: [ "/work/Nimbus/a.cs", FORMAT, `--dateformat=${ANNOTATE_DATE_FORMAT}`, "--encoding=utf-8" ],
      command: "annotate",
    }]);
  });

  it("throws cm's message for a binary file", async () => {
    const error = new Error("not supported to show differences.");
    const shell = mockShell<IAnnotatedLine[]>({ error, success: false });
    let message = "";
    try {
      await Annotate.run(shell.mock.object, "/work/Nimbus/a.png");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.contain("not supported");
  });

  it("refuses a path with a quote before calling cm", async () => {
    const shell = mockShell<IAnnotatedLine[]>({ result: [], success: true });
    let failed = false;
    try {
      await Annotate.run(shell.mock.object, "/work/a\"b.cs");
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(shell.calls).to.eql([]);
  });
});
