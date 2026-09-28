import test from "node:test";
import assert from "node:assert/strict";

async function environment(t, label) {
  const previous = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  const redirects = [];
  const requests = [];
  const user = { id: "account-one", name: "김민수", job_title: "대리", role: "user" };
  let reply = new Response(JSON.stringify({ user }), { status: 200 });
  globalThis.window = globalThis;
  globalThis.location = { href: "http://erp.local/chat", origin: "http://erp.local", pathname: "/chat", search: "", replace: (url) => redirects.push(url) };
  globalThis.fetch = async (input, options) => { requests.push({ input, options }); return reply.clone(); };
  t.after(() => Object.assign(globalThis, previous));
  const session = await import(`../app/static/auth-state.js?test=${label}`);
  return { session, user, requests, redirects, reply: (value) => { reply = value; } };
}

test("authenticated identity scopes local timers and accompanies same-origin API writes", async (t) => {
  const env = await environment(t, "identity");
  assert.deepEqual(await env.session.requireSession(), env.user);
  assert.equal(env.session.userStorageKey("timer"), "timer.account-one");
  await fetch("/api/receipts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const request = env.requests.at(-1);
  assert.equal(request.options.headers.get("X-ERP-User"), env.user.id);
  assert.equal(request.options.headers.get("Content-Type"), "application/json");
  assert.equal(request.options.body, "{}");
  await fetch("https://different.example/api/items");
  assert.equal(env.requests.at(-1).options, undefined);
});

test("expired sessions return to login while switched accounts reload before stale writes continue", async (t) => {
  const env = await environment(t, "expiry");
  await env.session.requireSession();
  env.reply(new Response("{}", { status: 401 }));
  await fetch("/api/team-chat/messages");
  assert.equal(env.redirects.at(-1), "/login?next=%2Fchat");
  env.reply(new Response("{}", { status: 409, headers: { "X-ERP-Account-Changed": "1" } }));
  await fetch("/api/pomodoro/history/run", { method: "PUT", body: "{}" });
  assert.equal(env.redirects.at(-1), "/");
});

test("an unauthenticated page stops initialization and retains its return address", async (t) => {
  const env = await environment(t, "missing");
  globalThis.location.pathname = "/receipt-upload";
  env.reply(new Response("{}", { status: 401 }));
  await assert.rejects(env.session.requireSession(), /로그인/);
  assert.equal(env.session.currentUser(), null);
  assert.equal(env.redirects[0], "/login?next=%2Freceipt-upload");
});
