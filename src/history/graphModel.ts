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
  /** Loaded changesets, whether shown or held back. */
  readonly count: number;
  /**
   * Loaded changesets below the paging horizon, held back until the other lane
   * has loaded that far; see `IGraphModel.loadMoreBranch`.
   */
  readonly hidden: number;
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

/** Ordered by age: `from` is the newer changeset, and so the one drawn higher. */
export interface IGraphLink {
  /** The newer changeset (child, or merge destination). */
  readonly fromId: number;
  /** The older changeset (parent, or merge source). */
  readonly toId: number;
  readonly kind: GraphLinkKind;
  readonly mergeType?: string;
  /** Branch of each end, so an end that is not loaded can still be named. */
  readonly fromBranch: string;
  readonly toBranch: string;
  /**
   * False when that changeset is not among the rows: a merge from a branch that
   * has no lane, or from a page not loaded yet. The link then has one end only,
   * and is drawn as a stub on the end it has.
   */
  readonly fromLoaded: boolean;
  readonly toLoaded: boolean;
}

export interface IGraphModel {
  readonly lanes: IGraphLane[];
  /** Interleaved by changeset id, newest first, across lanes. */
  readonly rows: IGraphRow[];
  readonly links: IGraphLink[];
  /** False when the workspace's changeset is older than everything shown. */
  readonly currentLoaded: boolean;
  /**
   * The lane whose next page would extend the graph: the one with more to load
   * whose oldest loaded changeset is the newest among such lanes. Rows of other
   * lanes older than that changeset are held back until it is loaded, so the
   * graph never shows a stretch where a lane looks empty only because its page
   * has not arrived. Undefined when no lane has more.
   */
  readonly loadMoreBranch?: string;
}

/** A changeset together with the lane it is drawn on, before the row is fleshed out. */
interface IRowSeed {
  readonly changeset: IHistoryChangeset;
  readonly lane: number;
}
export function buildGraphModel(input: IGraphInput): IGraphModel {
  const loaded = collectSeeds(input.lanes);
  const horizon = pagingHorizon(input.lanes);
  const seeds = horizon === undefined ? loaded : loaded.filter(seed => seed.changeset.id >= horizon);

  const counts: number[] = input.lanes.map(() => 0);
  const hidden: number[] = input.lanes.map(() => 0);
  let oldestLane0Id: number | undefined;
  for (const seed of loaded) {
    counts[seed.lane] += 1;
    if (horizon !== undefined && seed.changeset.id < horizon) {
      hidden[seed.lane] += 1;
    }
    // Over everything loaded, not just what is shown: the fork of the current
    // branch is its oldest changeset, hidden or not.
    if (seed.lane === 0 && (oldestLane0Id === undefined || seed.changeset.id < oldestLane0Id)) {
      oldestLane0Id = seed.changeset.id;
    }
  }

  const laneById = new Map<number, number>();
  for (const seed of seeds) {
    laneById.set(seed.changeset.id, seed.lane);
  }

  const labelsById = collectLabels(input, seeds);
  const rows = seeds.map(seed => toRow(seed, input, laneById, oldestLane0Id, labelsById.get(seed.changeset.id) ?? []));
  const bindingLane = horizon === undefined
    ? undefined
    : input.lanes.find(lane => lane.hasMore && oldestIdOf(lane) === horizon);

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
      hidden: hidden[index],
      kind: index === 0 ? "current" : "parent",
      loading: lane.loading,
    })),
    links: buildLinks(rows, input.merges, laneById),
    ...bindingLane ? { loadMoreBranch: bindingLane.branch } : {},
    rows,
  };
}

/**
 * Interleaved by changeset id, newest first, the way a Git graph lists the
 * commits of every shown ref in one sequence. Ids grow monotonically within a
 * repository, so this is the time order and a topological one at once: a parent
 * always comes after its children, and each lane keeps its own column.
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
  return seeds.sort((left, right) => right.changeset.id - left.changeset.id);
}

/**
 * The oldest changeset the graph may show. A lane with more pages says nothing
 * about what lies below its oldest loaded changeset, so the other lane's rows
 * from that stretch are held back until it catches up: shown early, they would
 * run alongside a line that looks empty only because its page is not loaded.
 */
function pagingHorizon(lanes: ILaneInput[]): number | undefined {
  let horizon: number | undefined;
  for (const lane of lanes) {
    const oldest = oldestIdOf(lane);
    if (lane.hasMore && oldest !== undefined && (horizon === undefined || oldest > horizon)) {
      horizon = oldest;
    }
  }
  return horizon;
}

function oldestIdOf(lane: ILaneInput): number | undefined {
  return lane.changesets[lane.changesets.length - 1]?.id;
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
    parentLane: parentLaneOf(seed, laneById, oldestLane0Id, input.lanes),
    parentLoaded: laneById.has(changeset.parentId),
    subject: subjectOf(changeset.comment),
  };
}

function parentLaneOf(
    seed: IRowSeed,
    laneById: Map<number, number>,
    oldestLane0Id: number | undefined,
    lanes: ILaneInput[]): number {
  const { id, parentId } = seed.changeset;
  if (parentId < 0) {
    return -1;
  }
  const loadedLane = laneById.get(parentId);
  if (loadedLane !== undefined) {
    return loadedLane;
  }
  // Once the current branch is loaded to its end, its oldest changeset is where
  // it forked off the parent branch, so the unloaded parent lives on the parent
  // lane. While there are more pages the parent is just the next page: a tail
  // bent toward the parent lane there would claim a fork that is not one.
  if (seed.lane === 0 && id === oldestLane0Id && lanes.length > 1 && !lanes[0].hasMore) {
    return 1;
  }
  return seed.lane;
}

function buildLinks(rows: IGraphRow[], merges: IMergeLink[], laneById: Map<number, number>): IGraphLink[] {
  const links: IGraphLink[] = [];
  const seen = new Set<string>();
  const keyOf = (fromId: number, toId: number): string => `${fromId}>${toId}`;
  const branchById = new Map(rows.map(row => [ row.id, row.branch ]));

  for (const row of rows) {
    if (!row.parentLoaded) {
      continue;
    }
    seen.add(keyOf(row.id, row.parentId));
    links.push({
      fromBranch: row.branch,
      fromId: row.id,
      fromLoaded: true,
      kind: "parent",
      toBranch: branchById.get(row.parentId) ?? row.branch,
      toId: row.parentId,
      toLoaded: true,
    });
  }

  for (const merge of merges) {
    const fromLane = laneById.get(merge.destinationChangesetId);
    const toLane = laneById.get(merge.sourceChangesetId);
    // With neither end loaded there is no row to hang the link on.
    if (fromLane === undefined && toLane === undefined) {
      continue;
    }
    // A same-lane link (a subtractive cherry pick inside one branch) is not ancestry
    // and would be drawn straight over the trunk line.
    if (fromLane !== undefined && fromLane === toLane) {
      continue;
    }
    const key = keyOf(merge.destinationChangesetId, merge.sourceChangesetId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    links.push({
      fromBranch: merge.destinationBranch,
      fromId: merge.destinationChangesetId,
      fromLoaded: fromLane !== undefined,
      kind: "merge",
      mergeType: merge.type,
      toBranch: merge.sourceBranch,
      toId: merge.sourceChangesetId,
      toLoaded: toLane !== undefined,
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
