from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path
import re
import sqlite3
from uuid import uuid4


MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENTS = 10
logger = logging.getLogger(__name__)


def image_media_type(path: Path) -> str:
    with path.open("rb") as source:
        header = source.read(32)
        if header.startswith(b"\x89PNG\r\n\x1a\n") and header[12:16] == b"IHDR" and path.stat().st_size >= 33:
            return "image/png"
        if header.startswith(b"\xff\xd8\xff"):
            source.seek(-2, 2)
            if source.read() == b"\xff\xd9":
                return "image/jpeg"
        if header[:6] in {b"GIF87a", b"GIF89a"} and len(header) >= 14:
            return "image/gif"
        if header[:4] == b"RIFF" and header[8:12] == b"WEBP" and len(header) >= 20:
            return "image/webp"
    raise ValueError("이미지는 JPG, PNG, GIF, WEBP 형식으로 등록해 주세요.")


class RemoteWorkStore:
    def __init__(self, root: Path):
        self.root = root

    @property
    def uploads(self) -> Path:
        path = self.root / "Uploads"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @contextmanager
    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.root / "remote-work.sqlite3", timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("""CREATE TABLE IF NOT EXISTS remote_work (
                id TEXT PRIMARY KEY,
                work_date TEXT NOT NULL,
                author TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS remote_work_date ON remote_work(work_date DESC, created_at DESC)")
            # A separate table keeps existing text-only records unchanged.
            db.execute("""CREATE TABLE IF NOT EXISTS remote_work_files (
                id TEXT PRIMARY KEY, entry_id TEXT, filename TEXT NOT NULL,
                kind TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL,
                position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS remote_work_files_entry ON remote_work_files(entry_id, position)")
            with db:
                yield db

    def list(self, month: str = "", query: str = "", limit: int = 25, offset: int = 0) -> dict:
        clauses = []
        params = []
        if month:
            clauses.append("substr(work_date, 1, 7) = ?")
            params.append(month)
        if query:
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            clauses.append("(author LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
            params.extend([pattern, pattern])
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self.connect() as db:
            # Keep the count and this page consistent if another person saves a record.
            db.execute("BEGIN")
            total = db.execute("SELECT COUNT(*) FROM remote_work" + where, params).fetchone()[0]
            rows = db.execute("SELECT * FROM remote_work" + where + " ORDER BY work_date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?",
                              [*params, limit, offset]).fetchall()
            items = [self.record(db, row) for row in rows]
        return {"items": items, "total": total}

    @staticmethod
    def file_metadata(row) -> dict:
        item = {key: row[key] for key in ("id", "filename", "kind", "media_type", "size")}
        item["download_url"] = f"/api/remote-work/files/{row['id']}/download"
        item["preview_url"] = f"/api/remote-work/files/{row['id']}/preview" if row["kind"] == "image" else None
        return item

    def record(self, db, row) -> dict:
        return {**dict(row), "attachments": [self.file_metadata(file) for file in db.execute(
            "SELECT * FROM remote_work_files WHERE entry_id = ? ORDER BY position, id", (row["id"],)
        )]}

    def set_attachments(self, db, entry_id: str, attachment_ids: list[str]) -> list[str]:
        if len(attachment_ids) > MAX_ATTACHMENTS or len(set(attachment_ids)) != len(attachment_ids):
            raise ValueError("첨부 파일은 중복 없이 최대 10개까지 등록할 수 있습니다.")
        for file_id in attachment_ids:
            row = db.execute("SELECT * FROM remote_work_files WHERE id = ?", (file_id,)).fetchone()
            if row is None or row["entry_id"] not in {None, entry_id} or not (self.uploads / file_id).is_file():
                raise ValueError("첨부 파일을 찾을 수 없거나 다른 기록에 등록된 파일입니다. 파일을 다시 선택해 주세요.")
        previous = [row[0] for row in db.execute("SELECT id FROM remote_work_files WHERE entry_id = ?", (entry_id,))]
        removed = [file_id for file_id in previous if file_id not in attachment_ids]
        db.executemany("DELETE FROM remote_work_files WHERE id = ?", [(file_id,) for file_id in removed])
        for position, file_id in enumerate(attachment_ids):
            db.execute("UPDATE remote_work_files SET entry_id = ?, position = ? WHERE id = ?", (entry_id, position, file_id))
        return removed

    def remove_files(self, file_ids: list[str]) -> None:
        for file_id in file_ids:
            try:
                (self.uploads / file_id).unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove remote-work attachment %s", file_id, exc_info=True)

    def create(self, values: dict) -> dict:
        entry_id = uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("INSERT INTO remote_work (id, work_date, author, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (entry_id, values["work_date"], values["author"], values["content"], now, now))
            self.set_attachments(db, entry_id, values.get("attachment_ids", []))
            return self.record(db, db.execute("SELECT * FROM remote_work WHERE id = ?", (entry_id,)).fetchone())

    def update(self, entry_id: str, changes: dict) -> dict | None:
        attachment_ids = changes.get("attachment_ids")
        changes = {key: value for key, value in changes.items() if key in {"work_date", "author", "content"}}
        removed = []
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT id FROM remote_work WHERE id = ?", (entry_id,)).fetchone() is None:
                return None
            if attachment_ids is not None:
                removed = self.set_attachments(db, entry_id, attachment_ids)
            if changes or attachment_ids is not None:
                changes["updated_at"] = datetime.now(timezone.utc).isoformat()
                assignments = ", ".join(f"{key} = ?" for key in changes)
                db.execute(f"UPDATE remote_work SET {assignments} WHERE id = ?", (*changes.values(), entry_id))
            row = db.execute("SELECT * FROM remote_work WHERE id = ?", (entry_id,)).fetchone()
            item = self.record(db, row)
        self.remove_files(removed)
        return item

    def delete(self, entry_id: str) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            removed = self.set_attachments(db, entry_id, [])
            deleted = db.execute("DELETE FROM remote_work WHERE id = ?", (entry_id,)).rowcount > 0
        self.remove_files(removed)
        return deleted

    def save_upload(self, file_id: str, filename: str, kind: str, path: Path) -> dict:
        if not re.fullmatch(r"[a-f0-9]{32}", file_id):
            raise ValueError("올바르지 않은 첨부 파일입니다.")
        size = path.stat().st_size
        if not 0 < size <= MAX_FILE_BYTES:
            raise ValueError("파일은 0바이트보다 크고 20MB 이하여야 합니다.")
        media_type = image_media_type(path) if kind == "image" else "application/octet-stream"
        destination = self.uploads / file_id
        moved = False
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT * FROM remote_work_files WHERE id = ?", (file_id,)).fetchone()
                if existing is not None:
                    if (existing["filename"], existing["kind"], existing["size"]) != (filename, kind, size):
                        raise ValueError("이미 사용한 업로드 요청입니다. 파일을 다시 선택해 주세요.")
                    return self.file_metadata(existing)
                path.replace(destination)
                moved = True
                db.execute("INSERT INTO remote_work_files (id, filename, kind, media_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                           (file_id, filename, kind, media_type, size, datetime.now(timezone.utc).isoformat()))
                result = self.file_metadata(db.execute("SELECT * FROM remote_work_files WHERE id = ?", (file_id,)).fetchone())
        except Exception:
            if moved:
                destination.unlink(missing_ok=True)
            raise
        self.clean_pending_uploads()
        return result

    def clean_pending_uploads(self) -> None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            expired = [row[0] for row in db.execute("SELECT id FROM remote_work_files WHERE entry_id IS NULL AND created_at < ?", (cutoff,))]
            db.executemany("DELETE FROM remote_work_files WHERE id = ?", [(file_id,) for file_id in expired])
        self.remove_files(expired)

    def discard_upload(self, file_id: str) -> bool:
        with self.connect() as db:
            deleted = db.execute("DELETE FROM remote_work_files WHERE id = ? AND entry_id IS NULL", (file_id,)).rowcount > 0
        if deleted:
            self.remove_files([file_id])
        return deleted

    def file(self, file_id: str):
        if not re.fullmatch(r"[a-f0-9]{32}", file_id):
            return None
        with self.connect() as db:
            row = db.execute("SELECT * FROM remote_work_files WHERE id = ? AND entry_id IS NOT NULL", (file_id,)).fetchone()
        path = self.uploads / file_id
        return (path, self.file_metadata(row)) if row is not None and path.is_file() else None
