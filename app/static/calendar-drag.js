function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("일정 날짜를 확인해 주세요.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("일정 날짜를 확인해 주세요.");
  return date.getTime();
}

export function shiftedCalendarDates(item, origin, target) {
  const offset = dateValue(target) - dateValue(origin);
  const start = dateValue(item.start_date || item.date);
  const end = dateValue(item.end_date || item.start_date || item.date);
  if (end < start) throw new Error("일정의 시작일과 종료일을 확인해 주세요.");
  const startDate = new Date(start + offset).toISOString().slice(0, 10);
  const endDate = new Date(end + offset).toISOString().slice(0, 10);
  dateValue(startDate); dateValue(endDate);
  return { date: startDate, start_date: startDate, end_date: endDate };
}

// Only a drag started on a known event in this calendar can change dates.
// Dates are saved first so a rejected request leaves the original grid intact.
export function setupCalendarDrag(root, { items, save, onMoved, isActive }) {
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const feedback = root.querySelector("[data-calendar-drag-feedback]");
  let dragging = null;
  let highlighted = null;
  let saving = false;
  let suppressClickUntil = 0;

  function highlight(day = null) {
    if (highlighted === day) return;
    highlighted?.classList.remove("is-calendar-drop-target");
    highlighted = day;
    highlighted?.classList.add("is-calendar-drop-target");
  }

  function clearDrag() {
    root.querySelectorAll(".is-calendar-dragging").forEach((element) => element.classList.remove("is-calendar-dragging"));
    highlight();
    dragging = null;
  }

  function message(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle("is-error", error);
  }

  root.addEventListener("click", (event) => {
    if (!saving && performance.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  root.addEventListener("dragstart", (event) => {
    const source = event.target.closest("[data-calendar-drag-id]");
    const item = source && byId.get(source.dataset.calendarDragId);
    const day = source?.closest(".day[data-date]");
    if (!item || !day || saving || !isActive()) { event.preventDefault(); return; }
    dragging = { item, origin: day.dataset.date };
    source.classList.add("is-calendar-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.title);
    event.dataTransfer.setData("application/x-erp-calendar-event", String(item.id));
    event.stopPropagation();
  });

  root.addEventListener("dragover", (event) => {
    const day = event.target.closest(".day[data-date]");
    if (!dragging || saving || !day) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    highlight(day);
  });

  root.addEventListener("dragleave", (event) => {
    if (highlighted && !highlighted.contains(event.relatedTarget)) highlight();
  });

  root.addEventListener("dragend", () => {
    suppressClickUntil = performance.now() + 250;
    clearDrag();
  });

  root.addEventListener("drop", async (event) => {
    const day = event.target.closest(".day[data-date]");
    if (!dragging || saving || !day || !isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    const { item, origin } = dragging;
    const target = day.dataset.date;
    suppressClickUntil = performance.now() + 250;
    clearDrag();
    if (origin === target) return;
    let dates;
    try { dates = shiftedCalendarDates(item, origin, target); }
    catch (error) { message(error.message, true); return; }
    const controls = [...root.querySelectorAll("button")].map((control) => [control, control.disabled]);
    saving = true;
    controls.forEach(([control]) => { control.disabled = true; });
    root.classList.add("is-calendar-moving");
    root.setAttribute("aria-busy", "true");
    message(`‘${item.title}’ 일정을 이동하는 중…`);
    let persisted = false;
    try {
      const saved = await save(item.id, dates);
      persisted = true;
      if (!isActive()) return;
      await onMoved(saved, target);
    } catch (error) {
      if (!isActive()) return;
      let reason = error.message;
      try { const detail = JSON.parse(reason).detail; if (typeof detail === "string") reason = detail; } catch { /* Network errors already contain text. */ }
      message(persisted ? "일정 날짜는 저장했지만 달력을 다시 불러오지 못했습니다. 페이지를 새로고침해 주세요." : `일정을 이동하지 못했습니다. 기존 날짜를 유지합니다. ${reason}`, true);
    } finally {
      saving = false;
      if (root.isConnected) {
        controls.forEach(([control, disabled]) => { control.disabled = disabled; });
        root.classList.remove("is-calendar-moving");
        root.setAttribute("aria-busy", "false");
      }
    }
  });
}
