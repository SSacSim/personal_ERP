import test from "node:test";
import assert from "node:assert/strict";
import { validateInlineImage } from "../app/static/inline-image-upload.js";

test("inline images accept supported clipboard formats without changing their bytes", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const file = new File(["image bytes"], "clipboard", { type });
    assert.equal(validateInlineImage(file), file);
  }
});

test("empty, unsupported and oversized images are rejected before reading or uploading", () => {
  assert.throws(() => validateInlineImage(new File([], "empty.png", { type: "image/png" })), /10MB/);
  assert.throws(() => validateInlineImage(new File(["<svg/>"], "image.svg", { type: "image/svg+xml" })), /JPG/);
  assert.throws(() => validateInlineImage({ type: "image/png", size: 10 * 1024 * 1024 + 1 }), /10MB/);
  assert.doesNotThrow(() => validateInlineImage({ type: "image/png", size: 10 * 1024 * 1024 }));
});
