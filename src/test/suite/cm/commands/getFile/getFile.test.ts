import * as os from "os";
import * as path from "path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { ICmParser, ICmShell } from "../../../../../cm/shell";
import { IMock, It, Mock, MockBehavior, Times } from "typemoq";
import { expect } from "chai";
import { GetFile } from "../../../../../cm/commands";
import { Uri } from "vscode";

const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";
const XLINKED_REPOSITORY = "SharedLibs@acme-studio@unity";
const DAY_MILLIS = 24 * 60 * 60 * 1000;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function runCatchingRevision(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // The test is about what happens next.
  }
}

/** Stands in for cm, which writes the content to whatever `--file=` names. */
function writeWhereCmWould(args: string[], content = "using System;"): string {
  const target = args.map(arg => arg.replace(/^--file=/, "")).find(arg => arg !== args[0])!;
  writeFileSync(target, content);
  return target;
}

/** A cm stand-in: reports `result` and lets the test write what cm would write. */
function mockShell(
    onExec: (args: string[]) => void,
    result?: { error?: Error; success: boolean }): IMock<ICmShell> {
  const shell = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
  shell
    .setup(mock => mock.exec(
      It.isValue("getfile"),
      It.is<string[]>(() => true),
      It.is<ICmParser<void>>(() => true)))
    .returns((_command: string, args: string[]) => {
      onExec(args);
      return Promise.resolve(result ?? { success: true });
    });
  return shell;
}

describe("GetFile command", () => {
  describe("revisionCacheLocation", () => {
    it("keys the cache by revision id and keeps the extension for language detection", () => {
      const location = GetFile.revisionCacheLocation("/wk", 12347, REPOSITORY, "/Assets/Code/Foo.cs");

      expect(location.fsPath).to.match(
        new RegExp(`^${escapeRegExp(path.join("/wk", ".plastic", "fileCache", "revisions"))}`
          + `${escapeRegExp(path.sep)}[0-9a-f]{12}${escapeRegExp(path.sep)}12347`
          + `${escapeRegExp(path.sep)}content\\.cs$`));
    });

    it("handles an extension-less name", () => {
      const location = GetFile.revisionCacheLocation("/wk", 10301, REPOSITORY, "/Jenkinsfile_track_import");

      expect(location.fsPath).to.equal(path.join(
        path.dirname(path.dirname(location.fsPath)), "10301", "content"));
    });

    it("keeps only the last extension of a dotted name", () => {
      const location = GetFile.revisionCacheLocation(
        "/wk", 5631, REPOSITORY, "/Assets/UISlowLapWarning.cs.meta");

      expect(path.basename(location.fsPath)).to.equal("content.meta");
    });

    it("resolves one revision under two names to the same file, so a pure move is fetched once", () => {
      const oldName = GetFile.revisionCacheLocation(
        "/wk", 5631, REPOSITORY, "/Assets/UISlowLapWarning.cs.meta");
      const newName = GetFile.revisionCacheLocation(
        "/wk", 5631, REPOSITORY, "/Assets/UILapTimeBanner.cs.meta");

      expect(oldName.fsPath).to.equal(newName.fsPath);
    });

    it("separates the same revision id in two repositories, because ids are per repository", () => {
      const local = GetFile.revisionCacheLocation("/wk", 42, REPOSITORY, "/Assets/Foo.cs");
      const xlinked = GetFile.revisionCacheLocation("/wk", 42, XLINKED_REPOSITORY, "/Assets/Foo.cs");

      expect(local.fsPath).to.not.equal(xlinked.fsPath);
      expect(path.basename(path.dirname(local.fsPath))).to.equal(path.basename(path.dirname(xlinked.fsPath)));
    });

    it("falls back to a fixed directory when the repository is unknown", () => {
      const location = GetFile.revisionCacheLocation("/wk", 42, "", "/Assets/Foo.cs");

      expect(location.fsPath).to.equal(
        path.join("/wk", ".plastic", "fileCache", "revisions", "default", "42", "content.cs"));
    });
  });

  describe("run", () => {
    let rootDir: string;

    beforeEach(() => {
      rootDir = mkdtempSync(path.join(os.tmpdir(), "plastic-getfile-"));
    });

    afterEach(() => {
      rmSync(rootDir, { force: true, recursive: true });
    });

    const workspaceFile = (): Uri => Uri.file(path.join(rootDir, "Assets", "Code", "Boot.cs"));

    it("publishes the entry by rename, so a command cut short leaves nothing to serve", async () => {
      const expectedOutput = GetFile.cachedFileLocation(rootDir, workspaceFile(), 3571).fsPath;
      let receivedArgs: string[] = [];
      const shell = mockShell(args => {
        receivedArgs = args;
        writeWhereCmWould(args);
      });

      const result = await GetFile.run(rootDir, workspaceFile(), 3571, shell.object);

      expect(receivedArgs[1]).to.equal(`--file=${expectedOutput}.partial`);
      expect(result?.fsPath).to.equal(expectedOutput);
      expect(existsSync(expectedOutput)).to.be.true;
      expect(existsSync(`${expectedOutput}.partial`)).to.be.false;
    });

    it("leaves no cache entry behind when the command fails part way through", async () => {
      const expectedOutput = GetFile.cachedFileLocation(rootDir, workspaceFile(), 3571).fsPath;
      // cm writes as it goes, so a failure can still have produced content.
      const shell = mockShell(
        args => writeWhereCmWould(args, "half a fi"),
        { error: new Error("Connection reset"), success: false });

      try {
        await GetFile.run(rootDir, workspaceFile(), 3571, shell.object);
      } catch {
        // The point of the test is what is left on disk.
      }

      expect(existsSync(expectedOutput), "a truncated file must not become a cache entry").to.be.false;
      expect(existsSync(`${expectedOutput}.partial`)).to.be.false;
    });

    it("serves the second request from the cache without calling cm", async () => {
      const shell = mockShell(args => writeWhereCmWould(args));

      const first = await GetFile.run(rootDir, workspaceFile(), 3571, shell.object);
      const second = await GetFile.run(rootDir, workspaceFile(), 3571, shell.object);

      expect(second?.fsPath).to.equal(first?.fsPath);
      shell.verify(
        mock => mock.exec(It.isAnyString(), It.is<string[]>(() => true), It.is<ICmParser<void>>(() => true)),
        Times.once());
    });

    it("never asks cm for the extension's own cache directory", async () => {
      // A strict mock with no setup fails the test if cm is called at all.
      const shell = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);

      const result = await GetFile.run(
        rootDir, Uri.file(path.join(rootDir, ".plastic", "plastic.workspace")), 3571, shell.object);

      expect(result).to.be.undefined;
    });
  });

  describe("runRevision", () => {
    let rootDir: string;

    beforeEach(() => {
      rootDir = mkdtempSync(path.join(os.tmpdir(), "plastic-getfile-"));
    });

    afterEach(() => {
      rmSync(rootDir, { force: true, recursive: true });
    });

    it("creates the target directory before asking cm to write into it", async () => {
      const expectedOutput =
        GetFile.revisionCacheLocation(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs").fsPath;
      const targetDir = path.dirname(expectedOutput);
      let directoryExistedAtExec = false;
      let receivedArgs: string[] = [];
      const shell = mockShell(args => {
        directoryExistedAtExec = existsSync(targetDir);
        receivedArgs = args;
        writeWhereCmWould(args);
      });

      expect(existsSync(targetDir)).to.be.false;

      const result = await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);

      expect(directoryExistedAtExec).to.be.true;
      // cm writes to a sibling; the entry only takes its real name once the
      // command has come back clean.
      expect(receivedArgs).to.eql([ `revid:12347@rep:${REPOSITORY}`, `--file=${expectedOutput}.partial` ]);
      expect(result.fsPath).to.equal(expectedOutput);
      expect(existsSync(`${expectedOutput}.partial`)).to.be.false;
    });

    it("uses the bare revid spec when no repository is given", async () => {
      let receivedArgs: string[] = [];
      const shell = mockShell(args => {
        receivedArgs = args;
        writeWhereCmWould(args);
      });

      await GetFile.runRevision(rootDir, 12347, "", "/Assets/Code/Foo.cs", shell.object);

      expect(receivedArgs[0]).to.equal("revid:12347");
    });

    it("serves the second request from the cache without calling cm", async () => {
      const shell = mockShell(args => writeWhereCmWould(args));

      const first = await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);
      const second = await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);

      expect(second.fsPath).to.equal(first.fsPath);
      shell.verify(
        mock => mock.exec(It.isAnyString(), It.is<string[]>(() => true), It.is<ICmParser<void>>(() => true)),
        Times.once());
    });

    it("fetches one revision once when both sides of a moved file ask at the same time", async () => {
      let release: () => void = () => undefined;
      const parked = new Promise<void>(resolve => {
        release = resolve;
      });
      const shell = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
      shell
        .setup(mock => mock.exec(
          It.isValue("getfile"),
          It.is<string[]>(() => true),
          It.is<ICmParser<void>>(() => true)))
        .returns(async (_command: string, args: string[]) => {
          await parked;
          writeWhereCmWould(args);
          return { success: true };
        });

      // A pure move diffs one revision under two names, so both sides resolve
      // the same cache file at once.
      const both = Promise.all([
        GetFile.runRevision(rootDir, 5631, REPOSITORY, "/Assets/Old.cs", shell.object),
        GetFile.runRevision(rootDir, 5631, REPOSITORY, "/Assets/New.cs", shell.object),
      ]);
      release();
      const [ first, second ] = await both;

      expect(second.fsPath).to.equal(first.fsPath);
      shell.verify(
        mock => mock.exec(It.isAnyString(), It.is<string[]>(() => true), It.is<ICmParser<void>>(() => true)),
        Times.once());
    });

    it("gives both concurrent callers the same failure and keeps neither in flight", async () => {
      let attempts = 0;
      let release: (result: { error?: Error; success: boolean }) => void = () => undefined;
      const parked = new Promise<{ error?: Error; success: boolean }>(resolve => {
        release = resolve;
      });
      const expectedError = new Error("Connection reset");
      const shell = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
      shell
        .setup(mock => mock.exec(
          It.isValue("getfile"),
          It.is<string[]>(() => true),
          It.is<ICmParser<void>>(() => true)))
        .returns(async (_command: string, args: string[]) => {
          attempts += 1;
          const result = attempts === 1 ? await parked : { success: true };
          if (result.success) {
            writeWhereCmWould(args);
          }
          return result;
        });

      const outcomes = Promise.allSettled([
        GetFile.runRevision(rootDir, 5633, REPOSITORY, "/Assets/Old.cs", shell.object),
        GetFile.runRevision(rootDir, 5633, REPOSITORY, "/Assets/New.cs", shell.object),
      ]);
      // Resolved rather than rejected: a failed command is a result the shell
      // reports, and rejecting the gate here would abort the whole mocha run.
      release({ error: expectedError, success: false });
      const settled = await outcomes;

      expect(settled.map(outcome => outcome.status)).to.eql([ "rejected", "rejected" ]);
      expect(settled.map(outcome => (outcome as PromiseRejectedResult).reason as Error))
        .to.eql([ expectedError, expectedError ]);

      // The map must not keep a rejected promise every later caller replays.
      const retried = await GetFile.runRevision(rootDir, 5633, REPOSITORY, "/Assets/New.cs", shell.object);
      expect(attempts, "a failed fetch must not be remembered as in flight").to.equal(2);
      expect(existsSync(retried.fsPath)).to.be.true;
    });

    it("lets the next request try again after a fetch failed", async () => {
      let attempts = 0;
      const shell = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);
      shell
        .setup(mock => mock.exec(
          It.isValue("getfile"),
          It.is<string[]>(() => true),
          It.is<ICmParser<void>>(() => true)))
        .returns((_command: string, args: string[]) => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.resolve({ error: new Error("Connection reset"), success: false });
          }
          writeWhereCmWould(args);
          return Promise.resolve({ success: true });
        });

      await runCatchingRevision(() => GetFile.runRevision(
        rootDir, 5632, REPOSITORY, "/Assets/Foo.cs", shell.object));
      const retried = await GetFile.runRevision(rootDir, 5632, REPOSITORY, "/Assets/Foo.cs", shell.object);

      expect(attempts, "a failed fetch must not be remembered as in flight").to.equal(2);
      expect(existsSync(retried.fsPath)).to.be.true;
    });

    it("leaves no cache entry behind when the command fails part way through", async () => {
      const expectedOutput =
        GetFile.revisionCacheLocation(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs").fsPath;
      // cm writes as it goes, so a failure can still have produced content.
      const shell = mockShell(
        args => writeWhereCmWould(args, "half a fi"),
        { error: new Error("Connection reset"), success: false });

      try {
        await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);
      } catch {
        // The point of the test is what is left on disk.
      }

      expect(existsSync(expectedOutput), "a truncated revision must not become a cache entry").to.be.false;
      expect(existsSync(`${expectedOutput}.partial`)).to.be.false;
    });

    it("reports a command that claims success but writes nothing", async () => {
      const shell = mockShell(() => undefined, { success: true });
      let error: Error | undefined;

      try {
        await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);
      } catch (e) {
        error = e as Error;
      }

      expect(error?.message).to.contain("wrote no content for revid:12347");
    });

    it("throws the shell error when the command fails", async () => {
      const expectedError = new Error("Could not find a part of the path");
      const shell = mockShell(() => undefined, { error: expectedError, success: false });
      let error: Error | undefined;

      try {
        await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);
      } catch (e) {
        error = e as Error;
      }

      expect(error).to.equal(expectedError);
    });

    it("names the revision spec when the command fails without an error", async () => {
      const shell = mockShell(() => undefined, { success: false });
      let error: Error | undefined;

      try {
        await GetFile.runRevision(rootDir, 12347, "", "/Assets/Code/Foo.cs", shell.object);
      } catch (e) {
        error = e as Error;
      }

      expect(error?.message).to.contain("revid:12347");
    });

    it("throws when the command succeeded but reported an error", async () => {
      const expectedError = new Error("Sample error");
      const shell = mockShell(() => undefined, { error: expectedError, success: true });
      let error: Error | undefined;

      try {
        await GetFile.runRevision(rootDir, 12347, REPOSITORY, "/Assets/Code/Foo.cs", shell.object);
      } catch (e) {
        error = e as Error;
      }

      expect(error).to.equal(expectedError);
    });
  });

  describe("pruneRevisionCache", () => {
    let rootDir: string;

    beforeEach(() => {
      rootDir = mkdtempSync(path.join(os.tmpdir(), "plastic-getfile-"));
    });

    afterEach(() => {
      rmSync(rootDir, { force: true, recursive: true });
    });

    /** Writes a revision into the cache the way `runRevision` would. */
    function seedRevision(revisionId: number, repository: string, ageMillis = 0): string {
      const file = GetFile.revisionCacheLocation(rootDir, revisionId, repository, "/Assets/Foo.cs").fsPath;
      const dir = path.dirname(file);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, "content");

      // Writing into the directory bumped its mtime, so back-date it afterwards.
      const seconds = (Date.now() - ageMillis) / 1000;
      utimesSync(dir, seconds, seconds);
      return dir;
    }

    it("removes only the entries older than the maximum age", async () => {
      const oldEntry = seedRevision(2080, REPOSITORY, 2 * DAY_MILLIS);
      const freshEntry = seedRevision(2241, REPOSITORY);
      const changesetEntry = path.join(rootDir, ".plastic", "fileCache", "3622");
      mkdirSync(changesetEntry, { recursive: true });

      await GetFile.pruneRevisionCache(rootDir, DAY_MILLIS);

      expect(existsSync(oldEntry)).to.be.false;
      expect(existsSync(freshEntry)).to.be.true;
      expect(existsSync(changesetEntry)).to.be.true;
    });

    it("ages every repository's revisions separately", async () => {
      const oldLocal = seedRevision(42, REPOSITORY, 2 * DAY_MILLIS);
      const freshXlinked = seedRevision(42, XLINKED_REPOSITORY);

      await GetFile.pruneRevisionCache(rootDir, DAY_MILLIS);

      expect(existsSync(oldLocal)).to.be.false;
      expect(existsSync(freshXlinked)).to.be.true;
    });

    it("drops a repository directory once its last revision has gone", async () => {
      const entry = seedRevision(42, REPOSITORY, 2 * DAY_MILLIS);

      await GetFile.pruneRevisionCache(rootDir, DAY_MILLIS);

      expect(existsSync(path.dirname(entry))).to.be.false;
    });

    it("keeps a revision a diff has just read, because the cache hit refreshed it", async () => {
      const entry = seedRevision(42, REPOSITORY, 2 * DAY_MILLIS);
      const shell = Mock.ofType<ICmShell>(undefined, MockBehavior.Strict);

      // A cache hit must not call cm; the strict mock fails the test if it does.
      await GetFile.runRevision(rootDir, 42, REPOSITORY, "/Assets/Foo.cs", shell.object);
      await GetFile.pruneRevisionCache(rootDir, DAY_MILLIS);

      expect(existsSync(entry)).to.be.true;
    });

    it("clears out the pre-repository cache layout an upgrade leaves behind", async () => {
      // Before revision ids were keyed by repository the layout was
      // `revisions/<revid>/content<ext>`, which the two-level walk now reads as a
      // repository directory holding one file.
      const revisions = path.join(rootDir, ".plastic", "fileCache", "revisions");
      const stale = path.join(revisions, "12347");
      const fresh = path.join(revisions, "12151");
      mkdirSync(stale, { recursive: true });
      mkdirSync(fresh, { recursive: true });
      writeFileSync(path.join(stale, "content.cs"), "stale");
      writeFileSync(path.join(fresh, "content.cs"), "fresh");
      const twoDaysAgoSeconds = (Date.now() - 2 * DAY_MILLIS) / 1000;
      utimesSync(path.join(stale, "content.cs"), twoDaysAgoSeconds, twoDaysAgoSeconds);

      await GetFile.pruneRevisionCache(rootDir, DAY_MILLIS);

      expect(existsSync(stale)).to.be.false;
      expect(existsSync(fresh)).to.be.true;
    });

    it("tolerates a file where it expects a repository directory", async () => {
      const revisions = path.join(rootDir, ".plastic", "fileCache", "revisions");
      mkdirSync(revisions, { recursive: true });
      writeFileSync(path.join(revisions, "stray.tmp"), "x");

      await GetFile.pruneRevisionCache(rootDir, DAY_MILLIS);
    });

    it("tolerates a missing cache directory", async () => {
      await GetFile.pruneRevisionCache(path.join(rootDir, "nowhere"), DAY_MILLIS);
    });
  });
});
