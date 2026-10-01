const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatDate = (value) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const imageUrl = (receipt) => receipt.image_url + (receipt.updated_at ? `?v=${encodeURIComponent(receipt.updated_at)}` : "");

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
  let replacementPhoto = null;
  let previewUrl = null;
  let photoReady = true;

  container.innerHTML = `
    <section class="receipts-page">
      <div class="receipts-heading">
        <div><h2>등록된 영수증 <span class="receipts-count">0건</span></h2><p>영수증 사진과 등록 내용을 한곳에서 확인하세요.</p></div>
        <div class="receipts-actions"><button class="secondary" type="button" data-refresh>새로고침</button><a class="button-link" href="/receipt-upload">+ 영수증 등록</a></div>
      </div>
      <p class="receipts-status" role="status" aria-live="polite">영수증을 불러오는 중입니다.</p>
      <div class="receipts-table-wrap" hidden>
        <table class="receipts-table">
          <caption class="receipts-sr-only">등록된 영수증 목록. 행 또는 상세 보기 버튼을 누르면 영수증 정보를 확인할 수 있습니다.</caption>
          <thead><tr><th scope="col">사진</th><th scope="col">등록자</th><th scope="col">등록 일시</th><th scope="col">내용</th><th scope="col">상세</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="receipts-pagination" hidden><button class="secondary" data-prev type="button">이전</button><span data-page></span><button class="secondary" data-next type="button">다음</button></div>
      <p class="receipts-hint">영수증을 누르면 상세 조회·수정·삭제할 수 있습니다. 최신 목록은 10초마다 갱신됩니다.</p>
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

  function focusReceipt(receiptId, selector = ".receipt-open") {
    const row = [...rows.querySelectorAll("[data-receipt-id]")].find((row) => row.dataset.receiptId === receiptId);
    (row?.querySelector(selector) || refresh).focus({ preventScroll: true });
  }

  function clearReplacement() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    replacementPhoto = null;
    photoReady = true;
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
      <figure class="receipt-detail-photo"><img src="${escape(imageUrl(receipt))}" alt="${escape(receipt.registrant)}님의 영수증 사진" /></figure>
      <div class="receipt-detail-info">
        <dl>
          <div><dt>등록자</dt><dd>${escape(receipt.registrant)}</dd></div>
          <div><dt>등록 일시</dt><dd><time datetime="${escape(receipt.created_at)}">${escape(formatDate(receipt.created_at))}</time></dd></div>
          ${edit ? "" : `<div><dt>내용</dt><dd class="receipt-detail-content">${escape(receipt.content) || "—"}</dd></div>`}
          <div><dt>첨부 파일</dt><dd class="receipt-detail-filename">${escape(receipt.filename)}</dd></div>
        </dl>
        ${edit ? `<form data-edit-form class="receipt-edit-form">
          <fieldset>
            <label for="receipt-content">내용</label>
            <textarea id="receipt-content" name="content" rows="6" maxlength="4000" required>${escape(receipt.content)}</textarea>
            <label for="receipt-photo">사진 교체</label>
            <input id="receipt-photo" name="photo" type="file" accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif" aria-describedby="receipt-photo-hint" />
            <p id="receipt-photo-hint" class="receipts-hint">새 사진을 선택하면 기존 사진을 교체합니다. JPG, PNG, WEBP, GIF · 10MB 이하</p>
            <div class="receipt-detail-actions"><button type="submit" data-save>변경사항 저장</button><button class="secondary" type="button" data-cancel-edit>취소</button></div>
          </fieldset>
        </form>` : `<div class="receipt-detail-actions">
          <a class="button-link secondary" href="${escape(receipt.image_url)}" target="_blank" rel="noopener noreferrer">원본 사진 보기 ↗</a>
          <button type="button" data-edit>수정</button><button class="danger-button" type="button" data-delete>삭제</button>
        </div>`}
        <p class="receipt-detail-notice" data-detail-notice role="status" aria-live="polite" hidden></p>
      </div>`;
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("receipts-modal-open");
    setBusy(busy);
    if (edit) detail.querySelector("textarea").focus();
  }

  async function mutate(receiptId, options) {
    const response = await fetch(`/api/receipts/${encodeURIComponent(receiptId)}`, { ...options, signal: abort.signal });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return data;
  }

  detail.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    const receipt = items.find((item) => item.id === selectedId);
    if (!button || !receipt || busy || disposed) return;
    if (button.hasAttribute("data-edit")) { openReceipt(receipt, true); return; }
    if (button.hasAttribute("data-cancel-edit")) { openReceipt(receipt); detail.querySelector("[data-edit]").focus(); return; }
    if (!button.hasAttribute("data-delete") || !window.confirm(`${receipt.registrant}님의 ${formatDate(receipt.created_at)} 영수증을 삭제하시겠습니까?\n사진과 등록 내용이 함께 삭제되며 되돌릴 수 없습니다.`)) return;
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
    const file = event.target.files[0];
    clearReplacement();
    const receipt = items.find((item) => item.id === selectedId);
    const photo = detail.querySelector(".receipt-detail-photo img");
    photo.src = imageUrl(receipt);
    detailMessage("");
    if (!file) { setBusy(false); return; }
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024 || file.name.length > 255) {
      event.target.value = "";
      detailMessage("파일 이름 255자 이내, 10MB 이하의 JPG, PNG, WEBP, GIF 사진을 선택해 주세요.", true);
      setBusy(false);
      return;
    }
    replacementPhoto = file;
    photoReady = false;
    const url = previewUrl = URL.createObjectURL(file);
    photo.src = url;
    setBusy(false);
    try {
      await photo.decode();
      if (disposed || previewUrl !== url) return;
      photoReady = true;
      detailMessage(`${file.name}: 저장하면 이 사진으로 교체됩니다.`);
    } catch {
      if (disposed || previewUrl !== url) return;
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
      const payload = { content };
      if (replacementPhoto) {
        payload.filename = replacementPhoto.name;
        payload.image_base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
          reader.onerror = reader.onabort = () => reject(new Error("사진을 읽지 못했습니다. 다시 선택해 주세요."));
          reader.readAsDataURL(replacementPhoto);
        });
      }
      const saved = await mutate(selectedId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
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
  }

  async function load() {
    if (loading || disposed) return;
    loading = true;
    buttons();
    try {
      const response = await fetch(`/api/receipts?offset=${offset}&limit=${pageSize}`, { signal: abort.signal, cache: "no-store" });
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
            <td><img class="receipt-thumbnail" src="${escape(imageUrl(receipt))}" alt="" loading="lazy" /></td>
            <td class="receipt-registrant">${escape(receipt.registrant)}</td>
            <td class="receipt-date"><time datetime="${escape(receipt.created_at)}">${escape(formatDate(receipt.created_at))}</time></td>
            <td><span class="receipt-summary">${escape(receipt.content) || "—"}</span></td>
            <td><div class="receipt-row-actions"><a class="button-link secondary receipt-download" href="${escape(receipt.image_url)}?download=true" download="${escape(receipt.filename)}" aria-label="${escape(receipt.registrant)}님의 ${escape(formatDate(receipt.created_at))} 영수증 다운로드">다운로드</a><button class="secondary receipt-open" type="button" aria-haspopup="dialog" aria-controls="receipt-detail" aria-label="${escape(receipt.registrant)}님의 ${escape(formatDate(receipt.created_at))} 영수증 상세 보기">보기</button></div></td>
          </tr>`).join("");
        tableWrap.hidden = items.length === 0;
        if (focusedId && !dialog.open) focusReceipt(focusedId, focusedAction);
        find(".receipts-pagination").hidden = total <= pageSize;
        find("[data-page]").textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
      }
      status.textContent = total ? "" : "아직 등록된 영수증이 없습니다. ‘영수증 등록’에서 첫 영수증을 올려 주세요.";
      status.hidden = total > 0;
      status.classList.remove("error");
    } catch (error) {
      if (disposed || error.name === "AbortError") return;
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
  const timer = setInterval(() => { if (!document.hidden && !dialog.open && offset === 0) load(); }, 10000);
  return () => {
    disposed = true;
    clearInterval(timer);
    abort.abort();
    clearReplacement();
    if (dialog.open) dialog.close();
    document.body.classList.remove("receipts-modal-open");
    items = [];
  };
}
