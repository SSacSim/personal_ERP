import { currentUser } from "./auth-state.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const today = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("-");
};
const categoryLabel = (value) => ({ annual_leave: "연차", half_day: "반차", remote_work: "재택" }[value] || value);
const dateLabel = (value) => String(value || "").replaceAll("-", ".");
const calendarUrl = (item) => `/calendar?${new URLSearchParams({ date: item.start_date || item.date, event: item.id })}`;

export function mountAttendance(container) {
  const abort = new AbortController();
  const pageSize = 25;
  let disposed = false;
  let busy = false;
  let offset = 0;
  let total = 0;
  let month = today().slice(0, 7);
  let kind = "";
  container.innerHTML = `
    <section class="attendance-page">
      <header class="attendance-heading"><div><h2>연차·반차·재택 <span data-count></span></h2><p>휴가와 재택 일정을 등록하고 팀의 캘린더에서 함께 확인하세요.</p></div><button type="button" data-add>+ 일정 등록</button></header>
      <p class="attendance-notice" role="status" data-notice hidden></p>
      <form class="attendance-filters"><fieldset><label>조회 월<input name="month" type="month" min="0001-01" max="9999-12" value="${month}" /></label><label>구분<select name="kind"><option value="">전체</option value="annual_leave">연차</option><option value="half_day">반차</option><option value="remote_work">재택</option></select></label><button class="secondary" type="submit">조회</button><button class="secondary" type="button" data-all>전체 기간</button></fieldset></form>
      <div class="attendance-table-wrap panel"><table class="attendance-table"><caption class="attendance-sr-only">연차·반차·재택 일정 목록</caption><thead><tr><th scope="col">이름</th><th scope="col">구분</th><th scope="col">날짜</th><th scope="col">메모</th><th scope="col">캘린더</th></tr></thead><tbody><tr><td colspan="5" class="attendance-empty">일정을 불러오는 중입니다.</td></tr></tbody></table></div>
      <div class="attendance-pagination" hidden><button class="secondary" type="button" data-prev>이전</button><span data-page></span><button class="secondary" type="button" data-next>다음</button></div>
      <p class="attendance-help">일정의 수정·삭제는 ‘캘린더 보기’에서 할 수 있습니다.</p>
      <dialog class="attendance-dialog" aria-labelledby="attendance-dialog-title">
        <header><div><h3 id="attendance-dialog-title">일정 등록</h3><p>등록하면 캘린더에 바로 표시됩니다.</p></div><button type="button" class="secondary" data-close aria-label="일정 등록 닫기">✕</button></header>
        <form class="attendance-form"><p class="attendance-notice" data-form-notice role="alert" hidden></p><fieldset>
          <div class="attendance-fields">
            <label>이름<input name="person" value="${escape(currentUser().name)}" readonly /></label>
            <label>구분<select name="kind" required><option value="annual_leave">연차</option><option value="half_day">반차</option><option value="remote_work">재택</option></select></label>
            <label><span data-start-label>시작일</span><input name="start_date" type="date" min="0001-01-01" max="9999-12-31" required /></label>
            <label data-end-field>종료일<input name="end_date" type="date" min="0001-01-01" max="9999-12-31" required /></label>
            <label data-period-field hidden>반차 시간<select name="period" disabled><option value="am">오전</option><option value="pm">오후</option></select></label>
            <label class="attendance-full">메모 <span class="attendance-optional">선택</span><textarea name="notes" rows="4" maxlength="4000" placeholder="공유할 내용을 간단히 적어 주세요."></textarea></label>
          </div>
          <div class="attendance-form-actions"><button class="secondary" type="button" data-cancel>취소</button><button type="submit">등록</button></div>
        </fieldset></form>
      </dialog>
    </section>`;

  const find = (selector) => container.querySelector(selector);
  const form = find(".attendance-form");
  const filters = find(".attendance-filters");
  const dialog = find("dialog");
  const tbody = find("tbody");
  const add = find("[data-add]");

  function message(text = "", error = false, inForm = dialog.open) {
    if (disposed) return;
    const target = find(inForm ? "[data-form-notice]" : "[data-notice]");
    target.textContent = text;
    target.hidden = !text;
    target.classList.toggle("is-error", error);
  }

  function syncFields() {
    const half = form.elements.kind.value === "half_day";
    find("[data-start-label]").textContent = half ? "날짜" : "시작일";
    find("[data-end-field]").hidden = half;
    form.elements.end_date.disabled = half;
    form.elements.end_date.min = form.elements.start_date.value || "0001-01-01";
    if (half || !form.elements.end_date.value || form.elements.end_date.value < form.elements.start_date.value) form.elements.end_date.value = form.elements.start_date.value;
    find("[data-period-field]").hidden = !half;
    form.elements.period.disabled = !half;
  }

  function setBusy(value) {
    busy = value;
    form.querySelector("fieldset").disabled = value;
    filters.querySelector("fieldset").disabled = value;
    add.disabled = value;
    find("[data-close]").disabled = value;
    find("[data-prev]").disabled = value || offset === 0;
    find("[data-next]").disabled = value || offset + pageSize >= total;
  }

  async function request(query = "", options = {}) {
    const response = await fetch(`/api/attendance${query}`, { ...options, cache: "no-store", signal: abort.signal, headers: { "Content-Type": "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((item) => item.msg.replace(/^Value error, /, "")).join(" ") : "일정을 처리하지 못했습니다. 다시 시도해 주세요.";
      throw new Error(detail);
    }
    return data;
  }

  async function reloadRows() {
    const data = await request(`?${new URLSearchParams({ month, kind, offset: String(offset), limit: String(pageSize) })}`);
    if (disposed) return;
    total = data.total;
    if (offset && offset >= total) {
      offset = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
      return reloadRows();
    }
    find("[data-count]").textContent = `${total}건`;
    tbody.innerHTML = data.items.length ? data.items.map((item) => {
      const start = item.start_date || item.date;
      const end = item.end_date || start;
      const people = Array.isArray(item.attendees) ? item.attendees.join(", ") : item.attendees;
      return `<tr><td class="attendance-person">${escape(people || "이름 미지정")}</td><td><span class="attendance-badge is-${escape(item.kind)}">${escape(categoryLabel(item.category))}</span></td><td class="attendance-date"><time datetime="${escape(start)}">${escape(dateLabel(start))}</time>${end !== start ? `<span> ~ </span><time datetime="${escape(end)}">${escape(dateLabel(end))}</time>` : ""}</td><td><div class="attendance-memo">${escape(item.notes || "—")}</div></td><td><a class="attendance-calendar-link" href="${escape(calendarUrl(item))}">캘린더 보기</a></td></tr>`;
    }).join("") : '<tr><td colspan="5" class="attendance-empty">등록된 일정이 없습니다. ‘일정 등록’으로 추가해 주세요.</td></tr>';
    find(".attendance-pagination").hidden = total <= pageSize;
    find("[data-page]").textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
  }

  async function load() {
    if (busy || disposed) return;
    setBusy(true);
    try { await reloadRows(); message("", false, false); }
    catch (error) { message(error.message, true, false); }
    finally { if (!disposed) setBusy(false); }
  }

  add.addEventListener("click", () => {
    form.reset();
    form.elements.start_date.value = today();
    form.elements.end_date.value = today();
    syncFields();
    message("", false, true);
    dialog.showModal();
    form.elements.kind.focus();
  });
  form.elements.kind.addEventListener("change", syncFields);
  form.elements.start_date.addEventListener("change", syncFields);
  find("[data-close]").addEventListener("click", () => { if (!busy) dialog.close(); });
  find("[data-cancel]").addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!disposed) add.focus(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const half = form.elements.kind.value === "half_day";
    const payload = { kind: form.elements.kind.value, start_date: form.elements.start_date.value, end_date: half ? form.elements.start_date.value : form.elements.end_date.value, period: half ? form.elements.period.value : null, notes: form.elements.notes.value.trim() };
    setBusy(true);
    message();
    try {
      const saved = await request("", { method: "POST", body: JSON.stringify(payload) });
      if (disposed) return;
      dialog.close();
      month = saved.start_date.slice(0, 7);
      kind = "";
      offset = 0;
      filters.elements.month.value = month;
      filters.elements.kind.value = kind;
      message("일정이 등록되어 캘린더에도 표시됩니다.", false, false);
      try { await reloadRows(); }
      catch { message("일정은 등록됐지만 목록을 불러오지 못했습니다. 조회를 눌러 주세요.", true, false); }
    } catch (error) { message(error.message, true); }
    finally { if (!disposed) setBusy(false); }
  });
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !filters.reportValidity()) return;
    month = filters.elements.month.value;
    kind = filters.elements.kind.value;
    offset = 0;
    void load();
  });
  find("[data-all]").addEventListener("click", () => {
    if (busy) return;
    month = "";
    filters.elements.month.value = "";
    kind = filters.elements.kind.value;
    offset = 0;
    void load();
  });
  find("[data-prev]").addEventListener("click", () => { if (!busy && offset) { offset = Math.max(0, offset - pageSize); void load(); } });
  find("[data-next]").addEventListener("click", () => { if (!busy && offset + pageSize < total) { offset += pageSize; void load(); } });
  void load();
  return () => { disposed = true; abort.abort(); dialog.close(); };
}
