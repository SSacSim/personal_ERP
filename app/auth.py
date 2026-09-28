from urllib.parse import quote, urlsplit

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, RedirectResponse

from app.auth_store import AuthStore
from app.config import VAULT_DIR


COOKIE_NAME = "erp_session"
store = AuthStore(VAULT_DIR / "Auth")


def current_user(request: Request):
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def admin_user(request: Request):
    user = current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="관리자만 접근할 수 있습니다.")
    return user


class AuthenticationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path.rstrip("/") or "/"
        static = path.startswith(("/static/", "/receipt-static/"))
        public = static or path in {"/login", "/api/auth/login", "/favicon.ico"}
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin:
                expected = (request.url.scheme, request.url.netloc.lower())
                parsed = urlsplit(origin)
                if (parsed.scheme, parsed.netloc.lower()) != expected:
                    return JSONResponse({"detail": "허용되지 않은 요청입니다."}, status_code=403)
            elif request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "허용되지 않은 요청입니다."}, status_code=403)
        user = None if static else await run_in_threadpool(store.user_from_session, request.cookies.get(COOKIE_NAME, ""))
        request.state.user = user
        expected_user = request.headers.get("x-erp-user")
        if user and expected_user and expected_user != user["id"]:
            return JSONResponse({"detail": "로그인 계정이 변경되었습니다. 페이지를 새로고침해 주세요."}, status_code=409,
                                headers={"X-ERP-Account-Changed": "1", "Cache-Control": "no-store"})
        if not public and user is None:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "로그인이 필요합니다."}, status_code=401, headers={"Cache-Control": "no-store"})
            destination = request.url.path + ("?" + request.url.query if request.url.query else "")
            return RedirectResponse("/login?next=" + quote(destination, safe=""), status_code=303, headers={"Cache-Control": "no-store"})
        if (path == "/admin" or path.startswith("/api/admin")) and user and user["role"] != "admin":
            return JSONResponse({"detail": "관리자만 접근할 수 있습니다."}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache" if static else "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        return response
