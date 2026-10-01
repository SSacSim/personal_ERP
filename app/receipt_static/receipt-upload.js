import { submitReceiptBatch } from "./receipt-batch.js?v=20261001-group";
import { requireSession, setupAccountBar } from "/static/auth-state.js";
import { clipboardImage, pastedImages } from "/static/remote-work-inputs.js";

const loggedInUser = await requireSession();
setupAccountBar();

const form = document.querySelector("#receipt-form");
const fields = document.querySelector("#receipt-fields");
const imageInput = document.querySelector("#image");
const registrant = document.querySelector("#registrant");
const content = document.querySelector("#content");
const preview = document.querySelector("#preview");
const notice = document.querySelector("#notice");
const submitButton = document.querySelector("#submit-button");
const newButton = document.querySelector("#new-receipt");
const selectionCount = document.querySelector("#selection-count");
const retryHint = document.querySelector("#retry-hint");
const progressArea = document.querySelector("#upload-progress");
const progress = document.querySelector("#batch-progress");
const progressLabel = document.querySelector("#progress-label");
const maxPhotos = 20;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let entries = [];
let sending = false;
let submission = { id: newId() };

// Works on a phone opening the server's LAN address over HTTP, too.
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function message(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle("error", error);
  notice.hidden = !text;
}

function clearPreview() {
  entries.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
  entries = [];
  preview.textContent = "";
  preview.hidden = true;
  selectionCount.textContent = "선택한 사진 0장";
}

function updateControls() {
  const started = !!submission.details;
  fields.disabled = sending;
  imageInput.disabled = started;
  registrant.readOnly = true;
  content.readOnly = started;
  retryHint.hidden = !started || sending;
  submitButton.disabled = sending || !entries.length || entries.some((entry) => entry.invalid);
  submitButton.textContent = sending ? "등록 중…" : started ? "영수증 다시 등록하기" : entries.length ? `사진 ${entries.length}장으로 영수증 1건 등록하기` : "영수증 등록하기";
  newButton.disabled = sending;
}

function selectionState(entry) {
  return entry.status === "saved" ? "등록 완료"
    : entry.invalid ? "사진을 열 수 없습니다. 목록에서 제외한 뒤 다른 사진을 선택해 주세요."
      : entry.status === "sending" ? "등록 중…" : entry.status === "error" ? entry.error : "등록 대기";
}

function updateSelections() {
  selectionCount.textContent = `선택한 사진 ${entries.length}장 · 영수증 1건으로 등록`;
  for (const entry of entries) {
    const card = preview.querySelector(`[data-entry-id="${entry.id}"]`);
    if (!card) continue;
    card.dataset.status = entry.status;
    card.querySelector(".preview-state").textContent = selectionState(entry);
    const remove = card.querySelector("[data-remove]");
    if (remove) remove.hidden = !!submission.details;
  }
  updateControls();
}

function renderSelections() {
  preview.hidden = !entries.length;
  preview.innerHTML = entries.map((entry) => {
    return `<div class="preview-card${entry.invalid ? " is-invalid" : ""}" data-entry-id="${entry.id}" data-status="${entry.status}">
      <img src="${escape(entry.previewUrl)}" alt="${escape(entry.file.name)} 미리보기" loading="lazy" />
      <p class="preview-filename" title="${escape(entry.file.name)}">${escape(entry.file.name)}</p>
      <p class="preview-size">${Math.max(1, Math.ceil(entry.file.size / 1024)).toLocaleString("ko-KR")} KB</p>
      <p class="preview-state">${escape(selectionState(entry))}</p>
      ${entry.status === "saved" ? "" : `<button class="remove-photo" type="button" data-remove="${entry.id}" aria-label="${escape(entry.file.name)} 목록에서 제외">제외</button>`}
    </div>`;
  }).join("");
  updateSelections();
}

function finishBatch(count) {
  message(`사진 ${count}장이 포함된 영수증 1건이 등록되었습니다.\nERP의 ‘영수증’ 탭에서 사진별로 보거나 다운로드할 수 있습니다.`);
  form.hidden = true;
  newButton.hidden = false;
  progressArea.hidden = true;
  clearPreview();
}

registrant.value = loggedInUser.name;

imageInput.addEventListener("change", () => {
  const files = [...imageInput.files];
  imageInput.value = "";
  addPhotos(files);
});
form.addEventListener("paste", (event) => {
  const images = pastedImages(event.clipboardData);
  if (!images.length) return;
  event.preventDefault();
  try {
    addPhotos(images.map((image) => clipboardImage(image)));
  } catch (error) {
    message(error.message, true);
  }
});

function addPhotos(files) {
  if (sending || submission.details || !files.length) return;
  const errors = [];
  for (const file of files) {
    // Browsers may report JPEGs as image/jpg or application/octet-stream.
    // Check the extension here; preview decoding and the server check the image bytes.
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name) || file.size === 0 || file.size > 10 * 1024 * 1024) {
      errors.push(`${file.name}: 10MB 이하의 JPG, PNG, WEBP, GIF 사진을 선택해 주세요.`);
      continue;
    }
    if (file.name.length > 255) { errors.push(`${file.name}: 파일 이름을 255자 이내로 줄여 주세요.`); continue; }
    if (entries.some((entry) => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified)) {
      errors.push(`${file.name}: 이미 선택한 사진입니다.`);
      continue;
    }
    if (entries.length >= maxPhotos) { errors.push(`한 번에 최대 ${maxPhotos}장까지 선택할 수 있습니다.`); break; }
    entries.push({ id: newId(), file, previewUrl: URL.createObjectURL(file), status: "ready", invalid: false, error: "" });
  }
  renderSelections();
  message(errors.join("\n"), errors.length > 0);
}
preview.addEventListener("error", (event) => {
  if (event.target.tagName !== "IMG") return;
  const card = event.target.closest("[data-entry-id]");
  const entry = entries.find((entry) => entry.id === card?.dataset.entryId);
  if (!entry || entry.status === "saved") return;
  entry.invalid = true;
  card.classList.add("is-invalid");
  card.querySelector(".preview-state").textContent = "사진을 열 수 없습니다. 목록에서 제외한 뒤 다른 사진을 선택해 주세요.";
  updateControls();
}, true);
preview.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button || sending || submission.details) return;
  const entry = entries.find((entry) => entry.id === button.dataset.remove);
  if (!entry || entry.status === "saved") return;
  URL.revokeObjectURL(entry.previewUrl);
  entries = entries.filter((item) => item !== entry);
  renderSelections();
  message("");
  (preview.querySelector("[data-remove]") || (imageInput.disabled ? newButton : imageInput)).focus();
});

async function uploadReceipt(body) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 300000);
  try {
    const response = await fetch("/api/receipts", {
      method: "POST",
      signal: abort.signal,
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "등록하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending || !form.reportValidity()) return;
  const name = registrant.value.trim();
  const text = content.value.trim();
  if (!name || !text || !entries.length) { message("사진, 등록자, 내용을 모두 입력해 주세요.", true); return; }
  if (entries.some((entry) => entry.invalid)) { message("열 수 없는 사진을 목록에서 제외한 뒤 등록해 주세요.", true); return; }
  sending = true;
  newButton.hidden = true;
  progressArea.hidden = false;
  progress.removeAttribute("value");
  progressLabel.textContent = `사진 ${entries.length}장을 영수증 1건으로 등록 중`;
  entries.forEach((entry) => { entry.status = "sending"; entry.error = ""; });
  message("");
  updateSelections();
  try {
    await submitReceiptBatch(entries, { registrant: name, content: text }, submission, uploadReceipt);
    finishBatch(entries.length);
  } catch (error) {
    const reason = error.name === "AbortError" ? "응답이 지연되었습니다. 다시 등록하면 저장 여부를 확인합니다." : error.message || "서버에 연결하지 못했습니다.";
    message(`${reason}\n‘영수증 다시 등록하기’를 눌러 재시도해 주세요. 같은 영수증은 중복 등록되지 않습니다.`, true);
    entries.forEach((entry) => { entry.status = "error"; entry.error = "등록 재시도 대기"; });
    updateSelections();
    newButton.hidden = false;
    progressArea.hidden = true;
  } finally {
    sending = false;
    updateControls();
    if (form.hidden) newButton.focus();
    else notice.scrollIntoView({ block: "nearest" });
  }
});

newButton.addEventListener("click", () => {
  if (sending) return;
  imageInput.value = "";
  content.value = "";
  submission = { id: newId() };
  clearPreview();
  message("");
  form.hidden = false;
  newButton.hidden = true;
  progressArea.hidden = true;
  updateControls();
  imageInput.focus();
});
updateControls();
window.addEventListener("beforeunload", (event) => {
  if (sending) { event.preventDefault(); event.returnValue = ""; }
});
