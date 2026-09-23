import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../models";
import { fileKey, isPhantomChange } from "./models";
import { posix } from "path";

/**
 * The file rows of one review scope (Changes, Merged, or one changeset) as
 * directory groups or a flat list. Pure: the Review view wraps these nodes in
 * tree items, and the editors' previous/next order comes from the same nodes,
 * so navigation always follows what the tree shows.
 */

export type FileLayout = "tree" | "list";

/** Folders start expanded up to this many files in the scope; a 5,000-row branch diff starts collapsed. */
export const AUTO_EXPAND_LIMIT = 200;

export interface IFileTreeFolder<G> {
  readonly kind: "folder";
  readonly id: string;
  /** Server path of the directory. */
  readonly path: string;
  /** The directory without its leading `/`: `Assets/Code/Core`. */
  readonly label: string;
  /** Always undefined: directory groups sit directly under their scope. */
  readonly parent?: IFileTreeFolder<G>;
  /** The files directly in the directory; empty for a directory record shown on its own. */
  readonly children: Array<FileTreeNode<G>>;
  /** Every file row of the group, directory records excluded: what the folder checkbox covers. */
  readonly files: IChangesetFileChange[];
  /** cm's records for the directory itself (added, moved or deleted directories). */
  readonly directories: IChangesetFileChange[];
  readonly expanded: boolean;
  readonly group: G;
}

export interface IFileTreeFile<G> {
  readonly kind: "file";
  /** `<prefix>/<path>@<revisionId>`: a delete and a re-add of one path are two rows. */
  readonly id: string;
  readonly file: IChangesetFileChange;
  readonly label: string;
  readonly parent?: IFileTreeFolder<G>;
  readonly group: G;
}

export type FileTreeNode<G> = IFileTreeFolder<G> | IFileTreeFile<G>;

export interface IFileTree<G> {
  readonly layout: FileLayout;
  readonly roots: Array<FileTreeNode<G>>;
  /** File nodes by `fileKey`, for reveal and navigation. */
  readonly byKey: ReadonlyMap<string, IFileTreeFile<G>>;
  /** Every file node in display order. */
  readonly files: Array<IFileTreeFile<G>>;
}

/** The Explorer's order: case-insensitive, numbers by value. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Builds the nodes of one scope. `idPrefix` makes ids unique across scopes and
 * reviews; `group` is stored on every node so a node alone says which scope
 * and comparison it belongs to.
 */
export function buildFileNodes<G>(
    files: readonly IChangesetFileChange[],
    layout: FileLayout,
    idPrefix: string,
    group: G): IFileTree<G> {
  const expanded = files.filter(file => file.revisionType !== RevisionType.Directory).length <= AUTO_EXPAND_LIMIT;
  const ids = new Set<string>();
  const uniqueId = (id: string) => {
    let candidate = id;
    for (let index = 2; ids.has(candidate); index++) {
      candidate = `${id}#${index}`;
    }
    ids.add(candidate);
    return candidate;
  };
  const roots = layout === "list"
    ? buildList(files, idPrefix, group, uniqueId)
    : buildTree(files, idPrefix, group, expanded, uniqueId);
  const ordered: Array<IFileTreeFile<G>> = [];
  walk(roots, node => {
    if (node.kind === "file") {
      ordered.push(node);
    }
  });
  const byKey = new Map<string, IFileTreeFile<G>>();
  for (const node of ordered) {
    const key = fileKey(node.file);
    if (!byKey.has(key)) {
      byKey.set(key, node);
    }
  }
  return { byKey, files: ordered, layout, roots };
}

/** Files in display order, without the rows that have no text diff (binaries, directories, phantoms). */
export function navigationOrder<G>(nodes: ReadonlyArray<FileTreeNode<G>>): IChangesetFileChange[] {
  const order: IChangesetFileChange[] = [];
  walk(nodes, node => {
    if (node.kind === "file" && isDiffable(node.file)) {
      order.push(node.file);
    }
  });
  return order;
}

export function isDiffable(file: IChangesetFileChange): boolean {
  return noDiffReason(file) === undefined;
}

/** `noDiffReason` of a text row that records no change, or only the same revision on both sides. */
export const NO_CONTENT_CHANGE = "No content change recorded";
/** `noDiffReason` of a changed text row without a base revision. */
export const SOURCE_UNAVAILABLE = "Source revision unavailable";

/**
 * Why a row opens no text diff; undefined when it does. The tree's row kinds,
 * previous/next and the editors all ask this one function, so a row the tree
 * offers to open is never one the editors refuse.
 */
export function noDiffReason(file: IChangesetFileChange): string | undefined {
  switch (file.revisionType) {
  case RevisionType.Directory:
    return "Directory";
  case RevisionType.BinaryFile:
    return "Binary file: no text diff";
  case RevisionType.TextFile:
    break;
  default:
    return "Not a file or directory: no text diff";
  }
  if (file.status === FileChangeStatus.None || isPhantomChange(file)) {
    return NO_CONTENT_CHANGE;
  }
  const addedOrDeleted = !!(file.status & (FileChangeStatus.Added | FileChangeStatus.Deleted));
  const pureMove = !!(file.status & FileChangeStatus.Moved) && !(file.status & FileChangeStatus.Changed);
  // A change's left side is its base revision; without one the diff would pass the file off as added.
  if (!addedOrDeleted && !pureMove && file.baseRevisionId < 0) {
    return SOURCE_UNAVAILABLE;
  }
  return undefined;
}

/**
 * The structural part of a file row's description: list rows lead with their
 * directory; `N discussions`, `same revision as head`, `binary` and the move
 * follow, joined with ` · `. `sameAsHead` is for a changeset row whose
 * revision is also the review head's, so its viewed state is shared.
 */
export function fileDescription(
    file: IChangesetFileChange,
    layout: FileLayout,
    discussions = 0,
    sameAsHead = false): string {
  const parts: string[] = [];
  if (layout === "list") {
    const directory = directoryOf(file.path);
    if (directory) {
      parts.push(directory);
    }
  }
  if (discussions > 0) {
    parts.push(`${discussions} ${discussions === 1 ? "discussion" : "discussions"}`);
  }
  if (sameAsHead) {
    parts.push("same revision as head");
  }
  if (file.revisionType === RevisionType.BinaryFile) {
    parts.push("binary");
  } else if (file.revisionType === RevisionType.TextFile) {
    const reason = noDiffReason(file);
    if (reason) {
      parts.push(reason === SOURCE_UNAVAILABLE ? "source revision unavailable" : "no content change");
    }
  }
  const move = moveDescription(file);
  if (move) {
    parts.push(move);
  }
  return parts.join(" · ");
}

/** What cm recorded for a directory itself: `added`, `deleted`, `← Old` or `moved`. */
export function folderDescription(folder: IFileTreeFolder<unknown>, layout: FileLayout): string {
  const parts: string[] = [];
  if (layout === "list" && !folder.children.length) {
    const directory = directoryOf(folder.path);
    if (directory) {
      parts.push(directory);
    }
  }
  for (const record of folder.directories) {
    const move = moveDescription(record);
    if (move) {
      parts.push(move);
    } else if (record.status & FileChangeStatus.Added) {
      parts.push("added");
    } else if (record.status & FileChangeStatus.Deleted) {
      parts.push("deleted");
    }
  }
  return Array.from(new Set(parts)).join(" · ");
}

/** `Assets/Code` for `/Assets/Code/Foo.cs`; empty at the repository root. */
export function directoryOf(path: string): string {
  const directory = posix.dirname(path).replace(/^\/+/, "");
  return directory === "." ? "" : directory;
}

/** Depth-first, in display order. */
export function walk<G>(nodes: ReadonlyArray<FileTreeNode<G>>, visit: (node: FileTreeNode<G>) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "folder") {
      walk(node.children, visit);
    }
  }
}

function moveDescription(file: IChangesetFileChange): string | undefined {
  if (!(file.status & FileChangeStatus.Moved) || !file.oldPath) {
    return undefined;
  }
  const renamedInPlace = posix.dirname(file.oldPath) === posix.dirname(file.path);
  return renamedInPlace ? `← ${posix.basename(file.oldPath)}` : "moved";
}

function buildList<G>(
    files: readonly IChangesetFileChange[],
    idPrefix: string,
    group: G,
    uniqueId: (id: string) => string): Array<FileTreeNode<G>> {
  return files
    .slice()
    .sort((a, b) => compareNames(a.path, b.path) || a.revisionId - b.revisionId)
    .map((file): FileTreeNode<G> => {
      const id = uniqueId(`${idPrefix}/${file.path}@${file.revisionId}`);
      if (file.revisionType === RevisionType.Directory) {
        return {
          children: [],
          directories: [file],
          expanded: false,
          files: [],
          group,
          id,
          kind: "folder",
          label: posix.basename(file.path) || file.path,
          path: file.path,
        };
      }
      return { file, group, id, kind: "file", label: posix.basename(file.path) || file.path };
    });
}

/**
 * One folder row per directory that has rows, labelled with its whole path
 * (`Assets/Code/Inventory`) and holding the files directly in it; folders in
 * path order, then the files at the repository root. A directory record goes
 * on its directory's row; a directory with a record but no files of its own
 * is a row of its own, as in the list.
 */
function buildTree<G>(
    files: readonly IChangesetFileChange[],
    idPrefix: string,
    group: G,
    expanded: boolean,
    uniqueId: (id: string) => string): Array<FileTreeNode<G>> {
  const directories = new Map<string, { files: IChangesetFileChange[]; records: IChangesetFileChange[] }>();
  const entry = (directory: string) => {
    let known = directories.get(directory);
    if (!known) {
      known = { files: [], records: [] };
      directories.set(directory, known);
    }
    return known;
  };
  const rootFiles: IChangesetFileChange[] = [];
  for (const file of files) {
    if (file.revisionType === RevisionType.Directory) {
      const directory = file.path.replace(/^\/+|\/+$/g, "");
      if (directory) {
        entry(directory).records.push(file);
      }
    } else {
      const directory = directoryOf(file.path);
      if (directory) {
        entry(directory).files.push(file);
      } else {
        rootFiles.push(file);
      }
    }
  }
  const folders = Array.from(directories.keys())
    .sort(comparePaths)
    .map((directory): IFileTreeFolder<G> => {
      const content = directories.get(directory)!;
      const folder: IFileTreeFolder<G> & { children: Array<FileTreeNode<G>> } = {
        children: [],
        directories: content.records,
        expanded,
        files: [],
        group,
        id: uniqueId(`${idPrefix}/${directory}/`),
        kind: "folder",
        label: directory,
        path: `/${directory}`,
      };
      folder.children = fileNodes(content.files, folder, idPrefix, group, uniqueId);
      folder.files.push(...folder.children.map(node => (node as IFileTreeFile<G>).file));
      return folder;
    });
  return (folders as Array<FileTreeNode<G>>).concat(fileNodes(rootFiles, undefined, idPrefix, group, uniqueId));
}

/** The files of one directory, by name as the Explorer sorts them. */
function fileNodes<G>(
    files: readonly IChangesetFileChange[],
    parent: IFileTreeFolder<G> | undefined,
    idPrefix: string,
    group: G,
    uniqueId: (id: string) => string): Array<FileTreeNode<G>> {
  return files
    .slice()
    .sort((a, b) => compareNames(posix.basename(a.path), posix.basename(b.path)) || a.revisionId - b.revisionId)
    .map((file): IFileTreeFile<G> => ({
      file,
      group,
      id: uniqueId(`${idPrefix}/${file.path}@${file.revisionId}`),
      kind: "file",
      label: posix.basename(file.path),
      parent,
    }));
}

/** Directory paths segment by segment, so `Assets/Code/*` stays together ahead of `Assets/Code-Gen`. */
function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = compareNames(left[index], right[index]);
    if (order) {
      return order;
    }
  }
  return left.length - right.length;
}

/** The Explorer's order, for paths and names alike; ties broken by code point so the order is total. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
