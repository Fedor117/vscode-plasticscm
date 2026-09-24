import { ICmOutput, ITokenCm } from "../../../reviews/reviewTokens";

/**
 * A cm that makes personal access tokens in memory, for review writes.
 * Nothing here runs cm, and every organization, id and token is made up.
 */

/** A documented REST host, as `cm getconfig organization` prints a region. */
export const REGION = "prd-azure-eastus-01-cloud.plasticscm.com";
export const ORIGIN = `https://${REGION}:7178`;

/** A made-up JWT whose payload carries `exp` (epoch seconds); nothing checks its signature. */
export function syntheticJwt(exp: number, subject = "synthetic"): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ exp, sub: subject })}.c3ludGhldGlj`;
}

/** A made-up token id, `00000000-0000-4000-8000-<n>`. */
export function tokenId(n: number): string {
  return `00000000-0000-4000-8000-${`000000000000${n}`.slice(-12)}`;
}

export function cmOk(stdout: string): ICmOutput {
  return { code: 0, stderr: "", stdout };
}

export function cmFailure(stderr: string, code = 1): ICmOutput {
  return { code, stderr, stdout: "" };
}

/**
 * `cm getconfig organization` and `cm accesstoken` from memory. Every call is
 * recorded; `answer` may answer one first. Each reveal prints a new JWT that
 * lives `lifetime` seconds from `clock`; `list` prints the ids of the tokens
 * not revoked, one per line.
 */
export class FakeTokenCm implements ITokenCm {
  public readonly calls: string[][] = [];
  /** What `getconfig organization` prints: `name|type|unityid|region`. */
  public organization = `acme-studio|unity|-1|${REGION}`;
  /** The tokens cm knows, by id, with how many times each was revealed. */
  public readonly tokens = new Map<string, number>();
  public lifetime = 60 * 60;
  public clock: () => number = Date.now;
  /** Answers a call before the defaults; undefined leaves it to them. */
  public answer?: (args: readonly string[]) => ICmOutput | undefined;
  /** Every call waits for this first, when set. */
  public hold?: Promise<void>;
  /** Every token revealed, in order. */
  public readonly revealed: string[] = [];
  private created = 0;

  public async run(args: readonly string[]): Promise<ICmOutput> {
    this.calls.push(args.slice());
    if (this.hold) {
      await this.hold;
    }
    const custom = this.answer?.(args);
    if (custom) {
      return custom;
    }
    const [ command, sub, id ] = args;
    if (command === "getconfig" && sub === "organization") {
      return cmOk(`${this.organization}\n`);
    }
    if (command !== "accesstoken") {
      return cmFailure(`Unknown command ${command}`);
    }
    if (sub === "create") {
      const created = tokenId(++this.created);
      this.tokens.set(created, 0);
      return cmOk(`${created}\n`);
    }
    if (sub === "list") {
      return cmOk(Array.from(this.tokens.keys()).map(known => `${known}\n`).join(""));
    }
    const reveals = this.tokens.get(id);
    if (reveals === undefined) {
      return cmFailure("The personal access token does not exist.");
    }
    if (sub === "reveal") {
      this.tokens.set(id, reveals + 1);
      const token = syntheticJwt(Math.floor(this.clock() / 1000) + this.lifetime, `${id}#${reveals + 1}`);
      this.revealed.push(token);
      return cmOk(`${token}\n`);
    }
    if (sub === "revoke") {
      this.tokens.delete(id);
      return cmOk("");
    }
    return cmFailure(`Unknown subcommand ${sub}`);
  }

  /** The calls of one `accesstoken` subcommand, or of `getconfig`. */
  public count(sub: "create" | "reveal" | "revoke" | "list" | "getconfig"): number {
    return this.calls.filter(call => (sub === "getconfig" ? call[0] === "getconfig" : call[1] === sub)).length;
  }
}
