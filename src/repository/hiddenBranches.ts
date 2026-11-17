import { ConfigurationTarget, workspace } from "vscode";

/** Whether the Repository view and the branch pickers list hidden branches too. */
export const SHOW_HIDDEN_BRANCHES_SETTING = "plastic-scm.showHiddenBranches";

export function showHiddenBranches(): boolean {
  return workspace.getConfiguration().get<boolean>(SHOW_HIDDEN_BRANCHES_SETTING, false);
}

/** Writes the setting where it is in effect, so a workspace value does not override the toggle. */
export async function setShowHiddenBranches(show: boolean): Promise<void> {
  const configuration = workspace.getConfiguration();
  const inspected = configuration.inspect<boolean>(SHOW_HIDDEN_BRANCHES_SETTING);
  const target = inspected?.workspaceValue !== undefined ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
  await configuration.update(SHOW_HIDDEN_BRANCHES_SETTING, show, target);
}
