from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from uuid import uuid4


SESSION_SECONDS = 12 * 60 * 60
PASSWORD_ITERATIONS = 600000
# Initial administrator credential is stored only as a salted password hash.
INITIAL_ADMIN_HASH = "pbkdf2_sha256$600000$c09186cab4683d2e9ceb38bb1359f88f$a331447994d701536a518920fbb6ec73b45606a902d60a2e527b2fd7ce2cc83a"
# Separate Info access password, stored only as a salted hash.
INFO_ACCESS_HASH = "pbkdf2_sha256$600000$8e4f5a7d83e01f953b21e5e6e561408e$151a67ea84de7d13fb70fb0b941229a72083d4b7b653906f86d576be5c3aa730"
INFO_ACCESS_SECONDS = 30 * 60
PUBLIC_COLUMNS = "id, login_id, name, job_title, role, created_at"


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PASSWORD_ITERATIONS).hex()
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    algorithm, iterations, salt, expected = encoded.split("$")
    if algorithm != "pbkdf2_sha256":
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
    return hmac.compare_digest(actual, expected)


class LoginLimited(ValueError):
    pass


class AuthStore:
    def __init__(self, root: Path):
        self.root = root
        self.ready = False
        self.lock = threading.Lock()

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.root / "auth.sqlite3", timeout=15)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db

    def ensure(self):
        if self.ready:
            return
        with self.lock:
            if self.ready:
                return
            self.root.mkdir(parents=True, exist_ok=True)
            with self.connect() as db:
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY, login_id TEXT NOT NULL,
                        login_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                        name TEXT NOT NULL, job_title TEXT NOT NULL,
                        role TEXT NOT NULL CHECK(role IN ('admin', 'user')), created_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS sessions (
                        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                        expires_at INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS login_attempts (
                        key TEXT PRIMARY KEY, failures INTEGER NOT NULL, since INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS info_access (
                        token_hash TEXT PRIMARY KEY,
                        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
                        expires_at INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS pomodoro_owners (
                        session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                        person TEXT NOT NULL
                    );
                """)
                db.execute("""INSERT OR IGNORE INTO users
                    (id, login_id, login_key, password_hash, name, job_title, role, created_at)
                    VALUES (?, 'admin', 'admin', ?, '관리자', '관리자', 'admin', ?)""",
                    (uuid4().hex, INITIAL_ADMIN_HASH, datetime.now(timezone.utc).isoformat()))
            self.ready = True

    def list_users(self):
        self.ensure()
        with self.connect() as db:
            return [dict(row) for row in db.execute(f"SELECT {PUBLIC_COLUMNS} FROM users ORDER BY role, created_at, id")]

    def create_user(self, login_id: str, password: str, name: str, job_title: str):
        self.ensure()
        user_id = uuid4().hex
        encoded = hash_password(password)
        try:
            with self.connect() as db:
                db.execute("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, 'user', ?)",
                           (user_id, login_id, login_id.casefold(), encoded, name, job_title, datetime.now(timezone.utc).isoformat()))
                return dict(db.execute(f"SELECT {PUBLIC_COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone())
        except sqlite3.IntegrityError as exc:
            raise ValueError("이미 등록된 ID입니다.") from exc

    def authenticate(self, login_id: str, password: str, client: str):
        self.ensure()
        now = int(time.time())
        attempt_key = hashlib.sha256(f"{client}\0{login_id.casefold()}".encode()).hexdigest()
        with self.connect() as db:
            attempt = db.execute("SELECT * FROM login_attempts WHERE key = ?", (attempt_key,)).fetchone()
            if attempt and attempt["failures"] >= 10 and attempt["since"] > now - 900:
                raise LoginLimited("로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.")
            row = db.execute("SELECT * FROM users WHERE login_key = ?", (login_id.casefold(),)).fetchone()
        valid = verify_password(password, row["password_hash"] if row else INITIAL_ADMIN_HASH)
        with self.connect() as db:
            db.execute("DELETE FROM login_attempts WHERE since <= ?", (now - 900,))
            if not row or not valid:
                db.execute("INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET failures = failures + 1", (attempt_key, now))
                return None
            db.execute("DELETE FROM login_attempts WHERE key = ?", (attempt_key,))
        return {key: row[key] for key in PUBLIC_COLUMNS.split(", ")}

    def create_session(self, user_id: str):
        self.ensure()
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (hashlib.sha256(token.encode()).hexdigest(), user_id, now + SESSION_SECONDS))
        return token

    def user_from_session(self, token: str):
        if not token or len(token) > 128:
            return None
        self.ensure()
        with self.connect() as db:
            row = db.execute(f"SELECT {', '.join('u.' + column for column in PUBLIC_COLUMNS.split(', '))} FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?",
                             (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
        return dict(row) if row else None

    def logout(self, token: str):
        self.ensure()
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))

    def unlock_info(self, session_token: str, password: str):
        user = self.user_from_session(session_token)
        if user is None:
            raise PermissionError("로그인이 필요합니다.")
        now = int(time.time())
        # Rate limits are per account, so a fresh browser/login cannot reset them.
        attempt_key = "info:" + user["id"]
        with self.connect() as db:
            # Serialize attempts across workers to prevent parallel guesses bypassing the limit.
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE since <= ?", (now - 900,))
            attempt = db.execute("SELECT * FROM login_attempts WHERE key = ?", (attempt_key,)).fetchone()
            if attempt and attempt["failures"] >= 10:
                raise LoginLimited("비밀번호 입력 시도가 많습니다. 15분 후 다시 시도해 주세요.")
            if not verify_password(password, INFO_ACCESS_HASH):
                db.execute("INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET failures = failures + 1", (attempt_key, now))
                return None
            db.execute("DELETE FROM login_attempts WHERE key = ?", (attempt_key,))
            session_hash = hashlib.sha256(session_token.encode()).hexdigest()
            session = db.execute("SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?", (session_hash, now)).fetchone()
            if session is None:
                raise PermissionError("로그인이 필요합니다.")
            access_token = secrets.token_urlsafe(32)
            expires_at = min(now + INFO_ACCESS_SECONDS, session["expires_at"])
            db.execute("DELETE FROM info_access WHERE expires_at <= ?", (now,))
            db.execute("INSERT INTO info_access VALUES (?, ?, ?)", (hashlib.sha256(access_token.encode()).hexdigest(), session_hash, expires_at))
            return {"token": access_token, "expires_in": expires_at - now}

    def info_access_allowed(self, session_token: str, access_token: str):
        if not session_token or not access_token or max(len(session_token), len(access_token)) > 128:
            return False
        self.ensure()
        now = int(time.time())
        with self.connect() as db:
            return db.execute("""SELECT 1 FROM info_access a JOIN sessions s ON s.token_hash = a.session_hash
                WHERE a.token_hash = ? AND a.session_hash = ? AND a.expires_at > ? AND s.expires_at > ?""",
                (hashlib.sha256(access_token.encode()).hexdigest(), hashlib.sha256(session_token.encode()).hexdigest(), now, now)).fetchone() is not None

    def lock_info(self, session_token: str, access_token: str):
        self.ensure()
        with self.connect() as db:
            db.execute("DELETE FROM info_access WHERE token_hash = ? AND session_hash = ?",
                       (hashlib.sha256(access_token.encode()).hexdigest(), hashlib.sha256(session_token.encode()).hexdigest()))

    def pomodoro_person(self, session_id: str, user: dict):
        self.ensure()
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO pomodoro_owners VALUES (?, ?, ?)", (session_id, user["id"], user["name"]))
            row = db.execute("SELECT user_id, person FROM pomodoro_owners WHERE session_id = ?", (session_id,)).fetchone()
            if row["user_id"] != user["id"]:
                raise PermissionError("다른 사용자의 집중 기록은 변경할 수 없습니다.")
            return row["person"]
