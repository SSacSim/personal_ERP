const form = document.querySelector("#login-form");
const notice = document.querySelector("#login-notice");
let sending = false;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending || !form.reportValidity()) return;
  sending = true;
  const fields = form.querySelector("fieldset");
  const payload = { login_id: form.elements.login_id.value.trim(), password: form.elements.password.value };
  fields.disabled = true;
  notice.hidden = true;
  try {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "ID와 비밀번호를 확인해 주세요.");
    let destination = data.redirect;
    const next = new URLSearchParams(location.search).get("next");
    if (data.user.role !== "admin" && next) {
      const url = new URL(next, location.origin);
      const allowed = new Set(["/dashboard", "/calendar", "/attendance", "/tasks", "/todos", "/projects", "/meetings", "/wiki", "/chat", "/receipts", "/receipt-upload", "/remote-work", "/id-info", "/pomodoro"]);
      if (url.origin === location.origin && allowed.has(url.pathname)) destination = url.pathname + url.search;
    }
    form.elements.password.value = "";
    location.replace(destination);
  } catch (error) {
    notice.textContent = error.message || "로그인하지 못했습니다. 연결을 확인해 주세요.";
    notice.hidden = false;
    fields.disabled = false;
    form.elements.password.focus();
  } finally { sending = false; }
});
