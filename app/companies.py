from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
import unicodedata
from uuid import uuid4


def normalize_company_name(value: str) -> str:
    name = " ".join(unicodedata.normalize("NFKC", value).split())
    if not name or len(name) > 120 or any(unicodedata.category(char).startswith("C") for char in name):
        raise ValueError("회사명은 공백이 아닌 1~120자로 입력해 주세요.")
    return name


class CompanyStore:
    def __init__(self, root: Path):
        self.root = root

    @contextmanager
    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.root / "companies.sqlite3", timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("""CREATE TABLE IF NOT EXISTS companies (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE
            )""")
            with db:
                yield db

    def list(self) -> list[dict]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT id, name FROM companies ORDER BY name_key, id")]

    def get(self, company_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT id, name FROM companies WHERE id = ?", (company_id,)).fetchone()
            return dict(row) if row else None

    def create(self, name: str) -> dict:
        name = normalize_company_name(name)
        with self.connect() as db:
            db.execute("INSERT INTO companies (id, name, name_key) VALUES (?, ?, ?) ON CONFLICT(name_key) DO NOTHING",
                       (uuid4().hex, name, name.casefold()))
            return dict(db.execute("SELECT id, name FROM companies WHERE name_key = ?", (name.casefold(),)).fetchone())
