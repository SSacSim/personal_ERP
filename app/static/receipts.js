const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatDate = (value) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

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
      <p class="receipts-hint">영수증을 누르면 사진과 상세 정보를 볼 수 있습니다. 최신 목록은 10초마다 갱신됩니다.</p>
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

  function openReceipt(receipt) {
    selectedId = receipt.id;
    detail.innerHTML = `
      <figure class="receipt-detail-photo"><img src="${escape(receipt.image_url)}" alt="${escape(receipt.registrant)}님의 영수증 사진" /></figure>
      <div class="receipt-detail-info">
        <dl>
          <div><dt>등록자</dt><dd>${escape(receipt.registrant)}</dd></div>
          <div><dt>등록 일시</dt><dd><time datetime="${escape(receipt.created_at)}">${escape(formatDate(receipt.created_at))}</time></dd></div>
          <div><dt>내용</dt><dd class="receipt-detail-content">${escape(receipt.content) || "—"}</dd></div>
          <div><dt>첨부 파일</dt><dd class="receipt-detail-filename">${escape(receipt.filename)}</dd></div>
        </dl>
        <a class="button-link secondary" href="${escape(receipt.image_url)}" target="_blank" rel="noopener noreferrer">원본 사진 보기 ↗</a>
      </div>`;
    dialog.showModal();
    document.body.classList.add("receipts-modal-open");
  }

  rows.addEventListener("click", (event) => {
    if (event.target.closest(".receipt-download")) return;
    const row = event.target.closest("[data-receipt-id]");
    const receipt = row && items.find((item) => item.id === row.dataset.receiptId);
    if (!receipt || disposed) return;
    row.querySelector("button").focus({ preventScroll: true });
    openReceipt(receipt);
  });
  find("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
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
    if (backdropPressed && event.target === dialog && outsideDialog(event)) dialog.close();
    backdropPressed = false;
  });

  function buttons() {
    prev.disabled = loading || offset === 0;
    next.disabled = loading || offset + pageSize >= total;
    refresh.disabled = loading;
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
            <td><img class="receipt-thumbnail" src="${escape(receipt.image_url)}" alt="" loading="lazy" /></td>
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
    if (dialog.open) dialog.close();
    document.body.classList.remove("receipts-modal-open");
    items = [];
  };
}
