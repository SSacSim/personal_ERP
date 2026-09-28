import { currentUser } from "./auth-state.js";
import { canChangeMessage, mergeChatMessages, EDIT_WINDOW_MS, formatChatName } from "./team-chat-state.js?v=20260928-account-profile";
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_TEXT = 4000;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/static/icons.svg#${name}" /></svg>`;
const initials = (name) => Array.from(name || "?").slice(0, 2).join("");
const fileSize = (size) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${Math.ceil(size / 1024)} KB` : `${size} B`;
const timeLabel = (value) => new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const dateLabel = (value) => new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(new Date(value));
const dayKey = (value) => new Date(value).toLocaleDateString("en-CA");

// getRandomValues also supports a workspace served over a local network's HTTP address.
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mountTeamChat(container) {
  const abort = new AbortController();
  let disposed = false;
  let session = null;
  let messages = [];
  let participants = [];
  let sharedFiles = [];
  let filesNeedRefresh = true;
  let filesLoading = false;
  let pendingFiles = [];
  let timer = null;
  let polling = false;
  let sending = false;
  let hasOlder = false;
  let loadingOlder = false;
  let clientId = newId();
  let serverCursor = 0;
  let changeCursor = 0;
  let serverClockOffset = 0;
  let contextTimer = null;
  let historyLoaded = false;
  let dragDepth = 0;
  let ready = false;

  const find = (selector) => container.querySelector(selector);
  async function request(path, options = {}) {
    const { json, raw, ...config } = options;
    const headers = new Headers(config.headers);
    if (json !== undefined) {
      headers.set("Content-Type", "application/json");
      config.body = JSON.stringify(json);
    }
    const response = await fetch(`/api/team-chat${path}`, { ...config, headers, signal: abort.signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(typeof data.detail === "string" ? data.detail : "요청을 처리하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.");
      error.status = response.status;
      throw error;
    }
    return raw ? response : response.json();
  }

  function notice(message = "") {
    if (disposed) return;
    const target = find(".tc-notice");
    if (target) {
      target.textContent = message;
      target.hidden = !message;
    }
  }

  function connection(online) {
    const target = find(".tc-connection");
    if (!target) return;
    target.classList.toggle("is-offline", !online);
    target.textContent = online ? "연결됨" : "연결 재시도 중";
    find(".tc-presence-label").textContent = online ? "현재 참여 중" : "마지막 확인한 참여자";
  }

  function showConnectionError(message = "") {
    ready = false;
    clearTimeout(timer);
    container.innerHTML = `
      <section class="panel tc-loading">
        <h2>팀 라운지</h2>
        <p>${escape(formatChatName(currentUser().name, currentUser().job_title))} 계정으로 연결합니다.</p>
        <p class="tc-notice" role="alert" ${message ? "" : "hidden"}>${escape(message)}</p>
        <button type="button">다시 연결</button>
      </section>`;
    find("button").addEventListener("click", initialize);
  }

  function showRoom() {
    ready = true;
    container.innerHTML = `
      <section class="tc-room panel" aria-label="팀 라운지">
        <header class="tc-room-head">
          <div class="tc-channel"><span class="tc-channel-icon">${icon("hash")}</span><div><h2>팀 라운지</h2><p>우리 팀의 열린 대화 공간</p></div></div>
          <div class="tc-self"><span class="tc-avatar tc-self-avatar">${escape(initials(session.participant.name))}</span><div><strong class="tc-self-name" title="${escape(formatChatName(session.participant.name, session.participant.job_title))}">${escape(formatChatName(session.participant.name, session.participant.job_title))}</strong></div></div>
        </header>
        <div class="tc-room-body">
          <div class="tc-conversation">
            <div class="tc-conversation-meta"><span class="tc-connection is-offline" role="status">연결 중</span><span class="tc-member-count"></span></div>
            <div class="tc-scroll" tabindex="0" aria-label="대화 기록">
              <div class="tc-history-control"><button class="secondary tc-load-older" type="button" hidden>이전 대화 보기</button></div>
              <div class="tc-messages" role="log" aria-label="메시지" aria-live="polite" aria-relevant="additions"></div>
              <div class="tc-welcome"><span>${icon("chat")}</span><h3>팀 라운지에 오신 것을 환영해요</h3><p>첫 인사와 함께 대화를 시작해 보세요.</p></div>
            </div>
            <button class="tc-new-messages secondary" type="button" hidden>새 메시지 보기 ↓</button>
            <div class="tc-notice" role="alert" hidden></div>
            <form class="tc-compose" aria-label="메시지 작성">
              <div class="tc-attachments" aria-label="첨부할 파일" hidden></div>
              <textarea name="message" rows="2" maxlength="${MAX_TEXT}" placeholder="팀원들에게 메시지를 남겨보세요…" aria-label="메시지"></textarea>
              <div class="tc-compose-bottom"><div><button class="tc-attach-button secondary" type="button" aria-label="파일 첨부">${icon("clip")}<span>파일 첨부</span></button><span class="tc-compose-hint">Enter 전송 · Shift + Enter 줄바꿈</span></div><button class="tc-send" type="submit" disabled>${icon("send")}<span>보내기</span></button></div>
              <input class="tc-file-input" type="file" multiple hidden aria-label="공유할 파일 선택" />
              <div class="tc-drop-hint" hidden>${icon("clip")} 여기에 파일을 놓아 첨부하세요</div>
            </form>
            <div class="tc-upload-hint">파일당 20MB · 최대 5개 · 내 메시지는 2분 이내 우클릭으로 수정·삭제</div>
          </div>
          <aside class="tc-sidebar" aria-label="참여자와 공유 파일">
            <section><h3><span class="tc-presence-label">현재 참여 중</span><span class="tc-presence-count"></span></h3><div class="tc-participants"></div></section>
            <section class="tc-shared-section"><h3>최근 공유 파일 ${icon("clip")}</h3><div class="tc-shared-files"></div></section>
            <p class="tc-room-note">함께 나눈 대화와 파일은<br>이 공간에 계속 남아 있어요.</p>
          </aside>
        </div>
      </section>`;
    find(".tc-messages").addEventListener("contextmenu", showMessageMenu);
    find(".tc-messages").addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) showMessageMenu(event);
    });
    find(".tc-scroll").addEventListener("scroll", closeMessageMenu);
    find(".tc-compose").addEventListener("submit", (event) => { event.preventDefault(); send(); });
    find(".tc-compose textarea").addEventListener("input", () => { clientId = newId(); updateSend(); });
    find(".tc-compose textarea").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        send();
      }
    });
    find(".tc-attach-button").addEventListener("click", () => find(".tc-file-input").click());
    find(".tc-file-input").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
    find(".tc-load-older").addEventListener("click", loadOlder);
    find(".tc-new-messages").addEventListener("click", scrollToBottom);
    find(".tc-scroll").addEventListener("scroll", () => { if (nearBottom()) find(".tc-new-messages").hidden = true; });
    find(".tc-room").addEventListener("click", (event) => {
      const download = event.target.closest("[data-chat-download]");
      if (download) downloadFile(download);
      const remove = event.target.closest("[data-chat-remove]");
      if (remove && !sending) {
        const file = pendingFiles.find((item) => item.uploadId === remove.dataset.chatRemove);
        if (file?.uploaded) request(`/files/${file.uploaded.id}`, { method: "DELETE" }).catch(() => {});
        pendingFiles = pendingFiles.filter((item) => item !== file);
        clientId = newId();
        renderPending();
      }
    });
    const compose = find(".tc-compose");
    compose.addEventListener("dragenter", (event) => {
      if (!Array.from(event.dataTransfer.types).includes("Files") || sending) return;
      event.preventDefault();
      dragDepth++;
      find(".tc-drop-hint").hidden = false;
    });
    compose.addEventListener("dragover", (event) => { if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); });
    compose.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) find(".tc-drop-hint").hidden = true; });
    compose.addEventListener("drop", (event) => {
      event.preventDefault();
      dragDepth = 0;
      find(".tc-drop-hint").hidden = true;
      addFiles(event.dataTransfer.files);
    });
    renderFiles();
  }

  function nearBottom() {
    const scroller = find(".tc-scroll");
    return !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  }

  function scrollToBottom() {
    const scroller = find(".tc-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    if (find(".tc-new-messages")) find(".tc-new-messages").hidden = true;
  }

  function attachmentHtml(file, compact = false) {
    const extension = file.filename.includes(".") ? file.filename.split(".").pop().slice(0, 5).toUpperCase() : "FILE";
    return `<button class="tc-file ${compact ? "is-compact" : ""}" type="button" data-chat-download="${escape(file.id)}" data-filename="${escape(file.filename)}" aria-label="${escape(file.filename)} 다운로드"><span class="tc-file-extension">${escape(extension)}</span><span class="tc-file-info"><strong>${escape(file.filename)}</strong><small>${fileSize(file.size)}${compact ? ` · ${escape(formatChatName(file.sender_name, file.sender_job_title))}` : " · 다운로드"}</small></span>${icon("download")}</button>`;
  }

  function messageHtml(message) {
    const own = message.participant_id === session.participant.id;
    const senderName = formatChatName(message.sender_name, message.sender_job_title);
    return `<article class="tc-message ${own ? "is-own" : ""}" data-message-id="${message.id}" ${own && !message.deleted_at ? 'tabindex="0" aria-label="내 메시지. 전송 후 2분 이내 우클릭으로 수정 또는 삭제"' : ""}><span class="tc-avatar">${escape(initials(message.sender_name))}</span><div class="tc-message-content"><div class="tc-message-byline"><strong>${escape(senderName)}</strong>${own ? "<span>나</span>" : ""}<time datetime="${escape(message.created_at)}">${timeLabel(message.created_at)}</time>${message.edited_at && !message.deleted_at ? '<small class="tc-edited">수정됨</small>' : ""}</div>${message.deleted_at ? '<div class="tc-bubble tc-deleted">삭제된 메시지입니다.</div>' : `${message.text ? `<div class="tc-bubble">${escape(message.text)}</div>` : ""}${message.attachments.length ? `<div class="tc-message-files">${message.attachments.map((file) => attachmentHtml(file)).join("")}</div>` : ""}`}</div></article>`;
  }

  function mergeMessages(items, { older = false, forceBottom = false } = {}) {
    if (disposed || !ready) return;
    const scroller = find(".tc-scroll");
    const stick = nearBottom();
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    const known = new Set(messages.map((message) => message.id));
    const merged = mergeChatMessages(messages, items);
    const fresh = merged.filter((message) => !known.has(message.id));
    const updated = merged.some((message) => known.has(message.id) && message.revision > messages.find((previous) => previous.id === message.id).revision);
    const rebuild = older || updated || fresh.some((message) => message.id < (messages.at(-1)?.id || 0));
    messages = merged;
    if (fresh.length || updated) {
      const target = find(".tc-messages");
      let previousDay = rebuild ? "" : dayKey(messages.findLast((message) => known.has(message.id))?.created_at || 0);
      const entries = rebuild ? messages : fresh;
      let html = "";
      for (const message of entries) {
        const day = dayKey(message.created_at);
        if (day !== previousDay) html += `<div class="tc-date-divider"><span>${dateLabel(message.created_at)}</span></div>`;
        html += messageHtml(message);
        previousDay = day;
      }
      if (rebuild) target.innerHTML = html;
      else target.insertAdjacentHTML("beforeend", html);
    }
    find(".tc-welcome").hidden = messages.length > 0;
    find(".tc-load-older").hidden = !hasOlder;
    if (older) scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
    else if (stick || forceBottom) scrollToBottom();
    else if (fresh.length) find(".tc-new-messages").hidden = false;
    if (updated || fresh.some((message) => message.attachments.length)) refreshFiles();
    const menu = find(".tc-message-menu");
    if (menu && !canChangeMessage(messages.find((message) => message.id === Number(menu.dataset.messageId)), session.participant.id, Date.now() + serverClockOffset)) closeMessageMenu();
  }

  function renderParticipants(items) {
    if (JSON.stringify(items) === JSON.stringify(participants) && find(".tc-participants").children.length) return;
    participants = items;
    find(".tc-member-count").textContent = `${items.length}명 참여 중`;
    find(".tc-presence-count").textContent = items.length;
    find(".tc-participants").innerHTML = items.map((person) => `<div class="tc-person"><span class="tc-avatar">${escape(initials(person.name))}</span><span title="${escape(formatChatName(person.name, person.job_title))}">${escape(formatChatName(person.name, person.job_title))}${person.id === session.participant.id ? " <small>나</small>" : ""}</span><i aria-hidden="true"></i></div>`).join("");
  }

  function renderFiles() {
    if (disposed || !ready) return;
    find(".tc-shared-files").innerHTML = sharedFiles.length ? sharedFiles.map((file) => attachmentHtml(file, true)).join("") : `<p class="tc-sidebar-empty">아직 공유된 파일이 없어요.<br>파일을 첨부해 함께 나눠보세요.</p>`;
  }

  async function refreshFiles() {
    filesNeedRefresh = true;
    if (filesLoading) return;
    filesLoading = true;
    filesNeedRefresh = false;
    try {
      const data = await request("/files");
      if (disposed) return;
      sharedFiles = data.items;
      renderFiles();
    } catch { filesNeedRefresh = true; }
    finally { filesLoading = false; }
  }

  async function loadInitial() {
    try {
      const data = await request("/messages");
      if (disposed) return;
      hasOlder = data.has_more;
      serverCursor = data.items.at(-1)?.id || 0;
      changeCursor = data.change_cursor;
      serverClockOffset = Date.parse(data.server_time) - Date.now();
      historyLoaded = true;
      mergeMessages(data.items, { forceBottom: true });
      renderParticipants(data.participants);
      connection(true);
      refreshFiles();
      find(".tc-compose textarea").focus({ preventScroll: true });
    } catch (error) {
      if (disposed) return;
      if (error.status === 401) { session = null; showConnectionError(error.message); return; }
      connection(false);
      notice("대화를 불러오지 못했습니다. 연결되면 자동으로 다시 불러옵니다.");
    }
    schedulePoll();
  }

  function schedulePoll(delay = 2500) {
    clearTimeout(timer);
    if (!disposed && ready) timer = setTimeout(poll, delay);
  }

  async function poll() {
    if (disposed || !ready) return;
    if (polling || document.hidden) { schedulePoll(); return; }
    polling = true;
    let delay = 2500;
    try {
      const wasLoaded = historyLoaded;
      const data = await request(wasLoaded ? `/messages?after=${serverCursor}&since_change=${changeCursor}` : "/messages");
      if (disposed) return;
      if (!wasLoaded) { hasOlder = data.has_more; notice(); }
      serverCursor = Math.max(serverCursor, data.items.at(-1)?.id || 0);
      changeCursor = Math.max(changeCursor, data.change_cursor);
      serverClockOffset = Date.parse(data.server_time) - Date.now();
      historyLoaded = true;
      mergeMessages([...data.items, ...data.changes.filter((message) => messages.some((existing) => existing.id === message.id))]);
      if (!sending && data.items.some((item) => item.participant_id === session.participant.id && item.client_id === clientId)) {
        find(".tc-compose textarea").value = "";
        pendingFiles = [];
        clientId = newId();
        renderPending();
        notice();
      }
      renderParticipants(data.participants);
      connection(true);
      if (filesNeedRefresh) refreshFiles();
      if (wasLoaded && (data.has_more || data.has_more_changes)) delay = 50;
    } catch (error) {
      if (disposed) return;
      if (error.status === 401) { session = null; showConnectionError(error.message); return; }
      connection(false);
      delay = 5000;
    } finally {
      polling = false;
      schedulePoll(delay);
    }
  }

  async function loadOlder() {
    if (loadingOlder || !hasOlder || !messages.length) return;
    loadingOlder = true;
    find(".tc-load-older").disabled = true;
    try {
      const data = await request(`/messages?before=${messages[0].id}`);
      if (disposed) return;
      hasOlder = data.has_more;
      mergeMessages(data.items, { older: true });
    } catch (error) { if (!disposed) notice(error.message); }
    finally { loadingOlder = false; if (!disposed && find(".tc-load-older")) find(".tc-load-older").disabled = false; }
  }

  function addFiles(files) {
    if (sending) return;
    const errors = [];
    for (const file of files) {
      if (pendingFiles.length >= MAX_FILES) { errors.push("한 번에 최대 5개까지 첨부할 수 있습니다."); break; }
      if (file.size > MAX_FILE_SIZE) { errors.push(`${file.name}: 파일은 20MB까지 첨부할 수 있습니다.`); continue; }
      if (file.name.length > 240) { errors.push(`${file.name.slice(0, 25)}…: 파일 이름을 240자 이내로 줄여 주세요.`); continue; }
      pendingFiles.push({ file, uploadId: newId(), uploaded: null });
    }
    clientId = newId();
    notice(errors.join(" "));
    renderPending();
  }

  function renderPending() {
    const target = find(".tc-attachments");
    target.hidden = !pendingFiles.length;
    target.innerHTML = pendingFiles.map((item) => `<div class="tc-pending-file">${icon("clip")}<span><strong>${escape(item.file.name)}</strong><small>${fileSize(item.file.size)}</small></span><button type="button" data-chat-remove="${item.uploadId}" aria-label="${escape(item.file.name)} 첨부 취소" ${sending ? "disabled" : ""}>${icon("close")}</button></div>`).join("");
    updateSend();
  }

  function updateSend() {
    if (disposed || !ready) return;
    const textarea = find(".tc-compose textarea");
    find(".tc-send").disabled = sending || (!textarea.value.trim() && !pendingFiles.length);
    find(".tc-attach-button").disabled = sending || pendingFiles.length >= MAX_FILES;
    textarea.disabled = sending;
  }

  async function send() {
    if (disposed || !ready || sending) return;
    const textarea = find(".tc-compose textarea");
    const text = textarea.value.trim();
    if (!text && !pendingFiles.length) return;
    if (text.length > MAX_TEXT) { notice("메시지는 4,000자 이내로 입력해 주세요."); return; }
    sending = true;
    notice();
    renderPending();
    const sendLabel = find(".tc-send span");
    try {
      for (let index = 0; index < pendingFiles.length; index++) {
        const item = pendingFiles[index];
        if (item.uploaded) continue;
        sendLabel.textContent = `파일 ${index + 1}/${pendingFiles.length}`;
        const query = new URLSearchParams({ filename: item.file.name, upload_id: item.uploadId });
        item.uploaded = await request(`/files?${query}`, { method: "POST", body: item.file, headers: { "Content-Type": "application/octet-stream" } });
      }
      sendLabel.textContent = "전송 중…";
      const message = await request("/messages", { method: "POST", json: { text, attachment_ids: pendingFiles.map((item) => item.uploaded.id), client_id: clientId } });
      if (disposed) return;
      mergeMessages([message], { forceBottom: true });
      textarea.value = "";
      pendingFiles = [];
      clientId = newId();
      connection(true);
    } catch (error) {
      if (!disposed) notice(error.status === 401 ? "참여 정보가 만료되었습니다. 새로고침 후 다시 참여해 주세요." : `전송하지 못했습니다. ${error.message} 작성 내용은 유지됩니다.`);
    } finally {
      sending = false;
      if (!disposed && ready) {
        sendLabel.textContent = "보내기";
        renderPending();
        textarea.focus({ preventScroll: true });
      }
    }
  }

  async function downloadFile(button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await request(`/files/${encodeURIComponent(button.dataset.chatDownload)}/download`, { raw: true });
      const blob = await response.blob();
      if (disposed) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = button.dataset.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (!disposed) notice(`파일을 다운로드하지 못했습니다. ${error.message}`); }
    finally { button.disabled = false; }
  }

  function closeMessageMenu() {
    clearTimeout(contextTimer);
    find(".tc-message-menu")?.remove();
  }

  function showMessageMenu(event) {
    const target = event.target.closest("[data-message-id]");
    const message = messages.find((item) => item.id === Number(target?.dataset.messageId));
    closeMessageMenu();
    if (!canChangeMessage(message, session.participant.id, Date.now() + serverClockOffset)) return;
    event.preventDefault();
    const menu = document.createElement("div");
    menu.className = "tc-message-menu";
    menu.dataset.messageId = message.id;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "메시지 관리");
    menu.innerHTML = '<button type="button" role="menuitem" data-action="edit">수정</button><button type="button" role="menuitem" class="tc-delete-action" data-action="delete">삭제</button>';
    container.appendChild(menu);
    const rectangle = target.getBoundingClientRect();
    const x = event.type === "keydown" ? rectangle.left : event.clientX;
    const y = event.type === "keydown" ? rectangle.bottom : event.clientY;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.addEventListener("click", (click) => {
      const action = click.target.closest("[data-action]");
      if (!action) return;
      closeMessageMenu();
      showMessageDialog(message, action.dataset.action === "delete");
    });
    menu.addEventListener("keydown", (key) => {
      const buttons = [...menu.querySelectorAll("button")];
      if (["ArrowDown", "ArrowUp"].includes(key.key)) {
        key.preventDefault();
        buttons[(buttons.indexOf(document.activeElement) + 1) % buttons.length].focus();
      }
      if (key.key === "Tab") closeMessageMenu();
    });
    menu.querySelector("button").focus({ preventScroll: true });
    contextTimer = setTimeout(closeMessageMenu, Math.max(0, Date.parse(message.created_at) + EDIT_WINDOW_MS - Date.now() - serverClockOffset));
  }

  function showMessageDialog(message, deleting) {
    if (find(".tc-edit-dialog") || !canChangeMessage(message, session.participant.id, Date.now() + serverClockOffset)) return;
    const dialog = document.createElement("dialog");
    dialog.className = "tc-edit-dialog";
    dialog.setAttribute("aria-labelledby", "tc-edit-title");
    dialog.innerHTML = `<form><h2 id="tc-edit-title">메시지 ${deleting ? "삭제" : "수정"}</h2><p>${deleting ? "이 메시지를 삭제할까요? 첨부 파일도 채팅에서 사라집니다." : "전송 후 2분 이내에 저장해 주세요."}</p>${deleting ? "" : `<label>메시지<textarea name="text" rows="5" maxlength="${MAX_TEXT}" ${message.attachments.length ? "" : "required"}>${escape(message.text)}</textarea></label>`}<p class="tc-edit-error" role="alert"></p><div class="tc-edit-actions"><button class="secondary" type="button" data-cancel>취소</button><button type="submit" ${deleting ? 'class="tc-delete-confirm"' : ""}>${deleting ? "삭제" : "저장"}</button></div></form>`;
    container.appendChild(dialog);
    const button = dialog.querySelector('[type="submit"]');
    const expiry = setTimeout(() => {
      button.disabled = true;
      dialog.querySelector(".tc-edit-error").textContent = "전송 후 2분이 지나 수정하거나 삭제할 수 없습니다.";
    }, Math.max(0, Date.parse(message.created_at) + EDIT_WINDOW_MS - Date.now() - serverClockOffset));
    dialog.addEventListener("close", () => {
      clearTimeout(expiry);
      dialog.remove();
      find(`[data-message-id="${message.id}"]`)?.focus({ preventScroll: true });
    });
    dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        const data = await request(`/messages/${message.id}`, deleting ? { method: "DELETE" } : { method: "PATCH", json: { text: event.currentTarget.elements.text.value.trim() } });
        if (disposed) return;
        mergeMessages([data]);
        dialog.close();
      } catch (error) { if (!disposed) dialog.querySelector(".tc-edit-error").textContent = error.message; }
      finally { button.disabled = !canChangeMessage(message, session.participant.id, Date.now() + serverClockOffset); }
    });
    dialog.showModal();
    dialog.querySelector(deleting ? "[data-cancel]" : "textarea").focus();
  }

  function onOutsidePointer(event) { if (!event.target.closest(".tc-message-menu")) closeMessageMenu(); }
  function onEscape(event) { if (event.key === "Escape") closeMessageMenu(); }
  document.addEventListener("pointerdown", onOutsidePointer);
  document.addEventListener("keydown", onEscape);
  window.addEventListener("resize", closeMessageMenu);

  function onVisibility() { if (!document.hidden && ready) poll(); }
  document.addEventListener("visibilitychange", onVisibility);

  async function initialize() {
    container.innerHTML = `<section class="panel tc-loading" role="status">채팅방에 연결하고 있어요…</section>`;
    try {
      const data = await request("/session");
      if (disposed) return;
      session = { participant: data.participant };
      showRoom();
      await loadInitial();
    } catch (error) {
      if (disposed) return;
      if (error.status === 401) { session = null; showConnectionError(error.message); }
      else {
        container.innerHTML = `<section class="panel tc-loading"><p>채팅방에 연결하지 못했습니다.</p><button type="button">다시 연결</button></section>`;
        find("button").addEventListener("click", initialize);
      }
    }
  }
  initialize();
  return () => {
    disposed = true;
    clearTimeout(timer);
    abort.abort();
    closeMessageMenu();
    find(".tc-edit-dialog")?.close();
    document.removeEventListener("pointerdown", onOutsidePointer);
    document.removeEventListener("keydown", onEscape);
    window.removeEventListener("resize", closeMessageMenu);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
