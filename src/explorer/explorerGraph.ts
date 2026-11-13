import { IHistoryChangeset, ILabelInfo, IMergeLink } from "../models";
import { shortOwner, subjectOf, toIsoDate } from "../history/graphModel";

/** Which changesets of the loaded window the graph shows. */
export type ExplorerScope =
  | { readonly kind: "all" }
  /** The workspace's changeset and branch head, with everything they descend from. */
  | { readonly kind: "current" }
  | { readonly kind: "branches"; readonly branches: readonly string[] };

export interface IExplorerInput {
  /** Loaded changesets of every branch, in any order. */
  readonly changesets: readonly IHistoryChangeset[];
  readonly merges: readonly IMergeLink[];
  readonly labels: readonly ILabelInfo[];
  readonly currentChangesetId: number;
  /** Full name of the branch the workspace is on; undefined on a label or a changeset. */
  readonly currentBranch?: string;
  readonly scope: ExplorerScope;
}

export interface IExplorerRef {
  readonly kind: "branch" | "label";
  readonly text: string;
  /** The branch the workspace is on. */
  readonly isCurrent: boolean;
}

export interface IExplorerMergeSource {
  readonly id: number;
  readonly branch: string;
  /** cm's type name: `merge`, `cherrypick`, `interval`... */
  readonly type: string;
}

export interface IExplorerRow {
  readonly id: number;
  /** -1 for the repository root. */
  readonly parentId: number;
  readonly branch: string;
  readonly subject: string;
  readonly comment: string;
  readonly owner: string;
  readonly ownerShort: string;
  /** ISO 8601. */
  readonly date: string;
  /** The changeset the workspace is on. */
  readonly isCurrent: boolean;
  readonly refs: IExplorerRef[];
  readonly mergedFrom: IExplorerMergeSource[];
  /** Lane the changeset's dot sits on. */
  readonly lane: number;
  /** Palette index of the changeset's branch. */
  readonly color: number;
  /**
   * The line pieces crossing this row, four numbers each: `top`, `bottom`,
   * `color`, `merge`. `top` is the lane the piece enters the row on, or -1 when
   * it starts at the dot; `bottom` is the lane it leaves on, or -1 when it ends
   * at the dot. `merge` is 1 for a merge link, drawn dashed. Flat rather than
   * objects because a long history carries tens of thousands of them.
   */
  readonly lines: number[];
}

export interface IExplorerModel {
  /** Newest first. */
  readonly rows: IExplorerRow[];
  /** Widest the graph gets, in lanes. */
  readonly laneCount: number;
  /** Every branch with a loaded changeset, sorted; what the branch filter offers. */
  readonly branches: string[];
  /** Every owner of a loaded changeset, sorted; what the author filter offers. */
  readonly owners: string[];
  /** Loaded changesets, shown or not. */
  readonly loadedCount: number;
}

/** How many colours the client's palette has. */
export const EXPLORER_PALETTE_SIZE = 8;

interface ILane {
  /** The changeset this lane's line runs down to. */
  readonly waitingFor: number;
  readonly color: number;
  readonly merge: boolean;
}

/**
 * Lays the loaded changesets out as one newest-first list with a lane graph,
 * the way a Git log graph does: each row sits on a lane, a line runs from it
 * down to its parent, and merge links are extra lines to the merge source.
 *
 * Changeset ids grow monotonically in a repository, so sorting by id is the
 * time order and a topological one at once: a parent always comes after its
 * children.
 */
export function buildExplorerModel(input: IExplorerInput): IExplorerModel {
  const byId = new Map<number, IHistoryChangeset>();
  for (const changeset of input.changesets) {
    if (!byId.has(changeset.id)) {
      byId.set(changeset.id, changeset);
    }
  }
  const loaded = Array.from(byId.values()).sort((left, right) => right.id - left.id);

  const sourcesByDestination = collectMergeSources(input.merges);
  const heads = branchHeads(loaded);
  const visible = visibleIds(loaded, byId, sourcesByDestination, heads, input);
  const labelsById = collectLabels(input.labels);

  const lanes: Array<ILane | undefined> = [];
  const rows: IExplorerRow[] = [];
  let laneCount = 0;

  for (const changeset of loaded) {
    if (!visible.has(changeset.id)) {
      continue;
    }

    const lines: number[] = [];
    const incoming: number[] = [];
    lanes.forEach((lane, index) => {
      if (!lane) {
        return;
      }
      if (lane.waitingFor === changeset.id) {
        incoming.push(index);
      } else {
        lines.push(index, index, lane.color, lane.merge ? 1 : 0);
      }
    });

    const laneIndex = incoming.length > 0 ? incoming[0] : firstFreeLane(lanes);
    for (const index of incoming) {
      const lane = lanes[index] as ILane;
      lines.push(index, -1, lane.color, lane.merge ? 1 : 0);
      lanes[index] = undefined;
    }

    const color = branchColor(changeset.branch);
    const parentId = visibleParent(changeset, byId, visible);
    if (parentId >= 0) {
      // The lane carries on down to the parent. Sibling branches each keep their
      // own lane until the parent's row, where they all meet at its dot.
      lanes[laneIndex] = { color, merge: false, waitingFor: parentId };
      lines.push(-1, laneIndex, color, 0);
    }

    const mergedFrom = sourcesByDestination.get(changeset.id) ?? [];
    for (const source of mergedFrom) {
      // A source that is not shown (older than the loaded window, or filtered
      // out) has no row to run a line to; the details still name it.
      if (source.id === parentId || !visible.has(source.id)) {
        continue;
      }
      let target = lanes.findIndex(lane => lane?.waitingFor === source.id);
      if (target < 0) {
        target = firstFreeLane(lanes);
        lanes[target] = { color: branchColor(source.branch), merge: true, waitingFor: source.id };
      }
      lines.push(-1, target, (lanes[target] as ILane).color, 1);
    }

    laneCount = Math.max(laneCount, lanes.length, laneIndex + 1);
    trimTrailingFreeLanes(lanes);

    rows.push({
      branch: changeset.branch,
      color,
      comment: changeset.comment,
      date: toIsoDate(changeset.date),
      id: changeset.id,
      isCurrent: changeset.id === input.currentChangesetId,
      lane: laneIndex,
      lines,
      mergedFrom,
      owner: changeset.owner,
      ownerShort: shortOwner(changeset.owner),
      parentId: changeset.parentId,
      refs: refsOf(changeset, heads, labelsById, input.currentBranch),
      subject: subjectOf(changeset.comment),
    });
  }

  return {
    branches: Array.from(heads.keys()).sort(),
    laneCount,
    loadedCount: loaded.length,
    owners: Array.from(new Set(loaded.map(changeset => changeset.owner))).sort(),
    rows,
  };
}

/** A changeset as a row without a graph: what a repository search result is shown as. */
export function toFlatExplorerRow(changeset: IHistoryChangeset, currentChangesetId: number): IExplorerRow {
  return {
    branch: changeset.branch,
    color: branchColor(changeset.branch),
    comment: changeset.comment,
    date: toIsoDate(changeset.date),
    id: changeset.id,
    isCurrent: changeset.id === currentChangesetId,
    lane: 0,
    lines: [],
    mergedFrom: [],
    owner: changeset.owner,
    ownerShort: shortOwner(changeset.owner),
    parentId: changeset.parentId,
    refs: [],
    subject: subjectOf(changeset.comment),
  };
}

/** A stable palette index for a branch, so a branch keeps its colour as pages load. */
export function branchColor(branch: string): number {
  let hash = 5381;
  for (let index = 0; index < branch.length; index++) {
    hash = ((hash << 5) + hash + branch.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % EXPLORER_PALETTE_SIZE;
}

function collectMergeSources(merges: readonly IMergeLink[]): Map<number, IExplorerMergeSource[]> {
  const sources = new Map<number, IExplorerMergeSource[]>();
  for (const merge of merges) {
    const list = sources.get(merge.destinationChangesetId) ?? [];
    if (!list.some(known => known.id === merge.sourceChangesetId)) {
      list.push({ branch: merge.sourceBranch, id: merge.sourceChangesetId, type: merge.type });
      sources.set(merge.destinationChangesetId, list);
    }
  }
  return sources;
}

/**
 * The newest loaded changeset of each branch. The window is loaded newest
 * first without gaps, so that changeset is the branch's head.
 */
function branchHeads(loaded: readonly IHistoryChangeset[]): Map<string, number> {
  const heads = new Map<string, number>();
  for (const changeset of loaded) {
    if (!heads.has(changeset.branch)) {
      heads.set(changeset.branch, changeset.id);
    }
  }
  return heads;
}

function collectLabels(labels: readonly ILabelInfo[]): Map<number, string[]> {
  const byId = new Map<number, string[]>();
  for (const label of labels) {
    const list = byId.get(label.changesetId) ?? [];
    if (!list.includes(label.name)) {
      list.push(label.name);
      byId.set(label.changesetId, list);
    }
  }
  return byId;
}

function refsOf(
    changeset: IHistoryChangeset,
    heads: Map<string, number>,
    labelsById: Map<number, string[]>,
    currentBranch: string | undefined): IExplorerRef[] {
  const refs: IExplorerRef[] = [];
  if (heads.get(changeset.branch) === changeset.id) {
    refs.push({ isCurrent: changeset.branch === currentBranch, kind: "branch", text: changeset.branch });
  }
  for (const label of labelsById.get(changeset.id) ?? []) {
    refs.push({ isCurrent: false, kind: "label", text: label });
  }
  return refs;
}

function visibleIds(
    loaded: readonly IHistoryChangeset[],
    byId: Map<number, IHistoryChangeset>,
    sourcesByDestination: Map<number, IExplorerMergeSource[]>,
    heads: Map<string, number>,
    input: IExplorerInput): Set<number> {
  const scope = input.scope;
  if (scope.kind === "branches") {
    const wanted = new Set(scope.branches);
    return new Set(loaded.filter(changeset => wanted.has(changeset.branch)).map(changeset => changeset.id));
  }
  if (scope.kind === "all") {
    return new Set(byId.keys());
  }

  // Everything the workspace's position descends from, through parents and merges.
  const pending: number[] = [input.currentChangesetId];
  const head = input.currentBranch === undefined ? undefined : heads.get(input.currentBranch);
  if (head !== undefined) {
    pending.push(head);
  }

  const reached = new Set<number>();
  while (pending.length > 0) {
    const id = pending.pop() as number;
    const changeset = byId.get(id);
    if (!changeset || reached.has(id)) {
      continue;
    }
    reached.add(id);
    pending.push(changeset.parentId);
    for (const source of sourcesByDestination.get(id) ?? []) {
      pending.push(source.id);
    }
  }
  return reached;
}

/**
 * The changeset a row's line runs down to: its parent when that is shown, else
 * the nearest shown ancestor, so a branch filter still connects what is left.
 * A parent older than the loaded window is returned as it is: its line runs off
 * the bottom of the graph, which is what "there is more below" looks like.
 */
function visibleParent(
    changeset: IHistoryChangeset,
    byId: Map<number, IHistoryChangeset>,
    visible: Set<number>): number {
  let parentId = changeset.parentId;
  while (parentId >= 0) {
    if (visible.has(parentId)) {
      return parentId;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      return parentId;
    }
    parentId = parent.parentId;
  }
  return -1;
}

function firstFreeLane(lanes: Array<ILane | undefined>): number {
  const free = lanes.findIndex(lane => lane === undefined);
  return free < 0 ? lanes.length : free;
}

function trimTrailingFreeLanes(lanes: Array<ILane | undefined>): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) {
    lanes.pop();
  }
}
