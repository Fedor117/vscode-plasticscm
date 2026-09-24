import { execFile } from "child_process";
import { hostname } from "os";
import { ReviewTokenError } from "./reviewTokenError";
import { SecretStorage } from "vscode";

export { ReviewTokenError };

/** What cm printed, and how it ended. */
export interface ICmOutput {
  /** cm's exit code; undefined when it did not start, or was killed at the timeout. */
  code: number | undefined;
  stdout: string;
  stderr: string;
  /** cm was not found where the settings say it is. */
  missing?: boolean;
}

/**
 * Runs cm for `cm getconfig organization` and `cm accesstoken`. Never the
 * shared CmShell, which writes every command and its output to the output
 * channel: `cm accesstoken reveal` prints the token. Tests replace it.
 */
export interface ITokenCm {
  run(args: readonly string[]): Promise<ICmOutput>;
}

/** Where consent is remembered: the extension's global state, which is not secret. */
export interface IConsentMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** An organization, as `cm getconfig organization` describes it. */
export interface IOrganization {
  name: string;
  /** `cloud` or `unity`. */
  type: string;
  /** The Unity organization id, `-1` when there is none. */
  unityId: string;
  /** Observed to be a host, such as `prd-azure-eastus-01-cloud.plasticscm.com`. */
  region: string;
}

/**
 * What `state` can tell about a server and user without running cm for a
 * token: a token or the consent to create one (`ready`), neither
 * (`needsConsent`), or cm's recent refusal to create one, with what an admin
 * can do and, for `notAllowed`, the command.
 */
export type TokenState =
  | { state: "ready" }
  | { state: "needsConsent" }
  | { state: "notAllowed"; message: string; command: string }
  | { state: "disabled"; message: string };

interface ISavedToken {
  id: string;
  token?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

type Refusal = Extract<TokenState, { message: string }> & { at: number };

/** What `cm accesstoken reveal` gave: the token, or how cm failed, without what it printed on stdout. */
type Revealed = ICmOutput & { token?: string; expiresAt?: number };

export const CONSENT_MESSAGE = "Create a personal access token for review actions?";
const SECRET_PREFIX = "plastic-reviews.pat:";
const CONSENT_PREFIX = "plastic-reviews.patConsent:";
/** Where 0.4.0's Configure Experimental Posting… kept a bearer token, per workspace and repository. */
const LEGACY_PREFIX = "plastic-reviews.experimental:";
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A saved token is used while it has this much life left. */
const MARGIN = 5 * 60 * 1000;
/** How long a token that is not a readable JWT is taken to live. */
const UNKNOWN_LIFETIME = 10 * 60 * 1000;
/** How long cm's refusal to create a token stands before it is asked again. */
const REFUSAL_LIFETIME = 10 * 60 * 1000;
/** The longest lifetime asked for first; a server that refuses it gets the second. */
const LIFETIMES = [ "180d", "30d" ];
const CM_MISSING = "cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting.";

/** What the consent dialog says about the token it creates. */
export function consentDetail(server: string): string {
  return `The token is created with cm on your account for ${server} and stored in VS Code's secret storage. ` +
    "It is used only for Add Me as Reviewer, your own review status and posting comments, lasts up to 180 days, " +
    "and can be revoked with Revoke Review Access Token or cm accesstoken revoke.";
}

/** The command an organization admin runs to allow the user personal access tokens. */
export function allowlistCommand(user: string, server: string): string {
  return `cm accesstoken admin allowlist add --users=${user} ${server}`;
}

/** cm with `execFile`: no shell, stdin closed, killed after a minute. */
export function execFileCm(cmPath: () => string): ITokenCm {
  return {
    run: args => new Promise<ICmOutput>(resolve => {
      try {
        const child = execFile(cmPath(), args.slice(), {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          timeout: 60 * 1000,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          resolve({
            code: error ? (typeof code === "number" ? code : undefined) : 0,
            missing: code === "ENOENT",
            stderr: String(stderr),
            stdout: String(stdout),
          });
        });
        child.stdin?.end();
      } catch {
        resolve({ code: undefined, missing: true, stderr: "", stdout: "" });
      }
    }),
  };
}

/**
 * Personal access tokens for review writes, created and revealed with
 * `cm accesstoken`: one per server spec and cm user, kept in SecretStorage as
 * the id `create` printed and the token `reveal` printed. A new token is
 * created only once the user has agreed to one for that server and user,
 * which global state remembers. Nothing `reveal` prints reaches a log, a
 * message or an error.
 */
export class ReviewTokens {
  private readonly organizations = new Map<string, IOrganization>();
  /** The token being acquired, per `tokenKey`: concurrent callers share it. */
  private readonly pending = new Map<string, Promise<string>>();
  /** The revoke in flight, per `tokenKey`: a token asked for meanwhile waits for it. */
  private readonly revoking = new Map<string, Promise<boolean>>();
  private readonly refusals = new Map<string, Refusal>();
  private readonly now: () => number;
  private readonly machine: () => string;

  public constructor(
    private readonly secrets: SecretStorage,
    private readonly memento: IConsentMemento,
    private readonly cm: ITokenCm,
    options: { now?: () => number; hostname?: () => string } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.machine = options.hostname ?? hostname;
  }

  /** `cm getconfig organization` for a server spec, asked once per server; rejects with a message safe to show. */
  public async organization(server: string): Promise<IOrganization> {
    const known = this.organizations.get(server.toLowerCase());
    if (known) {
      return known;
    }
    const output = await this.cm.run([
      "getconfig", "organization", server, "--format={name}|{type}|{unityid}|{region}",
    ]);
    if (output.missing) {
      throw new Error(CM_MISSING);
    }
    const organization = output.code === 0 ? parseOrganization(output.stdout) : undefined;
    if (!organization) {
      const line = safeLine(output.stderr) ?? safeLine(output.stdout);
      throw new Error(`cm couldn't describe the organization ${server}${line ? `: ${line}` : ""}. Review actions ` +
        "need a cm with cm accesstoken, as in Unity Version Control 11.0.16.9637 and later.");
    }
    this.organizations.set(server.toLowerCase(), organization);
    return organization;
  }

  /** Whether a token can be had without asking the user; runs no cm. */
  public async state(server: string, user: string): Promise<TokenState> {
    const key = tokenKey(server, user);
    const refusal = this.refusals.get(key);
    if (refusal && this.now() - refusal.at < REFUSAL_LIFETIME) {
      return refusal.state === "notAllowed"
        ? { command: refusal.command, message: refusal.message, state: refusal.state }
        : { message: refusal.message, state: refusal.state };
    }
    return await this.load(key) || this.consented(server, user) ? { state: "ready" } : { state: "needsConsent" };
  }

  /** Whether a token is saved for the server and user. */
  public async saved(server: string, user: string): Promise<boolean> {
    return !!await this.load(tokenKey(server, user));
  }

  /** Remembers that the user agreed to a token for the server. */
  public async consent(server: string, user: string): Promise<void> {
    this.refusals.delete(tokenKey(server, user));
    await this.memento.update(consentKey(server, user), true);
  }

  /**
   * The token for a server and user: the saved one while it has five minutes
   * left, else the saved id revealed again, else, with the user's consent, a
   * new one. Given the token a server answered 401 to, it drops that one and
   * reveals again. Concurrent calls share one acquire, and a call during a
   * revoke waits for it. Rejects with a ReviewTokenError.
   */
  public token(server: string, user: string, stale?: string): Promise<string> {
    const key = tokenKey(server, user);
    const revoking = this.revoking.get(key);
    if (revoking) {
      const again = () => this.token(server, user, stale);
      return revoking.then(again, again);
    }
    const pending = this.pending.get(key);
    if (pending) {
      // A renewal waits for the acquire in flight, and goes again if that only brought back the stale token.
      return stale === undefined ? pending : pending.then(token => token === stale ? this.token(server, user, stale)
        : token);
    }
    const acquire = this.acquire(server, user, stale);
    this.pending.set(key, acquire);
    const clear = () => {
      if (this.pending.get(key) === acquire) {
        this.pending.delete(key);
      }
    };
    acquire.then(clear, clear);
    return acquire;
  }

  /**
   * Revokes the saved token with `cm accesstoken revoke`, then forgets it and
   * the consent, whatever cm said; resolves whether a token was saved. Rejects
   * after forgetting when cm could not revoke it. An acquire in flight ends
   * first, so that what it saves is what is revoked.
   */
  public revoke(server: string, user: string): Promise<boolean> {
    const key = tokenKey(server, user);
    const earlier = this.revoking.get(key);
    const after = earlier ? earlier.then(() => undefined, () => undefined) : Promise.resolve();
    const revoke = after.then(() => this.revokeSaved(server, user));
    this.revoking.set(key, revoke);
    const clear = () => {
      if (this.revoking.get(key) === revoke) {
        this.revoking.delete(key);
      }
    };
    revoke.then(clear, clear);
    return revoke;
  }

  /**
   * Deletes the bearer token that 0.4.0's Configure Experimental Posting…
   * saved for a workspace and repository. Nothing reads it any more.
   */
  public async forgetLegacyToken(workspaceId: string, repository: string): Promise<void> {
    await this.secrets.delete(`${LEGACY_PREFIX}${JSON.stringify([ workspaceId, repository ])}`);
  }

  private async revokeSaved(server: string, user: string): Promise<boolean> {
    const key = tokenKey(server, user);
    await this.pending.get(key)?.catch(() => undefined);
    const saved = await this.load(key);
    const output = saved && await this.cm.run([ "accesstoken", "revoke", saved.id, server ]);
    await this.secrets.delete(key);
    await this.memento.update(consentKey(server, user), undefined);
    this.refusals.delete(key);
    if (output && output.code !== 0) {
      throw new Error(`cm couldn't revoke the token${cause(output)}. VS Code no longer keeps it; if it still ` +
        "exists, revoke it with cm accesstoken list and cm accesstoken revoke.");
    }
    return !!saved;
  }

  private async acquire(server: string, user: string, stale: string | undefined): Promise<string> {
    const key = tokenKey(server, user);
    const saved = await this.load(key);
    if (saved?.token && saved.token !== stale && (saved.expiresAt ?? 0) > this.now() + MARGIN) {
      return saved.token;
    }
    if (saved) {
      const revealed = await this.reveal(server, saved.id);
      if (revealed.token !== undefined) {
        await this.save(key, { expiresAt: revealed.expiresAt, id: saved.id, token: revealed.token });
        return revealed.token;
      }
      await this.forgetUnrevealed(server, user, saved, revealed);
    }
    if (!this.consented(server, user)) {
      throw new ReviewTokenError(`Create a personal access token for ${server} first.`, "consent");
    }
    const id = await this.create(server, user);
    // Saved before it is revealed, so that Revoke Review Access Token finds it whatever happens next.
    await this.save(key, { id });
    const revealed = await this.reveal(server, id);
    if (revealed.token === undefined) {
      throw this.refusal(server, user, revealed.stderr) ??
        new ReviewTokenError(`cm created a personal access token but couldn't reveal it${cause(revealed)}.`,
          "failed");
    }
    await this.save(key, { expiresAt: revealed.expiresAt, id, token: revealed.token });
    return revealed.token;
  }

  /**
   * After the saved id did not reveal: forgets it only once cm has said that
   * the token is not live, so that nothing is left on the account that no one
   * tracks, and rejects otherwise. A token `cm accesstoken list` leaves out
   * was revoked, likely by the user with cm: the consent goes too, and the
   * next action asks again. One still listed that revealed before, and so
   * has most likely expired, is revoked first and then replaced with the
   * consent there is.
   */
  private async forgetUnrevealed(server: string, user: string, saved: ISavedToken, revealed: Revealed):
      Promise<void> {
    const key = tokenKey(server, user);
    const failure = () => this.refusal(server, user, revealed.stderr) ?? new ReviewTokenError(
      `cm couldn't reveal the personal access token for ${server}` +
      `${revealed.code === 0 ? ": it printed no token" : cause(revealed)}.`, "failed");
    // cm did not finish, or it printed something that is not a token: nothing says the token is gone.
    if (revealed.missing || revealed.code === undefined || revealed.code === 0) {
      throw failure();
    }
    const listed = await this.listed(server);
    if (!listed) {
      throw failure();
    }
    if (!listed.has(saved.id.toLowerCase())) {
      await this.secrets.delete(key);
      await this.memento.update(consentKey(server, user), undefined);
      throw new ReviewTokenError(`The personal access token for ${server} has been revoked, so VS Code no longer ` +
        "keeps it. The next review action asks before creating another.", "consent");
    }
    // Listed, but never revealed: reveal does not work for it, and another token would do no better.
    if (!saved.token) {
      throw failure();
    }
    const revoked = await this.cm.run([ "accesstoken", "revoke", saved.id, server ]);
    if (revoked.code !== 0) {
      throw failure();
    }
    await this.secrets.delete(key);
  }

  /** The ids `cm accesstoken list` prints, in lower case; undefined when it failed. Revoked tokens are not listed. */
  private async listed(server: string): Promise<Set<string> | undefined> {
    const output = await this.cm.run([ "accesstoken", "list", server, "--format={id}" ]);
    return output.code === 0
      ? new Set((output.stdout.match(new RegExp(UUID.source, "gi")) ?? []).map(id => id.toLowerCase()))
      : undefined;
  }

  /** `cm accesstoken reveal`: the token, or how cm failed without what it printed on stdout. */
  private async reveal(server: string, id: string): Promise<Revealed> {
    const output = await this.cm.run([ "accesstoken", "reveal", id, server ]);
    const token = output.code === 0 ? revealedToken(output.stdout) : undefined;
    const failure = { ...output, stdout: "" };
    return token === undefined ? failure : { ...failure, expiresAt: expiry(token, this.now()), token };
  }

  /**
   * `cm accesstoken create` for 180 days and, when cm refuses that, for 30;
   * the new token's id. A create that did not finish, or finished without an
   * id, may have made a token, so it is not repeated.
   */
  private async create(server: string, user: string): Promise<string> {
    const description = `Plastic SCM for VS Code (${this.machine()})`;
    let output: ICmOutput | undefined;
    for (const lifetime of LIFETIMES) {
      output = await this.cm.run([ "accesstoken", "create", description, lifetime, server, "--format={id}" ]);
      const id = UUID.exec(output.stdout)?.[0];
      if (id) {
        return id;
      }
      const refused = this.refusal(server, user, `${output.stdout}\n${output.stderr}`);
      if (refused) {
        throw refused;
      }
      if (output.missing) {
        break;
      }
      if (output.code === undefined || output.code === 0) {
        const what = output.code === 0 ? "printed no token id when creating" : "did not finish creating";
        const where = `Look for "${description}" in cm accesstoken list ${server}`;
        throw new ReviewTokenError(`cm ${what} a personal access token for ${server}, and it may have created one. ` +
          `${where}, and revoke it with cm accesstoken revoke.`, "failed");
      }
    }
    throw new ReviewTokenError(`cm couldn't create a personal access token for ${server}${cause(output)}.`, "failed");
  }

  /** cm's refusal to make a token, remembered for a while; undefined when `text` is not one. */
  private refusal(server: string, user: string, text: string): ReviewTokenError | undefined {
    let refusal: Refusal;
    if (/permission/i.test(text)) {
      refusal = {
        at: this.now(),
        command: allowlistCommand(user, server),
        message: "Your organization hasn't enabled personal access tokens for you. An organization admin can " +
          `allow them with: ${allowlistCommand(user, server)}`,
        state: "notAllowed",
      };
    } else if (/not enabled/i.test(text)) {
      refusal = {
        at: this.now(),
        message: `Personal access tokens aren't enabled for ${server}. Ask an organization admin to enable them.`,
        state: "disabled",
      };
    } else {
      return undefined;
    }
    this.refusals.set(tokenKey(server, user), refusal);
    return new ReviewTokenError(refusal.message, refusal.state);
  }

  private consented(server: string, user: string): boolean {
    return this.memento.get<boolean>(consentKey(server, user)) === true;
  }

  private async load(key: string): Promise<ISavedToken | undefined> {
    let value: Partial<ISavedToken> | undefined;
    try {
      const saved = await this.secrets.get(key);
      value = saved ? JSON.parse(saved) as Partial<ISavedToken> : undefined;
    } catch {
      // An unreadable saved token counts as none.
      value = undefined;
    }
    if (!value || typeof value.id !== "string" || !UUID.test(value.id)) {
      return undefined;
    }
    return {
      id: value.id,
      ...(typeof value.token === "string" ? { token: value.token } : {}),
      ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
    };
  }

  private async save(key: string, saved: ISavedToken): Promise<void> {
    await this.secrets.store(key, JSON.stringify(saved));
  }
}

/** The secret's key: `plastic-reviews.pat:["<server>","<user>"]`. */
export function tokenKey(server: string, user: string): string {
  return `${SECRET_PREFIX}${JSON.stringify([ server, user ])}`;
}

function consentKey(server: string, user: string): string {
  return `${CONSENT_PREFIX}${JSON.stringify([ server, user ])}`;
}

/** `name|type|unityid|region`, the first line that has all four. */
function parseOrganization(stdout: string): IOrganization | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split("|").map(part => part.trim());
    if (parts.length === 4 && parts.every(Boolean)) {
      const [ name, type, unityId, region ] = parts;
      return { name, region, type, unityId };
    }
  }
  return undefined;
}

/** A JWT anywhere in what `reveal` printed, or else the whole of it if that is one word of 20 characters or more. */
function revealedToken(stdout: string): string | undefined {
  const jwt = JWT.exec(stdout);
  if (jwt) {
    return jwt[0];
  }
  const word = stdout.trim();
  return /^\S{20,}$/.test(word) ? word : undefined;
}

/** When a token expires: its JWT `exp`, or ten minutes from now when it has none that can be read. */
function expiry(token: string, now: number): number {
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof payload.exp === "number" && isFinite(payload.exp)) {
        return payload.exp * 1000;
      }
    } catch {
      // Not a JWT after all.
    }
  }
  return now + UNKNOWN_LIFETIME;
}

/** Why cm failed, as `: <reason>` for a message: its first line on stderr, or its exit code. */
function cause(output: ICmOutput | undefined): string {
  if (!output) {
    return "";
  }
  if (output.missing) {
    return `: ${CM_MISSING.replace(/\.$/, "")}`;
  }
  const line = safeLine(output.stderr);
  return line ? `: ${line}` : output.code === undefined ? " (cm did not finish)" : ` (exit code ${output.code})`;
}

/**
 * The first line of cm's output, without anything shaped like a token or a
 * token id and without a final full stop, for a message to end; undefined
 * when there is none.
 */
function safeLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(Boolean);
  const safe = line?.replace(new RegExp(JWT.source, "g"), "[token]").replace(new RegExp(UUID.source, "gi"), "[id]")
    .substring(0, 200).replace(/\.$/, "");
  return safe || undefined;
}
