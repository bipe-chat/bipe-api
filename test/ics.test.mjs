import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchCalendar, isPrivateAddress } from "../dist/agenda-calendars.js";
import { parseBusy, writeFeed } from "../dist/ics.js";

const window = { start: Date.UTC(2030, 0, 1), end: Date.UTC(2030, 1, 1) };
const cal = (...lines) => ["BEGIN:VCALENDAR", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

test("private, loopback, link-local and metadata addresses are refused", () => {
  for (const a of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "ff02::1", "not-an-address"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "142.250.1.1", "2607:f8b0:4004::1"]) assert.equal(isPrivateAddress(a), false, a);
});

test("the fetch refuses http, credentials and a literal private address before connecting", async () => {
  for (const url of ["http://example.com/a.ics", "https://user:pw@example.com/a.ics", "https://127.0.0.1/a.ics", "https://[::1]/a.ics", "https://169.254.169.254/latest/meta-data"]) {
    await assert.rejects(fetchCalendar(url), /refused url/, url);
  }
});

test("busy times keep start and end, skip free and cancelled events, and read zones", () => {
  const busy = parseBusy(cal("SUMMARY:Secret", "DTSTART;TZID=America/Sao_Paulo:20300110T090000", "DTEND;TZID=America/Sao_Paulo:20300110T100000"), window, "UTC");
  assert.deepEqual(busy, [{ start: Date.UTC(2030, 0, 10, 12), end: Date.UTC(2030, 0, 10, 13) }]);
  assert.deepEqual(parseBusy(cal("DTSTART:20300110T090000Z", "DTEND:20300110T100000Z", "TRANSP:TRANSPARENT"), window, "UTC"), []);
  assert.deepEqual(parseBusy(cal("DTSTART:20300110T090000Z", "DTEND:20300110T100000Z", "STATUS:CANCELLED"), window, "UTC"), []);
  assert.deepEqual(parseBusy(cal("DTSTART;VALUE=DATE:20300110"), window, "UTC"), [{ start: Date.UTC(2030, 0, 10), end: Date.UTC(2030, 0, 11) }]);
  assert.deepEqual(parseBusy(cal("DTSTART:20300110T090000Z", "DURATION:PT30M"), window, "UTC"), [{ start: Date.UTC(2030, 0, 10, 9), end: Date.UTC(2030, 0, 10, 9, 30) }]);
});

test("recurring events expand inside the window, with COUNT, UNTIL, BYDAY and EXDATE", () => {
  const starts = (lines) => parseBusy(cal("DTSTART:20300107T090000Z", "DTEND:20300107T100000Z", ...lines), window, "UTC").map((b) => new Date(b.start).getUTCDate());
  assert.deepEqual(starts(["RRULE:FREQ=WEEKLY;BYDAY=MO"]), [7, 14, 21, 28]);
  assert.deepEqual(starts(["RRULE:FREQ=WEEKLY;COUNT=2"]), [7, 14]);
  assert.deepEqual(starts(["RRULE:FREQ=WEEKLY;UNTIL=20300115T000000Z"]), [7, 14]);
  assert.deepEqual(starts(["RRULE:FREQ=DAILY;INTERVAL=10"]), [7, 17, 27]);
  assert.deepEqual(starts(["RRULE:FREQ=WEEKLY", "EXDATE:20300114T090000Z"]), [7, 21, 28]);
});

test("a feed holds times and the summary, and escapes text", () => {
  const ics = writeFeed([{ id: "b1", start: new Date(Date.UTC(2030, 0, 1, 9)), end: new Date(Date.UTC(2030, 0, 1, 10)), summary: "Zé, o; primeiro", cancelled: false }], new Date(0));
  assert.match(ics, /DTSTART:20300101T090000Z/);
  assert.match(ics, /SUMMARY:Zé\\, o\; primeiro/);
});
