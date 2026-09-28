"""Durable shared chat, using SQLite transactions for concurrent participants."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import secrets
import sqlite3
from uuid import uuid4


MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENTS = 5
MAX_MESSAGE_LENGTH = 4000
MESSAGE_EDIT_SECONDS = 120


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class ChatStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.uploads = self.root / "Uploads"
        self.database = self.root / "chat.sqlite3"

    def ensure(self) -> None:
        self.uploads.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS participants (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    participant_id TEXT NOT NULL REFERENCES participants(id),
                    sender_name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    client_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(participant_id, client_id)
                );
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY,
                    participant_id TEXT NOT NULL REFERENCES participants(id),
                    upload_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    message_id INTEGER REFERENCES messages(id),
                    UNIQUE(participant_id, upload_id)
                );
                CREATE INDEX IF NOT EXISTS chat_files_message ON files(message_id);
                CREATE INDEX IF NOT EXISTS chat_participants_seen ON participants(last_seen);
                CREATE TABLE IF NOT EXISTS account_participants (
                    user_id TEXT PRIMARY KEY,
                    participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id)
                );
                CREATE TABLE IF NOT EXISTS message_changes (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id INTEGER NOT NULL REFERENCES messages(id)
                );
            """)
            db.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(messages)")}
            for column, definition in (("edited_at", "TEXT"), ("deleted_at", "TEXT"), ("revision", "INTEGER NOT NULL DEFAULT 0"), ("sender_job_title", "TEXT")):
                if column not in columns:
                    db.execute(f"ALTER TABLE messages ADD COLUMN {column} {definition}")
            if "job_title" not in {row["name"] for row in db.execute("PRAGMA table_info(participants)")}:
                db.execute("ALTER TABLE participants ADD COLUMN job_title TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def account_participant(self, user_id: str, name: str, job_title: str) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT participant_id FROM account_participants WHERE user_id = ?", (user_id,)).fetchone()
            if row:
                participant_id = row["participant_id"]
                db.execute("UPDATE participants SET name = ?, job_title = ?, last_seen = ? WHERE id = ?", (name, job_title, timestamp(), participant_id))
            else:
                participant_id = uuid4().hex
                now = timestamp()
                db.execute("INSERT INTO participants (id, token_hash, name, created_at, last_seen, job_title) VALUES (?, ?, ?, ?, ?, ?)",
                           (participant_id, hashlib.sha256(secrets.token_bytes(32)).hexdigest(), name, now, now, job_title))
                db.execute("INSERT INTO account_participants VALUES (?, ?)", (user_id, participant_id))
            return {"id": participant_id, "name": name, "job_title": job_title}

    def sync_account_profiles(self, users: list[dict]) -> None:
        # Populate titles for existing account-linked chat participants without guessing by name.
        with self.connect() as db:
            db.executemany("UPDATE participants SET name = ?, job_title = ? WHERE id = (SELECT participant_id FROM account_participants WHERE user_id = ?)",
                           [(user["name"], user["job_title"], user["id"]) for user in users])

    def touch(self, participant_id: str) -> None:
        with self.connect() as db:
            db.execute("UPDATE participants SET last_seen=? WHERE id=?", (timestamp(), participant_id))

    def participants(self) -> list[dict]:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat(timespec="milliseconds")
        with self.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT id, name, job_title FROM participants WHERE last_seen>? ORDER BY name, id", (cutoff,)
            )]

    @staticmethod
    def file_data(row) -> dict:
        return {key: row[key] for key in ("id", "filename", "size", "created_at", "message_id")}

    def message_data(self, db, row) -> dict:
        result = dict(row)
        if result["sender_job_title"] is None:
            profile = db.execute("SELECT job_title FROM participants WHERE id = ?", (row["participant_id"],)).fetchone()
            result["sender_job_title"] = profile["job_title"] if profile else ""
        if result["deleted_at"]:
            result["text"] = ""
            result["attachments"] = []
            return result
        result["attachments"] = [self.file_data(file) for file in db.execute(
            "SELECT * FROM files WHERE message_id=? ORDER BY created_at, id", (row["id"],)
        )]
        return result

    def messages(self, *, after: int | None, before: int | None, limit: int, since_change: int | None = None) -> dict:
        if after is not None:
            query, args = "SELECT * FROM messages WHERE id>? ORDER BY id LIMIT ?", (after, limit + 1)
        elif before is not None:
            query, args = "SELECT * FROM messages WHERE id<? ORDER BY id DESC LIMIT ?", (before, limit + 1)
        else:
            query, args = "SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit + 1,)
        with self.connect() as db:
            # Read content and the change cursor from one snapshot, so a concurrent edit cannot be skipped.
            db.execute("BEGIN")
            newest_change = db.execute("SELECT COALESCE(MAX(sequence), 0) FROM message_changes").fetchone()[0]
            rows = db.execute(query, args).fetchall()
            has_more = len(rows) > limit
            rows = rows[:limit]
            if after is None:
                rows.reverse()
            items = [self.message_data(db, row) for row in rows]
            changes = []
            has_more_changes = False
            change_cursor = newest_change
            if since_change is not None:
                events = db.execute("SELECT sequence, message_id FROM message_changes WHERE sequence > ? ORDER BY sequence LIMIT ?",
                                    (since_change, limit + 1)).fetchall()
                has_more_changes = len(events) > limit
                events = events[:limit]
                change_cursor = events[-1]["sequence"] if events else since_change
                for message_id in dict.fromkeys(event["message_id"] for event in events):
                    changes.append(self.message_data(db, db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()))
        return {"items": items, "has_more": has_more, "changes": changes, "change_cursor": change_cursor,
                "has_more_changes": has_more_changes, "server_time": timestamp()}

    @staticmethod
    def record_change(db, message_id: int):
        cursor = db.execute("INSERT INTO message_changes (message_id) VALUES (?)", (message_id,))
        db.execute("UPDATE messages SET revision = ? WHERE id = ?", (cursor.lastrowid, message_id))

    def change_message(self, participant_id: str, message_id: int, *, text: str | None = None, delete: bool = False) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
            if row is None or row["deleted_at"]:
                raise LookupError("메시지를 찾을 수 없습니다.")
            if row["participant_id"] != participant_id:
                raise PermissionError("본인이 작성한 메시지만 수정하거나 삭제할 수 있습니다.")
            now = timestamp()
            if datetime.fromisoformat(now) >= datetime.fromisoformat(row["created_at"]) + timedelta(seconds=MESSAGE_EDIT_SECONDS):
                raise PermissionError("전송 후 2분이 지나 수정하거나 삭제할 수 없습니다.")
            if delete:
                db.execute("UPDATE messages SET text = '', deleted_at = ? WHERE id = ?", (now, message_id))
            else:
                text = (text or "").strip()
                attached = db.execute("SELECT 1 FROM files WHERE message_id = ?", (message_id,)).fetchone()
                if (not text and not attached) or len(text) > MAX_MESSAGE_LENGTH:
                    raise ValueError("메시지는 1자 이상 4000자 이하로 입력해 주세요.")
                if text == row["text"]:
                    return self.message_data(db, row)
                db.execute("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?", (text, now, message_id))
            self.record_change(db, message_id)
            return self.message_data(db, db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone())

    def send(self, participant: dict, text: str, attachment_ids: list[str], client_id: str) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM messages WHERE participant_id=? AND client_id=?", (participant["id"], client_id)
            ).fetchone()
            if existing:
                return self.message_data(db, existing)
            for file_id in attachment_ids:
                row = db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
                if row is None or row["participant_id"] != participant["id"] or row["message_id"] is not None:
                    raise ValueError("첨부할 수 없는 파일입니다. 파일을 다시 선택해 주세요.")
            cursor = db.execute(
                "INSERT INTO messages (participant_id, sender_name, sender_job_title, text, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (participant["id"], participant["name"], participant["job_title"], text, client_id, timestamp()),
            )
            for file_id in attachment_ids:
                db.execute("UPDATE files SET message_id=? WHERE id=?", (cursor.lastrowid, file_id))
            self.record_change(db, cursor.lastrowid)
            db.execute("UPDATE participants SET last_seen=? WHERE id=?", (timestamp(), participant["id"]))
            return self.message_data(db, db.execute("SELECT * FROM messages WHERE id=?", (cursor.lastrowid,)).fetchone())

    def uploaded(self, participant_id: str, upload_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM files WHERE participant_id=? AND upload_id=?", (participant_id, upload_id)).fetchone()
            return self.file_data(row) if row else None

    def save_upload(self, participant_id: str, upload_id: str, filename: str, temporary: Path, size: int) -> dict:
        file_id = uuid4().hex
        destination = self.uploads / file_id
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT * FROM files WHERE participant_id=? AND upload_id=?", (participant_id, upload_id)).fetchone()
                if existing:
                    return self.file_data(existing)
                temporary.replace(destination)
                db.execute("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, NULL)",
                           (file_id, participant_id, upload_id, filename, size, timestamp()))
                return self.file_data(db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone())
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        finally:
            temporary.unlink(missing_ok=True)

    def shared_files(self, limit: int = 30) -> list[dict]:
        with self.connect() as db:
            return [{**self.file_data(row), "sender_name": row["sender_name"], "sender_job_title": row["sender_job_title"]} for row in db.execute(
                "SELECT files.*, messages.sender_name, COALESCE(messages.sender_job_title, participants.job_title, '') AS sender_job_title "
                "FROM files JOIN messages ON messages.id=files.message_id JOIN participants ON participants.id=messages.participant_id "
                "WHERE messages.deleted_at IS NULL ORDER BY files.message_id DESC, files.created_at DESC LIMIT ?", (limit,)
            )]

    def download(self, file_id: str) -> tuple[Path, dict] | None:
        with self.connect() as db:
            row = db.execute("SELECT files.* FROM files JOIN messages ON messages.id=files.message_id WHERE files.id=? AND messages.deleted_at IS NULL", (file_id,)).fetchone()
        if row is None:
            return None
        path = self.uploads / row["id"]
        return (path, self.file_data(row)) if path.is_file() else None

    def discard_upload(self, participant_id: str, file_id: str) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM files WHERE id=? AND participant_id=? AND message_id IS NULL", (file_id, participant_id)).fetchone()
            if row is None:
                return False
            (self.uploads / row["id"]).unlink(missing_ok=True)
            db.execute("DELETE FROM files WHERE id=?", (file_id,))
            return True
