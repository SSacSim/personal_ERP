import { currentUser, userStorageKey } from "./auth-state.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const statusLabels = { draft: "작성 중", published: "사용 중", archived: "보관" };
const dateInput = (date = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(date);
const nextReview = (days) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + Number(days)); return dateInput(date); };
const displayTime = (value) => value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "—";
const contentHtml = (value) => String(value).split(/(https?:\/\/[^\s<>"']+)/gi).map((part) => /^https?:\/\//i.test(part) ? `<a href="${escape(part)}" target="_blank" rel="noopener noreferrer">${escape(part)}</a>` : escape(part)).join("");

export function mountManuals(container) {
  const abort = new AbortController();
  let disposed = false;
  let busy = true;
  let items = [];
  let guide;
  let selectedId = new URLSearchParams(location.search).get("manual");
  let mode = selectedId === "new" ? "new" : new URLSearchParams(location.search).get("edit") === "1" ? "edit" : "view";
  let editingVersion = null;
  const find = (selector) => container.querySelector(selector);
  const draftKey = () => userStorageKey(`erp.manual.draft.v1.${mode === "new" ? "new" : selectedId}`);
  const due = (item) => item.status === "published" && item.next_review_date <= dateInput();

  container.innerHTML = `<section class="manual-page">
    <header class="manual-heading"><div><p class="eyebrow">PUBLIC · 함께 쌓는 업무 기준</p><h2>매뉴얼</h2><p>누가 맡아도 이어갈 수 있는 업무 방법을 기록하고, 주기적으로 다듬어 보세요.</p></div><button type="button" data-manual-new disabled>+ 새 매뉴얼</button></header>
    <p class="manual-notice" role="status" data-manual-notice hidden></p>
    <details class="panel manual-guide" data-manual-guide><summary>매뉴얼 작성 가이드 <span>작성 원칙과 정기 검토 방법</span></summary><div data-guide-content><p>가이드를 불러오는 중…</p></div></details>
    <div class="manual-workspace"><aside class="panel manual-sidebar" aria-label="매뉴얼 목록">
      <div class="section-head"><h3>업무 매뉴얼 <span class="count-label" data-manual-count>0</span></h3><button type="button" class="secondary" data-manual-refresh disabled>새로고침</button></div>
      <label>매뉴얼 검색<input type="search" data-manual-search placeholder="업무명, 담당자, 본문 검색" disabled /></label>
      <div class="manual-filters"><label>업무 분류<select data-manual-category disabled><option value="">전체 분류</option></select></label><label>문서 상태<select data-manual-filter disabled><option value="">전체 상태</option><option value="published">사용 중</option><option value="draft">작성 중</option><option value="due">검토 필요</option><option value="archived">보관</option></select></label></div>
      <div class="manual-list" data-manual-list><p class="empty">매뉴얼을 불러오는 중…</p></div>
    </aside><section class="panel manual-detail" data-manual-detail tabindex="-1" aria-label="매뉴얼 내용"><p class="empty">매뉴얼을 불러오는 중…</p></section></div></section>`;

  function notice(message = "", error = false) {
    if (disposed) return;
    const node = find("[data-manual-notice]");
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle("is-error", error);
  }

  function setBusy(value) {
    busy = value;
    container.querySelectorAll("button, input, select, textarea, fieldset").forEach((element) => { element.disabled = value; });
    if (!guide) container.querySelectorAll("[data-manual-new]").forEach((element) => { element.disabled = true; });
    find("[data-manual-detail]").setAttribute("aria-busy", String(value));
  }

  async function request(path = "", options = {}) {
    const response = await fetch(`/api/manuals${path}`, { ...options, cache: "no-store", signal: options.method ? undefined : abort.signal,
      headers: { "Content-Type": "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((item) => item.msg).join(" ") : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
      throw Object.assign(new Error(reason), { status: response.status });
    }
    return data;
  }

  function updateUrl() {
    const url = new URL(location.href);
    if (selectedId || mode === "new") url.searchParams.set("manual", mode === "new" ? "new" : selectedId);
    else url.searchParams.delete("manual");
    if (mode === "edit") url.searchParams.set("edit", "1");
    else url.searchParams.delete("edit");
    history.replaceState({}, "", url);
  }

  function drawList() {
    const query = find("[data-manual-search]").value.trim().toLocaleLowerCase();
    const category = find("[data-manual-category]").value;
    const filter = find("[data-manual-filter]").value;
    const visible = items.filter((item) => (!category || item.category === category) && (!filter || (filter === "due" ? due(item) : item.status === filter)) &&
      (!query || [item.title, item.category, item.owner, ...Object.values(item.sections)].join(" ").toLocaleLowerCase().includes(query)));
    find("[data-manual-count]").textContent = visible.length;
    find("[data-manual-list]").innerHTML = visible.length ? visible.map((item) => `<button type="button" class="manual-list-item ${item.id === selectedId && mode !== "new" ? "is-selected" : ""}" data-manual-open="${escape(item.id)}" aria-pressed="${item.id === selectedId && mode !== "new"}">
      <span class="manual-list-meta">${escape(item.category)} <span class="manual-status ${item.status}">${statusLabels[item.status]}</span></span><strong>${escape(item.title)}</strong><small>${escape(item.owner)} · v${item.version}</small><small class="${due(item) ? "manual-due" : ""}">${due(item) ? "검토 필요 · " : "다음 검토 · "}${escape(item.next_review_date)}</small></button>`).join("") : `<p class="empty">${items.length ? "조건에 맞는 매뉴얼이 없습니다." : "아직 매뉴얼이 없습니다. 새 매뉴얼을 작성해 보세요."}</p>`;
  }

  function drawCategories() {
    const select = find("[data-manual-category]");
    const previous = select.value;
    select.innerHTML = `<option value="">전체 분류</option>${[...new Set(items.map((item) => item.category))].sort().map((category) => `<option value="${escape(category)}">${escape(category)}</option>`).join("")}`;
    select.value = [...select.options].some((option) => option.value === previous) ? previous : "";
  }

  function formData() {
    const values = new FormData(find("[data-manual-form]"));
    return { title: String(values.get("title") || "").trim(), category: String(values.get("category") || "").trim(), owner: String(values.get("owner") || "").trim(),
      status: values.get("status"), review_cycle_days: Number(values.get("review_cycle_days")), next_review_date: values.get("next_review_date") || null,
      sections: Object.fromEntries(guide.sections.map((section) => [section.key, String(values.get(section.key) || "").trim()])),
      ...(mode === "edit" ? { version: editingVersion, change_summary: String(values.get("change_summary") || "").trim() } : {}) };
  }

  function rememberDraft() {
    if (!find("[data-manual-form]") || busy) return;
    try {
      localStorage.setItem(draftKey(), JSON.stringify(formData()));
      find("[data-draft-status]").textContent = "작성 내용 임시 저장됨 · 매뉴얼 저장을 누르면 팀에 공유됩니다.";
    } catch {
      find("[data-draft-status]").textContent = "임시 저장을 사용할 수 없습니다. 페이지를 나가기 전에 매뉴얼을 저장해 주세요.";
    }
  }

  function drawDetail() {
    const detail = find("[data-manual-detail]");
    const item = items.find((entry) => entry.id === selectedId);
    if (mode === "new" || mode === "edit" && item) {
      let draft = null;
      try { draft = JSON.parse(localStorage.getItem(draftKey())); } catch { /* The form still works without browser storage. */ }
      const values = draft && typeof draft.sections === "object" && draft.sections ? draft : item || { owner: currentUser().name, category: "일반 업무", status: "draft", review_cycle_days: 90, next_review_date: nextReview(90), sections: {} };
      editingVersion = draft?.version || item?.version || null;
      detail.innerHTML = `<header class="manual-detail-heading"><div><p class="eyebrow">${mode === "edit" ? `v${item.version} 업데이트` : "공통 양식으로 시작하기"}</p><h3>${mode === "edit" ? "매뉴얼 수정" : "새 매뉴얼 작성"}</h3></div><span class="badge">7개 표준 항목</span></header>
        <p class="manual-form-intro">작성 중으로 먼저 저장하고, 실제 업무로 검증한 뒤 사용 중으로 바꾸세요. 필수 항목은 사용 중으로 저장할 때 확인합니다.</p>
        <p class="manual-draft-status" data-draft-status role="status">${draft ? "이전에 임시 저장한 작성 내용을 복원했습니다." : "작성 내용은 이 브라우저에 임시 저장됩니다."}</p>
        <form data-manual-form><p class="manual-notice is-error" data-manual-form-notice role="alert" hidden></p><fieldset class="manual-form-fields">
          <label class="manual-full">매뉴얼 제목<input name="title" required maxlength="140" value="${escape(values.title)}" placeholder="예: 월말 법인카드 영수증 정산하기" /></label>
          <label>업무 분류<input name="category" required maxlength="80" list="manual-categories" value="${escape(values.category)}" placeholder="예: 재무·정산, 고객 지원" /><datalist id="manual-categories">${[...new Set(items.map((entry) => entry.category))].map((category) => `<option value="${escape(category)}"></option>`).join("")}</datalist></label>
          <label>관리 담당자<input name="owner" required maxlength="80" value="${escape(values.owner)}" /></label>
          <label>문서 상태<select name="status">${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}" ${key === values.status ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <label>정기 검토 주기<select name="review_cycle_days">${guide.review_cycles.map((cycle) => `<option value="${cycle.days}" ${cycle.days === Number(values.review_cycle_days) ? "selected" : ""}>${escape(cycle.label)}</option>`).join("")}</select></label>
          <label>다음 검토일<input name="next_review_date" type="date" required value="${escape(values.next_review_date || nextReview(values.review_cycle_days))}" /></label>
          <div class="manual-date-actions"><button class="secondary" type="button" data-manual-review-date>오늘부터 주기만큼 연장</button></div>
          ${guide.sections.map((section, index) => `<section class="manual-form-section manual-full"><label for="manual-${section.key}"><span class="manual-section-number">${index + 1}</span>${escape(section.title)} ${section.required ? '<span class="manual-required">사용 중 필수</span>' : ""}</label><p id="manual-hint-${section.key}">${escape(section.hint)}</p><textarea id="manual-${section.key}" name="${section.key}" rows="${section.key === "procedure" ? 9 : 4}" maxlength="${section.key === "procedure" ? 30000 : 10000}" aria-describedby="manual-hint-${section.key}" placeholder="${escape(section.placeholder)}">${escape(values.sections[section.key])}</textarea></section>`).join("")}
          ${mode === "edit" ? `<label class="manual-full">변경 요약<textarea name="change_summary" required maxlength="1000" rows="3" placeholder="무엇을 왜 바꿨는지 적으세요. 변경이 없다면 ‘정기 검토 완료, 내용 변경 없음’으로 기록하세요.">${escape(values.change_summary)}</textarea></label>` : ""}
          <details class="manual-before-save manual-full"><summary>저장 전 점검표</summary><ul><li>처음 맡은 동료가 순서대로 따라 할 수 있나요?</li><li>담당 역할, 완료 기준, 예외 대응과 참고 자료를 확인했나요?</li><li>실제 비밀번호·인증키·개인정보를 제거했나요?</li><li>관리 담당자와 다음 검토일을 지정했나요?</li></ul></details>
          <div class="manual-form-actions manual-full"><button class="secondary" type="button" data-manual-close>작성 닫기</button><button type="submit">${mode === "edit" ? "변경 내용 저장" : "매뉴얼 저장"}</button></div>
        </fieldset></form>`;
      const form = find("[data-manual-form]");
      form.addEventListener("input", rememberDraft, { signal: abort.signal });
      form.addEventListener("change", (event) => {
        if (event.target.name === "review_cycle_days") form.elements.next_review_date.value = nextReview(event.target.value);
        rememberDraft();
      }, { signal: abort.signal });
      form.addEventListener("submit", save, { signal: abort.signal });
      return;
    }
    if (!item) {
      detail.innerHTML = `<div class="manual-empty"><span class="manual-empty-symbol" aria-hidden="true">≡</span><h3>우리 팀의 일하는 방법</h3><p>반복하는 업무부터 하나씩 기록해 보세요.<br>공통 양식과 작성 가이드가 첫 작성을 도와드립니다.</p><button type="button" data-manual-new>첫 매뉴얼 작성하기</button></div>`;
      return;
    }
    detail.innerHTML = `<article class="manual-reader"><header class="manual-detail-heading"><div><p class="eyebrow">${escape(item.category)} · v${item.version}</p><h3>${escape(item.title)}</h3></div><button type="button" data-manual-edit>수정·업데이트</button></header>
      <div class="manual-meta"><span class="manual-status ${item.status}">${statusLabels[item.status]}</span><span>관리 담당 · ${escape(item.owner)}</span><span>최종 수정 · ${escape(displayTime(item.updated_at))}</span><span>수정자 · ${escape(item.updated_by)}</span><span>최근 검토 · ${escape(item.last_reviewed_date || "검토 전")}</span><span class="${due(item) ? "manual-due" : ""}">다음 검토 · ${escape(item.next_review_date)} (${item.review_cycle_days}일 주기)</span></div>
      ${due(item) ? '<p class="manual-review-notice">검토일이 되었습니다. 실제 업무와 다른 부분을 확인하고, 변경 요약과 다음 검토일을 갱신해 주세요.</p>' : ""}
      ${item.status === "draft" ? '<p class="manual-review-notice">작성 중인 문서입니다. 실제 업무에 적용하기 전 내용을 검증해 주세요.</p>' : item.status === "archived" ? '<p class="manual-review-notice">보관된 문서입니다. 현재 업무에 적용하기 전에 최신 기준을 확인해 주세요.</p>' : ""}
      <nav class="manual-toc" aria-label="매뉴얼 목차">${guide.sections.map((section, index) => `<a href="#manual-section-${section.key}">${index + 1}. ${escape(section.title)}</a>`).join("")}</nav>
      ${guide.sections.map((section, index) => `<section class="manual-reader-section" id="manual-section-${section.key}"><h4><span class="manual-section-number">${index + 1}</span>${escape(section.title)}</h4><div class="manual-text">${item.sections[section.key] ? contentHtml(item.sections[section.key]) : '<span class="manual-unwritten">아직 작성되지 않았습니다.</span>'}</div></section>`).join("")}
      <section class="manual-history"><h4>변경 이력</h4><div class="manual-history-scroll"><table><thead><tr><th>버전</th><th>수정일</th><th>수정자</th><th>변경 요약</th></tr></thead><tbody>${item.revision_history.map((revision) => `<tr><td>v${revision.version}</td><td>${escape(displayTime(revision.date))}</td><td>${escape(revision.author)}</td><td>${escape(revision.summary)}</td></tr>`).join("")}</tbody></table></div></section></article>`;
  }

  async function save(event) {
    event.preventDefault();
    if (busy || disposed) return;
    const form = event.currentTarget;
    const data = formData();
    const feedback = find("[data-manual-form-notice]");
    if (data.status === "published") {
      const missing = guide.sections.find((section) => section.required && !data.sections[section.key]);
      if (missing) {
        feedback.textContent = `사용 중으로 저장하려면 ‘${missing.title}’ 항목을 작성해 주세요.`;
        feedback.hidden = false;
        form.elements[missing.key].focus();
        return;
      }
    }
    rememberDraft();
    const key = draftKey();
    let draftAtSave;
    try { draftAtSave = localStorage.getItem(key); } catch { /* Saving to the server remains available. */ }
    const editing = mode === "edit";
    setBusy(true);
    feedback.hidden = true;
    const submit = form.querySelector("[type=submit]");
    const label = submit.textContent;
    submit.textContent = "저장 중…";
    try {
      const saved = await request(editing ? `/${encodeURIComponent(selectedId)}` : "", { method: editing ? "PATCH" : "POST", body: JSON.stringify(data) });
      try { if (localStorage.getItem(key) === draftAtSave) localStorage.removeItem(key); } catch { /* The server has already saved the manual. */ }
      if (disposed) return;
      items = [saved, ...items.filter((item) => item.id !== saved.id)];
      selectedId = saved.id;
      mode = "view";
      updateUrl();
      drawCategories(); drawList(); drawDetail();
      notice(`매뉴얼 v${saved.version}을 저장했습니다.`);
      find("[data-manual-detail]").focus({ preventScroll: true });
    } catch (error) {
      if (disposed) return;
      feedback.textContent = `저장하지 못했습니다. 작성 내용은 유지됩니다. ${error.message}`;
      if (error.status === 409) feedback.insertAdjacentHTML("beforeend", `<span class="manual-conflict-actions"><a href="/manuals?manual=${encodeURIComponent(selectedId)}" target="_blank" rel="noopener">최신본 새 창에서 확인</a><button type="button" class="secondary" data-manual-latest>최신본으로 다시 편집</button></span>`);
      feedback.hidden = false;
      feedback.scrollIntoView({ block: "center" });
    } finally {
      if (!disposed) { setBusy(false); if (submit.isConnected) submit.textContent = label; }
    }
  }

  async function reload() {
    if (!guide) {
      guide = await request("/guide");
      if (disposed) return;
      find("[data-guide-content]").innerHTML = `<ol class="manual-guide-grid">${guide.guidelines.map((rule) => `<li><strong>${escape(rule.title)}</strong><p>${escape(rule.text)}</p></li>`).join("")}</ol><p class="manual-guide-footer">권장 흐름: 작성 중으로 저장 → 실제 업무로 검증 → 사용 중으로 전환 → 정기 검토와 변경 요약 기록</p>`;
    }
    const data = await request();
    if (disposed) return;
    items = data.items;
    if (mode !== "new" && !items.some((item) => item.id === selectedId)) { selectedId = items[0]?.id || null; mode = "view"; }
    drawCategories(); drawList(); drawDetail(); updateUrl();
  }

  container.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy || disposed) return;
    if (button.hasAttribute("data-manual-new")) { mode = "new"; selectedId = null; }
    else if (button.hasAttribute("data-manual-open")) { selectedId = button.dataset.manualOpen; mode = "view"; }
    else if (button.hasAttribute("data-manual-edit")) mode = "edit";
    else if (button.hasAttribute("data-manual-close")) { rememberDraft(); mode = "view"; if (!items.some((item) => item.id === selectedId)) selectedId = items[0]?.id || null; }
    else if (button.hasAttribute("data-manual-review-date")) { find("[data-manual-form]").elements.next_review_date.value = nextReview(find("[name=review_cycle_days]").value); rememberDraft(); return; }
    else if (button.hasAttribute("data-manual-refresh")) {
      if (mode !== "view") { notice("작성 중에는 목록 새로고침 대신 먼저 매뉴얼을 저장하거나 작성을 닫아 주세요."); return; }
      setBusy(true);
      try { await reload(); notice("최신 목록을 불러왔습니다."); } catch (error) { notice(error.message, true); }
      finally { if (!disposed) setBusy(false); }
      return;
    } else if (button.hasAttribute("data-manual-latest")) {
      if (!confirm("현재 임시 작성 내용을 지우고 최신본으로 다시 편집할까요? 필요한 내용은 먼저 복사해 주세요.")) return;
      setBusy(true);
      try {
        const latest = await request(`/${encodeURIComponent(selectedId)}`);
        if (disposed) return;
        try { localStorage.removeItem(draftKey()); } catch { /* Use the latest server content in this editor. */ }
        items = items.map((item) => item.id === latest.id ? latest : item);
        drawDetail();
      } catch (error) { notice(error.message, true); }
      finally { if (!disposed) setBusy(false); }
      return;
    } else return;
    notice(); updateUrl(); drawList(); drawDetail();
    find("[data-manual-detail]").focus({ preventScroll: true });
  }, { signal: abort.signal });
  find("[data-manual-search]").addEventListener("input", drawList, { signal: abort.signal });
  for (const selector of ["[data-manual-category]", "[data-manual-filter]"]) find(selector).addEventListener("change", drawList, { signal: abort.signal });

  (async () => {
    try {
      await reload();
    } catch (error) { if (!disposed) notice(`매뉴얼을 불러오지 못했습니다. ${error.message}`, true); }
    finally { if (!disposed) setBusy(false); }
  })();
  return () => { if (mode !== "view") rememberDraft(); disposed = true; abort.abort(); };
}
