import { GetWorkspaceFromPath } from "./cm/commands";
import { ICmShell } from "./cm/shell";
import { IWorkspaceInfo } from "./models";

/** The Plastic workspace that holds `folderPath`, a folder VS Code has open. */
export function locateWorkspace(folderPath: string, shell: ICmShell): Promise<IWorkspaceInfo | undefined> {
  return GetWorkspaceFromPath.run(folderPath, shell);
}
