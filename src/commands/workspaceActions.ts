import { confirmPendingChanges, runPendingChangesFollowUp } from "./pendingChanges";
import { IOperationHost, OperationOutcome, runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { switchSpec, SwitchTarget, SwitchWorkspace, UpdateWorkspace } from "../cm/commands";
import { window } from "vscode";
import { WkConfigType } from "../models";
import { Workspace } from "../workspace";

/** Human wording of a target for dialogs and progress titles: `branch /main/x`, `changeset cs:42`, `label v1`. */
export function describeTarget(target: SwitchTarget): string {
  switch (target.kind) {
  case "branch":
    return `branch ${target.name}`;
  case "changeset":
    return `changeset cs:${target.id}`;
  case "label":
    return `label ${target.name}`;
  }
}

export interface ISwitchOptions {
  /** The caller already asked about pending changes (e.g. before creating the branch it switches to). */
  pendingChangesConfirmed?: boolean;
}

/**
 * Switches the workspace to `target`. Asks about pending changes first, then
 * runs `cm switch` through the operation runner. Resolves undefined when the
 * user cancelled the dialog; otherwise the runner's outcome (errors are
 * already shown).
 */
export async function switchWorkspace(
    host: IOperationHost,
    workspace: Workspace,
    target: SwitchTarget,
    options: ISwitchOptions = {}): Promise<OperationOutcome<string[]> | undefined> {

  const description = describeTarget(target);
  if (!options.pendingChangesConfirmed
      && !await confirmPendingChanges(workspace, { kind: "switch", target: description })) {
    return undefined;
  }

  const outcome = await runWorkspaceOperation(
    host,
    workspace,
    { name: "Switch", operation: WorkspaceOperation.Switch, title: `Switching to ${description}` },
    async () => SwitchWorkspace.run(workspace.shell, target));

  if (outcome.status === "succeeded") {
    host.channel.appendLine(`Switched '${workspace.info.name}' to ${switchSpec(target)}`);
    window.setStatusBarMessage(`Switched to ${description}`, 5000);
  }
  await runPendingChangesFollowUp(workspace, outcome.status === "succeeded");
  return outcome;
}

/** What an update means for the workspace's current location. */
export type UpdatePlan =
  | { readonly kind: "update" }
  /** The workspace is on a changeset or a label: `--last` moves it to that one's branch first. */
  | { readonly kind: "update-last"; readonly from: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export function planUpdate(config: { configType: WkConfigType; location: string } | undefined): UpdatePlan {
  switch (config?.configType) {
  case WkConfigType.Changeset:
    return { from: `changeset cs:${config.location.replace(/^cs:/, "")}`, kind: "update-last" };
  case WkConfigType.Label:
    return { from: `label ${config.location}`, kind: "update-last" };
  case WkConfigType.Shelve:
    return {
      kind: "unsupported",
      reason: "This workspace is on a shelve. Use Switch to Branch to leave it, then update.",
    };
  default:
    return { kind: "update" };
  }
}

/**
 * Updates the workspace to the latest changeset of its branch. A workspace on
 * a changeset or a label is first pointed at that one's branch (`cm update
 * --last`), which the user confirms because it changes where the workspace is.
 */
export async function updateWorkspace(
    host: IOperationHost,
    workspace: Workspace): Promise<OperationOutcome<string[]> | undefined> {

  const plan = planUpdate(workspace.workspaceConfig);
  if (plan.kind === "unsupported") {
    void window.showInformationMessage(plan.reason);
    return undefined;
  }

  if (plan.kind === "update-last") {
    const move = "Update";
    const answer = await window.showWarningMessage(
      `Update '${workspace.info.name}' to the latest changeset?`,
      {
        detail: `The workspace is on ${plan.from}. Updating points it at the branch of that changeset ` +
          "and brings it to that branch's latest changeset (cm update --last).",
        modal: true,
      },
      move);
    if (answer !== move) {
      return undefined;
    }
  }

  if (!await confirmPendingChanges(workspace, { kind: "update", target: `'${workspace.info.name}'` })) {
    return undefined;
  }

  const outcome = await runWorkspaceOperation(
    host,
    workspace,
    { name: "Update", operation: WorkspaceOperation.Update, title: `Updating ${workspace.info.name}` },
    async () => UpdateWorkspace.run(workspace.shell, { last: plan.kind === "update-last" }));

  if (outcome.status === "succeeded") {
    host.channel.appendLine(`Updated '${workspace.info.name}'`);
    window.setStatusBarMessage(`Updated ${workspace.info.name}`, 5000);
  }
  await runPendingChangesFollowUp(workspace, outcome.status === "succeeded");
  return outcome;
}
