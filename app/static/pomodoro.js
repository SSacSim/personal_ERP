import { createTimer, remainingTime, advanceTimer, startTimer, startSession, historySnapshot, pauseTimer, resetTimer, restoreTimer, formatRemaining, dialScale, dialAngle, sectorPath, pointerAngle, minutesAtAngle, dragMinutes, miniTimerState, MAX_MINUTES } from "./pomodoro-timer.js";
import { queueHistory, startHistorySync, mountPomodoroHistory } from "./pomodoro-history.js";
import { currentUser, userStorageKey } from "./auth-state.js";

const STORAGE_KEY = "erp.pomodoro.v1";
let memoryTimer = createTimer();
const timerListeners = new Set();
const preferences = new Map();

function preference(key, fallback = "") {
  key = userStorageKey(key);
  try { return localStorage.getItem(key) ?? preferences.get(key) ?? fallback; }
  catch { return preferences.get(key) ?? fallback; }
}

function savePreference(key, value) {
  key = userStorageKey(key);
  preferences.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* In-memory fallback. */ }
}

function sessionId() {
  if (globalThis.crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readTimer() {
  try {
    const saved = localStorage.getItem(userStorageKey(STORAGE_KEY));
    if (saved) memoryTimer = restoreTimer(JSON.parse(saved));
  } catch { /* Keep the timer usable if browser storage is unavailable. */ }
  return advanceTimer(memoryTimer);
}

function saveTimer(timer) {
  if (memoryTimer.session && memoryTimer.session.id !== timer.session?.id && ["running", "paused"].includes(memoryTimer.status)) {
    queueHistory(historySnapshot(memoryTimer, Date.now(), true));
  }
  memoryTimer = timer;
  try { localStorage.setItem(userStorageKey(STORAGE_KEY), JSON.stringify(timer)); } catch { /* In-memory fallback. */ }
  queueHistory(historySnapshot(timer));
  timerListeners.forEach((listener) => listener(timer));
}

// Mounted outside the route view so the countdown continues across ERP tabs.
export function mountPomodoroIndicator(navigate) {
  let timer = readTimer();
  const stopHistorySync = startHistorySync();
  queueHistory(historySnapshot(timer));
  let lastTime = null;
  const indicator = document.createElement("a");
  indicator.className = "pomo-mini";
  indicator.href = "/pomodoro";
  indicator.hidden = true;
  indicator.title = "뽀모도로로 돌아가기";
  indicator.innerHTML = `
    <span class="pomo-mini-heading"><span class="pomo-mini-label"><svg class="icon" aria-hidden="true"><use href="/static/icons.svg#timer" /></svg>뽀모도로</span><span class="pomo-mini-remaining"><strong data-mini-time></strong><span>남음</span></span></span>
    <span class="pomo-mini-track" aria-hidden="true"><span class="pomo-mini-fill" data-mini-fill></span></span>`;
  const time = indicator.querySelector("[data-mini-time]");
  const fill = indicator.querySelector("[data-mini-fill]");
  document.body.appendChild(indicator);

  function update(now = Date.now()) {
    const advanced = advanceTimer(timer, now);
    if (advanced !== timer) { timer = advanced; saveTimer(timer); }
    const state = miniTimerState(timer, document.body.dataset.route, now);
    indicator.hidden = !state.visible;
    document.body.classList.toggle("pomo-mini-visible", state.visible);
    if (!state.visible) return;
    const formatted = formatRemaining(state.remainingMs);
    if (formatted !== lastTime) {
      time.textContent = formatted;
      indicator.setAttribute("aria-label", `뽀모도로 ${formatted} 남음. 뽀모도로로 돌아가기`);
      lastTime = formatted;
    }
    fill.style.width = `${state.remainingPercent}%`;
  }

  function synchronize(savedTimer) { timer = savedTimer || readTimer(); update(); }
  function onStorage(event) {
    if (event.key !== userStorageKey(STORAGE_KEY) && event.key !== null) return;
    if (event.newValue === null) memoryTimer = createTimer();
    synchronize();
  }
  const onVisibility = () => { if (!document.hidden) synchronize(); };
  indicator.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate();
  });
  timerListeners.add(synchronize);
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisibility);
  const interval = setInterval(() => { if (!document.hidden && timer.status === "running") update(); }, 250);
  update();
  return {
    refresh: synchronize,
    dispose() {
      stopHistorySync();
      clearInterval(interval);
      timerListeners.delete(synchronize);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      indicator.remove();
      document.body.classList.remove("pomo-mini-visible");
    },
  };
}

function clockMarks() {
  return Array.from({ length: 60 }, (_, index) => {
    const major = index % 5 === 0;
    return `<line class="pomo-tick${major ? " major" : ""}" x1="200" y1="${major ? 46 : 51}" x2="200" y2="58" transform="rotate(${index * 6} 200 200)" />`;
  }).join("");
}

function clockNumbers(scale) {
  return Array.from({ length: 12 }, (_, index) => {
    const angle = index * Math.PI / 6;
    return `<text class="pomo-number" x="${200 + Math.sin(angle) * 173}" y="${200 - Math.cos(angle) * 173}">${index * scale / 12}</text>`;
  }).join("");
}

export function mountPomodoro(container) {
  let timer = readTimer();
  let scale = dialScale(timer.durationMs);
  let drag = null;
  let lastStatus = null;
  let lastScale = null;
  let lastTime = null;

  container.innerHTML = `
    <div class="pomo-workspace">
    <div class="pomo-toolbar"><button class="secondary" type="button" data-history-toggle aria-controls="pomo-history" aria-expanded="true">기록 숨기기</button></div>
    <div class="pomo-body">
    <section class="pomo-page" data-status="idle" aria-label="뽀모도로 타이머">
      <div class="pomo-clock">
        <svg class="pomo-dial" viewBox="0 0 400 400" role="slider" tabindex="0" aria-label="바늘로 집중 시간 설정" aria-valuemin="1" aria-valuemax="60" aria-valuenow="25" aria-describedby="pomo-hint">
          <g aria-hidden="true">
            <circle class="pomo-face" cx="200" cy="200" r="194" />
            <circle class="pomo-track" cx="200" cy="200" r="136" />
            <path class="pomo-sector" data-sector />
            <g>${clockMarks()}</g><g data-numbers></g>
            <g class="pomo-hand" data-hand data-drag-handle>
              <line class="pomo-hand-hit" x1="200" y1="200" x2="200" y2="72" />
              <line class="pomo-hand-line" x1="200" y1="200" x2="200" y2="72" />
              <circle class="pomo-handle-hit" cx="200" cy="76" r="20" />
              <circle class="pomo-handle" cx="200" cy="76" r="7" />
            </g>
          </g>
        </svg>
        <button class="pomo-toggle" type="button" data-toggle aria-label="집중 시작">
          <span class="pomo-time" data-time aria-hidden="true">25:00</span>
          <span class="pomo-action"><span data-action-icon aria-hidden="true">▶</span><span data-action-label>시작</span></span>
        </button>
        <span class="pomo-sr-only" data-timer role="timer" aria-live="off" aria-label="남은 집중 시간">25:00</span>
      </div>
      <form class="pomo-settings">
        <div class="pomo-person-field"><label for="pomo-person">이름</label><input id="pomo-person" name="person" maxlength="80" autocomplete="name" placeholder="실행할 사람" required /></div>
        <div class="pomo-time-settings">
        <label for="pomo-minutes">집중 시간</label>
        <div class="pomo-input-wrap"><input id="pomo-minutes" name="minutes" type="number" min="1" max="${MAX_MINUTES}" step="1" inputmode="numeric" aria-describedby="pomo-hint" required /><span>분</span></div>
        <button class="pomo-reset" type="button" data-reset aria-label="설정한 시간으로 초기화" title="초기화"><svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1.6 7M4 4v6h6" /></svg></button>
        </div>
      </form>
      <p id="pomo-hint" class="pomo-hint" role="status" aria-live="polite" data-message></p>
    </section>
    <aside class="pomo-history" id="pomo-history" aria-label="뽀모도로 실행 기록" aria-live="off" hidden></aside>
    </div></div>`;

  const find = (selector) => container.querySelector(selector);
  const page = find(".pomo-page");
  const form = find("form");
  const input = form.elements.minutes;
  const person = form.elements.person;
  const dial = find(".pomo-dial");
  const sector = find("[data-sector]");
  const hand = find("[data-hand]");
  const numbers = find("[data-numbers]");
  const time = find("[data-time]");
  const accessibleTime = find("[data-timer]");
  const toggle = find("[data-toggle]");
  const reset = find("[data-reset]");
  const workspace = find(".pomo-workspace");
  const historyPanel = find(".pomo-history");
  const historyToggle = find("[data-history-toggle]");
  let historyOpen = preference("erp.pomodoro.history.open", "true") === "true";
  function displayHistory() {
    workspace.dataset.historyOpen = String(historyOpen);
    historyPanel.hidden = !historyOpen;
    historyToggle.setAttribute("aria-expanded", String(historyOpen));
    historyToggle.textContent = historyOpen ? "기록 숨기기" : "실행 기록 보기";
  }
  displayHistory();
  const history = mountPomodoroHistory(historyPanel);
  historyToggle.addEventListener("click", () => {
    historyOpen = !historyOpen;
    savePreference("erp.pomodoro.history.open", String(historyOpen));
    displayHistory();
    if (historyOpen) history.refresh();
  });
  input.value = timer.durationMs / 60000;
  person.value = currentUser()?.name || timer.session?.person || preference("erp.pomodoro.person");
  person.readOnly = Boolean(currentUser());

  function update(now = Date.now()) {
    const advanced = advanceTimer(timer, now);
    if (advanced !== timer) { timer = advanced; saveTimer(timer); }
    const remaining = remainingTime(timer, now);
    const formatted = formatRemaining(remaining);
    if (lastScale !== scale) {
      numbers.innerHTML = clockNumbers(scale);
      dial.setAttribute("aria-valuemax", scale);
      lastScale = scale;
    }
    const angle = dialAngle(timer, now, scale);
    sector.setAttribute("d", sectorPath(angle));
    hand.setAttribute("transform", `rotate(${angle} 200 200)`);
    dial.setAttribute("aria-valuenow", Math.max(1, Math.ceil(remaining / 60000)));
    dial.setAttribute("aria-valuetext", `남은 시간 ${formatted}, 한 바퀴 ${scale}분`);
    if (lastTime !== formatted) {
      time.textContent = formatted;
      accessibleTime.textContent = formatted;
      if (document.body.dataset.route === "pomodoro") document.title = `${formatted} · 뽀모도로 · ERP`;
      lastTime = formatted;
    }
    const running = timer.status === "running";
    input.disabled = running || Boolean(drag);
    person.disabled = running || timer.status === "paused" || Boolean(drag);
    if (timer.session && (running || timer.status === "paused")) person.value = timer.session.person;
    toggle.disabled = Boolean(drag);
    reset.disabled = Boolean(drag) || timer.status === "idle";
    dial.setAttribute("aria-disabled", String(running));
    dial.setAttribute("tabindex", running ? "-1" : "0");
    if (lastStatus !== timer.status) {
      const states = {
        idle: ["시작", "▶", "바늘을 드래그하거나 아래 시간을 입력하세요."],
        running: ["일시정지", "Ⅱ", "시간을 바꾸려면 일시정지하세요."],
        paused: ["재개", "▶", "잠시 멈췄어요. 시간을 조절하거나 이어서 시작하세요."],
        completed: ["다시 시작", "↻", "집중 완료! 잠깐 쉬어가세요."],
      };
      const [action, icon, message] = states[timer.status];
      page.dataset.status = timer.status;
      find("[data-action-label]").textContent = action;
      find("[data-action-icon]").textContent = icon;
      find("[data-message]").textContent = message;
      toggle.setAttribute("aria-label", `집중 ${action}`);
      lastStatus = timer.status;
    }
  }

  function changeDuration(minutes, keepScale = false, persist = true) {
    if (timer.status === "running") return;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return;
    timer = createTimer(minutes);
    if (!keepScale) scale = dialScale(timer.durationMs);
    if (persist) saveTimer(timer);
    update();
  }

  input.addEventListener("input", () => changeDuration(input.valueAsNumber));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.reportValidity()) changeDuration(input.valueAsNumber);
  });
  toggle.addEventListener("click", () => {
    if (drag) return;
    if (timer.status !== "running" && !form.reportValidity()) return;
    if (timer.status === "idle" || timer.status === "completed") {
      const name = currentUser()?.name || person.value.trim();
      if (!name) { person.setCustomValidity("이름을 입력해 주세요."); person.reportValidity(); return; }
      savePreference("erp.pomodoro.person", name);
      timer = startSession(createTimer(input.valueAsNumber), name, sessionId());
    } else timer = timer.status === "running" ? pauseTimer(timer) : startTimer(timer);
    saveTimer(timer);
    update();
  });
  person.addEventListener("input", () => person.setCustomValidity(""));
  reset.addEventListener("click", () => {
    timer = resetTimer(timer);
    input.value = timer.durationMs / 60000;
    saveTimer(timer);
    update();
  });

  function pointOnDial(event) {
    const bounds = dial.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    // Ignore the central button area, where angle changes are unstable.
    if (Math.hypot(x, y) < bounds.width * .16) return null;
    return pointerAngle(x, y);
  }

  function previewDrag() {
    const minutes = Math.round(drag.minutes);
    input.value = minutes;
    changeDuration(minutes, true, false);
  }

  function finishDrag(commit) {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (!commit || !current.changed) timer = current.original;
    else saveTimer(timer);
    input.value = timer.durationMs / 60000;
    page.classList.remove("is-dragging");
    if (dial.hasPointerCapture(current.pointerId)) dial.releasePointerCapture(current.pointerId);
    update();
  }

  dial.addEventListener("pointerdown", (event) => {
    if (timer.status === "running" || drag || event.button !== 0 || event.isPrimary === false) return;
    const angle = pointOnDial(event);
    if (angle === null) return;
    event.preventDefault();
    const onHand = Boolean(event.target.closest("[data-drag-handle]"));
    const minutes = Math.max(1, remainingTime(timer) / 60000);
    drag = { pointerId: event.pointerId, angle, minutes, original: timer, changed: !onHand };
    dial.setPointerCapture(event.pointerId);
    dial.focus({ preventScroll: true });
    page.classList.add("is-dragging");
    if (!onHand) {
      drag.minutes = minutesAtAngle(angle, scale, minutes);
      previewDrag();
    } else update();
  });
  dial.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const angle = pointOnDial(event);
    if (angle === null) return;
    event.preventDefault();
    const minutes = dragMinutes(drag.minutes, drag.angle, angle, scale);
    drag.angle = angle;
    if (minutes === drag.minutes) return;
    drag.minutes = minutes;
    drag.changed = true;
    previewDrag();
  });
  dial.addEventListener("pointerup", (event) => {
    if (drag?.pointerId === event.pointerId) finishDrag(true);
  });
  for (const eventName of ["pointercancel", "lostpointercapture"]) {
    dial.addEventListener(eventName, (event) => {
      if (drag?.pointerId === event.pointerId) finishDrag(false);
    });
  }
  dial.addEventListener("keydown", (event) => {
    if (timer.status === "running" || drag) return;
    const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 };
    if (!(event.key in steps) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const minutes = event.key === "Home" ? 1 : event.key === "End" ? scale : Math.round(remainingTime(timer) / 60000) + steps[event.key];
    input.value = Math.max(1, Math.min(scale, minutes));
    changeDuration(input.valueAsNumber, true);
  });

  function synchronize(event) {
    if (event.key !== userStorageKey(STORAGE_KEY) && event.key !== null) return;
    finishDrag(false);
    if (event.newValue === null) memoryTimer = createTimer();
    timer = readTimer();
    scale = dialScale(timer.durationMs);
    input.value = timer.durationMs / 60000;
    update();
  }
  const onVisibility = () => {
    if (document.hidden) finishDrag(false);
    else update();
  };
  window.addEventListener("storage", synchronize);
  document.addEventListener("visibilitychange", onVisibility);
  update();
  const interval = setInterval(() => { if (timer.status === "running") update(); }, 250);
  return () => {
    history.dispose();
    finishDrag(false);
    clearInterval(interval);
    window.removeEventListener("storage", synchronize);
    document.removeEventListener("visibilitychange", onVisibility);
    memoryTimer = advanceTimer(timer);
  };
}
