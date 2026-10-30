import assert from "node:assert/strict";
import { test } from "node:test";
import { addAssistant, assistantFacts, endAssistant, listAssistants, oneAssistant } from "../dist/assistants.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// Assistants as chat members (ADR 0210, bipe#867). Synthetic accounts only. The operator check stands in for
// Badges.verifiedBrand(): a verified CNPJ seal, or null.
const sealed = new Map([["@loja:example.test", { name: "Loja da Ana", cnpj: "12345678000190" }]]);
const check = async (id) => sealed.get(id) ?? null;

test("staff register an assistant only for an operator with a seal; facts follow the seal; end removes the label", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  await assert.rejects(addAssistant(db, check, "@bot:example.test", "@ninguem:example.test", "fora"), /no verified CNPJ seal/);
  await assert.rejects(addAssistant(db, check, "@bot:example.test", "@loja:example.test", "marte"), /model location/);
  await assert.rejects(addAssistant(db, check, "@loja:example.test", "@loja:example.test", "fora"), /own operator/);
  await assert.rejects(addAssistant(db, check, "bot", "@loja:example.test", "fora"), /Matrix user IDs/);

  await addAssistant(db, check, "@bot:example.test", "@loja:example.test", "fora");
  assert.deepEqual(await oneAssistant(db, check, "@bot:example.test"), {
    user_id: "@bot:example.test", operator_verified: true, operator_name: "Loja da Ana", model_location: "fora",
  });
  assert.deepEqual(
    (await assistantFacts(db, check, ["@ana:example.test", "@bot:example.test", "@bot:example.test", "not an id"])).map((f) => f.user_id),
    ["@bot:example.test"],
    "only registered assistants, once each",
  );

  // The operator loses its seal: the label stays, the operator shows as not verified.
  sealed.delete("@loja:example.test");
  const lost = await oneAssistant(db, check, "@bot:example.test");
  assert.equal(lost.operator_verified, false);
  assert.equal(lost.operator_name, null);
  sealed.set("@loja:example.test", { name: "Loja da Ana", cnpj: "12345678000190" });

  assert.equal((await listAssistants(db)).length, 1);
  assert.equal(await endAssistant(db, "@bot:example.test"), true);
  assert.equal(await endAssistant(db, "@bot:example.test"), false);
  await assert.rejects(oneAssistant(db, check, "@bot:example.test"), (e) => e.id === "not_found");

  // A new registration of the same account starts again.
  await addAssistant(db, check, "@bot:example.test", "@loja:example.test", "brasil");
  assert.equal((await oneAssistant(db, check, "@bot:example.test")).model_location, "brasil");
});
