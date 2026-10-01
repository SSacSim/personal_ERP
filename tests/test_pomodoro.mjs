import test from "node:test";
import assert from "node:assert/strict";
import { createTimer, remainingTime, advanceTimer, startTimer, pauseTimer, resetTimer, restoreTimer, formatRemaining, dialScale, dialAngle, sectorPath, pointerAngle, minutesAtAngle, dragMinutes, miniTimerState } from "../app/static/pomodoro-timer.js";

const NOW = 1800000000000;

test("accepts custom minute limits and rejects invalid durations", () => {
  assert.equal(createTimer(1).durationMs, 60000);
  assert.equal(createTimer(180).durationMs, 10800000);
  assert.equal(createTimer().durationMs, 1500000);
  for (const value of [0, -1, 181, 1.5, NaN, Infinity, "25", null]) {
    assert.throws(() => createTimer(value), RangeError);
  }
});

test("counts against a deadline even when ticks are delayed or a device sleeps", () => {
  const timer = startTimer(createTimer(25), NOW);
  assert.equal(timer.endsAt, NOW + 1500000);
  assert.equal(remainingTime(timer, NOW + 1250), 1498750);
  assert.equal(remainingTime(timer, NOW + 10 * 60000), 15 * 60000);
  assert.equal(remainingTime(timer, NOW + 24 * 60000 + 59499), 501);
  assert.equal(remainingTime(timer, NOW + 30 * 60000), 0);
  assert.equal(startTimer(timer, NOW + 1000).endsAt, timer.endsAt);
});

test("pause freezes the exact remainder and resume excludes paused time", () => {
  const started = startTimer(createTimer(10), NOW);
  const paused = pauseTimer(started, NOW + 2350);
  assert.equal(paused.status, "paused");
  assert.equal(paused.remainingMs, 597650);
  assert.equal(paused.endsAt, null);
  assert.equal(remainingTime(paused, NOW + 60 * 60000), 597650);
  const resumed = startTimer(paused, NOW + 3600000);
  assert.equal(resumed.endsAt, NOW + 3600000 + 597650);
  assert.equal(remainingTime(resumed, NOW + 3601000), 596650);
});

test("serialized timer survives refresh and navigation without restarting", () => {
  const saved = JSON.parse(JSON.stringify(startTimer(createTimer(45), NOW)));
  const reopened = restoreTimer(saved, NOW + 15 * 60000);
  assert.equal(reopened.status, "running");
  assert.equal(reopened.endsAt, saved.endsAt);
  assert.equal(remainingTime(reopened, NOW + 15 * 60000), 30 * 60000);
  const paused = pauseTimer(reopened, NOW + 15 * 60000);
  assert.deepEqual(restoreTimer(JSON.parse(JSON.stringify(paused)), NOW + 90000000), paused);
});

test("expired sessions restore as completed with zero remaining time", () => {
  const timer = startTimer(createTimer(1), NOW);
  const complete = advanceTimer(timer, NOW + 60000);
  assert.equal(complete.status, "completed");
  assert.equal(complete.remainingMs, 0);
  assert.equal(complete.endsAt, null);
  assert.strictEqual(advanceTimer(complete, NOW + 999999), complete);
  assert.deepEqual(restoreTimer(timer, NOW + 999999), complete);
  assert.deepEqual(pauseTimer(timer, NOW + 60000), complete);
  const restarted = startTimer(complete, NOW + 120000);
  assert.equal(restarted.endsAt, NOW + 180000);
});

test("reset stops the timer and retains the chosen focus duration", () => {
  const timer = startTimer(createTimer(90), NOW);
  const reset = resetTimer(pauseTimer(timer, NOW + 12345));
  assert.deepEqual(reset, createTimer(90));
  assert.equal(remainingTime(reset, NOW + 9999999), 5400000);
});

test("invalid saved state falls back to a usable timer", () => {
  const base = createTimer();
  for (const value of [
    null, [], {}, { ...base, version: 0 }, { ...base, status: "unknown" },
    { ...base, durationMs: "1500000" }, { ...base, durationMs: 1 }, { ...base, durationMs: Infinity },
    { ...base, remainingMs: -1 }, { ...base, remainingMs: 99999999 }, { ...base, remainingMs: "1" },
    { ...base, status: "running", endsAt: null }, { ...base, status: "running", endsAt: "1234" },
  ]) assert.deepEqual(restoreTimer(value, NOW), base);
  assert.equal(restoreTimer({ ...base, status: "paused", remainingMs: 0 }, NOW).status, "idle");
});

test("clock sector expresses actual remaining minutes and expands above an hour", () => {
  const timer = startTimer(createTimer(25), NOW);
  assert.equal(dialScale(timer.durationMs), 60);
  assert.equal(dialAngle(timer, NOW), 150);
  assert.equal(dialAngle(timer, NOW + 750000), 75);
  assert.equal(dialAngle(timer, NOW + 1500000), 0);
  assert.equal(dialScale(createTimer(90).durationMs), 120);
  assert.equal(dialAngle(createTimer(90), NOW), 270);
  assert.equal(dialScale(createTimer(180).durationMs), 180);
  assert.equal(dialAngle(createTimer(180), NOW), 360);
});

test("sector handles empty, half, and full circles without an SVG gap", () => {
  assert.equal(sectorPath(0), "");
  assert.equal(sectorPath(-10), "");
  assert.equal(sectorPath(180), "M 200 200 L 200 64 A 136 136 0 0 1 200.0000 336.0000 Z");
  assert.equal((sectorPath(360).match(/A 136 136/g) || []).length, 2);
  assert.equal(sectorPath(400), sectorPath(360));
});

test("countdown rounds up the last second and never displays negative time", () => {
  assert.equal(formatRemaining(1500000), "25:00");
  assert.equal(formatRemaining(59999), "01:00");
  assert.equal(formatRemaining(1), "00:01");
  assert.equal(formatRemaining(0), "00:00");
  assert.equal(formatRemaining(-1000), "00:00");
  assert.equal(formatRemaining(180 * 60000), "180:00");
});

test("pointer positions follow a clock from twelve o'clock clockwise", () => {
  assert.equal(pointerAngle(0, -100), 0);
  assert.equal(pointerAngle(100, 0), 90);
  assert.equal(pointerAngle(0, 100), 180);
  assert.equal(pointerAngle(-100, 0), 270);
  assert.equal(pointerAngle(0, 0), null);
  assert.equal(pointerAngle(NaN, 100), null);
  assert.equal(pointerAngle(100, Infinity), null);
});

test("clicking the dial selects whole minutes on the current scale", () => {
  assert.equal(minutesAtAngle(90, 60, 25), 15);
  assert.equal(minutesAtAngle(90, 120, 90), 30);
  assert.equal(minutesAtAngle(270, 180, 90), 135);
  assert.equal(minutesAtAngle(0, 60, 1), 1);
  assert.equal(minutesAtAngle(0, 60, 59), 60);
  assert.equal(minutesAtAngle(359, 60, 59), 60);
});

test("dragging across twelve o'clock stops at the boundary instead of wrapping", () => {
  let minutes = dragMinutes(59, 354, 0, 60);
  assert.equal(minutes, 60);
  minutes = dragMinutes(minutes, 0, 6, 60);
  assert.equal(minutes, 60);
  assert.equal(dragMinutes(minutes, 6, 0, 60), 59);
  assert.equal(dragMinutes(1, 6, 354, 60), 1);
  assert.equal(dragMinutes(1, 354, 0, 60), 2);
  assert.equal(dragMinutes(179, 358, 2, 180), 180);
});

test("small pointer movements accumulate and reverse without losing precision", () => {
  let minutes = 25;
  for (let angle = 150; angle < 156; angle += .25) minutes = dragMinutes(minutes, angle, angle + .25, 60);
  assert.ok(Math.abs(minutes - 26) < 1e-9);
  minutes = dragMinutes(minutes, 156, 144, 60);
  assert.ok(Math.abs(minutes - 24) < 1e-9);
});

test("changing a long duration keeps the dial scale stable during a drag", () => {
  const scale = dialScale(createTimer(90).durationMs);
  const minutes = dragMinutes(90, 270, 180, scale);
  assert.equal(minutes, 60);
  const adjusted = createTimer(minutes);
  assert.equal(dialAngle(adjusted, NOW, scale), 180);
  assert.equal(dialAngle(startTimer(adjusted, NOW), NOW + 30 * 60000, scale), 90);
});

test("floating timer stays visible across ERP routes without resetting the deadline", () => {
  const timer = startTimer(createTimer(25), NOW);
  for (const route of ["dashboard", "calendar", "tasks", "receipts", "remote-work", "id-info"]) {
    const state = miniTimerState(timer, route, NOW + 10 * 60000);
    assert.equal(state.visible, true);
    assert.equal(state.remainingMs, 15 * 60000);
    assert.equal(state.remainingPercent, 60);
  }
  assert.equal(miniTimerState(timer, "pomodoro", NOW).visible, false);
  assert.equal(timer.endsAt, NOW + 25 * 60000);
});

test("red bar measures the chosen duration rather than an hour or the analog dial scale", () => {
  for (const minutes of [1, 25, 90, 180]) {
    const timer = startTimer(createTimer(minutes), NOW);
    assert.equal(miniTimerState(timer, "meetings", NOW).remainingPercent, 100);
    assert.equal(miniTimerState(timer, "meetings", NOW + minutes * 30000).remainingPercent, 50);
    assert.equal(miniTimerState(timer, "meetings", NOW + minutes * 60000).remainingPercent, 0);
  }
});

test("floating timer hides on pause, reset, completion and expiry between delayed ticks", () => {
  const timer = startTimer(createTimer(1), NOW);
  const paused = pauseTimer(timer, NOW + 15000);
  for (const value of [createTimer(), paused, resetTimer(timer), advanceTimer(timer, NOW + 60000)]) {
    assert.equal(miniTimerState(value, "documents", NOW + 15000).visible, false);
  }
  assert.equal(miniTimerState(timer, "documents", NOW + 90000).visible, false);
  assert.equal(miniTimerState(timer, "documents", NOW + 90000).remainingPercent, 0);
  const resumed = startTimer(paused, NOW + 120000);
  assert.equal(miniTimerState(resumed, "documents", NOW + 120000).remainingPercent, 75);
  assert.equal(miniTimerState(resumed, "documents", NOW + 120000).visible, true);
});

test("reloading a different ERP tab restores the same remaining bar", () => {
  const timer = startTimer(createTimer(25), NOW);
  const restored = restoreTimer(JSON.parse(JSON.stringify(timer)), NOW + 900000);
  assert.deepEqual(miniTimerState(restored, "receipts", NOW + 900000), {
    visible: true, remainingMs: 600000, remainingPercent: 40,
  });
  assert.equal(miniTimerState(restoreTimer(timer, NOW + 1800000), "receipts", NOW + 1800000).visible, false);
});
