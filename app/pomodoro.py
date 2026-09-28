from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class PomodoroStore:
    def __init__(self, root: Path):
        self.root = root

    @contextmanager
    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.root / "pomodoro.sqlite3", timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("""CREATE TABLE IF NOT EXISTS pomodoro_sessions (
                id TEXT PRIMARY KEY,
                person TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                remaining_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ends_at INTEGER,
                revision INTEGER NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS pomodoro_started ON pomodoro_sessions(started_at DESC, id DESC)")
            with db:
                yield db

    @staticmethod
    def public(row, now: int) -> dict:
        item = dict(row)
        if item["status"] == "running":
            item["remaining_ms"] = max(0, min(item["remaining_ms"], item["ends_at"] - now))
            if item["remaining_ms"] == 0:
                item["status"] = "completed"
                item["ends_at"] = None
        item["focused_ms"] = item["duration_ms"] - item["remaining_ms"]
        return item

    def list(self, limit: int = 25, offset: int = 0) -> dict:
        with self.connect() as db:
            db.execute("BEGIN")
            total = db.execute("SELECT COUNT(*) FROM pomodoro_sessions").fetchone()[0]
            rows = db.execute("SELECT * FROM pomodoro_sessions ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        now = now_ms()
        return {"items": [self.public(row, now) for row in rows], "total": total}

    def save(self, session_id: str, values: dict) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT * FROM pomodoro_sessions WHERE id = ?", (session_id,)).fetchone()
            if current and any(current[key] != values[key] for key in ("person", "duration_ms", "started_at")):
                raise ValueError("이미 기록된 실행의 이름이나 설정 시간은 변경할 수 없습니다.")
            # An old retry must never overwrite a newer pause/resume/stop snapshot.
            if not current:
                db.execute("""INSERT INTO pomodoro_sessions
                    (id, person, duration_ms, remaining_ms, status, started_at, ends_at, revision)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (session_id, values["person"], values["duration_ms"], values["remaining_ms"], values["status"], values["started_at"], values["ends_at"], values["revision"]))
            elif values["revision"] > current["revision"]:
                db.execute("UPDATE pomodoro_sessions SET remaining_ms = ?, status = ?, ends_at = ?, revision = ? WHERE id = ?",
                           (values["remaining_ms"], values["status"], values["ends_at"], values["revision"], session_id))
            row = db.execute("SELECT * FROM pomodoro_sessions WHERE id = ?", (session_id,)).fetchone()
        return self.public(row, now_ms())
