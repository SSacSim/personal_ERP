let user = null;
let guarded = false;

export const currentUser = () => user;
export const userStorageKey = (key) => user ? `${key}.${user.id}` : key;

function loginUrl() {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export async function requireSession() {
  const response = await fetch("/api/auth/me", { cache: "no-store" });
  if (response.status === 401) {
    location.replace(loginUrl());
    throw new Error("로그인이 필요합니다.");
  }
  if (!response.ok) throw new Error("로그인 정보를 불러오지 못했습니다. 새로고침해 주세요.");
  user = (await response.json()).user;
  if (!guarded) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      const privateApi = url.origin === location.origin && url.pathname.startsWith("/api/") && url.pathname !== "/api/auth/login";
      if (privateApi) {
        const headers = new Headers(options?.headers || (input instanceof Request ? input.headers : undefined));
        headers.set("X-ERP-User", user.id);
        options = { ...options, headers };
      }
      const result = await originalFetch(input, options);
      if (privateApi && result.status === 401) location.replace(loginUrl());
      if (privateApi && result.status === 409 && result.headers.get("X-ERP-Account-Changed")) location.replace("/");
      return result;
    };
    guarded = true;
  }
  return user;
}

export function setupAccountBar(root = document) {
  root.querySelectorAll("[data-account-name]").forEach((element) => { element.textContent = user.name; });
  root.querySelectorAll("[data-account-title]").forEach((element) => { element.textContent = user.job_title; });
  root.querySelectorAll("[data-admin-link]").forEach((element) => { element.hidden = user.role !== "admin"; });
  root.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok && response.status !== 401) throw new Error("로그아웃하지 못했습니다. 다시 시도해 주세요.");
      location.replace("/login");
    } catch (error) { button.disabled = false; alert(error.message); }
  }));
}
