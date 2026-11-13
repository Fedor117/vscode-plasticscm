import { LONG_COMMAND_TIMEOUT_MILLIS, runMutation } from "../runMutation";
import { ICmShell } from "../../shell";

export interface IUpdateRequest {
  /**
   * `--last`: for a workspace on a changeset or a label, first point it at the
   * branch of that changeset or label, then update. Without it such a workspace
   * stays where it is.
   */
  last?: boolean;
}

/**
 * `cm update [--last] --noinput`, in the workspace the shell was started in.
 * `--noinput` is required because the shell cannot answer cm's questions about
 * pending changes; per `cm help update` it also disables bringing them along.
 * An update downloads files and can take minutes, so it gets a generous bound instead of the default timeout.
 */
export class UpdateWorkspace {
  public static run(shell: ICmShell, request: IUpdateRequest = {}): Promise<string[]> {
    return runMutation(shell, {
      args: [ ...(request.last ? ["--last"] : []), "--noinput" ],
      command: "update",
      name: "update",
      options: { timeoutMillis: LONG_COMMAND_TIMEOUT_MILLIS },
    });
  }
}
