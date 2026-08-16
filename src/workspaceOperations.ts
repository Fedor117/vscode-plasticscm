import { Progress, ProgressLocation, window } from "vscode";

export const enum WorkspaceOperation {
  Status = "Status",
  Checkin = "Checkin",
  Add = "Add",
  UndoCheckout = "UndoCheckout",
}

export interface IWorkspaceOperations {
  isIdle(): boolean;
  isRunning(operation: WorkspaceOperation): boolean;
  run<T>(operation: WorkspaceOperation, action: () => Promise<T>): Promise<T>;
}

function isReadOnlyOperation(operation: WorkspaceOperation) {
  return operation !== WorkspaceOperation.Status;
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
      action: () => Promise<T>): Promise<T> {

    this.start(operation);
    try {
      return await window.withProgress(
        {
          location: ProgressLocation.SourceControl,
        },
        async (progress: Progress<{ message?: string; increment?: number }>) => {
          progress.report({});
          return await action();
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
