import test from "node:test";
import assert from "node:assert/strict";
import { mountReceipts } from "../app/static/receipts.js";

// Exercise the real UI listeners with a small DOM adapter, without browser dependencies.
class Element {
  constructor(selector = "") {
    this.selector = selector;
    this.children = new Map();
    this.handlers = new Map();
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(html) { this.html = html; this.children.clear(); }
  get innerHTML() { return this.html || ""; }
  querySelector(selector) {
    const optional = { fieldset: "<fieldset>", "[data-save]": "data-save", "[data-edit]": "data-edit>", "[data-delete]": "data-delete" };
    if (this.selector === "[data-detail]" && optional[selector] && !this.innerHTML.includes(optional[selector])) return null;
    if (!this.children.has(selector)) {
      const child = new Element(selector);
      child.parent = this;
      this.children.set(selector, child);
    }
    return this.children.get(selector);
  }
  querySelectorAll(selector) {
    if (selector === "[data-receipt-id]") return [...this.innerHTML.matchAll(/data-receipt-id="([^"]+)"/g)].map((match) => {
      const row = this.querySelector(match[1]);
      row.selector = "[data-receipt-id]";
      row.dataset.receiptId = match[1];
      return row;
    });
    if (selector === "[data-edit], [data-delete]") return [this.querySelector("[data-edit]"), this.querySelector("[data-delete]")].filter(Boolean);
    return [];
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  matches(selector) { return this.selector === selector || (selector === "button" && /^\[data-(edit|delete|cancel-edit|save|photo-index)\]$/.test(this.selector)); }
  hasAttribute(name) { return this.selector === `[${name}]`; }
  removeAttribute(name) { delete this[name]; }
  setAttribute(name, value) { this[name] = value; }
  contains() { return false; }
  focus() { if (!this.disabled) document.activeElement = this; }
  reportValidity() { return true; }
  decode() { return Promise.resolve(); }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  dispatch(name, target = this) { return this.handlers.get(name)?.({ target, preventDefault() {}, stopPropagation() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const receipt = (i) => ({ id: `receipt-${i}`, registrant: "홍길동", content: `식비 ${i}`, filename: "photo.JPG", created_at: "2026-10-01T12:00:00+09:00", image_url: `/api/receipts/receipt-${i}/image` });

async function environment(t, count = 1) {
  const previous = Object.fromEntries(["document", "window", "fetch", "setInterval", "clearInterval", "FileReader"].map((key) => [key, globalThis[key]]));
  const env = { records: Array.from({ length: count }, (_, i) => receipt(i)), calls: [], confirm: false, intercept: null };
  globalThis.document = { body: new Element(), activeElement: null, hidden: false, createElement() {
    const image = new Element();
    image.decode = () => env.failDecode ? Promise.reject(new Error("decode failed")) : Promise.resolve();
    return image;
  } };
  globalThis.window = { confirm: () => env.confirm };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.FileReader = class {
    async readAsDataURL(file) {
      this.result = "data:application/octet-stream;base64," + Buffer.from(await file.arrayBuffer()).toString("base64");
      this.onload();
    }
  };
  globalThis.fetch = async (url, options = {}) => {
    env.calls.push({ url, options });
    if (env.intercept) {
      const response = env.intercept(url, options);
      if (response) return response;
    }
    if (options.method === "PATCH") {
      const item = env.records.find((entry) => url.endsWith("/" + entry.id));
      Object.assign(item, JSON.parse(options.body instanceof FormData ? options.body.get("metadata") : options.body), { updated_at: "2026-10-01T13:00:00+09:00" });
      return json(item);
    }
    if (options.method === "DELETE") {
      env.records = env.records.filter((entry) => !url.endsWith("/" + entry.id));
      return new Response(null, { status: 204 });
    }
    const offset = Number(new URL(url, "http://erp.local").searchParams.get("offset"));
    return json({ items: env.records.slice(offset, offset + 24), total: env.records.length, offset, limit: 24 });
  };
  env.container = new Element();
  env.dispose = mountReceipts(env.container);
  t.after(() => { env.dispose(); Object.assign(globalThis, previous); });
  await settle();
  env.detail = env.container.querySelector("[data-detail]");
  env.dialog = env.container.querySelector(".receipt-dialog");
  env.open = (index = 0) => {
    const rows = env.container.querySelector("tbody");
    return rows.dispatch("click", rows.querySelectorAll("[data-receipt-id]")[index]);
  };
  env.click = (action) => env.detail.dispatch("click", env.detail.querySelector(`[data-${action}]`));
  env.submit = (content) => {
    const form = env.detail.querySelector("[data-edit-form]");
    form.elements = { content: { value: content } };
    return env.detail.dispatch("submit", form);
  };
  env.writes = () => env.calls.filter(({ options }) => ["PATCH", "DELETE"].includes(options.method));
  return env;
}

test("editing can be cancelled without changing the saved receipt", async (t) => {
  const env = await environment(t);
  env.open();
  assert.equal(env.dialog.open, true);
  await env.click("edit");
  assert.match(env.detail.innerHTML, /data-edit-form/);
  await env.click("cancel-edit");
  assert.doesNotMatch(env.detail.innerHTML, /data-edit-form/);
  assert.match(env.detail.innerHTML, /식비 0/);
  assert.equal(env.writes().length, 0);
});

test("failed saves retain input, block duplicate requests while pending and can be retried", async (t) => {
  const env = await environment(t);
  env.open();
  await env.click("edit");
  let complete;
  env.intercept = (_url, options) => options.method === "PATCH" ? new Promise((resolve) => { complete = resolve; }) : null;
  const saving = env.submit("수정한 내용 <b>그대로</b>");
  assert.equal(env.container.querySelector("[data-close]").disabled, true);
  await env.submit("수정한 내용 <b>그대로</b>");
  assert.equal(env.writes().length, 1);
  complete(json({ detail: "저장 실패" }, 503));
  await saving;
  assert.equal(env.detail.querySelector("[data-edit-form]").elements.content.value, "수정한 내용 <b>그대로</b>");
  assert.equal(env.detail.querySelector("[data-detail-notice]").textContent, "저장 실패");
  assert.equal(env.detail.querySelector("[data-save]").disabled, false);
  env.intercept = null;
  await env.submit("수정한 내용 <b>그대로</b>");
  assert.match(env.detail.innerHTML, /수정한 내용 &lt;b&gt;그대로&lt;\/b&gt;/);
  assert.match(env.container.querySelector("tbody").innerHTML, /수정한 내용/);
  assert.equal(env.detail.querySelector("[data-detail-notice]").textContent, "저장했습니다.");
});

test("uppercase JPG replacement keeps the original filename and bytes in the edit request", async (t) => {
  const env = await environment(t);
  env.open();
  await env.click("edit");
  const input = env.detail.querySelector("#receipt-photo");
  input.files = [new File(["test image bytes"], "교체.JPG", { type: "image/jpg" })];
  await env.detail.dispatch("change", input);
  assert.equal(env.detail.querySelector("[data-save]").disabled, false);
  await env.submit("교체한 영수증");
  const body = env.writes()[0].options.body;
  assert.deepEqual(JSON.parse(body.get("metadata")), { content: "교체한 영수증" });
  assert.equal(body.getAll("images")[0].name, "교체.JPG");
  assert.equal(await body.getAll("images")[0].text(), "test image bytes");
});

test("blank content and unreadable replacement images cannot be saved", async (t) => {
  const env = await environment(t);
  env.open();
  await env.click("edit");
  await env.submit("   ");
  assert.equal(env.writes().length, 0);
  const input = env.detail.querySelector("#receipt-photo");
  input.files = [new File(["invalid image"], "broken.JPG", { type: "image/jpeg" })];
  env.failDecode = true;
  await env.detail.dispatch("change", input);
  assert.equal(env.detail.querySelector("[data-save]").disabled, true);
  await env.submit("수정 내용");
  assert.equal(env.writes().length, 0);
});

test("each photo in a receipt can be selected and downloaded by its own URL and filename", async (t) => {
  const env = await environment(t);
  env.records[0].images = [1, 2, 3].map((index) => ({ filename: `사진${index}.JPG`, image_url: `/api/receipts/receipt-0/images/${index}` }));
  env.container.querySelector("[data-refresh]").dispatch("click");
  await settle();
  assert.match(env.container.querySelector("tbody").innerHTML, /3장/);
  env.open();
  assert.match(env.detail.querySelector("[data-gallery]").innerHTML, /사진 3 보기/);
  for (const index of [1, 2, 0]) {
    const button = env.detail.querySelector("[data-photo-index]");
    button.dataset.photoIndex = String(index);
    await env.detail.dispatch("click", button);
    assert.equal(env.detail.querySelector("[data-photo-position]").textContent, `사진 ${index + 1} / 3`);
    assert.equal(env.detail.querySelector(".receipt-detail-photo img").src, env.records[0].images[index].image_url);
    assert.equal(env.detail.querySelector("[data-photo-download]").href, env.records[0].images[index].image_url + "?download=true");
    assert.equal(env.detail.querySelector("[data-photo-download]").download, `사진${index + 1}.JPG`);
  }
});

test("all replacement photos are sent together and cancel does not change existing photos", async (t) => {
  const env = await environment(t);
  env.open();
  await env.click("edit");
  const input = env.detail.querySelector("#receipt-photo");
  input.files = [new File(["first"], "first.JPG"), new File(["second"], "second.PNG")];
  await env.detail.dispatch("change", input);
  assert.match(env.detail.querySelector("[data-gallery]").innerHTML, /사진 2 보기/);
  await env.click("cancel-edit");
  assert.equal(env.writes().length, 0);
  await env.click("edit");
  const retryInput = env.detail.querySelector("#receipt-photo");
  retryInput.files = input.files;
  await env.detail.dispatch("change", retryInput);
  await env.submit("사진 교체");
  assert.deepEqual(env.writes()[0].options.body.getAll("images").map((file) => file.name), ["first.JPG", "second.PNG"]);
});

test("delete requires confirmation, preserves the dialog on failure and removes the row on retry", async (t) => {
  const env = await environment(t);
  env.open();
  await env.click("delete");
  assert.equal(env.writes().length, 0);
  env.confirm = true;
  env.intercept = (_url, options) => options.method === "DELETE" ? json({ detail: "삭제 실패" }, 503) : null;
  await env.click("delete");
  assert.equal(env.dialog.open, true);
  assert.equal(env.detail.querySelector("[data-detail-notice]").textContent, "삭제 실패");
  env.intercept = null;
  await env.click("delete");
  assert.equal(env.dialog.open, false);
  assert.equal(env.container.querySelector(".receipts-count").textContent, "0건");
  assert.equal(env.container.querySelector(".receipts-table-wrap").hidden, true);
});

test("deleting the last receipt on a page returns to the previous populated page", async (t) => {
  const env = await environment(t, 25);
  env.container.querySelector("[data-next]").dispatch("click");
  await settle();
  env.open();
  env.confirm = true;
  await env.click("delete");
  assert.equal(env.records.length, 24);
  assert.equal(env.container.querySelector("[data-page]").textContent, "1 / 1");
  assert.equal(env.container.querySelector("tbody").querySelectorAll("[data-receipt-id]").length, 24);
  assert.equal(env.calls.at(-1).url, "/api/receipts?offset=0&limit=24");
});

test("a save response arriving after navigation does not reopen the old dialog", async (t) => {
  const env = await environment(t);
  env.open();
  await env.click("edit");
  let complete;
  env.intercept = (_url, options) => options.method === "PATCH" ? new Promise((resolve) => { complete = resolve; }) : null;
  const saving = env.submit("수정 내용");
  env.dispose();
  env.container.innerHTML = "다른 화면";
  complete(json({ ...receipt(0), content: "수정 내용" }));
  await saving;
  assert.equal(env.dialog.open, false);
  assert.equal(env.container.innerHTML, "다른 화면");
  assert.equal(env.writes()[0].options.signal.aborted, true);
});
