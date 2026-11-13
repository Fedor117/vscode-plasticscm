import { IBranchInfo, IHistoryChangeset, ILabelInfo, IShelveInfo, IWorkspaceConfig, WkConfigType } from "../models";

/** The first non-empty line of a cm comment, for one-line descriptions. */
export function firstLine(comment: string): string {
  return comment.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? "";
}

/** Local date and time; the epoch (an unreadable date) reads as an empty string. */
export function formatDate(date: Date): string {
  return date.getTime() === 0 ? "" : date.toLocaleString();
}

/** `owner · date`, skipping whichever is missing. */
export function ownerAndDate(owner: string, date: Date): string {
  return [ owner, formatDate(date) ].filter(part => part.length > 0).join(" · ");
}

/** True when the workspace is switched to this branch. */
export function isCurrentBranch(branch: IBranchInfo, config: IWorkspaceConfig | undefined): boolean {
  return config?.configType === WkConfigType.Branch && config.location === branch.name;
}

/** True when the workspace is switched to this label. */
export function isCurrentLabel(label: ILabelInfo, config: IWorkspaceConfig | undefined): boolean {
  return config?.configType === WkConfigType.Label && config.location === label.name;
}

/**
 * True when the workspace is switched to this shelve. `cm status` prints the
 * shelve location as `sh:N` or `N` (unverified which); both are accepted.
 */
export function isCurrentShelve(shelve: IShelveInfo, config: IWorkspaceConfig | undefined): boolean {
  if (config?.configType !== WkConfigType.Shelve) {
    return false;
  }
  const location = config.location.replace(/^sh:/, "");
  return location === String(shelve.shelveId);
}

/** `sh:N`, the spec cm and the desktop app use for a shelve. */
export function shelveSpec(shelve: IShelveInfo): string {
  return `sh:${shelve.shelveId}`;
}

/** Markdown-free tooltip lines, one field per line, empty fields left out. */
export function tooltipLines(...lines: Array<[string, string]>): string {
  return lines
    .filter(([ , value ]) => value.length > 0)
    .map(([ name, value ]) => `${name}: ${value}`)
    .join("\n");
}

export function branchTooltip(branch: IBranchInfo): string {
  return tooltipLines(
    [ "Branch", branch.name ],
    [ "Owner", branch.owner ],
    [ "Created", formatDate(branch.date) ],
    [ "Head", branch.headChangesetId >= 0 ? `cs:${branch.headChangesetId}` : "" ],
    [ "Comment", branch.comment ],
  );
}

export function labelTooltip(label: ILabelInfo): string {
  return tooltipLines(
    [ "Label", label.name ],
    [ "Changeset", label.changesetId >= 0 ? `cs:${label.changesetId}` : "" ],
    [ "Branch", label.branch ],
    [ "Owner", label.owner ],
    [ "Created", formatDate(label.date) ],
    [ "Comment", label.comment ],
  );
}

export function shelveTooltip(shelve: IShelveInfo): string {
  return tooltipLines(
    [ "Shelve", shelveSpec(shelve) ],
    [ "Based on", shelve.parentChangesetId >= 0 ? `cs:${shelve.parentChangesetId}` : "" ],
    [ "Owner", shelve.owner ],
    [ "Created", formatDate(shelve.date) ],
    [ "Comment", shelve.comment ],
  );
}

export function changesetTooltip(changeset: IHistoryChangeset): string {
  return tooltipLines(
    [ "Changeset", `cs:${changeset.id}` ],
    [ "Branch", changeset.branch ],
    [ "Owner", changeset.owner ],
    [ "Date", formatDate(changeset.date) ],
    [ "Comment", changeset.comment ],
  );
}
