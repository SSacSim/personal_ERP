from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import warnings
from uuid import uuid4

from PIL import Image


MAX_FILE_BYTES = 1024 * 1024 * 1024


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def preview_type(path: Path) -> str | None:
    # Only verified raster images may be served inline. Other formats still download.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                media_type = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}.get(image.format)
                image.verify()
                return media_type
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return None


class DocumentStore:
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
        with closing(sqlite3.connect(self.root / "documents.sqlite3", timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("""CREATE TABLE IF NOT EXISTS document_folders (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS document_files (
                id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES document_folders(id),
                filename TEXT NOT NULL, size INTEGER NOT NULL, preview_type TEXT,
                uploaded_at TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS document_files_folder ON document_files(folder_id, uploaded_at DESC)")
            with db:
                yield db

    def list_folders(self) -> list[dict]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("""SELECT f.*, COUNT(d.id) AS file_count,
                COALESCE(SUM(d.size), 0) AS total_size FROM document_folders f
                LEFT JOIN document_files d ON d.folder_id = f.id
                GROUP BY f.id ORDER BY f.created_at DESC, f.id DESC""")]

    def folder(self, folder_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM document_folders WHERE id = ?", (folder_id,)).fetchone()
            return dict(row) if row else None

    def create_folder(self, data: dict) -> dict:
        item = {"id": uuid4().hex, **data, "created_at": timestamp(), "updated_at": timestamp()}
        with self.connect() as db:
            db.execute("INSERT INTO document_folders VALUES (:id, :title, :description, :created_at, :updated_at)", item)
        return item

    def update_folder(self, folder_id: str, data: dict) -> dict | None:
        with self.connect() as db:
            result = db.execute("UPDATE document_folders SET title = ?, description = ?, updated_at = ? WHERE id = ?",
                                (data["title"], data["description"], timestamp(), folder_id))
            if not result.rowcount:
                return None
            return dict(db.execute("SELECT * FROM document_folders WHERE id = ?", (folder_id,)).fetchone())

    def delete_folder(self, folder_id: str) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM document_files WHERE folder_id = ? LIMIT 1", (folder_id,)).fetchone():
                raise ValueError("폴더 안의 파일을 먼저 삭제해 주세요.")
            return bool(db.execute("DELETE FROM document_folders WHERE id = ?", (folder_id,)).rowcount)

    @staticmethod
    def file_metadata(row) -> dict:
        item = dict(row)
        item["download_url"] = f"/api/documents/files/{item['id']}/download"
        item["preview_url"] = f"/api/documents/files/{item['id']}/preview" if item["preview_type"] else None
        return item

    def list_files(self, folder_id: str) -> list[dict] | None:
        with self.connect() as db:
            db.execute("BEGIN")
            if not db.execute("SELECT 1 FROM document_folders WHERE id = ?", (folder_id,)).fetchone():
                return None
            return [self.file_metadata(row) for row in db.execute(
                "SELECT * FROM document_files WHERE folder_id = ? ORDER BY uploaded_at DESC, id DESC", (folder_id,))]

    def save_file(self, folder_id: str, filename: str, temporary: Path) -> dict | None:
        item = {"id": uuid4().hex, "folder_id": folder_id, "filename": filename,
                "size": temporary.stat().st_size, "preview_type": preview_type(temporary), "uploaded_at": timestamp()}
        target = self.uploads / item["id"]
        try:
            with self.connect() as db:
                # Serializes finalization against folder deletion and other uploads.
                db.execute("BEGIN IMMEDIATE")
                if not db.execute("SELECT 1 FROM document_folders WHERE id = ?", (folder_id,)).fetchone():
                    return None
                temporary.replace(target)
                db.execute("""INSERT INTO document_files
                    VALUES (:id, :folder_id, :filename, :size, :preview_type, :uploaded_at)""", item)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.file_metadata(item)

    def file(self, file_id: str) -> tuple[Path, dict] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM document_files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            return None
        path = self.uploads / row["id"]
        return (path, self.file_metadata(row)) if path.is_file() else None

    def delete_file(self, file_id: str) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM document_files WHERE id = ?", (file_id,)).fetchone()
            if row is None:
                return False
            (self.uploads / row["id"]).unlink(missing_ok=True)
            db.execute("DELETE FROM document_files WHERE id = ?", (file_id,))
        return True
