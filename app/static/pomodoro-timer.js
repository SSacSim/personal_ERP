export const DEFAULT_MINUTES = 25;
export const MAX_MINUTES = 180;

export function createTimer(minutes = DEFAULT_MINUTES) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    throw new RangeError(`집중 시간은 1~${MAX_MINUTES}분으로 입력해 주세요.`);
  }
  const durationMs = minutes * 60000;
  return { version: 1, status: "idle", durationMs, remainingMs: durationMs, endsAt: null };
}

export function remainingTime(timer, now = Date.now()) {
  const remaining = timer.status === "running" ? timer.endsAt - now : timer.remainingMs;
  return Math.max(0, Math.min(timer.durationMs, remaining));
}

function sessionRevision(timer, now) {
  return timer.session ? { session: { ...timer.session, revision: Math.max(now, timer.session.revision + 1) } } : {};
}

export function advanceTimer(timer, now = Date.now()) {
  if (timer.status === "running" && remainingTime(timer, now) === 0) {
    return { ...timer, ...sessionRevision(timer, now), status: "completed", remainingMs: 0, endsAt: null };
  }
  return timer;
}

export function startTimer(timer, now = Date.now()) {
  if (timer.status === "running") return advanceTimer(timer, now);
  if (timer.status === "completed") timer = resetTimer(timer);
  const remainingMs = timer.status === "paused" ? timer.remainingMs : timer.durationMs;
  return { ...timer, ...sessionRevision(timer, now), status: "running", remainingMs, endsAt: now + remainingMs };
}

export function pauseTimer(timer, now = Date.now()) {
  if (timer.status !== "running") return timer;
  const remainingMs = remainingTime(timer, now);
  return { ...timer, ...sessionRevision(timer, now), status: remainingMs ? "paused" : "completed", remainingMs, endsAt: null };
}

export function startSession(timer, person, id, now = Date.now()) {
  const name = String(person ?? "").trim();
  if (!name || name.length > 80) throw new RangeError("이름을 1~80자로 입력해 주세요.");
  return { ...startTimer(timer, now), session: { id, person: name, startedAt: now, revision: now } };
}

export function historySnapshot(timer, now = Date.now(), stop = false) {
  if (!timer.session) return null;
  const remaining = stop ? remainingTime(timer, now) : timer.remainingMs;
  return {
    id: timer.session.id, person: timer.session.person, duration_ms: timer.durationMs,
    remaining_ms: Math.round(remaining),
    status: stop ? (remaining ? "stopped" : "completed") : timer.status,
    started_at: timer.session.startedAt, ends_at: stop ? null : timer.endsAt,
    revision: stop ? Math.max(now, timer.session.revision + 1) : timer.session.revision,
  };
}

export function resetTimer(timer) {
  return createTimer(timer.durationMs / 60000);
}

export function restoreTimer(value, now = Date.now()) {
  if (!value || value.version !== 1 || !["idle", "running", "paused", "completed"].includes(value.status)) return createTimer();
  if (typeof value.durationMs !== "number") return createTimer();
  const minutes = value.durationMs / 60000;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return createTimer();
  if (!Number.isFinite(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > value.durationMs) return createTimer();
  if (value.status === "running" && (!Number.isFinite(value.endsAt) || value.endsAt <= 0)) return createTimer();
  if (value.status === "paused" && value.remainingMs === 0) return createTimer(minutes);
  const timer = {
    version: 1, status: value.status, durationMs: minutes * 60000,
    remainingMs: value.status === "idle" ? value.durationMs : value.status === "completed" ? 0 : value.remainingMs,
    endsAt: value.status === "running" ? value.endsAt : null,
  };
  const session = value.session;
  if (value.status !== "idle" && session && typeof session.id === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(session.id)
      && typeof session.person === "string" && session.person.trim() && session.person.length <= 80
      && Number.isSafeInteger(session.startedAt) && session.startedAt > 0 && session.startedAt <= 253402300799999
      && Number.isSafeInteger(session.revision) && session.revision > 0) {
    timer.session = { id: session.id, person: session.person, startedAt: session.startedAt, revision: session.revision };
  }
  return advanceTimer(timer, now);
}

export function formatRemaining(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function miniTimerState(timer, route, now = Date.now()) {
  const remainingMs = remainingTime(timer, now);
  return {
    visible: route !== "pomodoro" && timer.status === "running" && remainingMs > 0,
    remainingMs,
    remainingPercent: remainingMs / timer.durationMs * 100,
  };
}

export function dialScale(durationMs) {
  return Math.max(60, Math.ceil(durationMs / 3600000) * 60);
}

export function dialAngle(timer, now = Date.now(), scale = dialScale(timer.durationMs)) {
  return remainingTime(timer, now) / (scale * 60000) * 360;
}

// Clockwise degrees from twelve o'clock. The centre has no direction.
export function pointerAngle(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
  return (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
}

export function minutesAtAngle(angle, scale, previousMinutes) {
  const minutes = angle === 0 && previousMinutes > scale / 2 ? scale : angle / 360 * scale;
  return Math.max(1, Math.min(scale, Math.round(minutes)));
}

// Keep fractional movement until rendering so slow drags accumulate correctly.
// Clamp at either end instead of wrapping from a full dial back to one minute.
export function dragMinutes(minutes, previousAngle, nextAngle, scale) {
  const delta = ((nextAngle - previousAngle + 540) % 360) - 180;
  return Math.max(1, Math.min(scale, minutes + delta / 360 * scale));
}

export function sectorPath(angle) {
  const bounded = Math.max(0, Math.min(360, angle));
  if (bounded === 0) return "";
  if (bounded === 360) return "M 200 64 A 136 136 0 1 1 200 336 A 136 136 0 1 1 200 64 Z";
  const radians = bounded * Math.PI / 180;
  const x = 200 + 136 * Math.sin(radians);
  const y = 200 - 136 * Math.cos(radians);
  return `M 200 200 L 200 64 A 136 136 0 ${bounded > 180 ? 1 : 0} 1 ${x.toFixed(4)} ${y.toFixed(4)} Z`;
}
