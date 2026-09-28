import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMenuOrder, moveMenuItem, setupSidebarOrder } from "../app/static/sidebar-order.js";

const defaults = { private: ["tasks", "todos"], public: ["calendar", "chat", "id-info"] };

test("saved orders cannot move menus between groups, duplicate them or remove new menus", () => {
  assert.deepEqual(normalizeMenuOrder(defaults, { private: ["chat", "todos", "todos"], public: ["tasks", "id-info", "dashboard", "missing"] }), {
    private: ["todos", "tasks"], public: ["id-info", "calendar", "chat"],
  });
  for (const value of [null, [], "invalid", { private: {}, public: 5 }]) {
    assert.deepEqual(normalizeMenuOrder(defaults, value), defaults);
  }
  const moved = moveMenuItem(defaults, "public", "calendar", "id-info", true);
  assert.deepEqual(moved.public, ["chat", "id-info", "calendar"]);
  assert.deepEqual(defaults.public, ["calendar", "chat", "id-info"]);
  assert.equal(moveMenuItem(defaults, "public", "chat", "todos"), defaults);
  assert.equal(moveMenuItem(defaults, "private", "chat", "todos"), defaults);
  assert.equal(moveMenuItem(defaults, "private", "dashboard", "todos"), defaults);
});

// DOM adapter exercises real pointer/keyboard listeners without browser dependencies.
class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.listeners = new Map();
    this.captures = new Set();
    this.scrollTop = this.scrollLeft = 0;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, value) => { value ? this.classList.add(name) : this.classList.remove(name); },
    };
  }
  matches(selector) {
    if (selector === "[data-menu-group]") return Boolean(this.dataset.menuGroup);
    if (selector === "[data-menu-item]") return Boolean(this.dataset.menuItem);
    if (selector === "a[data-route]") return this.tagName === "a" && Boolean(this.dataset.route);
    return selector.startsWith(".") && this.className.split(" ").includes(selector.slice(1));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
  }
  replaceWith(node) {
    const parent = this.parentElement;
    parent.children[parent.children.indexOf(this)] = node;
    node.parentElement = parent;
    this.parentElement = null;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
  }
  setAttribute() {}
  focus() { document.activeElement = this; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  emit(name, values = {}) {
    const event = { isPrimary: true, button: 0, pointerId: 1, clientX: 50, clientY: 120,
      preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; }, ...values };
    for (const callback of this.listeners.get(name) || []) { callback(event); if (event.stopped) break; }
    return event;
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  getBoundingClientRect() {
    if (this.dataset.menuItem) {
      const group = this.parentElement.getBoundingClientRect();
      const index = this.parentElement.children.indexOf(this);
      const horizontal = window.matchMedia().matches;
      const left = group.left + (horizontal ? index * 125 : 0);
      const top = group.top + (horizontal ? 0 : index * 45);
      return { left, top, right: left + 120, bottom: top + 40, width: 120, height: 40 };
    }
    return this.rect || { left: 0, right: 230, top: 0, bottom: 900, width: 230, height: 900 };
  }
}

function environment(t, { saved = null, sideways = false, unavailable = false, key = "menu.alice" } = {}) {
  const previous = Object.fromEntries(["document", "window", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"].map((name) => [name, globalThis[name]]));
  const sidebar = new Element();
  sidebar.className = "sidebar";
  const nav = new Element("nav");
  sidebar.append(nav);
  const dashboard = new Element("a");
  dashboard.dataset.route = "dashboard";
  nav.append(dashboard);
  for (const [name, routes] of Object.entries(defaults)) {
    const group = new Element();
    group.dataset.menuGroup = name;
    group.rect = { left: 0, right: 230, top: name === "private" ? 100 : 250, bottom: name === "private" ? 185 : 380, width: 230 };
    for (const route of routes) { const link = new Element("a"); link.dataset.route = route; link.textContent = route; group.append(link); }
    nav.append(group);
  }
  let hit = null;
  const body = new Element("body");
  body.append(sidebar);
  globalThis.document = { createElement: (tag) => new Element(tag), body, elementFromPoint: () => hit };
  globalThis.window = Object.assign(new Element(), { matchMedia: () => ({ matches: sideways }), innerWidth: 1200, innerHeight: 900 });
  const storage = new Map(saved === null ? [] : [[key, JSON.stringify(saved)]]);
  globalThis.localStorage = {
    getItem: (name) => { if (unavailable) throw new Error("Disabled"); return storage.get(name) || null; },
    setItem: (name, value) => { if (unavailable) throw new Error("Disabled"); storage.set(name, value); },
  };
  let nextFrame = 0;
  const frames = new Map();
  globalThis.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => { window.emit("blur"); Object.assign(globalThis, previous); });
  setupSidebarOrder(nav, key);
  const row = (route) => nav.querySelectorAll("[data-menu-item]").find((item) => item.dataset.menuItem === route);
  const handle = (route) => row(route).querySelector(".nav-drag-handle");
  const order = (name) => nav.querySelectorAll("[data-menu-group]").find((group) => group.dataset.menuGroup === name).children.map((item) => item.dataset.menuItem);
  function start(route) {
    const rect = row(route).getBoundingClientRect();
    handle(route).emit("pointerdown", { clientX: rect.left + 5, clientY: rect.top + 5 });
  }
  function aim(source, target, after = true, gap = false) {
    const rect = row(target).getBoundingClientRect();
    hit = gap ? row(target).parentElement : row(target);
    const point = { clientX: rect.left + (after ? 100 : 10), clientY: rect.top + (after ? 35 : 5) };
    if (gap) point.clientY = rect.bottom + 2;
    handle(source).emit("pointermove", point);
    return point;
  }
  return { nav, row, handle, order, start, aim, storage, frames, dashboard, pointAt: (node) => { hit = node; } };
}

test("pointer drag reorders within a group, persists per-account order and never moves dashboard", (t) => {
  const env = environment(t);
  env.start("tasks");
  const point = env.aim("tasks", "todos");
  assert.deepEqual(env.order("private"), defaults.private); // Preview only, until release.
  assert.match(env.row("todos").className, /nav-drop-after/);
  env.handle("tasks").emit("pointerup", point);
  assert.deepEqual(env.order("private"), ["todos", "tasks"]);
  assert.deepEqual(JSON.parse(env.storage.get("menu.alice")).private, ["todos", "tasks"]);
  assert.deepEqual(env.order("public"), defaults.public);
  assert.equal(env.dashboard.parentElement, env.nav);
  assert.equal(env.dashboard.children.length, 0);
  assert.equal(env.handle("tasks").hasPointerCapture(1), false);
  assert.equal(env.frames.size, 0);
  assert.equal(env.handle("tasks").emit("click").prevented, true);
});

test("cross-group drops, Escape, cancelled pointers and handle clicks leave the order unchanged", (t) => {
  const env = environment(t);
  env.start("chat");
  env.handle("chat").emit("pointerup", env.aim("chat", "todos"));
  env.start("tasks");
  env.handle("tasks").emit("pointerup", env.aim("tasks", "chat"));
  env.start("tasks");
  env.aim("tasks", "todos");
  assert.equal(window.emit("keydown", { key: "Escape" }).stopped, true);
  env.start("tasks");
  env.aim("tasks", "todos");
  env.handle("tasks").emit("pointercancel");
  env.start("tasks");
  env.handle("tasks").emit("pointerup");
  assert.deepEqual(env.order("private"), defaults.private);
  assert.deepEqual(env.order("public"), defaults.public);
  assert.equal(env.storage.size, 0);
  assert.equal(env.frames.size, 0);
});

test("dropping on the insertion gap works and keyboard movement stops at group boundaries", (t) => {
  const env = environment(t);
  env.start("id-info");
  env.handle("id-info").emit("pointerup", env.aim("id-info", "calendar", true, true));
  assert.deepEqual(env.order("public"), ["calendar", "id-info", "chat"]);
  env.handle("todos").emit("keydown", { key: "ArrowUp" });
  env.handle("todos").emit("keydown", { key: "ArrowUp" });
  assert.deepEqual(env.order("private"), ["todos", "tasks"]);
  assert.equal(document.activeElement, env.handle("todos"));
});

test("restored and synchronized preferences stay in their groups and ignore other accounts", (t) => {
  const env = environment(t, { saved: { private: ["todos", "tasks"], public: ["chat", "calendar", "id-info"] } });
  assert.deepEqual(env.order("private"), ["todos", "tasks"]);
  assert.deepEqual(env.order("public"), ["chat", "calendar", "id-info"]);
  window.emit("storage", { key: "menu.bob", newValue: JSON.stringify(defaults) });
  assert.deepEqual(env.order("private"), ["todos", "tasks"]);
  window.emit("storage", { key: "menu.alice", newValue: JSON.stringify({ private: ["chat"], public: ["tasks", "id-info"] }) });
  assert.deepEqual(env.order("private"), defaults.private);
  assert.deepEqual(env.order("public"), ["id-info", "calendar", "chat"]);
  window.emit("storage", { key: "menu.alice", newValue: "not json" });
  assert.deepEqual(env.order("public"), defaults.public);
});

test("horizontal touch dragging uses left/right drop positions without requiring storage", (t) => {
  const env = environment(t, { sideways: true, unavailable: true });
  env.start("calendar");
  const point = env.aim("calendar", "id-info");
  env.handle("calendar").emit("pointerup", { ...point, pointerType: "touch" });
  assert.deepEqual(env.order("public"), ["chat", "id-info", "calendar"]);
  assert.match(env.nav.querySelector(".nav-sort-status").textContent, /현재 화면/);
});
