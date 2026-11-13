import {
  IOperationWorkspace,
  OperationOutcome,
  runWorkspaceOperation,
  WorkspaceOperation,
  WorkspaceOperations,
} from "../../workspaceOperations";
import { expect } from "chai";

class FakeWorkspace implements IOperationWorkspace {
  public readonly info = { name: "Nimbus" };
  public readonly operations = new WorkspaceOperations();
  public refreshes = 0;
  public refreshError?: Error;
  /** Whether the workspace counted as busy while the refresh ran. */
  public idleDuringRefresh?: boolean;

  public updateWorkspaceStatus(): Promise<void> {
    this.refreshes++;
    this.idleDuringRefresh = this.operations.isIdle();
    return this.refreshError ? Promise.reject(this.refreshError) : Promise.resolve();
  }
}

function fakeHost(): { lines: string[]; channel: { appendLine(line: string): void } } {
  const lines: string[] = [];
  return { channel: { appendLine: line => lines.push(line) }, lines };
}

const OPTIONS = {
  name: "Checkin",
  operation: WorkspaceOperation.Checkin,
  title: "Checking in to /main/task001",
};

describe("runWorkspaceOperation", () => {
  it("returns the action's result and refreshes the status inside the operation", async () => {
    const workspace = new FakeWorkspace();
    const outcome = await runWorkspaceOperation(fakeHost(), workspace, OPTIONS, () => Promise.resolve(42));

    expect(outcome).to.eql({ result: 42, status: "succeeded" });
    expect(workspace.refreshes).to.equal(1);
    expect(workspace.idleDuringRefresh).to.be.false;
    expect(workspace.operations.isIdle()).to.be.true;
  });

  it("marks the operation as running while the action runs", async () => {
    const workspace = new FakeWorkspace();
    let running = false;
    await runWorkspaceOperation(fakeHost(), workspace, OPTIONS, () => {
      running = workspace.operations.isRunning(WorkspaceOperation.Checkin);
      return Promise.resolve();
    });

    expect(running).to.be.true;
    expect(workspace.operations.isRunning(WorkspaceOperation.Checkin)).to.be.false;
  });

  it("reports a failure, still refreshes, and does not throw", async () => {
    const workspace = new FakeWorkspace();
    const host = fakeHost();
    const outcome: OperationOutcome<void> = await runWorkspaceOperation(
      host, workspace, OPTIONS, () => Promise.reject(new Error("Error: The branch is locked")));

    expect(outcome.status).to.equal("failed");
    expect(outcome.status === "failed" && outcome.error.message).to.equal("Error: The branch is locked");
    expect(host.lines).to.eql(["ERROR: The branch is locked"]);
    expect(workspace.refreshes).to.equal(1);
    expect(workspace.operations.isIdle()).to.be.true;
  });

  it("wraps a non-Error throw", async () => {
    const outcome = await runWorkspaceOperation(fakeHost(), new FakeWorkspace(), OPTIONS, () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error, no-throw-literal
      throw "plain text";
    });

    expect(outcome.status === "failed" && outcome.error.message).to.equal("plain text");
  });

  it("skips the refresh when asked to", async () => {
    const workspace = new FakeWorkspace();
    await runWorkspaceOperation(
      fakeHost(), workspace, { ...OPTIONS, refreshStatus: false }, () => Promise.resolve());

    expect(workspace.refreshes).to.equal(0);
  });

  it("reports a failed refresh without failing the operation", async () => {
    const workspace = new FakeWorkspace();
    workspace.refreshError = new Error("status failed");
    const host = fakeHost();
    const outcome = await runWorkspaceOperation(host, workspace, OPTIONS, () => Promise.resolve("done"));

    expect(outcome).to.eql({ result: "done", status: "succeeded" });
    expect(host.lines).to.eql(["ERROR: status failed"]);
  });

  it("refuses to start while another operation runs in the workspace", async () => {
    const workspace = new FakeWorkspace();
    const host = fakeHost();
    let ran = false;
    let inner: OperationOutcome<void> | undefined;

    await workspace.operations.run(WorkspaceOperation.Add, async () => {
      inner = await runWorkspaceOperation(host, workspace, OPTIONS, () => {
        ran = true;
        return Promise.resolve();
      });
    });

    expect(inner).to.eql({ status: "busy" });
    expect(ran).to.be.false;
    expect(workspace.refreshes).to.equal(0);
    expect(host.lines).to.have.lengthOf(1);
  });

  it("runs while only a status refresh is in progress", async () => {
    const workspace = new FakeWorkspace();
    let inner: OperationOutcome<number> | undefined;

    await workspace.operations.run(WorkspaceOperation.Status, async () => {
      inner = await runWorkspaceOperation(fakeHost(), workspace, OPTIONS, () => Promise.resolve(1));
    });

    expect(inner).to.eql({ result: 1, status: "succeeded" });
  });
});
