export interface IWorkspaceInfo {
  name: string;
  /** The workspace root as VS Code sees it. Paths compared with editor URIs or passed to cm start here. */
  path: string;
  id: string;
  /**
   * The root as cm prints it, set only when it differs from `path`: cm resolves
   * symlinks, so a workspace opened through one is reported somewhere else.
   */
  cmPath?: string;
}
