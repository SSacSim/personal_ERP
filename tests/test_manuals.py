from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import storage
from app.main import app
from app.manuals import ManualConflict, save_manual
from app.models import ManualUpdate
from app.routers import manuals
from auth_support import authorize


class ManualTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.vault = storage.ObsidianVault(self.root / "Notes")
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", self.vault.root))
        self.stack.enter_context(patch.object(manuals, "vault", self.vault))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        self.accounts = authorize(self.client, self.stack, self.root)

    def create(self, **extra):
        response = self.client.post("/api/manuals", json={"title": "월말 정산하기", "owner": "재무 담당", **extra})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def update_data(self, item, **extra):
        keys = ("title", "owner", "category", "status", "review_cycle_days", "next_review_date", "sections", "version")
        return {**{key: item[key] for key in keys}, "change_summary": "정산 절차와 참고 자료 갱신", **extra}

    def test_shared_manuals_require_login_and_preserve_server_author_identity(self):
        self.assertEqual(self.client.get("/manuals").status_code, 200)
        created = self.create()
        self.assertEqual(created["created_by"], "홍길동")
        colleague = self.accounts.create_user("manual-colleague", "test-password", "김동료", "매니저")
        self.client.cookies.clear()
        self.client.cookies.set("erp_session", self.accounts.create_session(colleague["id"]))
        self.assertEqual(self.client.get("/api/manuals").json()["items"][0]["id"], created["id"])
        updated = self.client.patch(f'/api/manuals/{created["id"]}', json=self.update_data(created)).json()
        self.assertEqual(updated["updated_by"], "김동료")
        self.assertEqual(updated["created_by"], "홍길동")
        self.assertEqual(self.client.post("/api/manuals", json={"title": "사칭", "owner": "담당", "updated_by": "가짜"}).status_code, 422)
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/api/manuals").status_code, 401)
        self.assertEqual(self.client.post("/api/manuals", json={"title": "무단", "owner": "담당"}).status_code, 401)

    def test_draft_template_and_published_required_sections(self):
        guide = self.client.get("/api/manuals/guide").json()
        self.assertEqual(len(guide["sections"]), 7)
        self.assertTrue(any("비밀번호" in rule["title"] for rule in guide["guidelines"]))
        created = self.create()
        self.assertEqual(created["version"], 1)
        self.assertEqual(set(created["sections"]), {section["key"] for section in guide["sections"]})
        self.assertTrue(all(not value for value in created["sections"].values()))
        self.assertEqual(created["review_cycle_days"], 90)
        self.assertGreaterEqual(date.fromisoformat(created["next_review_date"]), date.today() + timedelta(days=89))
        self.assertEqual(self.client.post("/api/manuals", json={"title": "빈 절차", "owner": "담당", "status": "published"}).status_code, 422)
        sections = {section["key"]: f'{section["title"]}의 검증된 업무 내용' for section in guide["sections"] if section["required"]}
        published = self.create(status="published", sections=sections)
        self.assertTrue(published["last_reviewed_date"])
        self.assertEqual(self.client.get(f'/api/manuals/{published["id"]}').json()["sections"]["procedure"], sections["procedure"])

    def test_revisions_keep_identity_creation_date_template_and_change_summaries(self):
        original = self.create(sections={"procedure": "1. 이전 절차\n2. 확인"})
        payload = self.update_data(original, title="변경된 업무명", sections={**original["sections"], "procedure": "1. 변경된 절차\n2. 결과 확인", "references": "https://example.com/policy"}, review_cycle_days=30, next_review_date="2026-12-01")
        response = self.client.patch(f'/api/manuals/{original["id"]}', json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        updated = response.json()
        for key in ("id", "path", "created_at", "created_by"):
            self.assertEqual(updated[key], original[key])
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["next_review_date"], "2026-12-01")
        self.assertEqual([revision["version"] for revision in updated["revision_history"]], [2, 1])
        self.assertEqual(updated["revision_history"][0]["summary"], payload["change_summary"])
        self.assertNotIn("이전 절차", updated["body"])
        self.assertIn("## 4. 단계별 업무 절차", updated["body"])
        self.assertIn("https://example.com/policy", (self.vault.root / updated["path"]).read_text(encoding="utf-8"))
        self.assertEqual(self.client.patch(f'/api/manuals/{original["id"]}', json={**payload, "version": 2, "change_summary": " "}).status_code, 422)
        self.assertEqual(self.client.patch("/api/manuals/missing", json=payload).status_code, 404)

    def test_stale_updates_and_concurrent_writers_cannot_overwrite_newer_content(self):
        original = self.create()
        data = ManualUpdate(**self.update_data(original)).model_dump()
        user = {"name": "검토자"}
        def write():
            try:
                return save_manual(self.vault, data, user, original["id"])["version"]
            except ManualConflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: write(), range(2)))
        self.assertCountEqual(results, [2, "conflict"])
        before = (self.vault.root / original["path"]).read_bytes()
        response = self.client.patch(f'/api/manuals/{original["id"]}', json=self.update_data(original, title="오래된 문서로 덮어쓰기"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual((self.vault.root / original["path"]).read_bytes(), before)

    def test_failed_write_keeps_the_previous_manual_and_removes_temporary_file(self):
        original = self.create()
        path = self.vault.root / original["path"]
        before = path.read_bytes()
        with patch.object(Path, "replace", side_effect=OSError("test disk failure")):
            with self.assertRaises(OSError):
                save_manual(self.vault, ManualUpdate(**self.update_data(original)).model_dump(), {"name": "검토자"}, original["id"])
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(path.with_suffix(".tmp").exists())
