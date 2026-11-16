import { branchFromNode, explorerChangesetFromArg, guarded, resolveWorkspace } from "./targets";
import { commands, Disposable, window } from "vscode";
import { IMergeReport, IMergeResult, Merge, Undo } from "../cm/commands";
import { IWorkspaceConfig, WkConfigType } from "../models";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { countPendingChanges } from "./pendingChanges";
import { pickBranch } from "../repository/pickers";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";

export const MERGE_COMMANDS = {
  fromBranch: "plastic-scm.merge.fromBranch",
};

const MAX_LISTED = 10;
const USE_GUI = "Do this merge in the Plastic SCM GUI, which can resolve it.";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function listed(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_LISTED);
  if (lines.length > shown.length) {
    shown.push(`… and ${lines.length - shown.length} more`);
  }
  return shown.join("\n");
}

/** What the command needs to know about the workspace before it asks cm anything. */
export interface IMergeWorkspaceState {
  readonly name: string;
  readonly config: IWorkspaceConfig | undefined;
  /** Pending changes that are not private files. */
  readonly pendingChanges: number;
  /** The branch has changesets newer than the one the workspace is on. */
  readonly hasIncomingChanges: boolean;
}

/**
 * Why `source` cannot be merged into the workspace as it is, or undefined when it can.
 *
 * The merge needs a workspace without pending changes: cm refuses otherwise
 * (unless `MergeWithPendingChanges` is set in client.conf), and it is what
 * lets a merge that met conflicts be undone without touching anyone's work.
 */
export function mergeObstacle(source: string, state: IMergeWorkspaceState): string | undefined {
  if (state.config?.configType !== WkConfigType.Branch) {
    return `'${state.name}' is not on a branch. Switch it to the branch that should receive the merge first.`;
  }
  if (state.config.location === source) {
    return `'${state.name}' is on ${source}. Switch to the branch that should receive the merge first.`;
  }
  if (state.pendingChanges > 0) {
    return `'${state.name}' has ${plural(state.pendingChanges, "pending change")}. ` +
      "Check them in, shelve them or undo them, then merge again.";
  }
  if (state.hasIncomingChanges) {
    return `'${state.name}' is not on the latest changeset of ${state.config.location}. ` +
      "Update the workspace, then merge again.";
  }
  return undefined;
}

/** What to do with a preview. */
export type MergePlan =
  | { readonly kind: "nothing"; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string; readonly detail: string }
  | { readonly kind: "merge"; readonly message: string; readonly detail: string };

export function planMerge(source: string, destination: string, preview: IMergeReport): MergePlan {
  if (preview.directoryConflicts.length > 0) {
    return {
      detail: listed(preview.directoryConflicts.map(
        conflict => `${conflict.title}: ${conflict.source} on ${source}, ${conflict.destination} on ${destination}`)) +
        `\n\nNothing was changed. ${USE_GUI}`,
      kind: "blocked",
      message: `Merging ${source} into ${destination} has ` +
        `${plural(preview.directoryConflicts.length, "directory conflict")}.`,
    };
  }

  const changes = preview.incoming + preview.changedOnBoth.length + preview.other.length;
  if (changes === 0) {
    return {
      kind: "nothing",
      message: `There is nothing to merge from ${source} into ${destination}` +
        (preview.nothingToMerge ? ` (cm: ${preview.nothingToMerge}).` : "."),
    };
  }

  const both = preview.changedOnBoth.length === 0
    ? ""
    : ` ${plural(preview.changedOnBoth.length, "file")} changed on both branches: ` +
      "if their changes overlap, the merge is undone and you are told which files conflict.";
  return {
    detail: `${plural(changes, "item")} to merge.${both}\n\n` +
      "The result is left as pending changes with the merge link. Review it and check it in from Source Control.",
    kind: "merge",
    message: `Merge ${source} into ${destination}?`,
  };
}

/** How the merge itself ended. */
export type MergeOutcome =
  | { readonly kind: "merged"; readonly message: string }
  | { readonly kind: "conflicts"; readonly message: string; readonly files: string };

export function describeMergeResult(source: string, destination: string, result: IMergeResult): MergeOutcome {
  if (result.succeeded) {
    return {
      kind: "merged",
      message: `Merged ${source} into ${destination}. Review the pending changes and check them in.`,
    };
  }

  const files = result.report.unresolved.map(
    file => file.reason === "markers" ? file.path : `${file.path} (${file.reason})`);
  return {
    files: files.length > 0 ? listed(files) : result.error?.message ?? "cm did not say which files.",
    kind: "conflicts",
    message: `${source} cannot be merged into ${destination} automatically: ` +
      (files.length > 0 ? `${plural(files.length, "file")} conflict${files.length === 1 ? "s" : ""}.` : "cm stopped."),
  };
}

/** "Merge from Branch…": merges a branch into the branch the workspace is on, as pending changes. */
export class MergeCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposables: Disposable[];

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposables = [
      commands.registerCommand(MERGE_COMMANDS.fromBranch, (...args: unknown[]) => this.mergeFromBranch(args)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async mergeFromBranch(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace should receive the merge?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Merge", async () => {
      const source = branchFromNode(args[0])?.name
        ?? explorerChangesetFromArg(args[0])?.branch
        ?? (await pickBranch(workspace.shell, {
          title: "Merge from Branch",
          workspaceConfig: workspace.workspaceConfig,
        }))?.name;
      if (source) {
        await this.merge(workspace, source);
      }
    });
  }

  private async merge(workspace: Workspace, source: string): Promise<void> {
    if (!workspace.operations.isIdle()) {
      void window.showInformationMessage(
        `Plastic SCM: wait for the running operation in '${workspace.info.name}' to finish, then try again.`);
      return;
    }

    // The obstacles are judged on a fresh status: the undo after a conflict relies on a clean workspace.
    await workspace.updateWorkspaceStatus();
    const obstacle = mergeObstacle(source, {
      config: workspace.workspaceConfig,
      hasIncomingChanges: workspace.hasIncomingChanges,
      name: workspace.info.name,
      pendingChanges: countPendingChanges(workspace.pendingChanges),
    });
    if (obstacle) {
      void window.showWarningMessage(obstacle);
      return;
    }
    const destination = workspace.workspaceConfig?.location ?? "";

    const plan = planMerge(source, destination, await Merge.preview(workspace.shell, source));
    if (plan.kind === "nothing") {
      void window.showInformationMessage(plan.message);
      return;
    }
    if (plan.kind === "blocked") {
      void window.showWarningMessage(plan.message, { detail: plan.detail, modal: true });
      return;
    }

    const merge = "Merge";
    if (await window.showInformationMessage(plan.message, { detail: plan.detail, modal: true }, merge) !== merge) {
      return;
    }

    const outcome = await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      { name: "Merge", operation: WorkspaceOperation.Merge, title: `Merging ${source} into ${destination}` },
      async progress => {
        const result = await Merge.run(workspace.shell, source);
        if (!result.succeeded) {
          progress.report({ message: "Conflicts found, undoing the merge…" });
          try {
            await Undo.run(workspace.shell, true, workspace.info.path);
          } catch (e) {
            throw new Error(
              `Merging ${source} met conflicts and undoing it failed, so the workspace holds a partial merge. ` +
              `Undo its pending changes before anything else. ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return describeMergeResult(source, destination, result);
      });
    if (outcome.status !== "succeeded") {
      return;
    }

    if (outcome.result.kind === "merged") {
      this.mPlasticScm.channel.appendLine(`Merged br:${source} into '${workspace.info.name}'`);
      void window.showInformationMessage(outcome.result.message);
      void commands.executeCommand("workbench.view.scm");
    } else {
      void window.showWarningMessage(
        outcome.result.message,
        {
          detail: `${outcome.result.files}\n\nThe merge was undone, so the workspace is as it was. ${USE_GUI}`,
          modal: true,
        });
    }
  }
}
