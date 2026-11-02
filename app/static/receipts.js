const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatDate = (value) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const receiptPhotos = (receipt) => receipt.images?.length ? receipt.images : [receipt];
const imageUrl = (photo, receipt = photo) => photo.image_url + (receipt.updated_at ? `?v=${encodeURIComponent(receipt.updated_at)}` : "");
const isPdf = (file) => file.content_type === "application/pdf" || /\.pdf$/i.test(file.filename || file.name || "");
const thumbnail = (file, url, attributes = "") => isPdf(file)
  ? `<span class="receipt-pdf-icon" aria-label="PDF 파일">PDF</span>`
  : `<img src="${escape(url)}" alt="" ${attributes} />`;

export function mountReceipts(container) {
  const abort = new AbortController();
  const pageSize = 24;
  let offset = 0;
  let total = 0;
  let loading = false;
  let disposed = false;
  let lastResult = "";
  let items = [];
  let selectedId = null;
  let editing = false;
  let busy = false;
  let replacementPhotos = [];
  let previewUrls = [];
  let photoIndex = 0;
  let photoReady = true;
  let folderId = new URLSearchParams(window.location?.search || "").get("folder_id");
  let folders = [];
  let activeFolder = null;
  let creatingFolder = false;
  let movingReceipt = null;
  let moveTargets = [];
  let moveLoading = false;
  let moveToken = 0;

  container.innerHTML = `
    <section class="receipts-page">
      <nav class="receipts-folder-path" data-folder-path aria-label="영수증 폴더 경로" hidden>
        <button class="secondary receipts-back" type="button" data-folder-back hidden>← 폴더 목록</button>
        <span class="receipts-path-divider" aria-hidden="true">/</span><span data-folder-path-name aria-current="page"></span>
      </nav>
      <div class="receipts-heading">
        <div class="receipts-heading-main">
          <div class="receipts-folder-symbol" data-folder-symbol hidden><svg class="icon" aria-hidden="true"><use href="/static/icons.svg#folder" /></svg></div>
          <div class="receipts-heading-copy">
            <p class="receipts-folder-eyebrow" data-folder-eyebrow hidden>현재 열어둔 폴더</p>
            <div class="receipts-title-line"><h2><span data-heading>영수증 폴더</span></h2><span class="receipts-count-group"><span data-folder-count-label hidden>영수증</span><span class="receipts-count"></span></span><span class="receipts-current-state" data-folder-current-state hidden></span></div>
            <p data-description>용도별로 폴더를 만들고, 폴더 안에서 영수증을 등록하세요.</p>
          </div>
        </div>
        <div class="receipts-actions"><label class="receipts-folder-state" data-folder-state-label hidden>폴더 상태<select data-folder-state aria-label="폴더 상태"><option value="in_progress">진행</option><option value="completed">완료</option></select></label><button class="secondary" type="button" data-refresh>새로고침</button><button type="button" data-create-folder>+ 폴더 만들기</button><a class="button-link" data-upload href="/receipt-upload" hidden>+ 영수증 등록</a></div>
      </div>
      <p class="receipt-page-notice" data-page-notice role="status" aria-live="polite" hidden></p>
      <div class="receipt-folders" data-folders aria-label="영수증 폴더 목록"></div>
      <p class="receipts-status" role="status" aria-live="polite">폴더를 불러오는 중입니다.</p>
      <div class="receipts-table-wrap" hidden>
        <table class="receipts-table">
          <caption class="receipts-sr-only">등록된 영수증 목록. 행 또는 상세 보기 버튼을 누르면 영수증 정보를 확인할 수 있습니다.</caption>
          <thead><tr><th scope="col">첨부</th><th scope="col">등록자</th><th scope="col">등록 일시</th><th scope="col">내용</th><th scope="col">상세</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="receipts-pagination" hidden><button class="secondary" data-prev type="button">이전</button><span data-page></span><button class="secondary" data-next type="button">다음</button></div>
      <p class="receipts-hint">영수증을 누르면 상세 조회·수정·삭제할 수 있습니다. 최신 목록은 10초마다 갱신됩니다.</p>
      <dialog class="receipt-folder-dialog" aria-labelledby="receipt-folder-title">
        <form data-folder-form>
          <h2 id="receipt-folder-title">폴더 만들기</h2>
          <label for="receipt-folder-name">폴더 이름</label>
          <input id="receipt-folder-name" name="name" maxlength="80" placeholder="예: 11월 출장비" required />
          <p data-folder-notice role="status" hidden></p>
          <div class="receipt-detail-actions"><button type="submit" data-folder-save>폴더 만들기</button><button class="secondary" type="button" data-folder-cancel>취소</button></div>
        </form>
      </dialog>
      <dialog class="receipt-move-dialog" aria-labelledby="receipt-move-title">
        <header class="receipt-dialog-header"><h2 id="receipt-move-title">영수증 이동</h2><button class="secondary" type="button" data-move-close>닫기</button></header>
        <div class="receipt-move-body">
          <p>이동할 폴더를 선택하세요. 완료된 폴더는 선택할 수 없습니다.</p>
          <p class="receipt-move-summary" data-move-summary></p>
          <p data-move-notice role="status" aria-live="polite"></p>
          <div class="receipt-move-list" data-move-list aria-label="이동할 폴더 목록"></div>
        </div>
      </dialog>
      <dialog class="receipt-dialog" id="receipt-detail" aria-labelledby="receipt-detail-title">
        <header class="receipt-dialog-header"><h2 id="receipt-detail-title">영수증 상세</h2><button class="secondary receipt-dialog-close" type="button" data-close aria-label="영수증 상세 닫기" autofocus>닫기</button></header>
        <div class="receipt-dialog-body" data-detail></div>
      </dialog>
    </section>`;
  const find = (selector) => container.querySelector(selector);
  const status = find(".receipts-status");
  const tableWrap = find(".receipts-table-wrap");
  const rows = find("tbody");
  const dialog = find(".receipt-dialog");
  const detail = find("[data-detail]");
  const prev = find("[data-prev]");
  const next = find("[data-next]");
  const refresh = find("[data-refresh]");
  const folderGrid = find("[data-folders]");
  const folderDialog = find(".receipt-folder-dialog");
  const folderForm = find("[data-folder-form]");
  const folderState = find("[data-folder-state]");
  const moveDialog = find(".receipt-move-dialog");
  const moveList = find("[data-move-list]");

  function pageMessage(text, error = false) {
    const notice = find("[data-page-notice]");
    notice.textContent = text;
    notice.hidden = !text;
    notice.classList.toggle("error", error);
  }

  folderState.addEventListener("change", async () => {
    if (!activeFolder || busy || loading || disposed) return;
    const nextState = folderState.value;
    const previousState = activeFolder.status || "in_progress";
    setBusy(true);
    pageMessage("폴더 상태를 저장하는 중입니다.");
    try {
      const response = await fetch(`/api/receipts/folders/${encodeURIComponent(folderId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: nextState }), signal: abort.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "폴더 상태를 변경하지 못했습니다.");
      if (disposed) return;
      activeFolder = data;
      await load();
      pageMessage(nextState === "completed" ? "완료 처리했습니다. 이 폴더로는 새 영수증을 등록하거나 이동할 수 없습니다." : "진행으로 변경했습니다. 영수증을 등록하거나 이동할 수 있습니다.");
    } catch (error) {
      if (!disposed) { folderState.value = previousState; pageMessage(error.message || "폴더 상태를 변경하지 못했습니다.", true); }
    } finally {
      if (!disposed) setBusy(false);
    }
  });

  async function loadMoveTargets(token) {
    const response = await fetch("/api/receipts/folders", { signal: abort.signal, cache: "no-store" });
    if (!response.ok) throw new Error("이동할 폴더 목록을 불러오지 못했습니다. 창을 닫고 다시 시도해 주세요.");
    const data = await response.json();
    if (disposed || token !== moveToken || !moveDialog.open) return;
    moveTargets = data.items;
    moveList.innerHTML = moveTargets.map((folder) => {
      const current = folder.id === movingReceipt.folder_id;
      const available = folder.can_upload && !current;
      return `<button class="receipt-move-target" type="button" data-target-folder="${escape(folder.id)}" data-available="${available}" ${available ? "" : "disabled"}><strong>${escape(folder.name)}</strong><span>${current ? "현재 폴더" : folder.can_upload ? "진행" : "완료 · 이동 불가"} · 영수증 ${folder.receipt_count}건</span></button>`;
    }).join("");
  }

  async function openMove(receipt) {
    if (busy || loading || disposed) return;
    const token = ++moveToken;
    movingReceipt = receipt;
    moveTargets = [];
    moveList.innerHTML = "";
    const notice = find("[data-move-notice]");
    notice.textContent = "폴더를 불러오는 중입니다.";
    notice.classList.remove("error");
    find("[data-move-summary]").textContent = receipt.content;
    moveDialog.showModal();
    document.body.classList.add("receipts-modal-open");
    moveLoading = true;
    buttons();
    try {
      await loadMoveTargets(token);
      if (!disposed && token === moveToken) notice.textContent = "";
    } catch (error) {
      if (!disposed && token === moveToken) { notice.textContent = error.message; notice.classList.add("error"); }
    } finally {
      if (!disposed && token === moveToken) { moveLoading = false; buttons(); }
    }
  }

  find("[data-move-close]").addEventListener("click", () => { if (!busy) moveDialog.close(); });
  moveDialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  moveDialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
  moveDialog.addEventListener("close", () => {
    const receiptId = movingReceipt?.id;
    ++moveToken;
    movingReceipt = null;
    moveLoading = false;
    if (!dialog.open) {
      document.body.classList.remove("receipts-modal-open");
      if (!disposed) focusReceipt(receiptId, ".receipt-move");
    }
  });
  moveList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-target-folder]");
    if (!button || !movingReceipt || busy || moveLoading || disposed) return;
    const target = moveTargets.find((folder) => folder.id === button.dataset.targetFolder);
    if (!target?.can_upload || target.id === movingReceipt.folder_id) return;
    const token = moveToken;
    const notice = find("[data-move-notice]");
    setBusy(true);
    notice.textContent = "이동 중입니다.";
    notice.classList.remove("error");
    try {
      await mutate(movingReceipt.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: target.id }) }, "/move");
      if (disposed) return;
      moveDialog.close();
      if (dialog.open) dialog.close();
      await load();
      pageMessage(`‘${target.name}’ 폴더로 이동했습니다.`);
    } catch (error) {
      if (!disposed && token === moveToken) {
        notice.textContent = error.message || "영수증을 이동하지 못했습니다. 다시 시도해 주세요.";
        notice.classList.add("error");
        try { await loadMoveTargets(token); } catch { /* Keep the move error visible for retry. */ }
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  });

  function navigateFolder(id) {
    if (loading || busy || disposed) return;
    folderId = id;
    pageMessage("");
    offset = 0;
    lastResult = "";
    window.history?.replaceState({}, "", id ? `/receipts?folder_id=${encodeURIComponent(id)}` : "/receipts");
    load();
  }

  folderGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-folder-id]");
    if (button) navigateFolder(button.dataset.folderId);
  });
  find("[data-folder-back]").addEventListener("click", () => navigateFolder(null));
  find("[data-create-folder]").addEventListener("click", () => {
    folderForm.reset();
    find("[data-folder-notice]").hidden = true;
    folderDialog.showModal();
    find("#receipt-folder-name").focus();
  });
  find("[data-folder-cancel]").addEventListener("click", () => { if (!creatingFolder) folderDialog.close(); });
  folderDialog.addEventListener("cancel", (event) => { if (creatingFolder) event.preventDefault(); });
  folderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (creatingFolder || disposed || !folderForm.reportValidity()) return;
    const name = find("#receipt-folder-name").value.trim();
    const notice = find("[data-folder-notice]");
    if (!name) { notice.textContent = "폴더 이름을 입력해 주세요."; notice.hidden = false; return; }
    creatingFolder = true;
    find("[data-folder-save]").disabled = true;
    find("[data-folder-cancel]").disabled = true;
    find("#receipt-folder-name").disabled = true;
    try {
      const response = await fetch("/api/receipts/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), signal: abort.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "폴더를 만들지 못했습니다.");
      if (disposed) return;
      folderDialog.close();
      navigateFolder(data.id);
    } catch (error) {
      if (!disposed) { notice.textContent = error.message || "폴더를 만들지 못했습니다. 다시 시도해 주세요."; notice.hidden = false; }
    } finally {
      creatingFolder = false;
      if (!disposed) {
        find("[data-folder-save]").disabled = false;
        find("[data-folder-cancel]").disabled = false;
        find("#receipt-folder-name").disabled = false;
      }
    }
  });

  function focusReceipt(receiptId, selector = ".receipt-open") {
    const row = [...rows.querySelectorAll("[data-receipt-id]")].find((row) => row.dataset.receiptId === receiptId);
    (row?.querySelector(selector) || refresh).focus({ preventScroll: true });
  }

  function clearReplacement() {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls = [];
    replacementPhotos = [];
    photoReady = true;
  }

  function galleryPhotos(receipt) {
    return replacementPhotos.length
      ? replacementPhotos.map((file, index) => ({ filename: file.name, content_type: file.type, image_url: previewUrls[index] }))
      : receiptPhotos(receipt);
  }

  function renderGallery(receipt) {
    const photos = galleryPhotos(receipt);
    const source = (photo) => replacementPhotos.length ? photo.image_url : imageUrl(photo, receipt);
    photoIndex = 0;
    detail.querySelector("[data-gallery]").innerHTML = `
      <figure class="receipt-detail-photo">${filePreview(photos[0], source(photos[0]), 0, photos.length)}</figure>
      <div class="receipt-gallery-meta">
        <p><strong data-photo-position>파일 1 / ${photos.length}</strong><span data-photo-filename>${escape(photos[0].filename)}</span></p>
        <div class="receipt-detail-actions" ${replacementPhotos.length ? "hidden" : ""}>
          <a class="button-link secondary" data-photo-original href="${escape(photos[0].image_url)}" target="_blank" rel="noopener noreferrer">원본 보기 ↗</a>
          <a class="button-link secondary" data-photo-download href="${escape(photos[0].image_url)}?download=true" download="${escape(photos[0].filename)}">이 파일 다운로드</a>
        </div>
      </div>
      <div class="receipt-photo-list" role="group" aria-label="첨부 파일 선택" ${photos.length < 2 ? "hidden" : ""}>
        ${photos.map((photo, index) => `<button class="receipt-photo-choice" type="button" data-photo-index="${index}" aria-label="파일 ${index + 1} 보기" aria-pressed="${index === 0}">${thumbnail(photo, source(photo), 'loading="lazy"')}<span>${index + 1}</span></button>`).join("")}
      </div>`;
  }

  function filePreview(file, url, index, count) {
    return isPdf(file)
      ? `<iframe class="receipt-pdf-preview" src="${escape(url)}" title="${escape(file.filename)} PDF 미리보기"></iframe>`
      : `<img src="${escape(url)}" alt="영수증 사진 ${index + 1} / ${count}" />`;
  }

  function selectPhoto(receipt, index) {
    const photos = galleryPhotos(receipt);
    const photo = photos[index];
    if (!photo) return;
    photoIndex = index;
    detail.querySelector(".receipt-detail-photo").innerHTML = filePreview(photo, replacementPhotos.length ? photo.image_url : imageUrl(photo, receipt), index, photos.length);
    detail.querySelector("[data-photo-position]").textContent = `파일 ${index + 1} / ${photos.length}`;
    detail.querySelector("[data-photo-filename]").textContent = photo.filename;
    detail.querySelector("[data-photo-original]").href = photo.image_url;
    const download = detail.querySelector("[data-photo-download]");
    download.href = photo.image_url + "?download=true";
    download.download = photo.filename;
    detail.querySelectorAll("[data-photo-index]").forEach((button) => {
      button.setAttribute("aria-pressed", Number(button.dataset.photoIndex) === photoIndex ? "true" : "false");
    });
  }

  function detailMessage(text, error = false) {
    const notice = detail.querySelector("[data-detail-notice]");
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = !text;
    notice.classList.toggle("error", error);
  }

  function setBusy(value) {
    busy = value;
    find("[data-close]").disabled = busy;
    const fields = detail.querySelector("fieldset");
    if (fields) fields.disabled = busy;
    detail.querySelectorAll("[data-edit], [data-delete]").forEach((button) => { button.disabled = busy; });
    detail.querySelectorAll("[data-move]").forEach((button) => { button.disabled = busy; });
    const save = detail.querySelector("[data-save]");
    if (save) {
      save.disabled = busy || !photoReady;
      save.textContent = busy ? "저장 중…" : "변경사항 저장";
    }
    buttons();
  }

  function openReceipt(receipt, edit = false) {
    clearReplacement();
    selectedId = receipt.id;
    editing = edit;
    find("#receipt-detail-title").textContent = edit ? "영수증 수정" : "영수증 상세";
    detail.innerHTML = `
      <div class="receipt-gallery" data-gallery></div>
      <div class="receipt-detail-info">
        <dl>
          <div><dt>등록자</dt><dd>${escape(receipt.registrant)}</dd></div>
          <div><dt>등록 일시</dt><dd><time datetime="${escape(receipt.created_at)}">${escape(formatDate(receipt.created_at))}</time></dd></div>
          ${edit ? "" : `<div><dt>내용</dt><dd class="receipt-detail-content">${escape(receipt.content) || "—"}</dd></div>`}
          <div><dt>첨부 파일</dt><dd class="receipt-detail-filename">${receiptPhotos(receipt).length}개 · 파일을 선택해 개별로 보고 다운로드할 수 있습니다.</dd></div>
        </dl>
        ${edit ? `<form data-edit-form class="receipt-edit-form">
          <fieldset>
            <label for="receipt-content">내용</label>
            <textarea id="receipt-content" name="content" rows="6" maxlength="4000" required>${escape(receipt.content)}</textarea>
            <label for="receipt-photo">첨부 파일 전체 교체</label>
            <input id="receipt-photo" name="photo" type="file" accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,image/jpeg,image/png,image/webp,image/gif,application/pdf" aria-describedby="receipt-photo-hint" multiple />
            <p id="receipt-photo-hint" class="receipts-hint">새 파일을 선택하면 기존 첨부 전체를 교체합니다. 선택하지 않으면 기존 파일을 유지합니다. 최대 20개 · JPG, PNG, WEBP, GIF, PDF · 파일당 10MB</p>
            <div class="receipt-detail-actions"><button type="submit" data-save>변경사항 저장</button><button class="secondary" type="button" data-cancel-edit>취소</button></div>
          </fieldset>
        </form>` : `<div class="receipt-detail-actions">
          <button type="button" data-edit>수정</button><button class="secondary" type="button" data-move>이동</button><button class="danger-button" type="button" data-delete>삭제</button>
        </div>`}
        <p class="receipt-detail-notice" data-detail-notice role="status" aria-live="polite" hidden></p>
      </div>`;
    renderGallery(receipt);
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("receipts-modal-open");
    setBusy(busy);
    if (edit) detail.querySelector("textarea").focus();
  }

  async function mutate(receiptId, options, action = "") {
    const response = await fetch(`/api/receipts/${encodeURIComponent(receiptId)}${action}`, { ...options, signal: abort.signal });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return data;
  }

  detail.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    const receipt = items.find((item) => item.id === selectedId);
    if (!button || !receipt || busy || disposed) return;
    if (button.hasAttribute("data-photo-index")) { selectPhoto(receipt, Number(button.dataset.photoIndex)); return; }
    if (button.hasAttribute("data-edit")) { openReceipt(receipt, true); return; }
    if (button.hasAttribute("data-move")) { await openMove(receipt); return; }
    if (button.hasAttribute("data-cancel-edit")) { openReceipt(receipt); detail.querySelector("[data-edit]").focus(); return; }
    if (!button.hasAttribute("data-delete") || !window.confirm(`${receipt.registrant}님의 ${formatDate(receipt.created_at)} 영수증을 삭제하시겠습니까?\n첨부 파일과 등록 내용이 함께 삭제되며 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    detailMessage("삭제 중…");
    try {
      await mutate(receipt.id, { method: "DELETE" });
      if (disposed) return;
      dialog.close();
      await load();
    } catch (error) {
      if (!disposed) detailMessage(error.message || "삭제하지 못했습니다. 다시 시도해 주세요.", true);
    } finally {
      if (!disposed) {
        setBusy(false);
        if (!dialog.open) refresh.focus();
      }
    }
  });

  detail.addEventListener("change", async (event) => {
    if (!event.target.matches("#receipt-photo") || busy || disposed) return;
    const files = [...event.target.files];
    clearReplacement();
    const receipt = items.find((item) => item.id === selectedId);
    renderGallery(receipt);
    detailMessage("");
    if (!files.length) { setBusy(false); return; }
    if (files.length > 20 || files.some((file) => !/\.(jpe?g|png|webp|gif|pdf)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024 || file.name.length > 255)) {
      event.target.value = "";
      detailMessage("최대 20개, 파일 이름 255자 이내, 파일당 10MB 이하의 JPG, PNG, WEBP, GIF, PDF를 선택해 주세요.", true);
      setBusy(false);
      return;
    }
    replacementPhotos = files;
    photoReady = false;
    const urls = previewUrls = files.map((file) => URL.createObjectURL(file));
    renderGallery(receipt);
    setBusy(false);
    try {
      // Decode one at a time to limit memory use for large phone screenshots.
      for (const [index, url] of urls.entries()) {
        if (isPdf(files[index])) continue;
        const image = document.createElement("img");
        image.src = url;
        try { await image.decode(); } finally { image.removeAttribute("src"); }
        if (disposed || previewUrls !== urls) return;
      }
      photoReady = true;
      detailMessage(`저장하면 선택한 파일 ${files.length}개로 전체 교체됩니다.`);
    } catch {
      if (disposed || previewUrls !== urls) return;
      detailMessage("사진을 열 수 없습니다. 다른 사진을 선택해 주세요.", true);
    }
    setBusy(false);
  });

  detail.addEventListener("submit", async (event) => {
    if (!event.target.matches("[data-edit-form]")) return;
    event.preventDefault();
    if (busy || disposed || !editing || !photoReady || !event.target.reportValidity()) return;
    const content = event.target.elements.content.value.trim();
    if (!content) { detailMessage("내용을 입력해 주세요.", true); return; }
    setBusy(true);
    detailMessage("");
    try {
      let options = { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) };
      if (replacementPhotos.length) {
        const body = new FormData();
        body.append("metadata", JSON.stringify({ content }));
        replacementPhotos.forEach((file) => body.append("images", file, file.name));
        options = { method: "PATCH", body };
      }
      const saved = await mutate(selectedId, options);
      if (disposed) return;
      items = items.map((item) => item.id === saved.id ? saved : item);
      openReceipt(saved);
      detailMessage("저장했습니다.");
      await load();
    } catch (error) {
      if (!disposed) detailMessage(error.message || "저장하지 못했습니다. 다시 시도해 주세요.", true);
    } finally {
      if (!disposed) {
        setBusy(false);
        if (!editing && dialog.open) detail.querySelector("[data-edit]")?.focus();
      }
    }
  });

  rows.addEventListener("click", (event) => {
    if (event.target.closest(".receipt-download")) return;
    const row = event.target.closest("[data-receipt-id]");
    const receipt = row && items.find((item) => item.id === row.dataset.receiptId);
    if (!receipt || disposed || busy || loading) return;
    if (event.target.closest(".receipt-move")) { openMove(receipt); return; }
    row.querySelector("button").focus({ preventScroll: true });
    openReceipt(receipt);
  });
  find("[data-close]").addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    clearReplacement();
    editing = false;
    document.body.classList.remove("receipts-modal-open");
    detail.textContent = "";
    if (!disposed) focusReceipt(selectedId);
    selectedId = null;
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  function outsideDialog(event) {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  let backdropPressed = false;
  dialog.addEventListener("pointerdown", (event) => { backdropPressed = event.target === dialog && outsideDialog(event); });
  dialog.addEventListener("click", (event) => {
    if (!busy && backdropPressed && event.target === dialog && outsideDialog(event)) dialog.close();
    backdropPressed = false;
  });

  function buttons() {
    prev.disabled = busy || loading || offset === 0;
    next.disabled = busy || loading || offset + pageSize >= total;
    refresh.disabled = busy || loading;
    find("[data-create-folder]").disabled = busy || loading;
    find("[data-folder-back]").disabled = busy || loading;
    folderState.disabled = busy || loading;
    find("[data-move-close]").disabled = busy;
    moveList.querySelectorAll("[data-target-folder]").forEach((button) => { button.disabled = busy || moveLoading || button.dataset.available !== "true"; });
    folderGrid.querySelectorAll("button").forEach((button) => { button.disabled = busy || loading; });
  }

  async function load() {
    if (loading || disposed) return;
    loading = true;
    buttons();
    try {
      const folderResponse = await fetch("/api/receipts/folders", { signal: abort.signal, cache: "no-store" });
      if (!folderResponse.ok) throw new Error("폴더를 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요.");
      const folderData = await folderResponse.json();
      if (disposed) return;
      folders = folderData.items;
      activeFolder = folders.find((folder) => folder.id === folderId) || null;
      if (folderId && !activeFolder) throw new Error("폴더를 찾을 수 없습니다. 폴더 목록에서 다시 선택해 주세요.");
      find(".receipts-heading").classList.toggle("is-folder-view", !!activeFolder);
      find(".receipts-heading").classList.toggle("is-completed", activeFolder?.status === "completed");
      find("[data-folder-path]").hidden = !folderId;
      find("[data-folder-path-name]").textContent = activeFolder?.name || "";
      ["[data-folder-symbol]", "[data-folder-eyebrow]", "[data-folder-count-label]", "[data-folder-current-state]"].forEach((selector) => { find(selector).hidden = !activeFolder; });
      find("[data-folder-current-state]").textContent = activeFolder?.can_upload ? "진행" : "완료";
      find("[data-folder-back]").hidden = !folderId;
      find("[data-heading]").textContent = activeFolder ? activeFolder.name : "영수증 폴더";
      find("[data-create-folder]").hidden = !!folderId;
      find("[data-folder-state-label]").hidden = !activeFolder;
      if (activeFolder) folderState.value = activeFolder.status || "in_progress";
      find("[data-description]").textContent = activeFolder
        ? activeFolder.can_upload ? "이 폴더에 사진과 PDF 영수증을 등록하세요." : "완료된 폴더입니다. 새 영수증 등록과 이 폴더로의 이동이 제한됩니다."
        : "용도별로 폴더를 만들고, 폴더 안에서 영수증을 등록하세요.";
      const upload = find("[data-upload]");
      upload.hidden = !activeFolder?.can_upload;
      upload.href = activeFolder?.can_upload ? `/receipt-upload?folder_id=${encodeURIComponent(folderId)}` : "/receipt-upload";
      folderGrid.hidden = !!folderId;
      find("[data-folder-back]").hidden = !folderId;
      if (!folderId) {
        items = [];
        total = 0;
        tableWrap.hidden = true;
        find(".receipts-pagination").hidden = true;
        find(".receipts-count").textContent = `${folders.length}개`;
        const html = folders.map((folder) => `<button class="receipt-folder-card" type="button" data-folder-id="${escape(folder.id)}"><svg class="icon" aria-hidden="true"><use href="/static/icons.svg#folder" /></svg><strong>${escape(folder.name)}</strong><span>영수증 ${folder.receipt_count}건 <span class="receipt-folder-badge${folder.can_upload ? "" : " is-completed"}">${folder.can_upload ? "진행" : "완료"}</span></span></button>`).join("");
        if (folderGrid.innerHTML !== html) folderGrid.innerHTML = html;
        status.textContent = "아직 폴더가 없습니다. ‘폴더 만들기’로 첫 폴더를 만들어 주세요.";
        status.hidden = folders.length > 0;
        status.classList.remove("error");
        return;
      }
      const response = await fetch(`/api/receipts?offset=${offset}&limit=${pageSize}&folder_id=${encodeURIComponent(folderId)}`, { signal: abort.signal, cache: "no-store" });
      if (!response.ok) throw new Error("영수증을 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요.");
      const data = await response.json();
      if (disposed) return;
      total = data.total;
      if (offset > 0 && offset >= total) {
        offset = Math.max(0, Math.ceil(total / pageSize) - 1) * pageSize;
        loading = false;
        return await load();
      }
      const key = JSON.stringify(data);
      if (key !== lastResult) {
        const focusedRow = document.activeElement?.closest("[data-receipt-id]");
        const focusedId = rows.contains(focusedRow) ? focusedRow.dataset.receiptId : null;
        const focusedAction = document.activeElement?.closest(".receipt-download") ? ".receipt-download" : ".receipt-open";
        lastResult = key;
        items = data.items;
        find(".receipts-count").textContent = `${total}건`;
        rows.innerHTML = items.map((receipt) => `
          <tr class="receipt-row" data-receipt-id="${escape(receipt.id)}">
            <td><span class="receipt-thumbnail">${thumbnail(receiptPhotos(receipt)[0], imageUrl(receipt), 'loading="lazy"')}</span><span class="receipt-photo-count">${receiptPhotos(receipt).length}개</span></td>
            <td class="receipt-registrant">${escape(receipt.registrant)}</td>
            <td class="receipt-date"><time datetime="${escape(receipt.created_at)}">${escape(formatDate(receipt.created_at))}</time></td>
            <td><span class="receipt-summary">${escape(receipt.content) || "—"}</span></td>
            <td><div class="receipt-row-actions">${receiptPhotos(receipt).length === 1
              ? `<a class="button-link secondary receipt-download" href="${escape(receipt.image_url)}?download=true" download="${escape(receipt.filename)}" aria-label="${escape(receipt.registrant)}님의 ${escape(formatDate(receipt.created_at))} 영수증 다운로드">다운로드</a>`
              : `<button class="secondary receipt-gallery-open" type="button" aria-haspopup="dialog" aria-controls="receipt-detail" aria-label="첨부 파일 ${receiptPhotos(receipt).length}개 개별 다운로드">다운로드</button>`}
              <button class="secondary receipt-open" type="button" aria-haspopup="dialog" aria-controls="receipt-detail" aria-label="${escape(receipt.registrant)}님의 ${escape(formatDate(receipt.created_at))} 영수증 상세 보기">보기</button><button class="secondary receipt-move" type="button" aria-haspopup="dialog" aria-label="${escape(receipt.content)} 영수증 이동">이동</button></div></td>
          </tr>`).join("");
        tableWrap.hidden = items.length === 0;
        if (focusedId && !dialog.open) focusReceipt(focusedId, focusedAction);
        find(".receipts-pagination").hidden = total <= pageSize;
        find("[data-page]").textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
      }
      status.textContent = total ? "" : activeFolder.can_upload ? "이 폴더에 등록된 영수증이 없습니다. ‘영수증 등록’에서 첫 영수증을 올려 주세요." : "등록된 영수증이 없는 완료 폴더입니다.";
      status.hidden = total > 0;
      status.classList.remove("error");
    } catch (error) {
      if (disposed || error.name === "AbortError") return;
      find("[data-folder-path]").hidden = !folderId;
      find("[data-folder-back]").hidden = !folderId;
      find("[data-upload]").hidden = true;
      status.textContent = error.message || "서버 연결을 확인한 뒤 다시 시도해 주세요.";
      status.hidden = false;
      status.classList.add("error");
    } finally {
      loading = false;
      if (!disposed) buttons();
    }
  }

  refresh.addEventListener("click", () => { offset = 0; load(); });
  prev.addEventListener("click", () => { offset = Math.max(0, offset - pageSize); load(); });
  next.addEventListener("click", () => { offset += pageSize; load(); });
  load();
  const timer = setInterval(() => { if (!busy && !document.hidden && !dialog.open && !folderDialog.open && !moveDialog.open && offset === 0) load(); }, 10000);
  return () => {
    disposed = true;
    clearInterval(timer);
    abort.abort();
    clearReplacement();
    if (dialog.open) dialog.close();
    if (folderDialog.open) folderDialog.close();
    if (moveDialog.open) moveDialog.close();
    document.body.classList.remove("receipts-modal-open");
    items = [];
  };
}
