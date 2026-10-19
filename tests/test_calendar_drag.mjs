import test from "node:test";
import assert from "node:assert/strict";
import { shiftedCalendarDates } from "../app/static/calendar-drag.js";

test("moving an event from the 19th to the 22nd changes only date fields", () => {
  const item = { date: "2026-10-19", title: "회의", start_time: "10:30", attendees: ["동료"] };
  assert.deepEqual(shiftedCalendarDates(item, "2026-10-19", "2026-10-22"), {
    date: "2026-10-22", start_date: "2026-10-22", end_date: "2026-10-22",
  });
  assert.equal(item.date, "2026-10-19");
});

test("dragging any day of a range preserves its duration and the grabbed day offset", () => {
  const item = { start_date: "2026-10-19", end_date: "2026-10-21" };
  assert.deepEqual(shiftedCalendarDates(item, "2026-10-20", "2026-10-22"), {
    date: "2026-10-21", start_date: "2026-10-21", end_date: "2026-10-23",
  });
  assert.deepEqual(shiftedCalendarDates(item, "2026-10-19", "2026-09-30"), {
    date: "2026-09-30", start_date: "2026-09-30", end_date: "2026-10-02",
  });
});

test("calendar arithmetic handles year boundaries, leap days and daylight saving changes", () => {
  for (const [item, origin, target, expectedEnd] of [
    [{ start_date: "2026-12-30", end_date: "2027-01-02" }, "2026-12-30", "2027-01-02", "2027-01-05"],
    [{ start_date: "2028-02-28", end_date: "2028-03-01" }, "2028-02-28", "2028-02-29", "2028-03-02"],
    [{ start_date: "2026-03-07", end_date: "2026-03-09" }, "2026-03-07", "2026-03-08", "2026-03-10"],
  ]) assert.equal(shiftedCalendarDates(item, origin, target).end_date, expectedEnd);
});

test("malformed dates, reversed ranges and dates past the supported year are rejected", () => {
  for (const item of [{}, { date: "2026-02-30" }, { start_date: "2026-10-22", end_date: "2026-10-19" }]) {
    assert.throws(() => shiftedCalendarDates(item, "2026-10-19", "2026-10-22"));
  }
  assert.throws(() => shiftedCalendarDates({ date: "2026-10-19" }, "2026-10-19", "not-a-date"));
  assert.throws(() => shiftedCalendarDates({ start_date: "9999-12-30", end_date: "9999-12-31" }, "9999-12-30", "9999-12-31"));
});
