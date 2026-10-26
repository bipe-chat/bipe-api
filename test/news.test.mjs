import assert from "node:assert/strict";
import { test } from "node:test";
import { NewsItemFile, newsBody, newsPowerLevels, newsTxnId } from "../dist/news.js";

// Novidades do Bipe (ADR 0117, bipe#383): the item file, the message body and the room's power levels. No homeserver.

test("an item file needs an id, a text and an importance; the link is a bipe.chat page", () => {
  assert.ok(NewsItemFile.safeParse({ id: "stickers-2026-10", text: "Figurinhas chegaram.", importance: "normal" }).success);
  assert.ok(NewsItemFile.safeParse({ id: "a", text: "x", link: "https://bipe.chat/recursos/figurinhas/", importance: "important" }).success);
  for (const bad of [
    { id: "Upper", text: "x", importance: "normal" },
    { id: "ok", text: "  ", importance: "normal" },
    { id: "ok", text: "x", importance: "urgent" },
    { id: "ok", text: "x", link: "http://bipe.chat/a", importance: "normal" },
    { id: "ok", text: "x", link: "https://bipe.chat.evil.example/a", importance: "normal" },
    { id: "ok", text: "Antes — depois", importance: "normal" },
  ]) assert.equal(NewsItemFile.safeParse(bad).success, false, JSON.stringify(bad));
});

test("each item ends with the line that points to Suporte Bipe", () => {
  const body = newsBody({ body: "Figurinhas chegaram.", link: "https://bipe.chat/recursos/figurinhas/" });
  const parts = body.split("\n\n");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "Figurinhas chegaram.");
  assert.equal(parts[1], "https://bipe.chat/recursos/figurinhas/");
  assert.match(parts[2], /Suporte Bipe/);
  assert.equal(newsBody({ body: "Oi.", link: null }).split("\n\n").length, 2);
});

test("the room is read-only for the user", () => {
  const pl = newsPowerLevels("@ana:example.test");
  assert.deepEqual(Object.keys(pl.users), ["@ana:example.test"], "the creator (the bot) is not listed in a version 12 room");
  assert.equal(pl.users["@ana:example.test"], 0);
  assert.equal(pl.users_default, 0);
  assert.ok(pl.events_default > pl.users["@ana:example.test"], "the user cannot send messages");
  for (const k of ["state_default", "invite", "kick", "ban", "redact"]) assert.equal(pl[k], 100, k);
});

test("one transaction ID per item and room", () => {
  assert.equal(newsTxnId("a", "!one:example.test"), newsTxnId("a", "!one:example.test"));
  assert.notEqual(newsTxnId("a", "!one:example.test"), newsTxnId("a", "!two:example.test"));
  assert.notEqual(newsTxnId("a", "!one:example.test"), newsTxnId("b", "!one:example.test"));
});
