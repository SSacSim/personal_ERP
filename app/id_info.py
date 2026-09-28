from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from uuid import uuid4


PUBLIC_COLUMNS = "id, category, login_id, notes, created_at, updated_at, password != '' AS has_password"


class IdInfoStore:
    def __init__(self, root: Path):
        self.root = root

    @contextmanager
    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.root / "id-info.sqlite3", timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("""CREATE TABLE IF NOT EXISTS id_info (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                login_id TEXT NOT NULL DEFAULT '',
                password TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            with db:
                yield db

    @staticmethod
    def public(row) -> dict | None:
        if row is None:
            return None
        item = dict(row)
        item["has_password"] = bool(item["has_password"])
        return item

    def list(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(f"SELECT {PUBLIC_COLUMNS} FROM id_info ORDER BY created_at DESC, id DESC").fetchall()
            return [self.public(row) for row in rows]

    def create(self, values: dict) -> dict:
        entry_id = uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("""INSERT INTO id_info (id, category, login_id, password, notes, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)""",
                       (entry_id, values["category"], values["login_id"], values["password"], values["notes"], now, now))
            return self.public(db.execute(f"SELECT {PUBLIC_COLUMNS} FROM id_info WHERE id = ?", (entry_id,)).fetchone())

    def update(self, entry_id: str, changes: dict) -> dict | None:
        changes = {key: value for key, value in changes.items() if key in {"category", "login_id", "password", "notes"}}
        with self.connect() as db:
            if changes:
                changes["updated_at"] = datetime.now(timezone.utc).isoformat()
                assignments = ", ".join(f"{key} = ?" for key in changes)
                db.execute(f"UPDATE id_info SET {assignments} WHERE id = ?", (*changes.values(), entry_id))
            return self.public(db.execute(f"SELECT {PUBLIC_COLUMNS} FROM id_info WHERE id = ?", (entry_id,)).fetchone())

    def password(self, entry_id: str) -> str | None:
        with self.connect() as db:
            row = db.execute("SELECT password FROM id_info WHERE id = ?", (entry_id,)).fetchone()
            return row["password"] if row else None

    def delete(self, entry_id: str) -> bool:
        with self.connect() as db:
            return db.execute("DELETE FROM id_info WHERE id = ?", (entry_id,)).rowcount > 0
