import { requireSession, setupAccountBar } from "./auth-state.js";
const user = await requireSession();
if (user.role !== "admin") { location.replace("/dashboard"); throw new Error("관리자 전용 페이지입니다."); }
setupAccountBar();
const form = document.querySelector("#user-form");
const notice = document.querySelector("#admin-notice");
const rows = document.querySelector("#users");
const refresh = document.querySelector("#refresh-users");
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let saving = false;
function message(text, error = false) { notice.textContent = text; notice.hidden = !text; notice.classList.toggle("error", error); }
async function loadUsers() {
  refresh.disabled = true;
  try {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    if (!response.ok) throw new Error("계정 목록을 불러오지 못했습니다.");
    const { items } = await response.json();
    rows.innerHTML = items.map((item) => `<tr><td>${escape(item.login_id)}</td><td>${escape(item.name)}</td><td>${escape(item.job_title)}</td><td><span class="auth-role ${item.role === "admin" ? "is-admin" : ""}">${item.role === "admin" ? "관리자" : "사용자"}</span></td></tr>`).join("");
    document.querySelector("#user-count").textContent = `${items.length}명`;
  } finally { refresh.disabled = false; }
}
refresh.addEventListener("click", () => loadUsers().catch((error) => message(error.message, true)));
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !form.reportValidity()) return;
  const payload = { login_id: form.elements.login_id.value.trim(), password: form.elements.password.value, name: form.elements.name.value.trim(), job_title: form.elements.job_title.value.trim() };
  saving = true;
  form.querySelector("fieldset").disabled = true;
  message("");
  try {
    const response = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "ID·비밀번호·이름·직함을 확인해 주세요.");
    form.reset();
    message(`${data.name}님의 계정을 등록했습니다.`);
    try { await loadUsers(); } catch { message("계정은 등록됐지만 목록을 새로 불러오지 못했습니다. 새로고침을 눌러 주세요.", true); }
  } catch (error) { message(error.message || "계정을 등록하지 못했습니다.", true); }
  finally { saving = false; form.querySelector("fieldset").disabled = false; }
});
loadUsers().catch((error) => message(error.message, true));
