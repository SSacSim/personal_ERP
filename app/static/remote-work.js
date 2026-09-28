import { clipboardImage, pastedImages, readClipboardImages, hasDraggedFiles } from "./remote-work-inputs.js";
import { currentUser } from "./auth-state.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
const today = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("-");
};
const fileSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
const attachmentUrl = (file, action) => `/api/remote-work/files/${encodeURIComponent(file.id)}/${action}`;

function savedAttachments(files = []) {
  if (!files.length) return "";
  return `<div class="remote-work-saved-attachments">${files.map((file) => file.kind === "image"
    ? `<a class="remote-work-saved-image" href="${attachmentUrl(file, "preview")}" target="_blank" rel="noopener" title="${escape(file.filename)} · 원본 보기"><img src="${attachmentUrl(file, "preview")}" alt="${escape(file.filename)}" loading="lazy" /><span>${escape(file.filename)}</span></a>`
    : `<a class="remote-work-download" href="${attachmentUrl(file, "download")}" download><span>${escape(file.filename)}</span><small>${fileSize(file.size)} · 다운로드</small></a>`).join("")}</div>`;
}

export function mountRemoteWork(container) {
  const abort = new AbortController();
  const pageSize = 25;
  let disposed = false;
  let busy = false;
  let items = [];
  let total = 0;
  let offset = 0;
  let month = "";
  let query = "";
  let editingId = null;
  let attachments = [];
  let pendingUploads = new Set();
  let returnFocus = null;
  let clipboardRevision = 0;
  let readingClipboard = false;
  let dragDepth = 0;

  container.innerHTML = `
    <section class="remote-work-page">
      <div class="remote-work-heading"><div><h2>재택근무 기록 <span data-count>0건</span></h2><p>언제, 어떤 업무를 진행했는지 남겨 보세요.</p></div><button type="button" data-add>+ 기록 등록</button></div>
      <p class="remote-work-notice" role="status" aria-live="polite" hidden></p>
      <dialog class="remote-work-dialog" aria-labelledby="remote-work-form-title">
        <header class="remote-work-dialog-header"><div><h3 id="remote-work-form-title" data-form-title>기록 등록</h3><p>진행한 업무와 관련 자료를 함께 남겨 보세요.</p></div><button class="secondary" type="button" data-close aria-label="재택근무 기록 팝업 닫기">✕</button></header>
        <form class="remote-work-form">
        <p class="remote-work-notice" data-form-notice role="status" aria-live="polite" hidden></p>
        <fieldset>
          <div class="remote-work-fields">
            <label>근무 날짜<input name="work_date" type="date" min="0001-01-01" max="9999-12-31" required /></label>
            <label>작성자<input name="author" maxlength="80" readonly required /></label>
            <div class="remote-work-content-field">
              <label for="remote-work-content">진행 내용</label>
              <div class="remote-work-editor">
                <div class="remote-work-editor-toolbar"><button class="secondary" type="button" data-paste-image title="클립보드 이미지 붙여넣기">이미지 붙여넣기</button><button class="secondary" type="button" data-add-file>파일 첨부</button><span data-attachment-count>0 / 10</span></div>
                <textarea id="remote-work-content" name="content" rows="7" maxlength="10000" placeholder="진행한 업무와 결과를 입력해 주세요. 복사한 이미지는 Ctrl+V로 붙여넣을 수 있습니다." aria-describedby="remote-work-attachment-help" required></textarea>
                <div class="remote-work-draft-attachments" data-attachments hidden></div>
                <p class="remote-work-drop-hint" aria-hidden="true">여기에 파일을 놓으면 첨부됩니다</p>
              </div>
              <p class="remote-work-file-help" id="remote-work-attachment-help">이미지는 Ctrl+V(맥은 ⌘V)로 붙여넣기 · 파일은 버튼 클릭 또는 끌어 놓기<br />이미지·파일 최대 10개, 개당 20MB</p>
              <input type="file" multiple data-file-input hidden />
            </div>
          </div>
          <div class="remote-work-form-actions"><button class="secondary" type="button" data-cancel>취소</button><button type="submit" data-save>저장</button></div>
        </fieldset>
        </form>
      </dialog>
      <form class="remote-work-filters">
        <fieldset><label>근무 월<input name="month" type="month" min="0001-01" max="9999-12" aria-label="조회할 근무 월" /></label><label class="remote-work-search">검색<input name="query" type="search" maxlength="100" placeholder="작성자 또는 진행 내용" /></label><button type="submit">조회</button><button class="secondary" type="button" data-reset-filter>전체 보기</button></fieldset>
      </form>
      <div class="remote-work-table-wrap panel">
        <table class="remote-work-table"><caption class="remote-work-sr-only">재택근무 기록 목록</caption><thead><tr><th scope="col">근무 날짜</th><th scope="col">작성자</th><th scope="col">진행 내용</th><th scope="col">관리</th></tr></thead><tbody><tr><td colspan="4" class="remote-work-empty">기록을 불러오는 중입니다.</td></tr></tbody></table>
      </div>
      <div class="remote-work-pagination" hidden><button class="secondary" type="button" data-prev>이전</button><span data-page></span><button class="secondary" type="button" data-next>다음</button></div>
    </section>`;

  const find = (selector) => container.querySelector(selector);
  const form = find(".remote-work-form");
  const dialog = find(".remote-work-dialog");
  const editor = find(".remote-work-editor");
  const pasteButton = find("[data-paste-image]");
  const filters = find(".remote-work-filters");
  const tbody = find("tbody");
  const notice = find(".remote-work-page > .remote-work-notice");
  const formNotice = find("[data-form-notice]");
  const add = find("[data-add]");
  const prev = find("[data-prev]");
  const next = find("[data-next]");

  function message(text = "", error = false) {
    if (disposed) return;
    const target = dialog.open ? formNotice : notice;
    target.textContent = text;
    target.hidden = !text;
    target.classList.toggle("error", error);
    if (error && dialog.open) form.scrollTop = 0;
  }

  function setBusy(value) {
    busy = value;
    form.querySelector("fieldset").disabled = value;
    pasteButton.disabled = value || readingClipboard;
    if (value) resetDrag();
    find("[data-close]").disabled = value;
    form.setAttribute("aria-busy", String(value));
    filters.querySelector("fieldset").disabled = value;
    add.disabled = value;
    prev.disabled = value || offset === 0;
    next.disabled = value || offset + pageSize >= total;
    tbody.querySelectorAll("button").forEach((button) => { button.disabled = value; });
  }

  async function request(path = "", options = {}) {
    const response = await fetch(`/api/remote-work${path}`, {
      ...options, signal: abort.signal, cache: "no-store", headers: { "Content-Type": typeof options.body === "string" ? "application/json" : "application/octet-stream" },
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : response.status === 422 ? "날짜, 작성자와 진행 내용을 확인해 주세요." : "요청을 처리하지 못했습니다. 다시 시도해 주세요.");
    return data;
  }

  async function reloadRows() {
    const params = new URLSearchParams({ month, q: query, offset: String(offset), limit: String(pageSize) });
    const data = await request(`?${params}`);
    if (disposed) return;
    total = data.total;
    if (offset > 0 && offset >= total) {
      offset = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
      return reloadRows();
    }
    items = data.items;
    find("[data-count]").textContent = `${total}건`;
    tbody.innerHTML = items.length ? items.map((item) => `
      <tr data-entry="${escape(item.id)}">
        <td class="remote-work-date"><time datetime="${escape(item.work_date)}">${escape(dateFormatter.format(new Date(`${item.work_date}T00:00:00+09:00`)))}</time></td>
        <td class="remote-work-author">${escape(item.author)}</td>
        <td class="remote-work-content"><div class="remote-work-text">${escape(item.content)}</div>${savedAttachments(item.attachments)}</td>
        <td><div class="remote-work-row-actions"><button class="secondary" type="button" data-edit>수정</button><button class="danger-button" type="button" data-delete>삭제</button></div></td>
      </tr>`).join("") : `<tr><td colspan="4" class="remote-work-empty">${month || query ? "조회 조건에 맞는 기록이 없습니다." : "아직 기록이 없습니다. ‘기록 등록’으로 첫 재택근무 기록을 남겨 보세요."}</td></tr>`;
    find(".remote-work-pagination").hidden = total <= pageSize;
    find("[data-page]").textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
  }

  async function load() {
    if (busy || disposed) return;
    setBusy(true);
    try { await reloadRows(); message(); }
    catch (error) { message(error.message || "기록을 불러오지 못했습니다. 조회를 눌러 다시 시도해 주세요.", true); }
    finally { if (!disposed) setBusy(false); }
  }

  function discardUpload(fileId) {
    pendingUploads.delete(fileId);
    // This endpoint only removes uncommitted files, including after a lost save response.
    fetch(`/api/remote-work/files/${encodeURIComponent(fileId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }

  function clearDraft() {
    clipboardRevision++;
    readingClipboard = false;
    pasteButton.disabled = busy;
    pasteButton.textContent = "이미지 붙여넣기";
    resetDrag();
    attachments.forEach((file) => { if (file.localUrl) URL.revokeObjectURL(file.localUrl); });
    attachments = [];
    [...pendingUploads].forEach(discardUpload);
    renderDraft();
    form.reset();
    editingId = null;
  }

  function closeForm() {
    dialog.close();
    document.body.classList.remove("remote-work-modal-open");
    clearDraft();
    if (!disposed && returnFocus?.isConnected) returnFocus.focus();
  }

  function renderDraft() {
    const list = find("[data-attachments]");
    list.hidden = !attachments.length;
    find("[data-attachment-count]").textContent = `${attachments.length} / 10`;
    list.innerHTML = attachments.map((file) => `<div class="remote-work-attachment ${file.kind === "image" ? "is-image" : ""}">
      ${file.kind === "image" ? `<img src="${escape(file.localUrl || attachmentUrl(file, "preview"))}" alt="${escape(file.filename)}" />` : `<span class="remote-work-file-icon" aria-hidden="true">FILE</span>`}
      <div class="remote-work-attachment-name"><span title="${escape(file.filename)}">${escape(file.filename)}</span><small>${fileSize(file.size)}</small></div>
      <button class="secondary" type="button" data-remove-file="${escape(file.id)}" aria-label="${escape(file.filename)} 첨부 취소">✕</button>
    </div>`).join("");
  }

  function openForm(item = null) {
    if (busy) return;
    returnFocus = document.activeElement;
    clearDraft();
    editingId = item?.id || null;
    form.elements.work_date.value = item?.work_date || today();
    form.elements.author.value = item?.author || currentUser().name;
    form.elements.content.value = item?.content || "";
    find("[data-form-title]").textContent = item ? "기록 수정" : "기록 등록";
    attachments = (item?.attachments || []).map((file) => ({ ...file }));
    renderDraft();
    notice.hidden = true;
    dialog.showModal();
    form.scrollTop = 0;
    document.body.classList.add("remote-work-modal-open");
    message();
    form.elements.content.focus();
  }

  add.addEventListener("click", () => openForm());
  find("[data-cancel]").addEventListener("click", () => { if (!busy) closeForm(); });
  find("[data-close]").addEventListener("click", () => { if (!busy) closeForm(); });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!busy) closeForm(); });
  let backdropPointerDown = false;
  const outsideDialog = (event) => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  dialog.addEventListener("pointerdown", (event) => { backdropPointerDown = outsideDialog(event); });
  dialog.addEventListener("click", (event) => {
    if (backdropPointerDown && outsideDialog(event) && !busy) closeForm();
    backdropPointerDown = false;
  });

  function selectFiles(files, kind) {
    if (disposed || busy || !dialog.open || !files.length) return;
    if (attachments.length + files.length > 10) { message("이미지와 파일은 합쳐서 최대 10개까지 첨부할 수 있습니다.", true); return; }
    for (const file of files) {
      if (!file.size || file.size > 20 * 1024 * 1024) { message(`${file.name}: 파일은 0바이트보다 크고 20MB 이하여야 합니다.`, true); return; }
      if (file.name.length > 240) { message("파일 이름을 240자 이내로 줄여 주세요.", true); return; }
      if (kind === "image" && !/\.(png|jpe?g|gif|webp)$/i.test(file.name)) { message("이미지는 JPG, PNG, GIF, WEBP 형식으로 선택해 주세요.", true); return; }
    }
    attachments.push(...files.map((file) => ({
      id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      filename: file.name, size: file.size, kind, file, uploaded: false,
      localUrl: kind === "image" ? URL.createObjectURL(file) : null,
    })));
    renderDraft();
    message();
  }
  const fileInput = find("[data-file-input]");
  find("[data-add-file]").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { selectFiles([...fileInput.files], "file"); fileInput.value = ""; });

  editor.addEventListener("paste", (event) => {
    const images = pastedImages(event.clipboardData);
    if (!images.length) return; // Let normal text pastes use the textarea's native behavior.
    event.preventDefault();
    if (disposed || busy || !dialog.open) return;
    // A keyboard paste supersedes a pending clipboard permission prompt.
    clipboardRevision++;
    readingClipboard = false;
    pasteButton.disabled = false;
    pasteButton.textContent = "이미지 붙여넣기";
    try { selectFiles(images.map((image) => clipboardImage(image)), "image"); }
    catch (error) { message(error.message, true); }
  });
  pasteButton.addEventListener("click", async () => {
    if (disposed || busy || readingClipboard || !dialog.open) return;
    const revision = ++clipboardRevision;
    readingClipboard = true;
    pasteButton.disabled = true;
    pasteButton.textContent = "이미지 읽는 중…";
    try {
      const images = await readClipboardImages(navigator.clipboard);
      if (disposed || busy || !dialog.open || revision !== clipboardRevision) return;
      if (images.length) selectFiles(images, "image");
      else message("클립보드에 이미지가 없습니다. 이미지를 복사한 뒤 다시 붙여넣어 주세요.", true);
    } catch (error) {
      if (disposed || busy || !dialog.open || revision !== clipboardRevision) return;
      message(error.name === "NotAllowedError" || error.name === "SecurityError"
        ? "클립보드에 접근하지 못했습니다. 내용 입력창에서 Ctrl+V(맥은 ⌘V)로 붙여넣어 주세요."
        : error.message || "내용 입력창에서 Ctrl+V(맥은 ⌘V)로 이미지를 붙여넣어 주세요.", true);
    } finally {
      if (!disposed && revision === clipboardRevision) {
        readingClipboard = false;
        pasteButton.disabled = busy;
        pasteButton.textContent = "이미지 붙여넣기";
        if (dialog.open && !busy) form.elements.content.focus();
      }
    }
  });

  function resetDrag() {
    dragDepth = 0;
    editor.classList.remove("is-drag-over");
  }
  dialog.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (busy) return;
    dragDepth++;
    editor.classList.add("is-drag-over");
  });
  dialog.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
  });
  dialog.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) resetDrag();
  });
  dialog.addEventListener("dragend", resetDrag);
  dialog.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    resetDrag();
    if (disposed || busy || !dialog.open) return;
    const directories = [...(event.dataTransfer.items || [])].some((item) => item.webkitGetAsEntry?.()?.isDirectory);
    const files = [...event.dataTransfer.files];
    if (directories || !files.length) { message("폴더 대신 첨부할 파일을 끌어 놓아 주세요.", true); return; }
    selectFiles(files, "file");
  });
  find("[data-attachments]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-file]");
    if (!button || busy) return;
    const file = attachments.find((item) => item.id === button.dataset.removeFile);
    if (!file) return;
    if (file.localUrl) URL.revokeObjectURL(file.localUrl);
    if (pendingUploads.has(file.id)) discardUpload(file.id);
    attachments = attachments.filter((item) => item.id !== file.id);
    renderDraft();
    find("[data-add-file]").focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const payload = { work_date: form.elements.work_date.value, author: form.elements.author.value.trim(), content: form.elements.content.value.trim() };
    if (!payload.author || !payload.content) { message("작성자와 진행 내용을 입력해 주세요.", true); return; }
    const targetId = editingId;
    setBusy(true);
    try {
      const uploads = attachments.filter((file) => file.file && !file.uploaded);
      for (const [index, file] of uploads.entries()) {
        message(`첨부 파일 업로드 중 (${index + 1} / ${uploads.length})`);
        pendingUploads.add(file.id);
        const params = new URLSearchParams({ upload_id: file.id, filename: file.filename, kind: file.kind });
        await request(`/files?${params}`, { method: "POST", body: file.file });
        file.uploaded = true;
      }
      payload.attachment_ids = attachments.map((file) => file.id);
      message("기록을 저장하고 있습니다.");
      const saved = await request(targetId ? `/${targetId}` : "", { method: targetId ? "PATCH" : "POST", body: JSON.stringify(payload) });
      if (disposed) return;
      pendingUploads.clear();
      closeForm();
      offset = 0;
      month = saved.work_date.slice(0, 7);
      query = "";
      filters.elements.month.value = month;
      filters.elements.query.value = "";
      try { await reloadRows(); message("저장했습니다."); }
      catch { message("저장했지만 목록을 새로 불러오지 못했습니다. 조회를 눌러 확인해 주세요.", true); }
    } catch (error) {
      message(error.message || "저장하지 못했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요.", true);
    } finally {
      if (!disposed) {
        setBusy(false);
        if (!dialog.open) (returnFocus?.isConnected ? returnFocus : add).focus();
      }
    }
  });

  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !filters.reportValidity()) return;
    month = filters.elements.month.value;
    query = filters.elements.query.value.trim();
    offset = 0;
    load();
  });
  find("[data-reset-filter]").addEventListener("click", () => {
    filters.reset();
    month = "";
    query = "";
    offset = 0;
    load();
  });
  prev.addEventListener("click", () => { offset = Math.max(0, offset - pageSize); load(); });
  next.addEventListener("click", () => { offset += pageSize; load(); });
  tbody.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    const row = button?.closest("[data-entry]");
    if (!row || busy) return;
    const item = items.find((item) => item.id === row.dataset.entry);
    if (!item) return;
    if (button.hasAttribute("data-edit")) { openForm(item); return; }
    if (!button.hasAttribute("data-delete") || !window.confirm(`${item.work_date} ${item.author}님의 재택근무 기록을 삭제하시겠습니까?`)) return;
    setBusy(true);
    try {
      await request(`/${item.id}`, { method: "DELETE" });
      if (disposed) return;
      if (editingId === item.id) closeForm();
      try { await reloadRows(); message("삭제했습니다."); }
      catch { message("삭제했지만 목록을 새로 불러오지 못했습니다. 조회를 눌러 확인해 주세요.", true); }
    } catch (error) { message(error.message || "삭제하지 못했습니다. 다시 시도해 주세요.", true); }
    finally { if (!disposed) setBusy(false); }
  });

  load();
  return () => { disposed = true; abort.abort(); closeForm(); items = []; };
}
