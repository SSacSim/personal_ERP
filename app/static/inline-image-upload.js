import { clipboardImage, pastedImages } from "./remote-work-inputs.js";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImageSize = 10 * 1024 * 1024;
const guardedForms = new WeakSet();

export function validateInlineImage(file) {
  if (!imageTypes.has(file.type)) throw new Error("JPG, PNG, GIF, WEBP 이미지를 첨부해 주세요.");
  if (!file.size || file.size > maxImageSize) throw new Error("이미지는 10MB 이하로 첨부해 주세요.");
  return file;
}

// Only permanent asset URLs go into the document. Failed uploads stay visible
// with retry/remove actions, and cannot silently disappear on form submission.
export function setupInlineImageUpload(surface, { upload, renderImage, onUploaded, onChange }) {
  const editor = surface.closest("[data-inline-editor]");
  const form = surface.closest("form");
  const input = editor.querySelector("[data-inline-image-input]");
  const button = editor.querySelector("[data-inline-image-button]");
  let queue = Promise.resolve();
  let savedRange = null;

  if (form && !guardedForms.has(form)) {
    guardedForms.add(form);
    form.addEventListener("submit", (event) => {
      const unfinished = form.querySelector("[data-image-upload]");
      if (!unfinished) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      let feedback = form.querySelector("[data-image-upload-feedback]");
      if (!feedback) {
        feedback = document.createElement("p");
        feedback.dataset.imageUploadFeedback = "";
        feedback.className = "image-upload-feedback full";
        feedback.setAttribute("role", "alert");
        form.append(feedback);
      }
      feedback.textContent = "이미지 업로드가 끝난 뒤 저장해 주세요. 실패한 이미지는 다시 시도하거나 삭제해 주세요.";
      unfinished.scrollIntoView({ block: "nearest" });
    }, true);
  }

  function selectionRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return surface.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }

  function insert(nodes, range = selectionRange()) {
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    fragment.append(paragraph);
    if (range && surface.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(fragment);
    } else {
      surface.append(fragment);
    }
    const caret = document.createRange();
    caret.selectNodeContents(paragraph);
    caret.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
    surface.focus();
    onChange();
  }

  async function imageFile(source) {
    if (typeof source !== "string") return validateInlineImage(source);
    if (!/^(data:image\/(png|jpeg|gif|webp);base64,|blob:|https?:\/\/|\/api\/assets\/)/i.test(source)) {
      throw new Error("이미지를 읽을 수 없습니다. 이미지 파일을 복사하거나 이미지 삽입 버튼을 사용해 주세요.");
    }
    const response = await fetch(source);
    if (!response.ok) throw new Error("복사한 이미지를 읽지 못했습니다. 이미지 파일을 직접 첨부해 주세요.");
    return validateInlineImage(clipboardImage(await response.blob()));
  }

  function placeholder(source) {
    const node = document.createElement("figure");
    node.className = "image-upload-placeholder";
    node.contentEditable = "false";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary";
    retry.textContent = "다시 시도";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "삭제";
    node.append(status, retry, remove);

    function clearFeedback() {
      if (!form?.querySelector("[data-image-upload]")) form?.querySelector("[data-image-upload-feedback]")?.remove();
    }

    function start() {
      node.dataset.imageUpload = "pending";
      status.textContent = "이미지 업로드 중…";
      retry.hidden = true;
      queue = queue.then(async () => {
        if (!surface.contains(node)) return;
        try {
          const image = await upload(await imageFile(source));
          if (!surface.contains(node)) return;
          const template = document.createElement("template");
          template.innerHTML = renderImage(image).trim();
          node.replaceWith(template.content);
          onUploaded(image);
          onChange();
          clearFeedback();
        } catch (error) {
          if (!surface.contains(node)) return;
          node.dataset.imageUpload = "error";
          status.textContent = `이미지 업로드 실패: ${error.message || "연결 상태를 확인해 주세요."}`;
          retry.hidden = false;
        }
      });
    }
    retry.addEventListener("click", start);
    remove.addEventListener("click", () => { node.remove(); clearFeedback(); onChange(); });
    start();
    return node;
  }

  button.addEventListener("click", () => {
    savedRange = selectionRange();
    input.click();
  });
  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    if (files.length) insert(files.map(placeholder), savedRange);
    input.value = "";
    savedRange = null;
  });
  surface.addEventListener("paste", (event) => {
    const files = pastedImages(event.clipboardData);
    const html = event.clipboardData?.getData("text/html");
    const parsed = html ? new DOMParser().parseFromString(html, "text/html") : null;
    const htmlImages = parsed?.querySelectorAll("img") || [];
    if (files.length && (!htmlImages.length || htmlImages.length !== files.length)) {
      event.preventDefault();
      insert(files.map(placeholder));
      return;
    }
    if (!htmlImages.length) return; // Keep normal text paste and line breaks native.
    event.preventDefault();
    const nodes = [];
    let imageIndex = 0;
    function collect(node) {
      if (node.nodeType === Node.TEXT_NODE) { nodes.push(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches("script, style, noscript")) return;
      if (node.tagName === "IMG") { nodes.push(placeholder(files[imageIndex++] || node.getAttribute("src") || "")); return; }
      if (node.tagName === "BR") { nodes.push(document.createElement("br")); return; }
      node.childNodes.forEach(collect);
      if (node.matches("p, div, li, tr, h1, h2, h3, h4, blockquote")) nodes.push(document.createElement("br"));
    }
    parsed.body.childNodes.forEach(collect);
    insert(nodes);
  });
}
