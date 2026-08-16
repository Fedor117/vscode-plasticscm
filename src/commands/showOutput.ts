import { commands, Disposable } from "vscode";
import { PlasticScm } from "../plasticScm";

/**
 * Every cm invocation is already logged to the output channel, but until now there
 * was no way to reveal it — so server trigger messages and cm's own diagnostics
 * were invisible to the user.
 */
export class ShowOutputCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.showOutput", () => this.execute());
  }

  public dispose(): void {
    this.mDisposable.dispose();
  }

  private execute(): void {
    this.mPlasticScm.channel.show();
  }
}
