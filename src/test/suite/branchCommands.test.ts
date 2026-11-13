import { branchFromNode, labelFromNode } from "../../commands/targets";
import { IBranchInfo, IHistoryChangeset, ILabelInfo } from "../../models";
import { mockShell, mockShellAnswering } from "./cm/commands/findChangesets/shellMock";
import { expect } from "chai";
import { resolveBranchStart } from "../../commands/branch";

function changeset(id: number, branch: string): IHistoryChangeset {
  return {
    branch,
    comment: "",
    date: new Date("2026-04-14T09:30:00+00:00"),
    guid: "c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
    id,
    owner: "someone@example.com",
    parentId: id - 1,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

const BRANCH: IBranchInfo = {
  comment: "",
  date: new Date("2026-04-14T09:30:00+00:00"),
  guid: "b2a4c6d8-0e1f-4a3b-8c5d-6e7f8a9b0c1d",
  headChangesetId: 90,
  name: "/main/task001",
  owner: "someone@example.com",
  parent: "/main",
  repository: "Nimbus/Nimbus",
  server: "acme-studio@unity",
};

const LABEL: ILabelInfo = {
  branch: "/main",
  changesetId: 41,
  comment: "",
  date: new Date("2026-04-14T09:30:00+00:00"),
  id: 7,
  name: "v1.0",
  owner: "someone@example.com",
  repository: "Nimbus/Nimbus",
  server: "acme-studio@unity",
};

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("resolveBranchStart", () => {
  it("starts from the head of a branch without a start changeset", async () => {
    const shell = mockShell({ result: [], success: true });
    const start = await resolveBranchStart(
      shell.mock.object, { currentChangeset: 5 }, { branch: BRANCH, kind: "branch" });

    expect(start).to.eql({ description: "the latest changeset of /main/task001", parent: "/main/task001" });
    expect(shell.calls).to.eql([]);
  });

  it("starts from a chosen changeset, under that changeset's branch", async () => {
    const shell = mockShell({ result: [], success: true });
    const start = await resolveBranchStart(
      shell.mock.object, { currentChangeset: 5 }, { changeset: changeset(42, "/main/task001"), kind: "changeset" });

    expect(start).to.eql({ description: "cs:42", fromChangeset: 42, parent: "/main/task001" });
    expect(shell.calls).to.eql([]);
  });

  it("starts from a label, under the branch of the label's changeset", async () => {
    const shell = mockShellAnswering(() => ({ result: [changeset(41, "/main/release")], success: true }));
    const start = await resolveBranchStart(shell.mock.object, { currentChangeset: 5 }, { kind: "label", label: LABEL });

    expect(start).to.eql({ description: "label v1.0", fromLabel: "v1.0", parent: "/main/release" });
    expect(shell.calls.map(call => call.args[1])).to.eql(["where changesetid=41 and ignorehidden = 'true'"]);
  });

  it("starts from the workspace's changeset, under that changeset's branch", async () => {
    const shell = mockShellAnswering(() => ({ result: [changeset(5, "/main/task001")], success: true }));
    const start = await resolveBranchStart(shell.mock.object, { currentChangeset: 5 }, { kind: "current" });

    expect(start).to.eql({ description: "cs:5", fromChangeset: 5, parent: "/main/task001" });
  });

  it("does not guess when the workspace's changeset is not known yet", async () => {
    const shell = mockShell({ result: [], success: true });
    const error = await runCatching(
      () => resolveBranchStart(shell.mock.object, { currentChangeset: -1 }, { kind: "current" }));

    expect(error?.message).to.contain("not known yet");
    expect(shell.calls).to.eql([]);
  });

  it("fails clearly when the changeset cannot be found", async () => {
    const shell = mockShell({ result: [], success: true });
    const error = await runCatching(
      () => resolveBranchStart(shell.mock.object, { currentChangeset: 9 }, { kind: "current" }));

    expect(error?.message).to.equal("Changeset cs:9 was not found.");
  });
});

describe("Repository row arguments", () => {
  function node(sectionId: string, item: unknown) {
    return { item, kind: "item", parent: { section: { id: sectionId }}};
  }

  it("reads a branch from a branch row only", () => {
    expect(branchFromNode(node("branches", BRANCH))).to.equal(BRANCH);
    expect(branchFromNode(node("labels", LABEL))).to.equal(undefined);
  });

  it("reads a label from a label row only", () => {
    expect(labelFromNode(node("labels", LABEL))).to.equal(LABEL);
    expect(labelFromNode(node("branches", BRANCH))).to.equal(undefined);
  });

  it("ignores anything else a command can be invoked with", () => {
    for (const arg of [ undefined, null, "x", 5, {}, { kind: "section" }, { kind: "item" }]) {
      expect(branchFromNode(arg)).to.equal(undefined);
      expect(labelFromNode(arg)).to.equal(undefined);
    }
  });
});
