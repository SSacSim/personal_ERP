const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#${name}" /></svg>`;
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fileSize = (bytes) => bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const fileUrl = (id, action) => `/api/documents/files/${encodeURIComponent(id)}/${action}`;

export function mountDocuments(container) {
  const abort = new AbortController();
  let disposed = false;
  let busy = false;
  let folders = [];
  let files = [];
  let selectedId = null;
  let editingId = null;
  let maxFileBytes = 1024 * 1024 * 1024;
  let failedFiles = [];
  let dragDepth = 0;
  let returnFocus = null;

  container.innerHTML = `
    <section class="library-page">
      <header class="library-heading"><div><p class="eyebrow">PUBLIC · 함께 쓰는 자료</p><h2>자료실</h2><p>폴더에 문서와 이미지를 모아 팀과 공유하세요.</p></div><button type="button" data-new-folder>${icon("plus")} 새 폴더</button></header>
      <p class="library-notice" data-notice role="status" hidden></p>
      <div class="library-workspace">
        <aside class="panel library-folders"><div class="section-head"><h3>폴더 <span class="count-label" data-folder-count>0</span></h3><button type="button" class="secondary" data-refresh>새로고침</button></div><div data-folders><p class="empty">폴더를 불러오는 중…</p></div></aside>
        <section class="panel library-detail" aria-label="폴더 내용" data-detail><p class="empty">폴더를 선택해 주세요.</p></section>
      </div>
      <dialog class="library-dialog" aria-labelledby="library-dialog-title">
        <form data-folder-form><h3 id="library-dialog-title">새 폴더</h3><p>폴더의 제목과 보관할 자료에 대한 설명을 입력하세요.</p>
          <p class="library-notice is-error" data-form-notice role="alert" hidden></p>
          <fieldset><label>폴더 제목<input name="title" required maxlength="140" placeholder="예: 회사 소개 자료" /></label><label>내용 설명<textarea name="description" maxlength="3000" rows="5" placeholder="예: 회사 소개서, 발표 자료와 로고 이미지를 보관합니다."></textarea></label>
          <div class="library-dialog-actions"><button type="button" class="secondary" data-cancel>취소</button><button type="submit">폴더 만들기</button></div></fieldset>
        </form>
      </dialog>
    </section>`;
  const find = (selector) => container.querySelector(selector);
  const dialog = find("dialog");
  const form = find("[data-folder-form]");
  const detail = find("[data-detail]");

  function notice(message = "", error = false) {
    if (disposed) return;
    const node = find("[data-notice]");
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle("is-error", error);
  }

  function setBusy(value) {
    busy = value;
    container.querySelectorAll("button, input, textarea, fieldset").forEach((node) => { node.disabled = value; });
    detail.setAttribute("aria-busy", String(value));
  }

  async function request(path, options = {}) {
    const response = await fetch(`/api/documents${path}`, { ...options, signal: abort.signal, cache: "no-store" });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : response.status === 401 ? "로그인이 만료되었습니다. 다시 로그인해 주세요." : response.status === 422 ? "입력한 제목과 파일 이름을 확인해 주세요." : "요청을 처리하지 못했습니다. 다시 시도해 주세요.");
    return data;
  }

  function drawFolders() {
    find("[data-folder-count]").textContent = folders.length;
    find("[data-folders]").innerHTML = folders.length ? folders.map((folder) => `
      <button type="button" class="library-folder ${folder.id === selectedId ? "is-selected" : ""}" data-folder="${escape(folder.id)}" aria-pressed="${folder.id === selectedId}">
        <span class="library-folder-icon">${icon("folder")}</span><span><strong>${escape(folder.title)}</strong><small>${escape(folder.description || "설명 없음")}</small><span class="library-folder-count">파일 ${folder.file_count}개 · ${fileSize(folder.total_size)}</span></span>
      </button>`).join("") : `<div class="library-empty"><span class="library-empty-icon">${icon("folder")}</span><strong>첫 폴더를 만들어 보세요</strong><p>제목과 설명을 적고 자료를 모아 보세요.</p></div>`;
  }

  function drawDetail() {
    const folder = folders.find((item) => item.id === selectedId);
    if (!folder) {
      detail.innerHTML = `<div class="library-empty"><span class="library-empty-icon">${icon("folder")}</span><h3>함께 쓰는 문서 보관함</h3><p>새 폴더를 만들거나 왼쪽에서 폴더를 선택하세요.</p></div>`;
      return;
    }
    detail.innerHTML = `
      <header class="library-folder-heading"><div><h3>${escape(folder.title)}</h3><p>${escape(folder.description || "등록된 설명이 없습니다.")}</p></div><div class="library-actions"><button type="button" class="secondary" data-edit-folder>폴더 수정</button><button type="button" class="danger-button" data-delete-folder>폴더 삭제</button></div></header>
      <div class="library-dropzone" data-dropzone>
        <span class="library-upload-icon">${icon("folder")}</span><div><strong>파일을 여기에 끌어다 놓으세요</strong><p>이미지, PDF, PPT, 엑셀, 압축 파일 등 모든 형식 · 개당 ${fileSize(maxFileBytes)}까지</p></div>
        <button type="button" data-upload>파일 업로드</button><input type="file" multiple data-file-input aria-label="업로드할 파일 선택" hidden />
      </div>
      <p class="library-upload-progress" data-progress role="status" hidden></p><div class="library-upload-errors" data-upload-errors hidden></div>
      <div class="library-file-heading"><h4>파일 <span class="count-label">${files.length}</span></h4><span>최신 업로드 순 · 한국 시간</span></div>
      ${files.length ? `<div class="library-table-wrap"><table class="library-table"><thead><tr><th scope="col">파일명</th><th scope="col">크기</th><th scope="col">업로드 일시</th><th scope="col"><span class="sr-only">파일 관리</span></th></tr></thead><tbody>${files.map((file) => `
        <tr><td><div class="library-file-name">${file.preview_url ? `<a class="library-preview" href="${fileUrl(file.id, "preview")}" target="_blank" rel="noopener" aria-label="${escape(file.filename)} 미리보기"><img src="${fileUrl(file.id, "preview")}" alt="" loading="lazy" /></a>` : `<span class="library-file-type">${escape(file.filename.includes(".") ? file.filename.split(".").pop().slice(0, 6).toUpperCase() || "FILE" : "FILE")}</span>`}<a href="${fileUrl(file.id, "download")}" download title="${escape(file.filename)}">${escape(file.filename)}</a></div></td>
        <td class="library-file-size">${fileSize(file.size)}</td><td class="library-file-date"><time datetime="${escape(file.uploaded_at)}">${escape(dateFormatter.format(new Date(file.uploaded_at)))}</time></td><td><div class="library-actions"><a class="library-download" href="${fileUrl(file.id, "download")}" download aria-label="${escape(file.filename)} 다운로드">다운로드</a><button type="button" class="danger-button" data-delete-file="${escape(file.id)}" aria-label="${escape(file.filename)} 삭제">삭제</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="library-empty library-empty-files"><strong>아직 업로드한 파일이 없습니다</strong><p>파일을 선택하거나 끌어다 놓아 추가하세요.</p></div>`}`;
    drawFailures();
  }

  function drawFailures() {
    const node = find("[data-upload-errors]");
    if (!node) return;
    node.hidden = !failedFiles.length;
    node.innerHTML = failedFiles.length ? `<strong>업로드하지 못한 파일 ${failedFiles.length}개</strong><ul>${failedFiles.map(({ file, message }) => `<li>${escape(file.name)}: ${escape(message)}</li>`).join("")}</ul><button type="button" class="secondary" data-retry>실패한 파일 다시 시도</button>` : "";
  }

  async function reload() {
    const data = await request("/folders");
    if (disposed) return;
    folders = data.items;
    maxFileBytes = data.max_file_bytes;
    if (!folders.some((folder) => folder.id === selectedId)) {
      selectedId = folders[0]?.id || null;
      failedFiles = [];
    }
    files = selectedId ? (await request(`/folders/${selectedId}/files`)).items : [];
    if (disposed) return;
    drawFolders();
    drawDetail();
    setBusy(busy);
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    try { await reload(); notice(); }
    catch (error) { if (!disposed) notice(error.message, true); }
    finally { if (!disposed) setBusy(false); }
  }

  function openFolderForm(edit = false) {
    const folder = edit ? folders.find((item) => item.id === selectedId) : null;
    editingId = folder?.id || null;
    returnFocus = document.activeElement;
    form.reset();
    form.elements.title.value = folder?.title || "";
    form.elements.description.value = folder?.description || "";
    form.elements.title.setCustomValidity("");
    find("[data-form-notice]").hidden = true;
    find("#library-dialog-title").textContent = edit ? "폴더 수정" : "새 폴더";
    form.querySelector("[type=submit]").textContent = edit ? "변경 저장" : "폴더 만들기";
    dialog.showModal();
    form.elements.title.focus();
  }

  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!disposed && returnFocus?.isConnected) returnFocus.focus(); });
  form.elements.title.addEventListener("input", () => form.elements.title.setCustomValidity(""));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const title = form.elements.title.value.trim();
    if (!title) {
      form.elements.title.setCustomValidity("폴더 제목을 입력해 주세요.");
      form.elements.title.reportValidity();
      return;
    }
    setBusy(true);
    find("[data-form-notice]").hidden = true;
    let saved = false;
    try {
      const item = await request(editingId ? `/folders/${editingId}` : "/folders", {
        method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description: form.elements.description.value.trim() }),
      });
      if (disposed) return;
      selectedId = item.id;
      failedFiles = [];
      saved = true;
      dialog.close();
      await reload();
      notice("폴더를 저장했습니다.");
    } catch (error) {
      if (disposed) return;
      if (saved) notice(`폴더는 저장되었습니다. 목록을 새로고침해 주세요. ${error.message}`, true);
      else { find("[data-form-notice]").textContent = error.message; find("[data-form-notice]").hidden = false; }
    } finally { if (!disposed) setBusy(false); }
  });

  async function uploadFiles(chosen) {
    if (busy || !selectedId || !chosen.length) return;
    const folderId = selectedId;
    const batch = [...chosen];
    failedFiles = [];
    drawFailures();
    setBusy(true);
    notice();
    let uploaded = 0;
    const progress = find("[data-progress]");
    progress.hidden = false;
    for (const [index, file] of batch.entries()) {
      if (disposed) return;
      progress.textContent = `업로드 중 ${index + 1} / ${batch.length} · ${file.name}`;
      try {
        if (file.size > maxFileBytes) throw new Error(`파일당 ${fileSize(maxFileBytes)}까지 업로드할 수 있습니다.`);
        await request(`/folders/${folderId}/files?${new URLSearchParams({ filename: file.name })}`, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
        uploaded++;
      } catch (error) {
        if (disposed) return;
        failedFiles.push({ file, message: error.message });
      }
    }
    if (disposed) return;
    try {
      await reload();
      notice(`${uploaded}개 파일을 업로드했습니다.${failedFiles.length ? ` ${failedFiles.length}개 파일은 아래 내용을 확인한 뒤 다시 시도해 주세요.` : ""}`, failedFiles.length > 0);
    } catch (error) { if (!disposed) notice(`업로드 처리 후 목록을 불러오지 못했습니다. 새로고침해 주세요. ${error.message}`, true); }
    finally { if (!disposed) { progress.hidden = true; drawFailures(); setBusy(false); } }
  }

  async function deleteItem(fileId) {
    const item = fileId ? files.find((file) => file.id === fileId) : folders.find((folder) => folder.id === selectedId);
    if (!item) return;
    if (!fileId && item.file_count) { notice("폴더 안의 파일을 먼저 삭제해 주세요.", true); return; }
    if (!window.confirm(fileId ? `“${item.filename}” 파일을 삭제하시겠습니까?` : `“${item.title}” 폴더를 삭제하시겠습니까?`)) return;
    setBusy(true);
    let deleted = false;
    try {
      await request(fileId ? `/files/${fileId}` : `/folders/${selectedId}`, { method: "DELETE" });
      deleted = true;
      await reload();
      notice(fileId ? "파일을 삭제했습니다." : "폴더를 삭제했습니다.");
    } catch (error) { if (!disposed) notice(`${deleted ? "삭제되었습니다. 목록을 새로고침해 주세요. " : ""}${error.message}`, true); }
    finally { if (!disposed) setBusy(false); }
  }

  container.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy || disposed) return;
    if (button.hasAttribute("data-new-folder")) openFolderForm();
    else if (button.hasAttribute("data-edit-folder")) openFolderForm(true);
    else if (button.hasAttribute("data-cancel")) dialog.close();
    else if (button.hasAttribute("data-refresh")) await refresh();
    else if (button.hasAttribute("data-upload")) find("[data-file-input]").click();
    else if (button.hasAttribute("data-retry")) await uploadFiles(failedFiles.map(({ file }) => file));
    else if (button.hasAttribute("data-delete-folder")) await deleteItem(null);
    else if (button.hasAttribute("data-delete-file")) await deleteItem(button.dataset.deleteFile);
    else if (button.hasAttribute("data-folder") && button.dataset.folder !== selectedId) {
      setBusy(true);
      try {
        const data = await request(`/folders/${button.dataset.folder}/files`);
        if (disposed) return;
        selectedId = button.dataset.folder;
        files = data.items;
        failedFiles = [];
        drawFolders();
        drawDetail();
        notice();
      } catch (error) { if (!disposed) notice(error.message, true); }
      finally { if (!disposed) setBusy(false); }
    }
  }, { signal: abort.signal });
  container.addEventListener("change", (event) => {
    if (!event.target.matches("[data-file-input]")) return;
    const chosen = [...event.target.files];
    event.target.value = "";
    uploadFiles(chosen);
  }, { signal: abort.signal });
  detail.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy || !selectedId ? "none" : "copy";
  });
  detail.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth++;
    if (!busy) find("[data-dropzone]")?.classList.add("is-dragging");
  });
  detail.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) find("[data-dropzone]")?.classList.remove("is-dragging");
  });
  detail.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    find("[data-dropzone]")?.classList.remove("is-dragging");
    if (!busy) uploadFiles([...(event.dataTransfer?.files || [])]);
  });
  refresh();
  return () => { disposed = true; abort.abort(); dialog.close(); failedFiles = []; };
}
