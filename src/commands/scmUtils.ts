import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";
import { SourceControlResourceState } from "vscode";
import { Workspace } from "../workspace";

/**
 * Extract PlasticScmResource[] from VS Code SCM command arguments.
 *
 * When invoked from a context menu, the first arg is the right-clicked
 * resource and the second is the full array of selected resources.
 */
export function getSelectedResources(args: unknown[]): PlasticScmResource[] | undefined {
  if (!args || args.length === 0) {
    return undefined;
  }

  const firstArg = args[0];
  if (firstArg instanceof PlasticScmResource) {
    const selectedResources = args[1] as SourceControlResourceState[] | undefined;
    if (selectedResources && Array.isArray(selectedResources) && selectedResources.length > 0) {
      return selectedResources.filter(
        (r): r is PlasticScmResource => r instanceof PlasticScmResource);
    }
    return [firstArg];
  }

  return undefined;
}

/**
 * Find the Workspace that owns a given resource by path prefix.
 */
export function findWorkspaceForResource(
    plasticScm: PlasticScm,
    resource: PlasticScmResource): Workspace | undefined {
  for (const workspace of plasticScm.workspaces.values()) {
    if (resource.resourceUri.fsPath.startsWith(workspace.info.path)) {
      return workspace;
    }
  }
  return undefined;
}
