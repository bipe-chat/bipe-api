import assert from "node:assert/strict";
import { test } from "node:test";
import { dueReminder, reminderKind } from "../dist/business-pushes.js";

const HOUR = 3_600_000;

test("a reminder is due from its time for 30 minutes, and never after the start", () => {
  const start = 100 * HOUR;
  assert.equal(dueReminder(start, [1440, 120], start - 3 * HOUR), undefined);
  assert.equal(dueReminder(start, [1440, 120], start - 2 * HOUR), 120);
  assert.equal(dueReminder(start, [1440, 120], start - 2 * HOUR + 29 * 60_000), 120);
  assert.equal(dueReminder(start, [1440, 120], start - HOUR), undefined, "too late");
  assert.equal(dueReminder(start, [1440, 120], start - 24 * HOUR), 1440);
  assert.equal(dueReminder(start, [120], start + HOUR), undefined);
});

test("a long reminder says tomorrow and a short one says soon", () => {
  assert.equal(reminderKind(1440), "booking_tomorrow");
  assert.equal(reminderKind(120), "booking_soon");
});
