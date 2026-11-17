import { assertCmArgument } from "../refNames";
import { ICmShell } from "../../shell";
import { ServerMembersParser } from "./serverMembersParser";

/** A user or a group of a repository server, by the name cm knows. */
export interface IServerMember {
  name: string;
  type: "user" | "group";
}

/** cm asks who to sign in as when it does not know the server, and then waits; this bounds that wait. */
const LIST_USERS_OPTIONS = { timeoutMillis: 20000 };

/** The server of `repo@server`, e.g. `acme-studio@unity`; undefined when the spec names none. */
export function repositoryServer(repSpec: string | undefined): string | undefined {
  const at = repSpec?.indexOf("@") ?? -1;
  const server = at < 0 ? "" : repSpec?.substring(at + 1).trim();
  return server && server !== "unknown" ? server : undefined;
}

/** `cm listusers <server>`: every user and group of the server. */
export class ListUsers {
  public static async run(shell: ICmShell, server: string): Promise<IServerMember[]> {
    assertCmArgument(server, "server");
    const parser = new ServerMembersParser();
    const result = await shell.exec("listusers", [server], parser, LIST_USERS_OPTIONS);
    if (!result.success || result.error) {
      throw result.error ?? new Error("cm listusers failed.");
    }
    return result.result ?? [];
  }
}
