import { BaseCmParser } from "../baseCmParser";
import { IServerMember } from "./listUsers";

/**
 * Reads `cm listusers <server>`: one line per user or group, the name padded
 * to a column and then `User` or `Group`. Names may hold spaces, so the type
 * is read from the end of the line. Lines that end in neither are skipped.
 */
export class ServerMembersParser extends BaseCmParser<IServerMember[]> {
  public parse(): Promise<IServerMember[]> {
    const members: IServerMember[] = [];
    for (const line of this.mOutputBuffer) {
      const row = /^(.*\S)\s+(User|Group)\s*$/i.exec(line);
      if (row) {
        members.push({ name: row[1].trim(), type: row[2].toLowerCase() === "group" ? "group" : "user" });
      }
    }
    return Promise.resolve(members);
  }
}
