import { Disposable, Event, EventEmitter, FileDecoration, FileDecorationProvider, Uri, window } from "vscode";
import { IPlasticScmResourceGroup, Workspace } from "./workspace";
import { ChangeType } from "./models";
import { decorateLocked } from "./locks/lockDecoration";
import { join } from "path";

export class PlasticSCMDecorationProvider implements FileDecorationProvider {
  public readonly onDidChangeFileDecorations: Event<Uri[]>;

  private readonly onDidChangeDecorations: EventEmitter<Uri[]>;
  private disposables: Disposable[] = [];
  private decorations = new Map<string, FileDecoration>();
  private lockedPaths: string[] = [];

  public constructor(private workspace: Workspace) {
    this.onDidChangeDecorations = new EventEmitter<Uri[]>();
    this.onDidChangeFileDecorations = this.onDidChangeDecorations.event;

    this.disposables.push(
      window.registerFileDecorationProvider(this),
      workspace.onDidRunStatus(this.onDidRunStatus.bind(this), this),
      workspace.locks.onDidChange(this.onDidChangeLocks.bind(this), this)
    );
  }

  public provideFileDecoration(uri: Uri): FileDecoration | undefined {
    const status = this.decorations.get(uri.toString());
    if (uri.scheme !== "file") {
      return status;
    }

    const lock = this.workspace.locks.snapshot.forFile(this.workspace.info.path, uri.fsPath);
    return lock ? decorateLocked(lock, status) : status;
  }

  public dispose(): void {
    this.disposables.forEach(d => {
      d.dispose();
    });
  }

  private onDidChangeLocks(): void {
    const root = this.workspace.info.path;
    const paths = new Set(this.lockedPaths);
    this.lockedPaths = this.workspace.locks.snapshot.serverPaths();
    this.lockedPaths.forEach(serverPath => paths.add(serverPath));

    this.onDidChangeDecorations.fire(
      Array.from(paths).map(serverPath => Uri.file(join(root, ...serverPath.split("/")))));
  }

  private onDidRunStatus(): void {
    // At most one `lock list` a minute: the throttle lives in the store.
    void this.workspace.locks.refreshIfStale();

    const newDecorations = new Map<string, FileDecoration>();

    this.collectDecorationData(this.workspace.statusResourceGroup, newDecorations);

    const uris = new Set([...this.decorations.keys()].concat([...newDecorations.keys()]));
    this.decorations = newDecorations;
    this.onDidChangeDecorations.fire([...uris.values()].map(value => Uri.parse(value, true)));
  }

  private collectDecorationData(group: IPlasticScmResourceGroup, bucket: Map<string, FileDecoration>): void {
    for (const r of group.resourceStates) {
      const decoration = r.resourceDecoration;

      if (decoration) {
        // not deleted and has a decoration
        bucket.set(r.resourceUri.toString(), decoration);

        if (r.type === ChangeType.Moved) {
          bucket.set(r.resourceUri.toString(), decoration);
        }
      }
    }
  }
}
