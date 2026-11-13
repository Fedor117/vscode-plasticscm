import { expect } from "chai";
import { ReviewerListParser } from "../../../../../cm/commands";

/**
 * `cm codereview reviewer list --xml`, in the format cm's help documents: a
 * `Reviewers` root, a `Reviewer` per row with `User`, `Status` and `Type`.
 * Every name is made up.
 */

async function parse(lines: string[], errors: string[] = []) {
  const parser = new ReviewerListParser();
  lines.forEach(line => parser.readLineOut(line));
  errors.forEach(line => parser.readLineErr(line));
  const result = await parser.parse();
  return { error: parser.getError(), result };
}

describe("ReviewerListParser", () => {
  it("reads users and groups with the status each gave", async () => {
    const { error, result } = await parse([
      "﻿<?xml version=\"1.0\" encoding=\"utf-8\"?>",
      "<Reviewers>",
      "  <Reviewer>",
      "    <User>priya.nair@example.com</User>",
      "    <Status>Reviewed</Status>",
      "    <Type>user</Type>",
      "  </Reviewer>",
      "  <Reviewer>",
      "    <User>Developers</User>",
      "    <Status>Under review</Status>",
      "    <Type>group</Type>",
      "  </Reviewer>",
      "  <Reviewer>",
      "    <User>sam.rivera@example.com</User>",
      "    <Status>Rework required</Status>",
      "    <Type>user</Type>",
      "  </Reviewer>",
      "</Reviewers>",
    ]);
    expect(error).to.equal(undefined);
    expect(result).to.eql([
      { name: "priya.nair@example.com", status: "Reviewed", type: "user" },
      { name: "Developers", status: "Under review", type: "group" },
      { name: "sam.rivera@example.com", status: "Rework required", type: "user" },
    ]);
  });

  it("reads a review without reviewers as an empty list", async () => {
    expect((await parse([ "<?xml version=\"1.0\" encoding=\"utf-8\"?>", "<Reviewers />" ])).result).to.eql([]);
    expect((await parse(["<Reviewers></Reviewers>"])).result).to.eql([]);
  });

  it("matches tag names without case and escapes nothing twice", async () => {
    const { result } = await parse([
      "<REVIEWERS><REVIEWER><USER>dana &amp; co</USER><STATUS>Reviewed</STATUS>",
      "<TYPE>User</TYPE></REVIEWER></REVIEWERS>",
    ]);
    expect(result).to.eql([{ name: "dana & co", status: "Reviewed", type: "user" }]);
  });

  it("fails on output that is not a reviewer list, rather than reading it as no reviewers", async () => {
    const { error, result } = await parse(["The code review 99 does not exist."]);
    expect(result).to.equal(undefined);
    expect(error?.message).to.equal("cm did not print a list of reviewers.");
    const truncated = await parse([ "<Reviewers>", "  <Reviewer>", "    <User>someone@" ]);
    expect(truncated.result).to.equal(undefined);
    expect(truncated.error).to.be.instanceOf(Error);
  });
});
