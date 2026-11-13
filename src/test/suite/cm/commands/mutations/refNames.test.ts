import {
  assertFullBranchName,
  branchNameProblem,
  branchParentName,
  branchShortName,
  childBranchName,
  labelNameProblem,
} from "../../../../../cm/commands/refNames";
import { expect } from "chai";

describe("branch and label names", () => {
  it("accepts ordinary names", () => {
    expect(branchNameProblem("task001")).to.equal(undefined);
    expect(branchNameProblem("fix login (urgent)")).to.equal(undefined);
    expect(labelNameProblem("Rel1.1/rc2")).to.equal(undefined);
  });

  it("refuses what the shell or cm cannot carry", () => {
    for (const name of [ "", " a", "a ", "a\"b", "a\nb", "a\rb", "a@b", "-a" ]) {
      expect(branchNameProblem(name), JSON.stringify(name)).to.be.a("string");
      expect(labelNameProblem(name), JSON.stringify(name)).to.be.a("string");
    }
  });

  it("refuses a slash in a branch name segment but not in a label", () => {
    expect(branchNameProblem("a/b")).to.be.a("string");
    expect(labelNameProblem("a/b")).to.equal(undefined);
  });

  it("checks every segment of a full branch name", () => {
    expect(() => assertFullBranchName("/main/task001")).not.to.throw();
    expect(() => assertFullBranchName("/main//task001")).to.throw();
    expect(() => assertFullBranchName("main")).to.throw();
    expect(() => assertFullBranchName("/")).to.throw();
  });

  it("builds and splits full names", () => {
    expect(childBranchName("/main", "task")).to.equal("/main/task");
    expect(childBranchName("/main/", "task")).to.equal("/main/task");
    expect(branchShortName("/main/a/task")).to.equal("task");
    expect(branchParentName("/main/a/task")).to.equal("/main/a");
    expect(branchParentName("/main")).to.equal(undefined);
  });
});
