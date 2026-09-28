from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import storage
from app.companies import CompanyStore
from app.routers import companies, meetings


class MeetingCompanyTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", self.root))
        self.vault = storage.ObsidianVault(self.root)
        self.stack.enter_context(patch.object(companies, "vault", self.vault))
        self.stack.enter_context(patch.object(meetings, "vault", self.vault))
        app = FastAPI()
        app.include_router(companies.router)
        app.include_router(meetings.router)
        self.client = self.stack.enter_context(TestClient(app))

    def company(self, name="한빛 주식회사"):
        response = self.client.post("/api/companies", json={"name": name})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def meeting(self, **changes):
        response = self.client.post("/api/meetings", json={
            "title": "업무 회의", "date": "2026-09-28", "project_id": "project-a", "start_time": "10:00",
            "attendees": ["담당자"], "agenda": "안건\n\n## 세부 안건\n검토",
            "notes": "회의 본문\n\n## 다음 단계\n![사진](/api/assets/keep.png)",
            "images": [{"name": "사진", "url": "/api/assets/keep.png"}], **changes,
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_normalized_names_reuse_one_registered_company(self):
        first = self.company("  ACME   Korea  ")
        self.assertEqual(first["name"], "ACME Korea")
        self.assertEqual(self.company("acme korea"), first)
        self.assertEqual(self.company("ＡＣＭＥ Korea"), first)
        self.assertEqual(self.client.get("/api/companies").json()["items"], [first])
        reopened = CompanyStore(self.root / "Companies")
        self.assertEqual(reopened.get(first["id"]), first)

    def test_concurrent_duplicate_registration_keeps_a_single_company_id(self):
        def register(number):
            return CompanyStore(self.root / "Companies").create("한빛  주식회사" if number % 2 else "한빛 주식회사")
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(register, range(12)))
        self.assertEqual(len({company["id"] for company in results}), 1)
        self.assertEqual(len(self.vault.companies.list()), 1)

    def test_invalid_company_names_do_not_create_registry_entries(self):
        for name in ["", "   ", "a" * 121, "숨김\u200b이름", "bad\x00name", None, 123]:
            with self.subTest(name=name):
                self.assertEqual(self.client.post("/api/companies", json={"name": name}).status_code, 422)
        self.assertEqual(self.client.get("/api/companies").json()["items"], [])

    def test_company_selection_persists_in_markdown_and_combines_with_project_filter(self):
        first = self.company("한빛")
        second = self.company("다온")
        one = self.meeting(company_id=first["id"])
        two = self.meeting(company_id=first["id"], project_id="project-b")
        self.meeting(company_id=second["id"])
        unassigned = self.meeting()
        listing = self.client.get("/api/meetings", params={"company_id": first["id"]}).json()["items"]
        self.assertEqual({item["id"] for item in listing}, {one["id"], two["id"]})
        combined = self.client.get("/api/meetings", params={"company_id": first["id"], "project_id": "project-a"}).json()["items"]
        self.assertEqual(combined, [one])
        self.assertEqual(self.client.get("/api/meetings?company_id=").json()["items"], [unassigned])
        reopened = storage.ObsidianVault(self.root)
        self.assertEqual(reopened.list_meetings(project_id="project-a", company_id=first["id"]), [one])
        note = reopened.find_by_id("meeting", one["id"])
        self.assertEqual(note.metadata["company_id"], first["id"])
        self.assertEqual(note.metadata["company_name"], "한빛")

    def test_company_changes_preserve_document_content_images_identity_and_history(self):
        first = self.company("한빛")
        second = self.company("다온")
        original = self.meeting(company_id=first["id"])
        path = f"/api/meetings/{original['id']}"
        unchanged = self.client.patch(path, json={"start_time": "11:00"}).json()
        self.assertEqual(unchanged["company_id"], first["id"])
        updated = self.client.patch(path, json={"company_id": second["id"]}).json()
        self.assertEqual(updated["company_name"], "다온")
        for key in ["id", "path", "created_at", "project_id", "images", "attendees"]:
            self.assertEqual(updated[key], original[key])
        self.assertEqual(storage.split_change_log(updated["body"])[0], storage.split_change_log(original["body"])[0])
        self.assertIn("company_id", storage.split_change_log(updated["body"])[1])
        self.assertEqual(self.client.get("/api/meetings", params={"company_id": first["id"]}).json()["items"], [])
        for empty_value in ["", None]:
            self.client.patch(path, json={"company_id": first["id"]})
            cleared = self.client.patch(path, json={"company_id": empty_value}).json()
            self.assertEqual(cleared["company_id"], "")
            self.assertEqual(cleared["company_name"], "")

    def test_unknown_company_is_rejected_without_changing_existing_documents(self):
        original = self.meeting()
        path = self.vault.find_by_id("meeting", original["id"]).path
        before = path.read_bytes()
        self.assertEqual(self.client.patch(f"/api/meetings/{original['id']}", json={"company_id": "missing"}).status_code, 422)
        self.assertEqual(path.read_bytes(), before)
        response = self.client.post("/api/meetings", json={"title": "잘못된 회의", "date": "2026-09-28", "company_id": "missing"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(len(self.vault.list_meetings()), 1)

    def test_legacy_meetings_are_unassigned_until_explicitly_linked(self):
        original = self.meeting()
        note = self.vault.find_by_id("meeting", original["id"])
        note.metadata.pop("company_id")
        note.metadata.pop("company_name")
        note.path.write_text(storage.render_note(note.metadata, note.body), encoding="utf-8")
        before = note.path.read_bytes()
        legacy = self.client.get("/api/meetings?company_id=").json()["items"]
        self.assertEqual(legacy[0]["company_id"], "")
        self.assertEqual(legacy[0]["company_name"], "")
        self.assertEqual(note.path.read_bytes(), before)
        company = self.company()
        updated = self.client.patch(f"/api/meetings/{original['id']}", json={"company_id": company["id"]}).json()
        self.assertEqual(updated["company_name"], company["name"])
        self.assertEqual(updated["images"], original["images"])
        self.assertEqual(updated["path"], original["path"])
        self.client.delete(f"/api/meetings/{original['id']}")
        self.assertEqual(self.client.get("/api/meetings", params={"company_id": company["id"]}).json()["items"], [])


if __name__ == "__main__":
    unittest.main()
