import { cmFailure, cmOk, FakeTokenCm, REGION, syntheticJwt, tokenId } from "./tokenFixtures";
import { execFileCm, ICmOutput, ReviewTokenError, ReviewTokens, tokenKey } from "../../../reviews/reviewTokens";
import { expect } from "chai";
import { memorySecrets } from "./editorFixtures";

/**
 * Personal access tokens made with a fake cm: nothing here runs cm. The
 * server, user and every id and token are made up.
 */

const SERVER = "acme-studio@unity";
const USER = "dana.kim@example.test";
const KEY = tokenKey(SERVER, USER);
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const MINUTE = 60 * 1000;

interface IHarness {
  cm: FakeTokenCm;
  secrets: ReturnType<typeof memorySecrets>;
  consent: Map<string, unknown>;
  tokens: ReviewTokens;
  clock: { now: number };
}

function harness(initial: Record<string, string> = {}): IHarness {
  const clock = { now: NOW };
  const cm = new FakeTokenCm();
  cm.clock = () => clock.now;
  const secrets = memorySecrets(initial);
  const consent = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string) => consent.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      if (value === undefined) {
        consent.delete(key);
      } else {
        consent.set(key, value);
      }
      return Promise.resolve();
    },
  };
  const tokens = new ReviewTokens(secrets, memento, cm, { hostname: () => "build-box", now: () => clock.now });
  return { clock, cm, consent, secrets, tokens };
}

async function rejection(action: Promise<unknown>): Promise<ReviewTokenError> {
  try {
    await action;
  } catch (error) {
    return error as ReviewTokenError;
  }
  throw new Error("Expected rejection");
}

function saved(test: IHarness): { id: string; token?: string; expiresAt?: number } | undefined {
  const value = test.secrets.values.get(KEY);
  return value === undefined ? undefined : JSON.parse(value) as { id: string; token?: string; expiresAt?: number };
}

describe("Review access tokens (fake cm)", () => {
  it("asks for consent before the first token, then creates, reveals and keeps it", async () => {
    const test = harness();
    expect(await test.tokens.state(SERVER, USER)).to.deep.equal({ state: "needsConsent" });
    const refused = await rejection(test.tokens.token(SERVER, USER));
    expect(refused.kind).to.equal("consent");
    expect(test.cm.calls).to.deep.equal([]);

    await test.tokens.consent(SERVER, USER);
    expect(await test.tokens.state(SERVER, USER)).to.deep.equal({ state: "ready" });
    expect(test.cm.calls).to.deep.equal([]);
    const token = await test.tokens.token(SERVER, USER);
    expect(test.cm.calls).to.deep.equal([
      [ "accesstoken", "create", "Plastic SCM for VS Code (build-box)", "180d", SERVER, "--format={id}" ],
      [ "accesstoken", "reveal", tokenId(1), SERVER ],
    ]);
    expect(token).to.equal(test.cm.revealed[0]);
    expect(saved(test)).to.deep.equal({ expiresAt: NOW + 60 * MINUTE, id: tokenId(1), token });
    expect(KEY).to.equal(`plastic-reviews.pat:${JSON.stringify([ SERVER, USER ])}`);
    expect(Array.from(test.consent.keys())).to.deep.equal([
      `plastic-reviews.patConsent:${JSON.stringify([ SERVER, USER ])}`,
    ]);
    // Kept while it has more than five minutes left; no cm meanwhile.
    test.clock.now += 54 * MINUTE;
    expect(await test.tokens.token(SERVER, USER)).to.equal(token);
    expect(test.cm.calls).to.have.length(2);
    expect(await test.tokens.saved(SERVER, USER)).to.equal(true);
  });

  it("reveals the saved id again near expiry, and after a 401 for the token it was given", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    const first = await test.tokens.token(SERVER, USER);
    test.clock.now += 56 * MINUTE;
    const second = await test.tokens.token(SERVER, USER);
    expect(second).to.not.equal(first);
    expect(test.cm.count("reveal")).to.equal(2);
    const third = await test.tokens.token(SERVER, USER, second);
    expect(third).to.not.equal(second);
    expect([ test.cm.count("create"), test.cm.count("reveal") ]).to.deep.equal([ 1, 3 ]);
    expect(saved(test)?.token).to.equal(third);
  });

  it("forgets a saved id that cm no longer lists, and the consent, so that a revoked token is not replaced unasked",
    async () => {
      const stale = JSON.stringify({ expiresAt: NOW - MINUTE, id: tokenId(99), token: syntheticJwt(NOW / 1000 - 60) });
      const test = harness({ [KEY]: stale });
      // A saved token counts as ready, without asking cm anything.
      expect(await test.tokens.state(SERVER, USER)).to.deep.equal({ state: "ready" });
      expect(test.cm.calls).to.deep.equal([]);
      await test.tokens.consent(SERVER, USER);
      const revoked = await rejection(test.tokens.token(SERVER, USER));
      expect(revoked.kind).to.equal("consent");
      expect(revoked.message).to.equal("The personal access token for acme-studio@unity has been revoked, so VS " +
        "Code no longer keeps it. The next review action asks before creating another.");
      expect(test.cm.calls).to.deep.equal([
        [ "accesstoken", "reveal", tokenId(99), SERVER ],
        [ "accesstoken", "list", SERVER, "--format={id}" ],
      ]);
      expect(test.secrets.values.has(KEY)).to.equal(false);
      expect(await test.tokens.state(SERVER, USER)).to.deep.equal({ state: "needsConsent" });
      await test.tokens.consent(SERVER, USER);
      await test.tokens.token(SERVER, USER);
      expect(saved(test)?.id).to.equal(tokenId(1));
    });

  it("keeps the saved id, and creates nothing, while cm cannot say that the token is gone", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    await test.tokens.token(SERVER, USER);
    const kept = saved(test);
    const reveal = (output: ICmOutput) => (args: readonly string[]) => (args[1] === "reveal" ? output : undefined);
    const offline = cmFailure("Error: could not connect to the server.");
    const cases: Array<[ (args: readonly string[]) => ICmOutput | undefined, string ]> = [
      [ reveal({ code: undefined, missing: true, stderr: "", stdout: "" }),
        ": cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting." ],
      [ reveal({ code: undefined, stderr: "", stdout: "" }), " (cm did not finish)." ],
      [ reveal(cmOk("Token: short")), ": it printed no token." ],
      [ args => (args[1] === "reveal" || args[1] === "list" ? offline : undefined),
        ": Error: could not connect to the server." ],
    ];
    for (const [ answer, why ] of cases) {
      // Past the revealed copy's expiry, so each asks cm.
      test.clock.now += 61 * MINUTE;
      test.cm.answer = answer;
      const failed = await rejection(test.tokens.token(SERVER, USER));
      expect([ failed.kind, failed.message ]).to.deep.equal([
        "failed", `cm couldn't reveal the personal access token for acme-studio@unity${why}`,
      ]);
      expect(saved(test), why).to.deep.equal(kept);
    }
    expect([ test.cm.count("create"), test.cm.count("revoke") ]).to.deep.equal([ 1, 0 ]);
    expect(test.consent.size).to.equal(1);
  });

  it("revokes a saved token that cm lists but no longer reveals, then creates the next with the consent it has",
    async () => {
      const test = harness();
      await test.tokens.consent(SERVER, USER);
      await test.tokens.token(SERVER, USER);
      test.clock.now += 61 * MINUTE;
      // Expired, most likely: cm help says list still shows expired tokens.
      const expired = (id: string) => (args: readonly string[]) => (args[1] === "reveal" && args[2] === id
        ? cmFailure("The personal access token has expired.") : undefined);
      test.cm.answer = expired(tokenId(1));
      await test.tokens.token(SERVER, USER);
      expect(test.cm.calls.slice(2).map(call => call[1]))
        .to.deep.equal([ "reveal", "list", "revoke", "create", "reveal" ]);
      expect(test.cm.calls[4]).to.deep.equal([ "accesstoken", "revoke", tokenId(1), SERVER ]);
      expect(saved(test)?.id).to.equal(tokenId(2));
      expect(Array.from(test.cm.tokens.keys())).to.deep.equal([tokenId(2)]);

      // One cm will not revoke either stays saved: replacing it would leave it live.
      test.clock.now += 61 * MINUTE;
      const answer = expired(tokenId(2));
      const busy = cmFailure("Error: try again later.");
      test.cm.answer = args => answer(args) ?? (args[1] === "revoke" ? busy : undefined);
      expect((await rejection(test.tokens.token(SERVER, USER))).kind).to.equal("failed");
      expect([ saved(test)?.id, test.cm.count("create") ]).to.deep.equal([ tokenId(2), 2 ]);
    });

  it("asks for 30 days when cm refuses 180 days, and takes the first UUID anywhere in the output", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    test.cm.answer = args => {
      if (args[1] === "create" && args[3] === "180d") {
        return cmFailure("The lifetime exceeds the maximum the server allows.");
      }
      if (args[1] === "create") {
        test.cm.tokens.set(tokenId(7), 0);
        return cmOk(`Token created.\nID: ${tokenId(7)}\n`);
      }
      return undefined;
    };
    await test.tokens.token(SERVER, USER);
    expect(test.cm.calls.filter(call => call[1] === "create").map(call => call[3])).to.deep.equal([ "180d", "30d" ]);
    expect(saved(test)?.id).to.equal(tokenId(7));
  });

  it("does not ask for 30 days after a create that did not finish or printed no id, which may have made a token",
    async () => {
      const cases: Array<[ ICmOutput, string ]> = [
        [{ code: undefined, stderr: "", stdout: "" }, "did not finish creating" ],
        [ cmOk("Token created.\n"), "printed no token id when creating" ],
      ];
      for (const [ output, what ] of cases) {
        const test = harness();
        await test.tokens.consent(SERVER, USER);
        test.cm.answer = args => (args[1] === "create" ? output : undefined);
        const failed = await rejection(test.tokens.token(SERVER, USER));
        expect([ failed.kind, failed.message ]).to.deep.equal([ "failed", `cm ${what} a personal access token for ` +
          "acme-studio@unity, and it may have created one. Look for \"Plastic SCM for VS Code (build-box)\" in cm " +
          "accesstoken list acme-studio@unity, and revoke it with cm accesstoken revoke." ]);
        expect(test.cm.calls.map(call => call[1])).to.deep.equal(["create"]);
        expect(test.secrets.values.has(KEY)).to.equal(false);
      }
    });

  it("maps cm's refusals to notAllowed and disabled, which state remembers for a while", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    test.cm.answer = args => (args[1] === "create"
      ? cmFailure("You don't have permission to create personal access tokens.") : undefined);
    const refused = await rejection(test.tokens.token(SERVER, USER));
    expect(refused.kind).to.equal("notAllowed");
    const command = `cm accesstoken admin allowlist add --users=${USER} ${SERVER}`;
    expect(refused.message).to.equal("Your organization hasn't enabled personal access tokens for you. An " +
      `organization admin can allow them with: ${command}`);
    expect(test.cm.count("create")).to.equal(1);
    expect(await test.tokens.state(SERVER, USER)).to.deep.equal({
      command, message: refused.message, state: "notAllowed",
    });
    test.clock.now += 11 * MINUTE;
    expect(await test.tokens.state(SERVER, USER)).to.deep.equal({ state: "ready" });

    test.cm.answer = args => (args[1] === "create" ? cmFailure("Personal access tokens are not enabled.") : undefined);
    const disabled = await rejection(test.tokens.token(SERVER, USER));
    expect(disabled.kind).to.equal("disabled");
    expect((await test.tokens.state(SERVER, USER)).state).to.equal("disabled");
    // Consenting again asks cm again.
    await test.tokens.consent(SERVER, USER);
    expect((await test.tokens.state(SERVER, USER)).state).to.equal("ready");
  });

  it("shares one acquire between concurrent callers", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    let release!: () => void;
    test.cm.hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const all = Promise.all([ test.tokens.token(SERVER, USER), test.tokens.token(SERVER, USER) ]);
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const [ a, b ] = await all;
    expect(a).to.equal(b);
    expect([ test.cm.count("create"), test.cm.count("reveal") ]).to.deep.equal([ 1, 1 ]);
  });

  it("never puts what reveal printed, or anything shaped like a token or its id, in an error", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    const secret = syntheticJwt(NOW / 1000 + 3600, "leaked");
    test.cm.answer = args => (args[1] === "reveal"
      ? { code: 1, stderr: `Error: token ${secret} of ${tokenId(1)} could not be revealed`, stdout: secret }
      : undefined);
    const failed = await rejection(test.tokens.token(SERVER, USER));
    expect(failed.kind).to.equal("failed");
    expect(failed.message).to.equal("cm created a personal access token but couldn't reveal it: Error: token " +
      "[token] of [id] could not be revealed.");
    expect(failed.message).to.not.contain(secret).and.not.contain(tokenId(1));
    // The id was kept, so that revoking still finds the token.
    expect(saved(test)).to.deep.equal({ id: tokenId(1) });

    // An id that never revealed stays saved, and no other token is created for it.
    test.cm.answer = args => (args[1] === "reveal" ? cmOk("short-secret") : undefined);
    const printed = await rejection(test.tokens.token(SERVER, USER));
    expect(printed.message).to.not.contain("short-secret");
    test.cm.answer = args => (args[1] === "reveal" ? cmFailure("Error: cannot reveal.") : undefined);
    expect((await rejection(test.tokens.token(SERVER, USER))).kind).to.equal("failed");
    expect(saved(test)).to.deep.equal({ id: tokenId(1) });
    expect([ test.cm.count("create"), test.cm.count("revoke") ]).to.deep.equal([ 1, 0 ]);
  });

  it("takes a revealed token that is one long word but not a JWT, for ten minutes", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    const opaque = "opaque_synthetic_token_0123456789";
    test.cm.answer = args => (args[1] === "reveal" ? cmOk(`  ${opaque}\n`) : undefined);
    expect(await test.tokens.token(SERVER, USER)).to.equal(opaque);
    expect(saved(test)?.expiresAt).to.equal(NOW + 10 * MINUTE);
  });

  it("revokes with cm, then forgets the token and the consent, and nothing else", async () => {
    const test = harness({ unrelated: "kept" });
    await test.tokens.consent(SERVER, USER);
    await test.tokens.token(SERVER, USER);
    expect(await test.tokens.revoke(SERVER, USER)).to.equal(true);
    expect(test.cm.calls[test.cm.calls.length - 1]).to.deep.equal([ "accesstoken", "revoke", tokenId(1), SERVER ]);
    expect(Array.from(test.secrets.values.keys())).to.deep.equal(["unrelated"]);
    expect(test.consent.size).to.equal(0);
    expect(await test.tokens.state(SERVER, USER)).to.deep.equal({ state: "needsConsent" });
    expect(await test.tokens.revoke(SERVER, USER)).to.equal(false);

    // A revoke cm refuses still forgets the token here, and says how to finish with cm.
    await test.tokens.consent(SERVER, USER);
    await test.tokens.token(SERVER, USER);
    test.cm.answer = args => (args[1] === "revoke" ? cmFailure(`Error: cannot revoke ${tokenId(2)}`) : undefined);
    const failed = await rejection(test.tokens.revoke(SERVER, USER));
    expect(failed.message).to.equal("cm couldn't revoke the token: Error: cannot revoke [id]. VS Code no longer " +
      "keeps it; if it still exists, revoke it with cm accesstoken list and cm accesstoken revoke.");
    expect(test.secrets.values.has(KEY)).to.equal(false);
  });

  it("revokes what an acquire in flight saves, and a token asked for during a revoke waits for it", async () => {
    const test = harness();
    await test.tokens.consent(SERVER, USER);
    let release!: () => void;
    test.cm.hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const acquiring = test.tokens.token(SERVER, USER);
    await new Promise(resolve => setTimeout(resolve, 10));
    const revoking = test.tokens.revoke(SERVER, USER);
    const during = rejection(test.tokens.token(SERVER, USER));
    test.cm.hold = undefined;
    release();
    await acquiring;
    expect(await revoking).to.equal(true);
    expect((await during).kind).to.equal("consent");
    expect(test.cm.calls.map(call => call[1])).to.deep.equal([ "create", "reveal", "revoke" ]);
    expect([ test.secrets.values.has(KEY), test.consent.size ]).to.deep.equal([ false, 0 ]);
  });

  it("describes an organization once per server, and says when cm is missing or cannot", async () => {
    const test = harness();
    expect(await test.tokens.organization(SERVER)).to.deep.equal({
      name: "acme-studio", region: REGION, type: "unity", unityId: "-1",
    });
    await test.tokens.organization(SERVER);
    expect(test.cm.calls).to.deep.equal([
      [ "getconfig", "organization", SERVER, "--format={name}|{type}|{unityid}|{region}" ],
    ]);
    test.cm.answer = () => ({ code: undefined, missing: true, stderr: "", stdout: "" });
    expect((await rejection(test.tokens.organization("1234567890123@cloud"))).message)
      .to.equal("cm wasn't found. Check the plastic-scm.cmConfiguration.cmPath setting.");
    test.cm.answer = () => cmFailure("Unknown command 'getconfig organization'.");
    expect((await rejection(test.tokens.organization("1234567890123@cloud"))).message).to.equal(
      "cm couldn't describe the organization 1234567890123@cloud: Unknown command 'getconfig organization'. " +
      "Review actions need a cm with cm accesstoken, as in Unity Version Control 11.0.16.9637 and later.");
  });

  it("runs cm without a shell, and reports a cm that cannot start as missing", async () => {
    const output = await execFileCm(() => "/nonexistent/synthetic-cm").run([ "accesstoken", "list" ]);
    expect(output).to.include({ code: undefined, missing: true });
  });
});
