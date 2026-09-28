import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { createTimer, startTimer, startSession, pauseTimer, advanceTimer, resetTimer, restoreTimer, historySnapshot } from "../app/static/pomodoro-timer.js";
import { historyProgress } from "../app/static/pomodoro-history.js";

const NOW = 1800000000000;
const ID = "0e857e9a-debd-4b8a-9b20-ae795fbccfb9";

test("one named execution persists through pause, resume and refresh", () => {
  const running = startSession(createTimer(25), "  김민수  ", ID, NOW);
  const paused = pauseTimer(running, NOW + 30500);
  const resumed = startTimer(paused, NOW + 3600000);
  const restored = restoreTimer(JSON.parse(JSON.stringify(resumed)), NOW + 3610000);
  for (const timer of [running, paused, resumed, restored]) {
    assert.equal(timer.session.id, ID);
    assert.equal(timer.session.person, "김민수");
    assert.equal(timer.session.startedAt, NOW);
  }
  assert.equal(historyProgress(historySnapshot(paused), NOW + 900000).focused, "0분 30초");
  assert.equal(historyProgress(historySnapshot(restored), NOW + 3610000).focused, "0분 40초");
  assert.ok(resumed.session.revision > paused.session.revision);
});

test("stopping or changing duration records the partial focus and clears session identity", () => {
  const running = startSession(createTimer(25), "김민수", ID, NOW);
  const stopped = historySnapshot(running, NOW + 125000, true);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.ends_at, null);
  assert.equal(historyProgress(stopped, NOW + 9000000).focused, "2분 5초");
  const paused = pauseTimer(running, NOW + 125000);
  assert.equal(historySnapshot(paused, NOW + 9000000, true).remaining_ms, stopped.remaining_ms);
  assert.equal(historySnapshot(resetTimer(paused)), null);
  assert.equal(historySnapshot(createTimer(15)), null);
});

test("completion and restart cannot reuse a previous execution identity", () => {
  const running = startSession(createTimer(1), "김민수", ID, NOW);
  const complete = advanceTimer(running, NOW + 60000);
  assert.equal(historyProgress(historySnapshot(complete), NOW + 120000).focused, "1분");
  assert.equal(historySnapshot(complete).status, "completed");
  assert.equal(historySnapshot(startTimer(complete, NOW + 120000)), null);
  const next = startSession(createTimer(1), "이서연", "5e6cb97b-c3b1-488a-999f-bd509f108657", NOW + 120000);
  assert.notEqual(next.session.id, complete.session.id);
  assert.equal(historyProgress(historySnapshot(next), NOW + 120000).focused, "0분");
});

test("legacy timers remain usable and invalid history metadata is ignored", () => {
  const running = startTimer(createTimer(), NOW);
  assert.equal(historySnapshot(restoreTimer(running, NOW)), null);
  for (const session of [{}, { id: "invalid", person: "김민수", startedAt: NOW, revision: NOW }]) {
    assert.equal(historySnapshot(restoreTimer({ ...running, session }, NOW)), null);
  }
  for (const name of ["", "   ", "가".repeat(81)]) assert.throws(() => startSession(createTimer(), name, ID, NOW), RangeError);
});

async function outbox(t, key) {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => { globalThis.localStorage = previousStorage; globalThis.fetch = previousFetch; });
  return { values, client: await import(`../app/static/pomodoro-history.js?test=${key}`) };
}

test("failed history writes survive reload and retry the same session id", async (t) => {
  const { values, client } = await outbox(t, "offline");
  globalThis.fetch = async () => { throw new Error("offline"); };
  const snapshot = historySnapshot(startSession(createTimer(25), "김민수", ID, NOW));
  client.queueHistory(snapshot);
  await settle();
  assert.equal(JSON.parse([...values.values()][0])[0].id, ID);
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; };
  const reloaded = await import("../app/static/pomodoro-history.js?test=offline-reloaded");
  await reloaded.flushHistory();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/pomodoro/history/${ID}`);
  assert.equal(calls[0].body.person, "김민수");
  assert.deepEqual(JSON.parse([...values.values()][0]), []);
});

test("an older in-flight save cannot erase a newer pause or create a duplicate", async (t) => {
  const { values, client } = await outbox(t, "inflight");
  let finish;
  const sent = [];
  globalThis.fetch = (url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve({ ok: true });
  };
  const running = startSession(createTimer(25), "김민수", ID, NOW);
  client.queueHistory(historySnapshot(running));
  client.queueHistory(historySnapshot(pauseTimer(running, NOW + 60000)));
  finish({ ok: true });
  await settle();
  assert.equal(JSON.parse([...values.values()][0])[0].status, "paused");
  await client.flushHistory();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].remaining_ms, 1440000);
  client.queueHistory(historySnapshot(running));
  await settle();
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse([...values.values()][0]), []);
});
