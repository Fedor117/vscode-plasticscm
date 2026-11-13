import { IWorkspaceConfig, WkConfigType } from "./models";

/** The newest changeset of a branch as last seen on the server. */
export interface IKnownBranchHead {
  /** Full branch name. */
  readonly branch: string;
  readonly changesetId: number;
}

/**
 * True when the workspace is on a branch whose head, as last seen, is newer
 * than the changeset the workspace is at: an update would bring changes.
 * A workspace on a changeset, a label or a shelve never has incoming changes:
 * it stays where it is until it is switched.
 */
export function hasIncomingChanges(
    config: IWorkspaceConfig | undefined,
    currentChangeset: number | undefined,
    head: IKnownBranchHead | undefined): boolean {
  return config?.configType === WkConfigType.Branch
    && head !== undefined
    && head.branch === config.location
    && currentChangeset !== undefined
    && head.changesetId > currentChangeset;
}
