const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function timestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `<time datetime="${escape(value)}" title="한국 시간 (KST)"><span>${escape(dateFormatter.format(date))}</span><span class="id-info-time">${escape(timeFormatter.format(date))}</span></time>`;
}

export function mountIdInfo(container) {
  const abort = new AbortController();
  let disposed = false;
  let disposeContent = null;
  let token = "";
  let expiryTimer = null;

  function revoke() {
    const previous = token;
    token = "";
    clearTimeout(expiryTimer);
    if (previous) fetch("/api/id-info/lock", {
      method: "POST", headers: { "X-ERP-Info-Token": previous }, cache: "no-store", keepalive: true,
    }).catch(() => {});
  }

  function lock(message = "") {
    disposeContent?.();
    disposeContent = null;
    revoke();
    if (!disposed) showLock(message);
  }

  function showLock(message = "") {
    container.innerHTML = `
      <section class="id-info-page id-info-gate">
        <form class="panel id-info-lock" autocomplete="off">
          <div class="id-info-lock-icon"><svg class="icon" aria-hidden="true"><use href="/static/icons.svg#key" /></svg></div>
          <h2>Info</h2>
          <p>공유 정보를 확인하려면 접근 비밀번호를 입력해 주세요.</p>
          <label for="info-access-password">접근 비밀번호</label>
          <input id="info-access-password" name="access_password" type="password" required maxlength="1000" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="info-access-error" />
          <p id="info-access-error" class="id-info-lock-error" role="alert" ${message ? "" : "hidden"}>${escape(message)}</p>
          <button type="submit">잠금 해제</button>
          <span class="id-info-lock-hint">탭을 나가면 다시 잠깁니다.</span>
        </form>
      </section>`;
    const form = container.querySelector("form");
    const input = form.elements.access_password;
    const button = form.querySelector("button");
    const errorBox = form.querySelector("[role='alert']");
    input.focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (disposed || button.disabled || !form.reportValidity()) return;
      button.disabled = true;
      button.textContent = "확인 중…";
      errorBox.hidden = true;
      const body = JSON.stringify({ password: input.value });
      input.value = "";
      try {
        const response = await fetch("/api/id-info/unlock", {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
          signal: abort.signal, cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (disposed) return;
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "잠금을 해제하지 못했습니다. 다시 시도해 주세요.");
        token = data.token;
        disposeContent = mountUnlockedInfo(container, token, lock);
        expiryTimer = setTimeout(() => lock("접근 시간이 만료되었습니다. 비밀번호를 다시 입력해 주세요."), data.expires_in * 1000);
      } catch (error) {
        if (disposed) return;
        errorBox.textContent = error.message || "연결하지 못했습니다. 다시 시도해 주세요.";
        errorBox.hidden = false;
        input.focus();
      } finally {
        if (!disposed) { button.disabled = false; button.textContent = "잠금 해제"; }
      }
    }, { signal: abort.signal });
  }

  showLock();
  return () => {
    disposed = true;
    abort.abort();
    disposeContent?.();
    revoke();
    container.replaceChildren();
  };
}

function mountUnlockedInfo(container, accessToken, onLock) {
  const abort = new AbortController();
  let disposed = false;
  let items = [];
  let editingId = null;
  let busy = false;

  container.innerHTML = `
    <section class="id-info-page">
      <div class="id-info-heading">
        <div><h2>Info</h2><p>회사에서 함께 사용하는 계정과 기타 정보를 기록하세요.</p></div>
        <div class="id-info-actions"><button class="secondary" type="button" data-lock>잠금</button><button class="secondary" type="button" data-refresh>새로고침</button><button type="button" data-add>+ 정보 추가</button></div>
      </div>
      <p class="id-info-notice" role="status" aria-live="polite" hidden></p>
      <form class="id-info-form panel" autocomplete="off" hidden>
        <h3 data-form-title>정보 추가</h3>
        <fieldset>
          <div class="id-info-fields">
            <label>구분 <span class="id-info-required">필수</span><input name="category" maxlength="100" placeholder="예: 회사 메일, NAS, Wi-Fi" required /></label>
            <label>ID<input name="login_id" maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="공유 ID" /></label>
            <label>PWD<span class="id-info-password-input"><input name="password" type="password" maxlength="1000" autocomplete="new-password" spellcheck="false" placeholder="비밀번호" /><button class="secondary" type="button" data-form-reveal aria-label="입력한 PWD 보기" aria-pressed="false">보기</button></span></label>
            <label class="id-info-notes-field">기타 정보<textarea name="notes" rows="3" maxlength="4000" placeholder="접속 주소, 사용 방법, 참고 사항 등"></textarea></label>
          </div>
          <div class="id-info-form-actions"><button class="secondary" type="button" data-cancel>취소</button><button type="submit" data-save>저장</button></div>
        </fieldset>
      </form>
      <div class="id-info-table-wrap panel">
        <table class="id-info-table">
          <caption class="id-info-caption">공유 계정 정보</caption>
          <thead><tr><th scope="col">구분</th><th scope="col">ID</th><th scope="col">PWD</th><th scope="col">기타 정보</th><th scope="col">등록 일시</th><th scope="col">최종 변경 일시</th><th scope="col">관리</th></tr></thead>
          <tbody><tr><td colspan="7" class="id-info-empty">정보를 불러오는 중입니다.</td></tr></tbody>
        </table>
      </div>
    </section>`;

  const find = (selector) => container.querySelector(selector);
  const form = find("form");
  const fields = form.querySelector("fieldset");
  const tbody = find("tbody");
  const notice = find(".id-info-notice");
  const passwordInput = form.elements.password;
  const passwordToggle = find("[data-form-reveal]");

  function message(text = "", error = false) {
    if (disposed) return;
    notice.textContent = text;
    notice.hidden = !text;
    notice.classList.toggle("error", error);
  }

  function setBusy(value) {
    busy = value;
    fields.disabled = value;
    find("[data-add]").disabled = value;
    find("[data-refresh]").disabled = value;
    tbody.querySelectorAll("button").forEach((button) => { button.disabled = value; });
  }

  async function request(path = "", options = {}) {
    const response = await fetch(`/api/id-info${path}`, {
      ...options, signal: abort.signal, cache: "no-store",
      headers: { "Content-Type": "application/json", ...options.headers, "X-ERP-Info-Token": accessToken },
    });
    if (!disposed && response.status === 403 && response.headers.get("X-ERP-Info-Locked")) {
      onLock("접근 시간이 만료되었습니다. 비밀번호를 다시 입력해 주세요.");
      throw new Error("Info가 잠겼습니다.");
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return data;
  }

  function renderRows() {
    tbody.innerHTML = items.length ? items.map((item) => `
      <tr data-entry="${escape(item.id)}">
        <td class="id-info-category">${escape(item.category)}</td>
        <td class="id-info-login">${escape(item.login_id) || "—"}</td>
        <td><div class="id-info-password"><code data-password-text>${item.has_password ? "••••••••" : "—"}</code>${item.has_password ? '<button class="secondary" type="button" data-reveal aria-label="PWD 보기" aria-pressed="false">보기</button>' : ""}</div></td>
        <td class="id-info-notes">${escape(item.notes) || "—"}</td>
        <td class="id-info-timestamp">${timestamp(item.created_at)}</td>
        <td class="id-info-timestamp">${timestamp(item.updated_at)}</td>
        <td><div class="id-info-row-actions"><button class="secondary" type="button" data-edit>수정</button><button class="danger-button" type="button" data-delete>삭제</button></div></td>
      </tr>`).join("") : '<tr><td colspan="7" class="id-info-empty">등록된 정보가 없습니다. ‘정보 추가’로 공유 계정을 등록해 주세요.</td></tr>';
  }

  function resetPasswordVisibility() {
    passwordInput.type = "password";
    passwordToggle.textContent = "보기";
    passwordToggle.setAttribute("aria-label", "입력한 PWD 보기");
    passwordToggle.setAttribute("aria-pressed", "false");
  }

  function closeForm() {
    editingId = null;
    form.reset();
    resetPasswordVisibility();
    form.hidden = true;
  }

  function openForm(item = null, password = "") {
    form.reset();
    editingId = item?.id || null;
    form.elements.category.value = item?.category || "";
    form.elements.login_id.value = item?.login_id || "";
    form.elements.notes.value = item?.notes || "";
    passwordInput.value = password;
    resetPasswordVisibility();
    find("[data-form-title]").textContent = item ? "정보 수정" : "정보 추가";
    form.hidden = false;
    message("");
    form.elements.category.focus();
  }

  async function load() {
    if (busy || disposed) return;
    setBusy(true);
    try {
      const data = await request();
      if (disposed) return;
      items = data.items;
      renderRows();
      message("");
    } catch (error) {
      if (!disposed) message("정보를 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요.", true);
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  find("[data-lock]").addEventListener("click", () => onLock());
  find("[data-add]").addEventListener("click", () => openForm());
  find("[data-cancel]").addEventListener("click", closeForm);
  find("[data-refresh]").addEventListener("click", load);
  passwordToggle.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    passwordToggle.textContent = show ? "숨기기" : "보기";
    passwordToggle.setAttribute("aria-label", show ? "입력한 PWD 숨기기" : "입력한 PWD 보기");
    passwordToggle.setAttribute("aria-pressed", String(show));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const payload = {
      category: form.elements.category.value.trim(), login_id: form.elements.login_id.value,
      password: passwordInput.value, notes: form.elements.notes.value,
    };
    if (!payload.category) { message("구분을 입력해 주세요.", true); form.elements.category.focus(); return; }
    const targetId = editingId;
    setBusy(true);
    try {
      const saved = await request(targetId ? `/${targetId}` : "", { method: targetId ? "PATCH" : "POST", body: JSON.stringify(payload) });
      if (disposed) return;
      items = targetId ? items.map((item) => item.id === targetId ? saved : item) : [saved, ...items];
      closeForm();
      renderRows();
      message("저장했습니다.");
    } catch (error) {
      if (!disposed) message(error.message || "저장하지 못했습니다. 입력 내용을 유지한 채 다시 시도해 주세요.", true);
    } finally {
      if (!disposed) setBusy(false);
    }
  });

  tbody.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    const row = button?.closest("[data-entry]");
    if (!row || busy) return;
    const item = items.find((candidate) => candidate.id === row.dataset.entry);
    if (!item) return;
    if (button.hasAttribute("data-reveal") && button.getAttribute("aria-pressed") === "true") {
      row.querySelector("[data-password-text]").textContent = "••••••••";
      button.textContent = "보기";
      button.setAttribute("aria-label", "PWD 보기");
      button.setAttribute("aria-pressed", "false");
      return;
    }
    if (button.hasAttribute("data-delete") && !window.confirm(`‘${item.category}’ 정보를 삭제하시겠습니까?`)) return;
    setBusy(true);
    try {
      if (button.hasAttribute("data-delete")) {
        await request(`/${item.id}`, { method: "DELETE" });
        if (disposed) return;
        items = items.filter((candidate) => candidate.id !== item.id);
        if (editingId === item.id) closeForm();
        renderRows();
        message("삭제했습니다.");
      } else {
        const data = item.has_password ? await request(`/${item.id}/password`) : { password: "" };
        if (disposed) return;
        if (button.hasAttribute("data-edit")) {
          setBusy(false);
          openForm(item, data.password);
        } else {
          row.querySelector("[data-password-text]").textContent = data.password;
          button.textContent = "숨기기";
          button.setAttribute("aria-label", "PWD 숨기기");
          button.setAttribute("aria-pressed", "true");
        }
      }
    } catch (error) {
      if (!disposed) message(error.message || "요청을 처리하지 못했습니다. 다시 시도해 주세요.", true);
    } finally {
      if (!disposed) setBusy(false);
    }
  });

  load();
  return () => {
    disposed = true;
    abort.abort();
    form.reset();
    tbody.textContent = "";
    items = [];
  };
}
