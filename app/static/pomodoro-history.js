import { userStorageKey } from "./auth-state.js";
const OUTBOX_KEY = "erp.pomodoro.history.outbox.v1";
const listeners = new Set();
const acknowledged = new Map();
let pending = new Map();
let sending = false;
let syncError = "";

function readPending() {
  try {
    const values = JSON.parse(localStorage.getItem(userStorageKey(OUTBOX_KEY)) || "[]");
    if (Array.isArray(values)) for (const value of values) {
      if (value && typeof value.id === "string" && Number.isSafeInteger(value.revision)
          && typeof value.person === "string" && Number.isFinite(value.started_at)
          && Number.isFinite(value.duration_ms) && Number.isFinite(value.remaining_ms)
          && value.revision > (pending.get(value.id)?.revision || 0)
          && value.revision > (acknowledged.get(value.id) || 0)) pending.set(value.id, value);
    }
  } catch { /* The current page can still retain pending records in memory. */ }
}

function persistPending() {
  try { localStorage.setItem(userStorageKey(OUTBOX_KEY), JSON.stringify([...pending.values()])); } catch { /* In-memory fallback. */ }
}

function notify() { listeners.forEach((listener) => listener()); }

export function queueHistory(snapshot) {
  if (!snapshot) return;
  readPending();
  if (snapshot.revision <= (acknowledged.get(snapshot.id) || 0) || snapshot.revision < (pending.get(snapshot.id)?.revision || 0)) return;
  pending.set(snapshot.id, snapshot);
  persistPending();
  notify();
  void flushHistory();
}

export async function flushHistory() {
  if (sending) return;
  readPending();
  if (!pending.size) return;
  sending = true;
  try {
    for (const snapshot of [...pending.values()]) {
      const { id, ...body } = snapshot;
      const response = await fetch(`/api/pomodoro/history/${encodeURIComponent(id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("기록을 저장하지 못했습니다. 연결되면 자동으로 다시 저장합니다.");
      acknowledged.set(id, Math.max(snapshot.revision, acknowledged.get(id) || 0));
      if (pending.get(id)?.revision === snapshot.revision) pending.delete(id);
      persistPending();
      syncError = "";
      notify();
    }
  } catch {
    syncError = "기록을 저장하지 못했습니다. 연결되면 자동으로 다시 저장합니다.";
    notify();
  } finally { sending = false; }
}

export function startHistorySync() {
  const onOnline = () => { void flushHistory(); };
  const onStorage = (event) => {
    if (event.key === userStorageKey(OUTBOX_KEY) || event.key === null) { readPending(); notify(); void flushHistory(); }
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("storage", onStorage);
  const interval = setInterval(onOnline, 10000);
  void flushHistory();
  return () => { clearInterval(interval); window.removeEventListener("online", onOnline); window.removeEventListener("storage", onStorage); };
}

export function historyProgress(item, now = Date.now()) {
  const remaining = item.status === "running" ? Math.max(0, Math.min(item.remaining_ms, item.ends_at - now)) : item.remaining_ms;
  const seconds = Math.floor(Math.max(0, item.duration_ms - remaining) / 1000);
  return {
    status: item.status === "running" && remaining === 0 ? "completed" : item.status,
    focused: `${Math.floor(seconds / 60)}분${seconds % 60 ? ` ${seconds % 60}초` : ""}`,
  };
}

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function mountPomodoroHistory(panel) {
  let disposed = false;
  let loading = false;
  let reloadRequested = false;
  let items = [];
  let total = 0;
  let offset = 0;
  let loadError = "";
  const controller = new AbortController();
  panel.innerHTML = `
    <header class="pomo-history-heading"><h2>실행 기록</h2><span data-count>0건</span></header>
    <p class="pomo-history-caption">실제 집중한 시간 · 목표 시간</p>
    <p class="pomo-history-notice" role="status" hidden></p>
    <ol class="pomo-history-list"></ol>
    <div class="pomo-history-footer"><button class="secondary" type="button" data-prev aria-label="최신 기록 보기">이전</button><span data-page></span><button class="secondary" type="button" data-next aria-label="이전 실행 기록 보기">다음</button><button class="secondary" type="button" data-refresh>새로고침</button></div>`;
  const find = (selector) => panel.querySelector(selector);
  const list = find("ol");
  const notice = find(".pomo-history-notice");

  function render() {
    if (disposed || panel.hidden) return;
    const merged = new Map(items.map((item) => [item.id, item]));
    for (const item of pending.values()) {
      if ((offset === 0 || merged.has(item.id)) && item.revision >= (merged.get(item.id)?.revision || 0)) merged.set(item.id, item);
    }
    const records = [...merged.values()].sort((a, b) => b.started_at - a.started_at);
    const labels = { running: "집중 중", paused: "일시정지", completed: "완료", stopped: "종료" };
    list.innerHTML = records.length ? records.map((item) => {
      const state = historyProgress(item);
      return `<li class="pomo-history-entry"><div><strong class="pomo-history-person">${escape(item.person)}</strong><strong class="pomo-history-duration">${state.focused}</strong></div><div class="pomo-history-meta"><time datetime="${new Date(item.started_at).toISOString()}">${dateFormatter.format(new Date(item.started_at))}</time><span>목표 ${item.duration_ms / 60000}분</span></div><span class="pomo-history-status" data-state="${state.status}">${labels[state.status] || "기록"}${pending.has(item.id) ? " · 저장 대기" : ""}</span></li>`;
    }).join("") : `<li class="pomo-history-empty">${loading ? "기록을 불러오는 중입니다." : loadError ? "새로고침을 눌러 다시 확인해 주세요." : "이름을 입력하고 시작하면 실행 기록이 쌓입니다."}</li>`;
    const unsavedCount = offset === 0 ? [...pending.keys()].filter((id) => !items.some((item) => item.id === id)).length : 0;
    find("[data-count]").textContent = `${total + unsavedCount}건`;
    notice.textContent = syncError || loadError || (pending.size ? `기록 ${pending.size}건을 저장 중입니다.` : "");
    notice.hidden = !notice.textContent;
    find("[data-prev]").disabled = loading || offset === 0;
    find("[data-next]").disabled = loading || offset + 25 >= total;
    find("[data-refresh]").disabled = loading;
    find("[data-page]").textContent = `${Math.floor(offset / 25) + 1} / ${Math.max(1, Math.ceil(total / 25))}`;
  }

  async function load() {
    if (disposed || panel.hidden) return;
    if (loading) { reloadRequested = true; return; }
    loading = true;
    render();
    try {
      const response = await fetch(`/api/pomodoro/history?limit=25&offset=${offset}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (disposed) return;
      items = data.items;
      total = data.total;
      loadError = "";
    } catch { if (!disposed) loadError = "실행 기록을 불러오지 못했습니다."; }
    finally {
      loading = false;
      render();
      if (reloadRequested) { reloadRequested = false; void load(); }
    }
  }

  const changed = () => { render(); if (offset === 0) void load(); };
  listeners.add(changed);
  find("[data-prev]").addEventListener("click", () => { offset = Math.max(0, offset - 25); void load(); });
  find("[data-next]").addEventListener("click", () => { offset += 25; void load(); });
  find("[data-refresh]").addEventListener("click", () => { void flushHistory(); void load(); });
  const tick = setInterval(render, 1000);
  const poll = setInterval(() => { if (!document.hidden && offset === 0) void load(); }, 5000);
  void load();
  return {
    refresh() { render(); void load(); },
    dispose() { disposed = true; controller.abort(); clearInterval(tick); clearInterval(poll); listeners.delete(changed); },
  };
}
