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
from app.routers import companies, meetings, projects


class MeetingCompanyTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", self.root))
        self.vault = storage.ObsidianVault(self.root)
        self.stack.enter_context(patch.object(companies, "vault", self.vault))
        self.stack.enter_context(patch.object(meetings, "vault", self.vault))
        self.stack.enter_context(patch.object(projects, "vault", self.vault))
        app = FastAPI()
        app.include_router(companies.router)
        app.include_router(meetings.router)
        app.include_router(projects.router)
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

    def project(self, company_name="한빛 주식회사"):
        response = self.client.post("/api/projects", json={"name": "도입 프로젝트", "company_name": company_name})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_project_meetings_automatically_register_and_share_the_project_company(self):
        project = self.project()
        first = self.meeting(project_id=project["id"])
        second = self.meeting(project_id=project["id"], company_id="")
        self.assertTrue(first["company_id"])
        self.assertEqual(first["company_id"], second["company_id"])
        self.assertEqual(first["company_name"], project["company_name"])
        self.assertEqual(self.client.get("/api/companies").json()["items"], [{"id": first["company_id"], "name": project["company_name"]}])
        project_items = self.client.get("/api/meetings", params={"project_id": project["id"]}).json()["items"]
        company_items = self.client.get("/api/meetings", params={"company_id": first["company_id"]}).json()["items"]
        all_items = self.client.get("/api/meetings").json()["items"]
        self.assertEqual(project_items, company_items)
        self.assertEqual(company_items, all_items)
        self.assertEqual(len(list((self.root / "Meetings").glob("*.md"))), 2)
        reopened = storage.ObsidianVault(self.root)
        self.assertEqual(reopened.list_meetings(company_id=first["company_id"]), all_items)

    def test_project_company_reuses_normalized_registry_names_and_honors_explicit_selection(self):
        company = self.company("ACME Korea")
        project = self.project(" ＡＣＭＥ   korea ")
        original = self.meeting(project_id=project["id"])
        self.assertEqual(original["company_id"], company["id"])
        self.assertEqual(original["company_name"], company["name"])
        other = self.company("다른 회사")
        selected = self.meeting(project_id=project["id"], company_id=other["id"])
        self.assertEqual(selected["company_id"], other["id"])
        restored = self.client.patch(f"/api/meetings/{selected['id']}", json={"company_id": ""}).json()
        self.assertEqual(restored["company_id"], company["id"])
        self.assertEqual(len(self.client.get("/api/companies").json()["items"]), 2)

    def test_shared_project_meeting_edits_and_deletion_use_one_document(self):
        project = self.project()
        original = self.meeting(project_id=project["id"])
        url = f"/api/meetings/{original['id']}"
        # The standalone editor omits project_id; retain the project connection.
        updated = self.client.patch(url, json={"title": "공통 회의록에서 수정", "notes": "수정 본문", "company_id": original["company_id"]}).json()
        for key in ["id", "path", "created_at", "project_id", "company_id", "images"]:
            self.assertEqual(updated[key], original[key])
        self.assertEqual(self.vault.list_meetings(project_id=project["id"]), [updated])
        from_project = self.client.patch(url, json={"project_id": project["id"], "company_id": "", "agenda": "프로젝트에서 수정"}).json()
        self.assertEqual(self.vault.list_meetings(company_id=original["company_id"]), [from_project])
        self.assertEqual(len(list((self.root / "Meetings").glob("*.md"))), 1)
        self.assertEqual(self.client.delete(url).status_code, 200)
        self.assertEqual(self.vault.list_meetings(project_id=project["id"]), [])
        self.assertEqual(self.vault.list_meetings(company_id=original["company_id"]), [])

    def test_legacy_project_company_migration_preserves_document_and_runs_once(self):
        project = self.project()
        original = self.meeting()
        note = self.vault.find_by_id("meeting", original["id"])
        note.metadata["project_id"] = project["id"]
        note.metadata.pop("company_id")
        note.metadata.pop("company_name")
        note.path.write_text(storage.render_note(note.metadata, note.body), encoding="utf-8")
        # A manually assigned company must survive the migration.
        other = self.company("직접 선택한 회사")
        explicit = self.meeting(project_id=project["id"], company_id=other["id"])
        explicit_path = self.vault.find_by_id("meeting", explicit["id"]).path
        explicit_bytes = explicit_path.read_bytes()
        self.assertEqual(self.vault.migrate_project_meeting_companies(), 1)
        migrated = self.vault.find_by_id("meeting", original["id"])
        self.assertEqual(migrated.metadata["company_name"], project["company_name"])
        for key in ["id", "created_at", "updated_at", "images", "attendees", "project_id"]:
            self.assertEqual(migrated.metadata[key], note.metadata[key])
        self.assertEqual(migrated.body, note.body)
        self.assertEqual(migrated.path, note.path)
        self.assertEqual(explicit_path.read_bytes(), explicit_bytes)
        before = migrated.path.read_bytes()
        self.assertEqual(self.vault.migrate_project_meeting_companies(), 0)
        self.assertEqual(migrated.path.read_bytes(), before)
        self.assertEqual(len(self.vault.list_meetings(company_id=migrated.metadata["company_id"])), 1)

    def test_projects_without_company_and_missing_projects_remain_unassigned(self):
        project = self.project("")
        for project_id in [project["id"], "missing", None]:
            with self.subTest(project_id=project_id):
                meeting = self.meeting(project_id=project_id)
                self.assertEqual(meeting["company_id"], "")
                self.assertEqual(meeting["company_name"], "")
        self.assertEqual(self.vault.migrate_project_meeting_companies(), 0)
        self.assertEqual(self.client.get("/api/companies").json()["items"], [])

    def test_failed_legacy_link_keeps_original_note_and_can_be_retried(self):
        project = self.project()
        original = self.meeting()
        note = self.vault.find_by_id("meeting", original["id"])
        note.metadata["project_id"] = project["id"]
        note.path.write_text(storage.render_note(note.metadata, note.body), encoding="utf-8")
        before = note.path.read_bytes()
        for method in ["write_text", "replace"]:
            with self.subTest(method=method), patch.object(Path, method, side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    self.vault.migrate_project_meeting_companies()
            self.assertEqual(note.path.read_bytes(), before)
            self.assertEqual(list(note.path.parent.iterdir()), [note.path])
        self.assertEqual(self.vault.migrate_project_meeting_companies(), 1)
        self.assertEqual(self.vault.find_by_id("meeting", original["id"]).body, note.body)

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
