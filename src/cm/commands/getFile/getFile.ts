import { dirname, join, relative } from "path";
import { existsSync, promises } from "fs";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { GetFileParser } from "./getFileParser";
import { Uri } from "vscode";

export class GetFile {
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

    const result: ICmResult<void> = await shell.exec(
      "getfile",
      [ fileSpec, `--file=${outputFile}` ],
      parser);

    if (!result.success) {
      throw result.error ?? new Error(`Unable to get ${fileSpec}`);
    }

    if (result.error) {
      throw result.error;
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

  private static cacheDir(rootDir: string): string {
    return join(rootDir, ".plastic", "fileCache");
  }
}
