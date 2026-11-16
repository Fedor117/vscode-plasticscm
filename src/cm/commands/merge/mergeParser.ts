/** Passed to cm as `--fieldseparator`, so a path with spaces stays one field. */
export const MERGE_FIELD_SEPARATOR = "#|#";

/** A conflict about the tree (an evil twin, a change against a delete), which cm never resolves by itself. */
export interface IDirectoryConflict {
  /** cm's name for the kind, e.g. `Evil twin conflict`. */
  readonly title: string;
  /** What the merged branch did, e.g. `Added /twin.txt`. */
  readonly source: string;
  /** What the workspace's branch did. */
  readonly destination: string;
}

/** A file cm could not merge by itself. */
export interface IUnresolvedFile {
  /** Server path, e.g. `/src/Player.cs`. */
  readonly path: string;
  /** `markers` when cm wrote conflict markers into it; otherwise cm's reason: `binary`, `symlink`, `recursive`. */
  readonly reason: string;
}

/** What `cm merge --machinereadable` printed, with or without `--merge`. */
export interface IMergeReport {
  /** cm's words when there is nothing to merge, e.g. `No merges detected`. */
  readonly nothingToMerge?: string;
  /** Items taken from the merged branch as they are: changed, added, deleted or moved there only. */
  readonly incoming: number;
  /** Server paths of files changed on both branches. Only the merge itself tells whether they merge cleanly. */
  readonly changedOnBoth: readonly string[];
  readonly directoryConflicts: readonly IDirectoryConflict[];
  /** Only after `--merge --conflict-markers`. */
  readonly unresolved: readonly IUnresolvedFile[];
  /** Operations cm carried out (`DO_` lines). Zero means the workspace was not touched. */
  readonly applied: number;
  /** Lines of a kind this parser does not know, as cm printed them. */
  readonly other: readonly string[];
}

/**
 * Reads the lines of `cm merge <spec> --machinereadable --fieldseparator=<separator>`.
 * The line kinds are the ones cm 11.0.16 printed for a throwaway repository:
 *
 *     FILE_SRC|/a.txt|1|3|17
 *     APPLY|ADD|/c.txt
 *     APPLY|MV|/mv.txt|/moved.txt
 *     FILE_CONFLICT|/b.txt|1|4|5|18
 *     DIR_CONFLICT|EVIL|Evil twin conflict|<explanation>|Added /twin.txt|Added /twin.txt|60|False|ADD|/twin.txt|...
 *     STATUS|ALREADY_CONNECTED|No merges detected
 *     DO_MERGE|/abs/path/b.txt
 *     CONFLICT_MARKERS|/b.txt
 *     UNRESOLVED|/logo.png|binary
 */
export function parseMergeLines(lines: readonly string[], separator: string = MERGE_FIELD_SEPARATOR): IMergeReport {
  let nothingToMerge: string | undefined;
  let incoming = 0;
  let applied = 0;
  const changedOnBoth: string[] = [];
  const directoryConflicts: IDirectoryConflict[] = [];
  const unresolved: IUnresolvedFile[] = [];
  const other: string[] = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    const fields = line.split(separator);
    const kind = fields[0];
    if (kind === "STATUS") {
      nothingToMerge = fields[2] || fields[1] || kind;
      continue;
    }

    if (kind === "FILE_SRC" || kind === "APPLY") {
      incoming++;
    } else if (kind === "FILE_CONFLICT" && fields.length > 1) {
      changedOnBoth.push(fields[1]);
    } else if (kind === "DIR_CONFLICT" && fields.length > 5) {
      directoryConflicts.push({ destination: fields[5], source: fields[4], title: fields[2] });
    } else if (kind === "CONFLICT_MARKERS" && fields.length > 1) {
      unresolved.push({ path: fields[1], reason: "markers" });
    } else if (kind === "UNRESOLVED" && fields.length > 1) {
      unresolved.push({ path: fields[1], reason: fields[2] ?? "unknown" });
    } else if (kind.startsWith("DO_")) {
      applied++;
    } else {
      other.push(line);
    }
  }

  return { applied, changedOnBoth, directoryConflicts, incoming, nothingToMerge, other, unresolved };
}
