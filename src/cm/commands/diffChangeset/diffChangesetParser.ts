import { FileChangeStatus, IChangesetFileChange, IPermissionChange, RevisionType } from "../../../models";
import { BaseCmParser } from "../baseCmParser";

const STATUS_FLAGS: { [letter: string]: FileChangeStatus } = {
  A: FileChangeStatus.Added,
  C: FileChangeStatus.Changed,
  D: FileChangeStatus.Deleted,
  M: FileChangeStatus.Moved,
};

const REVISION_TYPES: { [letter: string]: RevisionType } = {
  B: RevisionType.BinaryFile,
  D: RevisionType.Directory,
  F: RevisionType.TextFile,
};

const FIELD_LINE = /^(S|T|P|R|PR|B|SP|DP|FP|SFP|RP):(.*)$/;

/** `dr-xr-xr-x`; a cm that does not know the field prints something else. */
const MODE = /^[a-z-][rwxsStT-]{9}$/;

/** Fields of one record as printed by `cm diff --format`, in the format's own order. */
interface IDiffRecord {
  status: string;
  type: string;
  path: string;
  revisionId: string;
  parentRevisionId: string;
  baseRevisionId: string;
  sourcePath: string;
  destinationPath: string;
  permissions: string;
  sourcePermissions: string;
  repository: string;
}

const FIELD_KEYS: { [prefix: string]: keyof IDiffRecord } = {
  B: "baseRevisionId",
  DP: "destinationPath",
  FP: "permissions",
  P: "path",
  PR: "parentRevisionId",
  R: "revisionId",
  RP: "repository",
  S: "status",
  SFP: "sourcePermissions",
  SP: "sourcePath",
  T: "type",
};

/** cm wraps every path-like value in double quotes and prints empty ones as `""`. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")
    ? value.substring(1, value.length - 1)
    : value;
}

function parseRevisionId(value: string): number {
  const id = parseInt(value, 10);
  return isNaN(id) ? -1 : id;
}

/**
 * Only a `C` row compares two modes: an added, deleted or moved row prints an
 * empty source mode for an item whose mode did not change.
 */
function permissionChange(record: IDiffRecord): IPermissionChange | undefined {
  if (record.status !== "C") {
    return undefined;
  }
  const to = unquote(record.permissions);
  const from = unquote(record.sourcePermissions);
  if (to === from || [ to, from ].some(mode => mode !== "" && !MODE.test(mode))) {
    return undefined;
  }
  return { from: from || undefined, to: to || undefined };
}

function comparePaths(left: IChangesetFileChange, right: IChangesetFileChange): number {
  const leftLower = left.path.toLowerCase();
  const rightLower = right.path.toLowerCase();
  if (leftLower !== rightLower) {
    return leftLower < rightLower ? -1 : 1;
  }
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
}

export class DiffChangesetParser extends BaseCmParser<IChangesetFileChange[]> {
  public parse(): Promise<IChangesetFileChange[] | undefined> {
    const changes = new Map<string, IChangesetFileChange>();

    for (const record of this.readRecords()) {
      const change = DiffChangesetParser.toChange(record);
      // A moved-and-edited item is printed twice (a `C` and an `M` row) with the
      // same destination revision; a delete plus re-add of one path has two
      // revisions and stays two rows.
      const key = `${change.revisionId}:${change.path}`;
      const existing = changes.get(key);
      changes.set(key, existing ? DiffChangesetParser.merge(existing, change) : change);
    }

    return Promise.resolve(Array.from(changes.values()).sort(comparePaths));
  }

  private static toChange(record: IDiffRecord): IChangesetFileChange {
    const oldPath = unquote(record.sourcePath);
    const permissions = permissionChange(record);
    return {
      baseRevisionId: parseRevisionId(record.baseRevisionId),
      oldPath: oldPath === "" ? undefined : oldPath,
      parentRevisionId: parseRevisionId(record.parentRevisionId),
      path: unquote(record.path),
      ...(permissions ? { permissionChange: permissions } : {}),
      repository: unquote(record.repository),
      revisionId: parseRevisionId(record.revisionId),
      revisionType: REVISION_TYPES[record.type] ?? RevisionType.Unknown,
      status: STATUS_FLAGS[record.status] ?? FileChangeStatus.None,
    };
  }

  private static merge(destination: IChangesetFileChange, source: IChangesetFileChange): IChangesetFileChange {
    const permissions = destination.permissionChange ?? source.permissionChange;
    return {
      baseRevisionId: Math.max(destination.baseRevisionId, source.baseRevisionId),
      oldPath: destination.oldPath ?? source.oldPath,
      parentRevisionId: Math.max(destination.parentRevisionId, source.parentRevisionId),
      path: destination.path,
      ...(permissions ? { permissionChange: permissions } : {}),
      repository: destination.repository,
      revisionId: destination.revisionId,
      revisionType: destination.revisionType !== RevisionType.Unknown
        ? destination.revisionType
        : source.revisionType,
      status: destination.status | source.status,
    };
  }

  /** A record opens at `S:` and closes at `RP:`; anything else, including a truncated record, is dropped. */
  private readRecords(): IDiffRecord[] {
    const records: IDiffRecord[] = [];
    let current: IDiffRecord | undefined;

    for (const line of this.mOutputBuffer) {
      const match = FIELD_LINE.exec(line);
      if (!match) {
        continue;
      }

      const [ , prefix, value ] = match;
      if (prefix === "S") {
        current = {
          baseRevisionId: "",
          destinationPath: "",
          parentRevisionId: "",
          path: "",
          permissions: "",
          repository: "",
          revisionId: "",
          sourcePath: "",
          sourcePermissions: "",
          status: "",
          type: "",
        };
      }
      if (!current) {
        continue;
      }

      current[FIELD_KEYS[prefix]] = value;
      if (prefix === "RP") {
        records.push(current);
        current = undefined;
      }
    }

    return records;
  }
}
