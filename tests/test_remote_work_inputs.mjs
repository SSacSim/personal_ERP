import test from "node:test";
import assert from "node:assert/strict";
import { clipboardImage, pastedImages, readClipboardImages, hasDraggedFiles } from "../app/static/remote-work-inputs.js";

test("normal text and HTML pastes do not become image attachments", () => {
  assert.deepEqual(pastedImages({ items: [{ kind: "string", type: "text/plain" }, { kind: "string", type: "text/html" }], files: [] }), []);
  assert.deepEqual(pastedImages({ files: [new File(["report"], "report.txt", { type: "text/plain" })] }), []);
  assert.deepEqual(pastedImages(null), []);
});

test("an image listed in both clipboard items and files is attached only once", () => {
  const screenshot = new File([new Uint8Array([137, 80, 78, 71])], "image", { type: "image/png" });
  const result = pastedImages({ items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }], files: [screenshot] });
  assert.deepEqual(result, [screenshot]);
  assert.deepEqual(pastedImages({ files: [screenshot] }), [screenshot]);
});

test("pasted blobs retain their bytes and get uploadable unique image filenames", async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const first = clipboardImage(blob);
  const second = clipboardImage(blob);
  assert.match(first.name, /\.png$/);
  assert.notEqual(first.name, second.name);
  assert.equal(first.type, "image/png");
  assert.deepEqual(await first.arrayBuffer(), await blob.arrayBuffer());
  assert.throws(() => clipboardImage(new Blob(["<svg/>"], { type: "image/svg+xml" })), /형식을 지원/);
});

test("clipboard button prefers one image format per item and ignores copied text", async () => {
  const requested = [];
  const images = await readClipboardImages({ read: async () => [
    { types: ["image/jpeg", "image/png"], getType: async (type) => { requested.push(type); return new Blob(["image"]); } },
    { types: ["text/plain"], getType: () => assert.fail("plain text must not be read") },
    { types: ["image/webp"], getType: async (type) => { requested.push(type); return new Blob(["second image"]); } },
  ] });
  assert.equal(images.length, 2);
  assert.deepEqual(requested, ["image/png", "image/webp"]);
  assert.deepEqual(images.map((image) => image.type), ["image/png", "image/webp"]);
});

test("missing clipboard access offers keyboard paste and permission errors are preserved", async () => {
  await assert.rejects(readClipboardImages(undefined), /Ctrl\+V/);
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  await assert.rejects(readClipboardImages({ read: async () => { throw denied; } }), (error) => error === denied);
  assert.deepEqual(await readClipboardImages({ read: async () => [{ types: ["text/plain"] }] }), []);
});

test("file drags are recognized before file contents are accessible without intercepting text drags", () => {
  assert.equal(hasDraggedFiles({ types: ["Files"], files: [] }), true);
  assert.equal(hasDraggedFiles({ items: [{ kind: "file" }] }), true);
  assert.equal(hasDraggedFiles({ types: ["text/plain", "text/uri-list"], items: [{ kind: "string" }] }), false);
  assert.equal(hasDraggedFiles(null), false);
});
