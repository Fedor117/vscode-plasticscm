import { commands, window } from "vscode";
import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";
import { Workspace } from "../workspace";

/**
 * Extract PlasticScmResource[] from VS Code SCM command arguments.
 *
 * The SCM view spreads its resources as separate positional arguments — it never
 * passes `(clicked, selectedArray)`. So every argument has to be considered, not
 * just the first two. This matters most in tree view: clicking an action on a
 * folder row makes VS Code flatten the whole subtree and spread every resource
 * underneath it, which is how the built-in git extension gets folder support out
 * of the same command it uses for a single file.
 *
 * Anything that isn't one of ours is dropped — the Unreal levels group holds
 * plain resource-state literals, and a keybinding can invoke with no arguments
 * at all.
 */
export function getSelectedResources(args: unknown[]): PlasticScmResource[] {
  if (!args) {
    return [];
  }

  const resources = args.filter(
    (arg): arg is PlasticScmResource => arg instanceof PlasticScmResource);

  return dedupeByPath(resources);
}

function dedupeByPath(resources: PlasticScmResource[]): PlasticScmResource[] {
  const seen = new Set<string>();

  return resources.filter(resource => {
    const key = resource.resourceUri.toString();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * cm prefixes its own diagnostics with "Error: " and we only want to show the
 * message once. Anything without that prefix is shown verbatim — the previous
 * version silently chopped six characters off those.
 */
export function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const prefix = "Error: ";
  const index = message.lastIndexOf(prefix);

  return index < 0 ? message : message.substring(index + prefix.length);
}

/**
 * Reports a failed operation, offering the full cm transcript rather than making
 * the user hunt for the output channel.
 */
export async function showOperationError(
    plasticScm: PlasticScm, operation: string, e: unknown): Promise<void> {
  const message = describeError(e);
  plasticScm.channel.appendLine(`ERROR: ${message}`);

  const showOutput = "Show Output";
  const choice = await window.showErrorMessage(
    `Plastic SCM ${operation} failed: ${message}`, showOutput);

  if (choice === showOutput) {
    await commands.executeCommand("plastic-scm.showOutput");
  }
}

/**
 * Find the Workspace that owns a given resource by path prefix.
 */
export function findWorkspaceForResource(
    plasticScm: PlasticScm,
    resource: PlasticScmResource): Workspace | undefined {
  for (const workspace of plasticScm.workspaces.values()) {
    if (isPathInside(resource.resourceUri.fsPath, workspace.info.path)) {
      return workspace;
    }
  }
  return undefined;
}

/**
 * Split resources by the workspace that owns them, so an operation spanning two
 * Plastic workspaces reaches both `cm` shells. A tree-view folder click can
 * easily produce such a selection, and sending one workspace's paths to another
 * workspace's shell fails in a way that is hard to read.
 */
export function groupResourcesByWorkspace(
    plasticScm: PlasticScm,
    resources: PlasticScmResource[]): Map<Workspace, PlasticScmResource[]> {
  const groups = new Map<Workspace, PlasticScmResource[]>();

  for (const resource of resources) {
    const workspace = findWorkspaceForResource(plasticScm, resource);
    if (!workspace) {
      continue;
    }

    const group = groups.get(workspace);
    if (group) {
      group.push(resource);
    } else {
      groups.set(workspace, [resource]);
    }
  }

  return groups;
}

/**
 * A plain `startsWith` has no separator boundary, so a resource in
 * `/dev/ProjectAlt` would be claimed by a workspace rooted at `/dev/Project`.
 */
export function isPathInside(candidate: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");

  if (candidate === normalizedRoot) {
    return true;
  }

  return candidate.startsWith(normalizedRoot) &&
    (candidate[normalizedRoot.length] === "/" || candidate[normalizedRoot.length] === "\\");
}
