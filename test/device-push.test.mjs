import assert from "node:assert/strict";
import { test } from "node:test";
import { pushDevices, pushEventId, pushToDevices } from "../dist/device-push.js";
import { bipePusher, kinds, pushGateway } from "./helpers/push-gateway.mjs";

// bipe-chat/bipe#171 and #628: one content-free push per kind to the Bipe Next pushers of an account.

test("only enabled Bipe Next HTTP pushers of a known other device get the push", () => {
  const pushers = [
    bipePusher("OLD1"),
    bipePusher("CALLER"),
    { ...bipePusher("OFF"), enabled: false },
    { ...bipePusher("EMAIL"), kind: "email" },
    { ...bipePusher("NODEVICE"), device_id: null },
    { ...bipePusher("FULL"), data: { format: "full", default_payload: { account_route: "r" } } },
    { ...bipePusher("NOROUTE"), data: { format: "event_id_only", default_payload: { aps: {} } } },
  ];
  const devices = pushDevices(pushers, "recovery_started", "CALLER");
  assert.deepEqual(devices.map((d) => d.pushkey), ["pushkey-OLD1"]);
  assert.deepEqual(devices[0].data.default_payload, { account_route: "route-OLD1", bipe_push_kind: "recovery_started" });
  assert.equal(devices[0].data.format, "event_id_only");
  assert.deepEqual(pushDevices(pushers, "recovery_completed", null).map((d) => d.pushkey), ["pushkey-OLD1", "pushkey-CALLER"]);
});

test("the notify request carries the kind and a fixed event ID, no room and no content", async (t) => {
  const gateway = await pushGateway(t);
  await pushToDevices({ pushers: async () => [bipePusher("A"), bipePusher("B")], sygnalUrl: `${gateway.url}/` }, "@ana:example.test", "recovery_started", null);
  assert.equal(gateway.state.requests.length, 1);
  const { notification } = gateway.state.requests[0];
  assert.equal(notification.event_id, pushEventId("recovery_started"));
  assert.equal(notification.event_id, "$recovery_started");
  assert.deepEqual(Object.keys(notification).sort(), ["devices", "event_id", "prio"]);
  assert.equal(notification.devices.length, 2);
  assert.deepEqual(kinds(gateway), ["recovery_started"]);
  assert.ok(!JSON.stringify(notification).includes("@ana"), "the push never carries the user ID");
});

test("no pushers, no configuration and failures send nothing and never throw", async (t) => {
  const gateway = await pushGateway(t);
  await pushToDevices(undefined, "@ana:example.test", "recovery_started", null);
  await pushToDevices({ pushers: null, sygnalUrl: gateway.url }, "@ana:example.test", "recovery_started", null);
  await pushToDevices({ pushers: async () => [bipePusher("A")], sygnalUrl: null }, "@ana:example.test", "recovery_started", null);
  await pushToDevices({ pushers: async () => [], sygnalUrl: gateway.url }, "@ana:example.test", "recovery_started", null);
  assert.equal(gateway.state.requests.length, 0);
  await pushToDevices({ pushers: async () => { throw new Error("synapse down"); }, sygnalUrl: gateway.url }, "@ana:example.test", "recovery_started", null);
  gateway.state.status = 502;
  await pushToDevices({ pushers: async () => [bipePusher("A")], sygnalUrl: gateway.url }, "@ana:example.test", "recovery_completed", null);
  assert.equal(gateway.state.requests.length, 1);
  await pushToDevices({ pushers: async () => [bipePusher("A")], sygnalUrl: "http://127.0.0.1:9" }, "@ana:example.test", "recovery_completed", null);
});
