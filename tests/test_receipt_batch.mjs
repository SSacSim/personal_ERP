import test from "node:test";
import assert from "node:assert/strict";
import { submitReceiptBatch } from "../app/receipt_static/receipt-batch.js";

const details = { registrant: "홍길동", content: "출장 영수증" };
const receipt = (id) => ({ file: new File([id], `${id}.JPG`, { type: "image/jpg" }) });

test("three photos are sent in one request as original files in selection order", async () => {
  const entries = [receipt("one"), receipt("two"), receipt("three")];
  const calls = [];
  const result = await submitReceiptBatch(entries, details, { id: "one-receipt" }, async (body) => {
    calls.push(body);
    return { id: "one-receipt", image_count: 3 };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].get("metadata")), { submission_id: "one-receipt", ...details });
  assert.deepEqual(calls[0].getAll("images").map((file) => file.name), ["one.JPG", "two.JPG", "three.JPG"]);
  assert.deepEqual(await Promise.all(calls[0].getAll("images").map((file) => file.text())), ["one", "two", "three"]);
  assert.deepEqual(result, { id: "one-receipt", image_count: 3 });
});

test("failed groups retry with the original request ID, details and every photo", async () => {
  const entries = [receipt("one"), receipt("two"), receipt("three")];
  const submission = { id: "stable-id" };
  await assert.rejects(submitReceiptBatch(entries, details, submission, async () => { throw new Error("network failure"); }));
  assert.equal(submission.result, undefined);
  await submitReceiptBatch([receipt("different")], { content: "변경 시도" }, submission, async (body) => {
    assert.deepEqual(JSON.parse(body.get("metadata")), { submission_id: "stable-id", ...details });
    assert.equal(body.getAll("images").length, 3);
    return { id: "stable-id" };
  });
});

test("retrying a lost response does not create a second receipt", async () => {
  const entries = [receipt("one"), receipt("two"), receipt("three")];
  const submission = { id: "stable-id" };
  const server = new Map();
  let loseResponse = true;
  const upload = async (body) => {
    const { submission_id } = JSON.parse(body.get("metadata"));
    if (!server.has(submission_id)) server.set(submission_id, { id: submission_id, image_count: body.getAll("images").length });
    if (loseResponse) throw Object.assign(new Error("timeout"), { name: "AbortError" });
    return server.get(submission_id);
  };
  await assert.rejects(submitReceiptBatch(entries, details, submission, upload));
  loseResponse = false;
  assert.deepEqual(await submitReceiptBatch(entries, details, submission, upload), { id: "stable-id", image_count: 3 });
  assert.equal(server.size, 1);
  await submitReceiptBatch(entries, details, submission, () => { assert.fail("completed receipts must not be uploaded again"); });
});
