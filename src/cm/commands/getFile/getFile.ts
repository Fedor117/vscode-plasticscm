import { createHash, randomBytes } from "crypto";
import { dirname, extname, join, relative } from "path";
import { existsSync, promises } from "fs";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { GetFileParser } from "./getFileParser";
import { Uri } from "vscode";

export class GetFile {
  /** Revision fetches in flight, keyed by the cache file they write. */
  private static readonly mPendingRevisions = new Map<string, Promise<Uri>>();

  public static cachedFileLocation(
      rootDir: string,
      filePath: Uri,
      changeset: number
  ): Uri {
    const outputFile = join(
      GetFile.cacheDir(rootDir), changeset.toString(), relative(rootDir, filePath.fsPath));
    return Uri.file(outputFile);
  }

  public static async run(
      rootDir: string,
      filePath: Uri,
      changeset: number,
      shell: ICmShell
  ): Promise<Uri | undefined> {
    const parser: ICmParser<void> = new GetFileParser();

    if (filePath.fsPath.includes(".plastic")) {
      return undefined;
    }

    const fileSpec = `${filePath.fsPath}#cs:${changeset}`;
    const outputFile = GetFile.cachedFileLocation(rootDir, filePath, changeset).fsPath;

    if (existsSync(outputFile)) {
      return Uri.file(outputFile);
    }

    // make sure the directory exists where we're going to store the outputFile
    // creates fileCache along the way if it doesn't exist yet
    await promises.mkdir(dirname(outputFile), { recursive: true });

    // Existence is the cache hit test above, so the entry has to appear whole:
    // cm writes into `--file=` as it goes, and a command that is cut short (a
    // timeout restarts the shell, and disposal kills the process) would leave a
    // truncated file that is served as the revision from then on. A leftover
    // `.partial` never matches the hit test and goes with the changeset
    // directory at the next prune.
    const partialFile = `${outputFile}.partial`;

    const result: ICmResult<void> = await shell.exec(
      "getfile",
      [ fileSpec, `--file=${partialFile}` ],
      parser);

    const error = result.success ? result.error : result.error ?? new Error(`Unable to get ${fileSpec}`);
    if (error) {
      await promises.rm(partialFile, { force: true });
      throw error;
    }

    try {
      await promises.rename(partialFile, outputFile);
    } catch (e) {
      throw new Error(
        `cm reported no error but wrote no content for ${fileSpec}: ${(e as Error).message}`);
    }

    return Uri.file(outputFile);
  }

  /**
   * Drops revisions the workspace has moved past. Called once per refresh — doing
   * it per file meant re-listing the whole cache directory for every fetch.
   */
  public static async pruneCache(rootDir: string, changeset: number): Promise<void> {
    const cacheDir = GetFile.cacheDir(rootDir);
    if (!existsSync(cacheDir)) {
      return;
    }

    const cacheDirContents = await promises.readdir(cacheDir);
    await Promise.all(cacheDirContents.map(async file => {
      const fileNameAsChangeset = parseInt(file, 10);
      if (isNaN(fileNameAsChangeset) || fileNameAsChangeset >= changeset) {
        return;
      }
      await promises.rm(join(cacheDir, file), { force: true, recursive: true });
    }));
  }

  /**
   * `<root>/.plastic/fileCache/revisions/<rep>/<revid>/content<ext>`. Revision ids
   * are only unique within a repository, so an xlinked repository gets its own
   * subtree; within one, the key is the revision and the extension, so a pure
   * move (one revision under two names) is fetched once and the extension
   * survives for language detection of the cached file.
   */
  public static revisionCacheLocation(
      rootDir: string,
      revisionId: number,
      repository: string,
      fileName: string): Uri {
    return Uri.file(join(
      GetFile.revisionCacheDir(rootDir),
      GetFile.repositoryKey(repository),
      revisionId.toString(),
      `content${extname(fileName)}`));
  }

  /**
   * Fetches a revision by id, which is how history diffs reach content that no
   * longer exists at any workspace path (deleted or moved items).
   */
  public static async runRevision(
      rootDir: string,
      revisionId: number,
      repository: string,
      fileName: string,
      shell: ICmShell
  ): Promise<Uri> {
    const outputFile = GetFile.revisionCacheLocation(rootDir, revisionId, repository, fileName).fsPath;

    if (existsSync(outputFile)) {
      // Both sides of a diff read the file long after it was written; refreshing
      // the timestamp keeps the prune from removing what is still in use.
      await GetFile.touch(outputFile);
      return Uri.file(outputFile);
    }

    // A diff of a moved file asks for one revision under two names at once, and
    // two cm processes writing the same target would race.
    const pending = GetFile.mPendingRevisions.get(outputFile);
    if (pending) {
      return pending;
    }

    const fetch = GetFile.fetchRevision(outputFile, revisionId, repository, shell);
    GetFile.mPendingRevisions.set(outputFile, fetch);
    try {
      return await fetch;
    } finally {
      GetFile.mPendingRevisions.delete(outputFile);
    }
  }

  /**
   * Drops revision cache entries older than `maxAgeMillis`. Never throws: it runs
   * on every status refresh and a failed cleanup must not fail the refresh.
   */
  public static async pruneRevisionCache(rootDir: string, maxAgeMillis: number): Promise<void> {
    const revisionsDir = GetFile.revisionCacheDir(rootDir);
    const cutoff = Date.now() - maxAgeMillis;

    let entries: string[];
    try {
      entries = await promises.readdir(revisionsDir);
    } catch {
      return;
    }

    // The tree is `<revisions>/<repository>/<revid>/content<ext>`, so the ages
    // that matter are one level below the repository directories.
    await Promise.all(entries.map(repositoryEntry =>
      GetFile.pruneRepositoryRevisions(join(revisionsDir, repositoryEntry), cutoff)));
  }

  private static async pruneRepositoryRevisions(repositoryDir: string, cutoff: number): Promise<void> {
    let entries: string[];
    try {
      entries = await promises.readdir(repositoryDir);
    } catch {
      return;
    }

    let removed = 0;
    await Promise.all(entries.map(async entry => {
      const entryPath = join(repositoryDir, entry);
      try {
        // The directory's mtime is set when cm writes the content into it, and
        // refreshed whenever a diff reads it again, so it tells when the revision
        // was last needed.
        const stats = await promises.stat(entryPath);
        if (stats.mtimeMs >= cutoff) {
          return;
        }
        await promises.rm(entryPath, { force: true, recursive: true });
        removed += 1;
      } catch {
        // A fetch racing the prune can remove or recreate an entry underneath us.
      }
    }));

    if (removed === entries.length) {
      // `rmdir` on a directory a fetch has just repopulated fails, which is the
      // wanted outcome: only an empty leftover goes away.
      await promises.rmdir(repositoryDir).catch(() => undefined);
    }
  }

  private static async fetchRevision(
      outputFile: string,
      revisionId: number,
      repository: string,
      shell: ICmShell): Promise<Uri> {
    // cm does not create the target directory: without it getfile fails with
    // "Could not find a part of the path".
    await promises.mkdir(dirname(outputFile), { recursive: true });

    // The qualified spec is what resolves revisions of xlinked repositories.
    const revisionSpec = repository ? `revid:${revisionId}@rep:${repository}` : `revid:${revisionId}`;

    // cm writes into `--file=` as it goes, so a command that fails or is cut
    // short leaves a truncated file behind. Under the final name that would be
    // served from the cache as the revision's content for a day. Writing to a
    // sibling and renaming on success makes the cache entry all-or-nothing, and
    // any leftover is ignored (the name never matches) until the prune.
    // The sibling's name is unique per fetch: the cache root can be shared by
    // several extension hosts, `mPendingRevisions` only deduplicates within one,
    // and cm rewrites an existing `--file=` target in place, so two hosts
    // fetching one revision into one shared name could truncate each other's
    // content between the write and the rename.
    const partialFile = `${outputFile}.${process.pid}.${randomBytes(4).toString("hex")}.partial`;
    const result: ICmResult<void> = await shell.exec(
      "getfile",
      [ revisionSpec, `--file=${partialFile}` ],
      new GetFileParser());

    const error = result.success ? result.error : result.error ?? new Error(`Unable to get ${revisionSpec}`);
    if (error) {
      await promises.rm(partialFile, { force: true });
      throw error;
    }

    try {
      await promises.rename(partialFile, outputFile);
    } catch (e) {
      await promises.rm(partialFile, { force: true });
      // Another host can put its copy in place first (Windows refuses to replace
      // a file someone has open). A revision is immutable, so that copy is the
      // same content and the entry is good.
      if (existsSync(outputFile)) {
        return Uri.file(outputFile);
      }
      throw new Error(
        `cm reported no error but wrote no content for ${revisionSpec}: ${(e as Error).message}`);
    }

    return Uri.file(outputFile);
  }

  /**
   * A repository spec is not a safe directory name (it carries `/`, `@` and `:`),
   * and only has to be told apart from the other specs in the same workspace.
   */
  private static repositoryKey(repository: string): string {
    return repository
      ? createHash("sha1").update(repository).digest("hex").substring(0, 12)
      : "default";
  }

  private static async touch(target: string): Promise<void> {
    const now = new Date();
    // The revision directory carries the age; the prune never stats the file.
    await promises.utimes(dirname(target), now, now).catch(() => undefined);
  }

  private static cacheDir(rootDir: string): string {
    return join(rootDir, ".plastic", "fileCache");
  }

  private static revisionCacheDir(rootDir: string): string {
    return join(GetFile.cacheDir(rootDir), "revisions");
  }
}
