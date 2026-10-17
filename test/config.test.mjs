import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, loadMailConfig } from "../dist/config.js";

const fixture = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://unused.invalid/test",
  SERVER_NAME: "example.test",
  SYNAPSE_URL: "https://matrix.example.test",
  MAS_URL: "https://mas.example.test",
  MAS_ADMIN_URL: "https://mas.example.test",
  MAS_CLIENT_ID: "synthetic-client",
  MAS_CLIENT_SECRET: "synthetic-client-secret",
  BIPE_INTERNAL_SECRET: "synthetic-only-internal-secret-32-bytes",
  APP_ATTEST_ENVIRONMENT: "production",
  APP_ATTEST_APP_IDS: "TESTTEAM01.chat.bipe.app.dev",
};

test("production requires an explicit environment and nonempty, valid App IDs", () => {
  for (const name of ["APP_ATTEST_ENVIRONMENT", "APP_ATTEST_APP_IDS"]) {
    for (const value of [undefined, "", "   "]) {
      assert.throws(() => loadConfig({ ...fixture, [name]: value }), new RegExp(name));
    }
  }
  for (const value of [",", "TESTTEAM01.chat.bipe.app,", "wrong-team.chat.bipe.app", "TESTTEAM01", "TESTTEAM01.chat.bipe.*"]) {
    assert.throws(() => loadConfig({ ...fixture, APP_ATTEST_APP_IDS: value }), /APP_ATTEST_APP_IDS/);
  }
  assert.throws(() => loadConfig({ ...fixture, APP_ATTEST_ENVIRONMENT: "either" }), /APP_ATTEST_ENVIRONMENT/);
});

test("production refuses development evidence policy even when attestation is optional", () => {
  for (const required of ["true", "false"]) {
    assert.throws(() => loadConfig({ ...fixture, APP_ATTEST_ENVIRONMENT: "development", SIGNUP_ATTEST_REQUIRED: required }), /APP_ATTEST_ENVIRONMENT/);
  }
});

test("explicit TestFlight development bundle can use production evidence", () => {
  const config = loadConfig({ ...fixture, APP_ATTEST_APP_IDS: " TESTTEAM01.chat.bipe.app.dev, TESTTEAM01.chat.bipe.app " });
  assert.equal(config.APP_ATTEST_ENVIRONMENT, "production");
  assert.deepEqual(config.APP_ATTEST_APP_IDS, ["TESTTEAM01.chat.bipe.app.dev", "TESTTEAM01.chat.bipe.app"]);
});

test("an isolated development deployment selects one environment explicitly", () => {
  const config = loadConfig({ ...fixture, NODE_ENV: "development", APP_ATTEST_ENVIRONMENT: "development", SIGNUP_ATTEST_REQUIRED: "false" });
  assert.equal(config.APP_ATTEST_ENVIRONMENT, "development");
  assert.equal(config.SIGNUP_ATTEST_REQUIRED, false);
  assert.throws(() => loadConfig({ ...fixture, NODE_ENV: "development", APP_ATTEST_ENVIRONMENT: undefined }), /APP_ATTEST_ENVIRONMENT/);
});

test("configuration errors print field names without their values", () => {
  assert.throws(() => loadConfig({ ...fixture, APP_ATTEST_APP_IDS: "sensitive-invalid-value" }), (error) => {
    assert.match(error.message, /APP_ATTEST_APP_IDS/);
    assert.equal(error.message.includes("sensitive-invalid-value"), false);
    return true;
  });
});

test("mail-only CLI does not require attestation policy", () => {
  assert.equal(loadMailConfig().PUBLIC_SITE_URL, process.env.PUBLIC_SITE_URL ?? "https://bipe.chat");
});
