import test from "node:test";
import assert from "node:assert/strict";
import { submitReceiptBatch } from "../app/receipt_static/receipt-batch.js";

const details = { registrant: "홍길동", content: "출장 영수증" };
const receipt = (id) => ({ id, file: { name: "영수증.png", size: 100 }, status: "ready", details: null });

test("uploads each selected photo separately with common details and preserves order", async () => {
  const entries = [receipt("one"), receipt("two"), receipt("three")];
  const calls = [];
  let active = 0;
  let maximum = 0;
  const result = await submitReceiptBatch(entries, details, async (entry) => {
    maximum = Math.max(maximum, ++active);
    await Promise.resolve();
    calls.push({ id: entry.id, details: entry.details, file: entry.file });
    active--;
    return { id: entry.id, created_at: "2026-09-28T12:00:00+09:00" };
  });
  assert.deepEqual(result, { saved: 3, failed: 0 });
  assert.deepEqual(calls.map((call) => call.id), ["one", "two", "three"]);
  assert.ok(calls.every((call) => call.details.registrant === details.registrant && call.details.content === details.content));
  assert.equal(maximum, 1, "large images should be read and uploaded one at a time");
  assert.ok(entries.every((entry) => entry.result.id === entry.id));
});

test("continues after one failure, then retries only that photo with its original ID and details", async () => {
  const entries = [receipt("one"), receipt("two"), receipt("three")];
  const calls = [];
  let fail = true;
  const upload = async (entry) => {
    calls.push({ id: entry.id, ...entry.details });
    if (entry.id === "two" && fail) throw new Error("일시적인 저장 오류");
    return { id: entry.id };
  };
  assert.deepEqual(await submitReceiptBatch(entries, details, upload), { saved: 2, failed: 1 });
  assert.deepEqual(entries.map((entry) => entry.status), ["saved", "error", "saved"]);
  assert.equal(entries[1].error, "일시적인 저장 오류");
  fail = false;
  assert.deepEqual(await submitReceiptBatch(entries, { registrant: "변경 시도", content: "다른 내용" }, upload), { saved: 3, failed: 0 });
  assert.deepEqual(calls.map((call) => call.id), ["one", "two", "three", "two"]);
  assert.deepEqual(calls.at(-1), { id: "two", ...details });
  assert.equal(entries[1].error, "");
});

test("a lost response can be retried without creating another server record", async () => {
  const entries = [receipt("stable-id")];
  const server = new Map();
  let loseResponse = true;
  const upload = async (entry) => {
    if (!server.has(entry.id)) server.set(entry.id, { id: entry.id, ...entry.details });
    if (loseResponse) throw Object.assign(new Error("timeout"), { name: "AbortError" });
    return server.get(entry.id);
  };
  assert.deepEqual(await submitReceiptBatch(entries, details, upload), { saved: 0, failed: 1 });
  assert.match(entries[0].error, /응답이 지연/);
  loseResponse = false;
  assert.deepEqual(await submitReceiptBatch(entries, details, upload), { saved: 1, failed: 0 });
  assert.equal(server.size, 1);
  assert.equal(entries[0].result.id, "stable-id");
  await submitReceiptBatch(entries, details, () => { assert.fail("completed receipts must not be uploaded again"); });
});
