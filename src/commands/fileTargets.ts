import { isPathInside } from "./scmUtils";
import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";
import { Uri } from "vscode";
import { Workspace } from "../workspace";

/**
 * The files a command was invoked on, whichever menu invoked it:
 * - Source Control rows: every argument is a resource (see getSelectedResources);
 * - Explorer: `(clicked, selected[])`, the selection holding every selected URI;
 * - editor title context menu: the URI of the editor;
 * - nothing (palette, keybinding): the active editor, when it is a file.
 *
 * Only `file:` URIs are returned, in order, without duplicates.
 */
export function fileTargetUris(args: unknown[], activeEditorUri?: Uri): Uri[] {
  const uris: Uri[] = [];

  const resources = args.filter((arg): arg is PlasticScmResource => arg instanceof PlasticScmResource);
  if (resources.length > 0) {
    uris.push(...resources.map(resource => resource.resourceUri));
  } else {
    const [ clicked, selected ] = args;
    if (Array.isArray(selected) && selected.some(item => item instanceof Uri)) {
      uris.push(...selected.filter((item): item is Uri => item instanceof Uri));
    } else if (clicked instanceof Uri) {
      uris.push(clicked);
    } else if (activeEditorUri) {
      uris.push(activeEditorUri);
    }
  }

  const seen = new Set<string>();
  return uris.filter(uri => {
    const key = uri.toString();
    if (uri.scheme !== "file" || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Splits files by the Plastic workspace that contains them; files outside every workspace are dropped. */
export function groupUrisByWorkspace(plasticScm: PlasticScm, uris: Uri[]): Map<Workspace, Uri[]> {
  const groups = new Map<Workspace, Uri[]>();

  for (const uri of uris) {
    for (const workspace of plasticScm.workspaces.values()) {
      if (isPathInside(uri.fsPath, workspace.info.path)) {
        const group = groups.get(workspace);
        if (group) {
          group.push(uri);
        } else {
          groups.set(workspace, [uri]);
        }
        break;
      }
    }
  }

  return groups;
}
