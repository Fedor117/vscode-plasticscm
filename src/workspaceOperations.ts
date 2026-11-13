import { OutputChannel, Progress, ProgressLocation, window } from "vscode";
import { showOperationError } from "./commands/scmUtils";

export const enum WorkspaceOperation {
  Status = "Status",
  Checkin = "Checkin",
  Add = "Add",
  UndoCheckout = "UndoCheckout",
  Switch = "Switch",
  Update = "Update",
  /** Creating, renaming, deleting or re-commenting a branch or a label. */
  Reference = "Reference",
  /** Creating, applying or deleting a shelve. */
  Shelve = "Shelve",
  /** Checking files out; takes an exclusive lock when the server's lock rules match. */
  Checkout = "Checkout",
  /** Releasing or removing locks. */
  Lock = "Lock",
  /** `cm remove` and `cm move`. */
  TrackedFileChange = "TrackedFileChange",
  /** `cm revert`: loading an earlier revision of a file into the workspace. */
  Revert = "Revert",
}

/** Reports progress text inside a running operation, e.g. `{ message: "Downloading…" }`. */
export type OperationProgress = Progress<{ message?: string; increment?: number }>;

export interface IOperationProgressOptions {
  /**
   * Shown in a progress notification while the operation runs, e.g.
   * "Switching to /main/task001". Without it, progress is the Source Control
   * view's quiet spinner, as for status refreshes.
   */
  title?: string;
}

export interface IWorkspaceOperations {
  /** True when no operation other than a status refresh is running. */
  isIdle(): boolean;
  isRunning(operation: WorkspaceOperation): boolean;
  run<T>(
    operation: WorkspaceOperation,
    action: (progress: OperationProgress) => Promise<T>,
    options?: IOperationProgressOptions): Promise<T>;
}

/** A status refresh only reads, so it never makes the workspace busy for other operations. */
function isReadOnlyOperation(operation: WorkspaceOperation) {
  return operation === WorkspaceOperation.Status;
}

export class WorkspaceOperations implements IWorkspaceOperations {
  private mOperations = new Map<WorkspaceOperation, number>();

  public isRunning(operation: WorkspaceOperation): boolean {
    return this.mOperations.has(operation);
  }

  public isIdle(): boolean {
    const runningOperations = this.mOperations.keys();

    for (const op of runningOperations) {
      if (!isReadOnlyOperation(op)) {
        return false;
      }
    }

    return true;
  }

  public async run<T>(
      operation: WorkspaceOperation,
      action: (progress: OperationProgress) => Promise<T>,
      options?: IOperationProgressOptions): Promise<T> {

    this.start(operation);
    try {
      return await window.withProgress(
        options?.title
          ? { location: ProgressLocation.Notification, title: options.title }
          : { location: ProgressLocation.SourceControl },
        async (progress: OperationProgress) => {
          progress.report({});
          return await action(progress);
        },
      );
    } finally {
      // Without this, a single rejected action latches the operation as
      // running forever, which silently kills autorefresh for the session.
      this.end(operation);
    }
  }

  private start(operation: WorkspaceOperation): void {
    this.mOperations.set(operation, (this.mOperations.get(operation) || 0) + 1);
  }

  private end(operation: WorkspaceOperation): void {
    const count = (this.mOperations.get(operation) || 0) - 1;

    if (count <= 0) {
      this.mOperations.delete(operation);
      return;
    }

    this.mOperations.set(operation, count);
  }
}

/** What {@link runWorkspaceOperation} needs of a workspace; `Workspace` satisfies it. */
export interface IOperationWorkspace {
  readonly info: { readonly name: string };
  readonly operations: IWorkspaceOperations;
  updateWorkspaceStatus(): Promise<void>;
}

/** Where errors are logged; `PlasticScm` satisfies it. */
export interface IOperationHost {
  readonly channel: Pick<OutputChannel, "appendLine">;
}

export interface IRunOperationOptions {
  /** Bookkeeping key; while it runs the workspace is not idle and other runner calls are refused. */
  operation: WorkspaceOperation;
  /** Short name used in the error message: `Plastic SCM <name> failed: …`, e.g. "Switch". */
  name: string;
  /** Progress notification text, e.g. "Switching to /main/task001". */
  title: string;
  /** Refresh the workspace status afterwards, also after a failure. Default true. */
  refreshStatus?: boolean;
}

/** How {@link runWorkspaceOperation} ended. */
export type OperationOutcome<T> =
  | { readonly status: "succeeded"; readonly result: T }
  | { readonly status: "failed"; readonly error: Error }
  /** Another non-status operation was running in the workspace, so the action did not run. */
  | { readonly status: "busy" };

/**
 * The one way mutating commands run: refuses while another operation runs in
 * the workspace, shows a progress notification, runs `action`, logs and shows
 * any error with a "Show Output" button, then refreshes the workspace status
 * (which also refreshes the graph, through `Workspace.onDidRunStatus`).
 *
 * Errors are reported here and returned, never thrown, so callers only branch
 * on `status`. The error message is not awaited: a toast left open must not
 * keep the operation, or a test, waiting.
 */
export async function runWorkspaceOperation<T>(
    host: IOperationHost,
    workspace: IOperationWorkspace,
    options: IRunOperationOptions,
    action: (progress: OperationProgress) => Promise<T>): Promise<OperationOutcome<T>> {

  if (!workspace.operations.isIdle()) {
    host.channel.appendLine(
      `Skipped '${options.name}' in '${workspace.info.name}': another operation is still running.`);
    void window.showInformationMessage(
      `Plastic SCM: wait for the running operation in '${workspace.info.name}' to finish, then try again.`);
    return { status: "busy" };
  }

  return workspace.operations.run(options.operation, async progress => {
    let outcome: OperationOutcome<T>;
    try {
      outcome = { result: await action(progress), status: "succeeded" };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      void showOperationError(host, options.name, error);
      outcome = { error, status: "failed" };
    }

    if (options.refreshStatus ?? true) {
      progress.report({ message: "Refreshing status…" });
      try {
        await workspace.updateWorkspaceStatus();
      } catch (e) {
        void showOperationError(host, "Refresh", e);
      }
    }

    return outcome;
  }, { title: options.title });
}
