import { commands, Disposable } from "vscode";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";

export class RefreshCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable?: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.refresh", (...args: unknown[]) => this.execute(args));
  }

  public dispose(): void {
    if (this.mDisposable) {
      this.mDisposable.dispose();
    }
  }

  private async execute(args: unknown[]): Promise<void> {
    const firstArg = args.length > 0 ? args[0] : undefined;
    const workspace: Workspace | undefined = firstArg instanceof Workspace
      ? firstArg
      : await this.mPlasticScm.promptUserToPickWorkspace();

    if (!workspace) {
      return;
    }

    await workspace.updateWorkspaceStatus();
  }
}
