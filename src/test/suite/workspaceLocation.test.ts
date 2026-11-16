import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ICmParser, ICmResult, ICmShell } from "../../cm/shell";
import { expect } from "chai";
import { IConfig } from "../../config";
import { locateWorkspace } from "../../workspaceLocation";
import { OutputChannel } from "vscode";
import { Workspace } from "../../workspace";
import { WorkspaceOperations } from "../../workspaceOperations";

const CONFIG = {
  autorefresh: false,
  consolidateUnrealOneFilePerActorChanges: false,
  ignoredDirectories: [],
} as unknown as IConfig;

const CHANNEL = { appendLine: () => undefined } as unknown as OutputChannel;

/**
 * Answers the way cm does: whatever path it is asked about, the paths it prints
 * have every symlink resolved.
 */
function cmShell(realRoot: string, changedFile: string): { shell: ICmShell; calls: string[][] } {
  const calls: string[][] = [];
  const output: { [command: string]: string } = {
    getworkspacefrompath: `guid-1@#@Nimbus@#@${realRoot}`,
    status: "<StatusOutput><WorkspaceStatus><Status><RepSpec><Server>local</Server><Name>Nimbus</Name></RepSpec>"
      + "<Changeset>9</Changeset></Status></WorkspaceStatus><WkConfigType>Branch</WkConfigType>"
      + "<WkConfigName>/main@Nimbus@local</WkConfigName><Changes><Change><Type>CH</Type>"
      + `<Path>${path.join(realRoot, changedFile)}</Path><RevisionType>enTextFile</RevisionType>`
      + "</Change></Changes></StatusOutput>",
  };

  const shell = {
    exec: async <T>(command: string, args: string[], parser: ICmParser<T>): Promise<ICmResult<T>> => {
      calls.push([ command, ...args ]);
      parser.readLineOut(output[command]);
      return { error: parser.getError(), result: await parser.parse(), success: true };
    },
  } as unknown as ICmShell;

  return { calls, shell };
}

describe("A workspace opened through a symlink", () => {
  const changedFile = path.join("Assets", "Player.cs");
  let base: string;
  let realRoot: string;
  let linkedRoot: string;
  const workspaces: Workspace[] = [];

  async function open(folder: string): Promise<{ workspace: Workspace; calls: string[][] }> {
    const { calls, shell } = cmShell(realRoot, changedFile);
    const info = await locateWorkspace(folder, shell);
    const workspace = await Workspace.build(info!, shell, CHANNEL, new WorkspaceOperations(), CONFIG);
    workspaces.push(workspace);
    return { calls, workspace };
  }

  before(() => {
    // os.tmpdir() is itself behind a symlink on macOS.
    base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "plastic-symlink-"));
    realRoot = path.join(base, "real", "Nimbus");
    linkedRoot = path.join(base, "link");
    fs.mkdirSync(path.join(realRoot, "Assets"), { recursive: true });
    fs.symlinkSync(realRoot, linkedRoot, "dir");
  });

  afterEach(() => {
    workspaces.splice(0).forEach(workspace => workspace.dispose());
  });

  after(() => {
    fs.rmSync(base, { force: true, recursive: true });
  });

  it("roots source control at the folder VS Code opened, so quick diff matches the editor's files", async () => {
    const { workspace } = await open(linkedRoot);

    expect(workspace.sourceControl.rootUri?.fsPath).to.equal(linkedRoot);
    expect(workspace.info.path).to.equal(linkedRoot);
  });

  it("lists pending changes under the opened folder, not under cm's resolved path", async () => {
    const { workspace } = await open(linkedRoot);

    expect(workspace.statusResourceGroup.resourceStates.map(state => state.resourceUri.fsPath))
      .to.eql([path.join(linkedRoot, changedFile)]);
    expect(workspace.pendingChanges.map(change => change.resourceUri.fsPath))
      .to.eql([path.join(linkedRoot, changedFile)]);
  });

  it("finds the workspace root above a folder opened inside the symlink", async () => {
    const { workspace } = await open(path.join(linkedRoot, "Assets"));

    expect(workspace.sourceControl.rootUri?.fsPath).to.equal(linkedRoot);
    expect(workspace.statusResourceGroup.resourceStates.map(state => state.resourceUri.fsPath))
      .to.eql([path.join(linkedRoot, changedFile)]);
  });

  it("asks cm for status at the opened path", async () => {
    const { calls } = await open(linkedRoot);

    expect(calls.find(call => call[0] === "status")?.[1]).to.equal(linkedRoot);
  });

  it("leaves a workspace opened at its real path as cm reports it", async () => {
    const { workspace } = await open(realRoot);

    expect(workspace.sourceControl.rootUri?.fsPath).to.equal(realRoot);
    expect(workspace.statusResourceGroup.resourceStates.map(state => state.resourceUri.fsPath))
      .to.eql([path.join(realRoot, changedFile)]);
  });

  it("keeps cm's path when the opened folder is a symlink to a folder inside the workspace", async () => {
    const linkedAssets = path.join(base, "assets-link");
    fs.symlinkSync(path.join(realRoot, "Assets"), linkedAssets, "dir");

    const { workspace } = await open(linkedAssets);

    expect(workspace.sourceControl.rootUri?.fsPath).to.equal(realRoot);
  });
});
