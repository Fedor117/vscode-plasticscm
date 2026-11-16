import * as fs from "fs";
import * as path from "path";
import { GetWorkspaceFromPath } from "./cm/commands";
import { ICmShell } from "./cm/shell";
import { IWorkspaceInfo } from "./models";

/**
 * The Plastic workspace that holds `folderPath`, a folder VS Code has open.
 *
 * cm answers with symlinks resolved, but VS Code keeps the path the folder was
 * opened through for every editor URI, and applies a SourceControl's quick diff
 * only to files under its root. So the root is restated in the folder's terms.
 */
export async function locateWorkspace(folderPath: string, shell: ICmShell): Promise<IWorkspaceInfo | undefined> {
  const info = await GetWorkspaceFromPath.run(folderPath, shell);
  if (!info) {
    return undefined;
  }

  const openedRoot = await openedWorkspaceRoot(folderPath, info.path);
  return openedRoot === info.path ? info : { ...info, cmPath: info.path, path: openedRoot };
}

/**
 * `cmRoot` as reached through `folderPath`. Falls back to `cmRoot` when the
 * root is not the folder or one of its textual parents, e.g. a symlink that
 * points at a folder inside the workspace: no path through it names the root.
 */
async function openedWorkspaceRoot(folderPath: string, cmRoot: string): Promise<string> {
  if (isSameOrInside(cmRoot, folderPath)) {
    return cmRoot;
  }

  try {
    const [ realFolder, realRoot ] = await Promise.all(
      [ folderPath, cmRoot ].map(target => fs.promises.realpath(target)));
    if (!isSameOrInside(realRoot, realFolder)) {
      return cmRoot;
    }

    const candidate = path.resolve(folderPath, path.relative(realFolder, realRoot));
    return await fs.promises.realpath(candidate) === realRoot ? candidate : cmRoot;
  } catch {
    return cmRoot;
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
