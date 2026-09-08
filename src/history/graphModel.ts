import { IHistoryChangeset, IMergeLink } from "../models";

export interface ILaneInput {
  readonly branch: string;
  /** Newest first. */
  readonly changesets: IHistoryChangeset[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
  /** Branch head as last reported by cm; newer than `changesets[0]` means a refresh would show more. */
  readonly headChangesetId?: number;
}

export interface IGraphInput {
  readonly currentBranch: string;
  readonly currentChangesetId: number;
  /** `[current, parent?]` */
  readonly lanes: ILaneInput[];
  readonly merges: IMergeLink[];
}

export type GraphLaneKind = "current" | "parent";

export interface IGraphLane {
  readonly branch: string;
  readonly kind: GraphLaneKind;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly count: number;
  readonly hasNewer: boolean;
}

export interface IGraphLabel {
  readonly text: string;
  readonly kind: GraphLaneKind;
  readonly isCurrent: boolean;
}

export interface IGraphRow {
  readonly id: number;
  readonly lane: number;
  readonly parentId: number;
  readonly parentLoaded: boolean;
  /**
   * Lane the parent is expected on, so an unloaded parent can be drawn as a tail
   * toward the right lane; -1 when there is no parent at all.
   */
  readonly parentLane: number;
  readonly branch: string;
  /** First non-empty comment line, trimmed; empty when the comment is empty. */
  readonly subject: string;
  readonly comment: string;
  readonly owner: string;
  /** Owner up to the first `@`. */
  readonly ownerShort: string;
  /** ISO 8601. */
  readonly date: string;
  readonly isCurrent: boolean;
  readonly labels: IGraphLabel[];
}

export type GraphLinkKind = "parent" | "merge";

/**
 * Ordered by age, not by row: in the block layout a merge into the parent lane
 * has its newer endpoint rendered below its older one.
 */
export interface IGraphLink {
  /** The newer changeset (child, or merge destination). */
  readonly fromId: number;
  /** The older changeset (parent, or merge source). */
  readonly toId: number;
  readonly kind: GraphLinkKind;
  readonly mergeType?: string;
}

export interface IGraphModel {
  readonly lanes: IGraphLane[];
  readonly rows: IGraphRow[];
  readonly links: IGraphLink[];
  /** False when the workspace's changeset is older than everything loaded. */
  readonly currentLoaded: boolean;
}

/** A changeset together with the lane it is drawn on, before the row is fleshed out. */
interface IRowSeed {
  readonly changeset: IHistoryChangeset;
  readonly lane: number;
}
export function buildGraphModel(input: IGraphInput): IGraphModel {
  const seeds = collectSeeds(input.lanes);

  const laneById = new Map<number, number>();
  const counts: number[] = input.lanes.map(() => 0);
  let oldestLane0Id: number | undefined;
  for (const seed of seeds) {
    laneById.set(seed.changeset.id, seed.lane);
    counts[seed.lane] += 1;
    if (seed.lane === 0 && (oldestLane0Id === undefined || seed.changeset.id < oldestLane0Id)) {
      oldestLane0Id = seed.changeset.id;
    }
  }

  const labelsById = collectLabels(input, seeds);
  const rows = seeds.map(seed => toRow(seed, input, laneById, oldestLane0Id, labelsById.get(seed.changeset.id) ?? []));

  return {
    currentLoaded: rows.some(row => row.isCurrent),
    lanes: input.lanes.map((lane, index): IGraphLane => ({
      branch: lane.branch,
      count: counts[index],
      error: lane.error,
      hasMore: lane.hasMore,
      hasNewer: lane.headChangesetId !== undefined
        && lane.changesets.length > 0
        && lane.headChangesetId > lane.changesets[0].id,
      kind: index === 0 ? "current" : "parent",
      loading: lane.loading,
    })),
    links: buildLinks(rows, input.merges, laneById),
    rows,
  };
}

/**
 * Block layout: lane 0's changesets, then lane 1's, each newest first. Interleaving
 * by date would zig-zag the lines the way `git log` does without `--topo-order`.
 */
function collectSeeds(lanes: ILaneInput[]): IRowSeed[] {
  const laneByBranch = new Map<string, number>();
  lanes.forEach((lane, index) => {
    if (!laneByBranch.has(lane.branch)) {
      laneByBranch.set(lane.branch, index);
    }
  });

  const seen = new Set<number>();
  const seeds: IRowSeed[] = [];
  lanes.forEach((lane, fetchedLane) => {
    for (const changeset of lane.changesets) {
      if (seen.has(changeset.id)) {
        continue;
      }
      seen.add(changeset.id);
      seeds.push({ changeset, lane: laneByBranch.get(changeset.branch) ?? fetchedLane });
    }
  });
  return seeds;
}

function collectLabels(input: IGraphInput, seeds: IRowSeed[]): Map<number, IGraphLabel[]> {
  const labels = new Map<number, IGraphLabel[]>();
  const addLabel = (id: number, kind: GraphLaneKind, text: string): void => {
    const list = labels.get(id) ?? [];
    list.push({ isCurrent: id === input.currentChangesetId, kind, text });
    labels.set(id, list);
  };

  // A branch without changesets yet still points at its base changeset on the
  // parent lane, so the current pill moves there instead of disappearing.
  const firstLane0 = seeds.find(seed => seed.lane === 0);
  if (firstLane0) {
    addLabel(firstLane0.changeset.id, "current", input.currentBranch);
  } else if (seeds.some(seed => seed.changeset.id === input.currentChangesetId)) {
    addLabel(input.currentChangesetId, "current", input.currentBranch);
  }

  if (input.lanes.length > 1) {
    const firstLane1 = seeds.find(seed => seed.lane === 1);
    if (firstLane1) {
      addLabel(firstLane1.changeset.id, "parent", input.lanes[1].branch);
    }
  }
  return labels;
}

function toRow(
    seed: IRowSeed,
    input: IGraphInput,
    laneById: Map<number, number>,
    oldestLane0Id: number | undefined,
    labels: IGraphLabel[]): IGraphRow {
  const { changeset, lane } = seed;
  return {
    branch: changeset.branch,
    comment: changeset.comment,
    date: toIsoDate(changeset.date),
    id: changeset.id,
    isCurrent: changeset.id === input.currentChangesetId,
    labels,
    lane,
    owner: changeset.owner,
    ownerShort: shortOwner(changeset.owner),
    parentId: changeset.parentId,
    parentLane: parentLaneOf(seed, laneById, oldestLane0Id, input.lanes.length),
    parentLoaded: laneById.has(changeset.parentId),
    subject: subjectOf(changeset.comment),
  };
}

function parentLaneOf(
    seed: IRowSeed,
    laneById: Map<number, number>,
    oldestLane0Id: number | undefined,
    laneCount: number): number {
  const { id, parentId } = seed.changeset;
  if (parentId < 0) {
    return -1;
  }
  const loadedLane = laneById.get(parentId);
  if (loadedLane !== undefined) {
    return loadedLane;
  }
  // The oldest loaded changeset of the current branch is where it forked off the
  // parent branch, so its unloaded parent lives on the parent lane, not its own.
  if (seed.lane === 0 && id === oldestLane0Id && laneCount > 1) {
    return 1;
  }
  return seed.lane;
}

function buildLinks(rows: IGraphRow[], merges: IMergeLink[], laneById: Map<number, number>): IGraphLink[] {
  const links: IGraphLink[] = [];
  const seen = new Set<string>();
  const keyOf = (fromId: number, toId: number): string => `${fromId}>${toId}`;

  for (const row of rows) {
    if (!row.parentLoaded) {
      continue;
    }
    seen.add(keyOf(row.id, row.parentId));
    links.push({ fromId: row.id, kind: "parent", toId: row.parentId });
  }

  for (const merge of merges) {
    const fromLane = laneById.get(merge.destinationChangesetId);
    const toLane = laneById.get(merge.sourceChangesetId);
    // A same-lane link (a subtractive cherry pick inside one branch) is not ancestry
    // and would be drawn straight over the trunk line.
    if (fromLane === undefined || toLane === undefined || fromLane === toLane) {
      continue;
    }
    const key = keyOf(merge.destinationChangesetId, merge.sourceChangesetId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    links.push({
      fromId: merge.destinationChangesetId,
      kind: "merge",
      mergeType: merge.type,
      toId: merge.sourceChangesetId,
    });
  }
  return links;
}

function subjectOf(comment: string): string {
  for (const line of comment.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

function shortOwner(owner: string): string {
  const at = owner.indexOf("@");
  return at < 0 ? owner : owner.substring(0, at);
}

/** The parsers already map unparseable dates to the epoch; mirror that rather than let `toISOString` throw. */
function toIsoDate(date: Date): string {
  return isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
