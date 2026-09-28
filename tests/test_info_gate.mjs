import test from "node:test";
import assert from "node:assert/strict";
import { mountIdInfo } from "../app/static/id-info.js";

// Minimal DOM adapter for lifecycle tests; API behavior is exercised separately.
class Element {
  constructor() {
    this.children = new Map();
    this.handlers = new Map();
    this.value = "";
    this.disabled = false;
    this.classList = { toggle() {} };
  }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  setAttribute() {}
  focus() {}
  reportValidity() { return true; }
  reset() { Object.values(this.elements || {}).forEach((input) => { input.value = ""; }); }
  dispatch(name) { return this.handlers.get(name)?.({ preventDefault() {} }); }
}

class Container extends Element {
  set innerHTML(html) {
    this.html = html;
    this.children = new Map();
    const form = this.querySelector("form");
    form.elements = Object.fromEntries(["access_password", "category", "login_id", "password", "notes"].map((key) => [key, new Element()]));
  }
  replaceChildren() { this.html = ""; this.children.clear(); }
}

function environment(t, respond) {
  const previous = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return respond(url, options);
  };
  globalThis.setTimeout = (callback) => { timers.set(++nextTimer, callback); return nextTimer; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => Object.assign(globalThis, previous));
  const container = new Container();
  const dispose = mountIdInfo(container);
  t.after(dispose);
  return { container, dispose, calls, timers };
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function submit(container, password) {
  const form = container.querySelector("form");
  form.elements.access_password.value = password;
  await form.dispatch("submit");
  await settle();
  return form;
}

test("Info fetches no records before unlock and clears incorrect submitted passwords", async (t) => {
  const env = environment(t, () => json({ detail: "Wrong password" }, 403));
  assert.equal(env.calls.length, 0);
  assert.match(env.container.html, /id-info-lock/);
  const form = await submit(env.container, "incorrect secret");
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, "/api/id-info/unlock");
  assert.deepEqual(JSON.parse(env.calls[0].options.body), { password: "incorrect secret" });
  assert.equal(form.elements.access_password.value, "");
  assert.equal(form.querySelector("[role='alert']").textContent, "Wrong password");
  assert.equal(form.querySelector("button").disabled, false);
});

test("successful unlock authorizes data requests; leaving revokes the grant and clears the view", async (t) => {
  const env = environment(t, (url) => url.endsWith("/unlock") ? json({ token: "verified-grant", expires_in: 1800 })
    : url.endsWith("/lock") ? new Response(null, { status: 204 }) : json({ items: [] }));
  await submit(env.container, "correct secret");
  assert.equal(env.calls[1].url, "/api/id-info");
  assert.equal(env.calls[1].options.headers["X-ERP-Info-Token"], "verified-grant");
  assert.equal(env.calls[1].options.body, undefined);
  assert.match(env.container.html, /id-info-table/);
  env.dispose();
  assert.equal(env.container.html, "");
  assert.equal(env.calls.at(-1).url, "/api/id-info/lock");
  assert.equal(env.calls.at(-1).options.headers["X-ERP-Info-Token"], "verified-grant");
  assert.equal(env.calls[1].options.signal.aborted, true);
  assert.equal(env.timers.size, 0);
  const disposeAgain = mountIdInfo(env.container);
  assert.match(env.container.html, /id-info-lock/);
  assert.equal(env.calls.length, 3);
  disposeAgain();
});

test("expiry or a rejected grant removes the information and returns to the password screen", async (t) => {
  let reject = false;
  const env = environment(t, (url) => url.endsWith("/unlock") ? json({ token: "grant", expires_in: 1800 })
    : url.endsWith("/lock") ? new Response(null, { status: 204 })
      : reject ? json({ detail: "Locked" }, 403, { "X-ERP-Info-Locked": "1" }) : json({ items: [] }));
  await submit(env.container, "password");
  [...env.timers.values()][0]();
  assert.match(env.container.html, /id-info-lock/);
  assert.doesNotMatch(env.container.html, /id-info-table/);
  await submit(env.container, "password");
  reject = true;
  await env.container.querySelector("[data-refresh]").dispatch("click");
  await settle();
  assert.match(env.container.html, /id-info-lock/);
  assert.equal(env.timers.size, 0);
});

test("an unlock response arriving after navigation cannot replace the next page", async (t) => {
  let complete;
  const env = environment(t, () => new Promise((resolve) => { complete = resolve; }));
  const pending = submit(env.container, "password");
  env.dispose();
  env.container.innerHTML = "Next page";
  complete(json({ token: "late-grant", expires_in: 1800 }));
  await pending;
  assert.equal(env.container.html, "Next page");
  assert.equal(env.calls.length, 1);
  assert.equal(env.timers.size, 0);
});
