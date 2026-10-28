import assert from "node:assert/strict";
import { test } from "node:test";
import { betaLogin } from "../dist/beta-login.js";

// Beta sign-in with an email (bipe#627). A fake MAS: one beta user "ana" with login email ana@example.test.

function deps() {
  const tries = [];
  const mas = {
    emailOwner: async (email) => (email === "ana@example.test" ? "01ANA" : null),
    usernameOf: async (id) => (id === "01ANA" ? "ana" : null),
    passwordMatches: async (localpart, password) => {
      tries.push(localpart);
      return localpart === "ana" && password === "right";
    },
  };
  return { deps: { config: { SERVER_NAME: "example.test" }, mas }, tries };
}

test("a login email with its password gives the Matrix ID", async () => {
  const { deps: d } = deps();
  assert.deepEqual(await betaLogin(d, " Ana@Example.test ", "right", 0), { user_id: "@ana:example.test" });
});

test("a wrong password and an unknown email give the same error", async () => {
  const { deps: d, tries } = deps();
  for (const [email, password] of [["ana@example.test", "wrong"], ["nobody@example.test", "right"]]) {
    await assert.rejects(betaLogin(d, email, password, 0), (e) => e.id === "unauthorized");
  }
  assert.deepEqual(tries, ["ana"]);
});

test("every answer takes at least the minimum time", async () => {
  const { deps: d } = deps();
  const started = Date.now();
  await assert.rejects(betaLogin(d, "nobody@example.test", "x", 120));
  assert.ok(Date.now() - started >= 115);
});
