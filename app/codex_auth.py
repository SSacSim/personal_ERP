from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock, Thread
from uuid import uuid4

from app.config import BASE_DIR


@dataclass
class CodexLoginSession:
    id: str
    auth_url: str
    created_at: datetime
    expires_at: datetime
    status: str = "pending"
    error: str = ""
    codex: object | None = None


_sessions: dict[str, CodexLoginSession] = {}
_lock = Lock()


def start_codex_login() -> dict[str, str]:
    try:
        from openai_codex import Codex, CodexConfig
    except ImportError as exc:
        raise RuntimeError(f"openai_codex 패키지를 import할 수 없습니다: {exc}") from exc

    codex = Codex(
        config=CodexConfig(
            cwd=str(BASE_DIR),
            env={
                "PYTHONIOENCODING": "utf-8",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "NO_COLOR": "1",
            },
        )
    )
    try:
        handle = codex.login_chatgpt()
    except Exception:
        codex.close()
        raise

    session = CodexLoginSession(
        id=uuid4().hex,
        auth_url=handle.auth_url,
        created_at=datetime.now(),
        expires_at=datetime.now() + timedelta(minutes=10),
        codex=codex,
    )
    with _lock:
        cleanup_expired_sessions()
        _sessions[session.id] = session

    worker = Thread(target=_wait_for_login, args=(session.id, handle), daemon=True)
    worker.start()
    return {
        "login_id": session.id,
        "auth_url": session.auth_url,
        "status": session.status,
        "expires_at": session.expires_at.isoformat(timespec="seconds"),
    }


def codex_login_status(login_id: str) -> dict[str, str]:
    with _lock:
        session = _sessions.get(login_id)
        if session is None:
            return {"login_id": login_id, "status": "not_found", "error": "인증 세션을 찾을 수 없습니다."}
        if session.status == "pending" and datetime.now() > session.expires_at:
            session.status = "expired"
            session.error = "인증 시간이 만료되었습니다. 인증 링크를 다시 생성해 주세요."
            close_session(session)
        return {
            "login_id": session.id,
            "status": session.status,
            "error": session.error,
            "auth_url": session.auth_url,
            "expires_at": session.expires_at.isoformat(timespec="seconds"),
        }


def cleanup_expired_sessions() -> None:
    now = datetime.now()
    expired = [session_id for session_id, session in _sessions.items() if now > session.expires_at and session.status == "pending"]
    for session_id in expired:
        session = _sessions[session_id]
        session.status = "expired"
        session.error = "인증 시간이 만료되었습니다."
        close_session(session)


def _wait_for_login(session_id: str, handle: object) -> None:
    try:
        handle.wait()
    except Exception as exc:
        with _lock:
            session = _sessions.get(session_id)
            if session is not None:
                session.status = "error"
                session.error = str(exc)
                close_session(session)
        return

    with _lock:
        session = _sessions.get(session_id)
        if session is not None:
            session.status = "completed"
            session.error = ""
            close_session(session)


def close_session(session: CodexLoginSession) -> None:
    codex = session.codex
    session.codex = None
    if codex is not None:
        try:
            codex.close()
        except Exception:
            pass
