from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import storage
from app.routers import meetings, wiki


class DocumentEditingTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", self.root))
        self.vault = storage.ObsidianVault(self.root)
        self.stack.enter_context(patch.object(meetings, "vault", self.vault))
        self.stack.enter_context(patch.object(wiki, "vault", self.vault))
        app = FastAPI()
        app.include_router(meetings.router)
        app.include_router(wiki.router)
        self.client = self.stack.enter_context(TestClient(app))
        self.images = [{"name": "기존 그림.png", "url": "/api/assets/example.png", "content_type": "image/png"}]

    def create_meeting(self):
        response = self.client.post("/api/meetings", json={
            "title": "기존 회의", "date": "2026-09-26", "start_time": "10:30", "project_id": "linked-project",
            "attendees": ["가이", "동료"], "agenda": "- 원래 안건\n\n## 안건 상세\n세부 검토",
            "notes": "- 첫 번째 결정\n\n## 세부 논의\n- 두 번째 결정\n\n![기존 그림|60](/api/assets/example.png)",
            "images": self.images,
        })
        self.assertEqual(response.status_code, 201)
        return response.json()

    def test_meeting_metadata_edit_keeps_agenda_nested_headings_and_history(self):
        original = self.create_meeting()
        result = self.client.patch(f"/api/meetings/{original['id']}", json={"title": "수정 회의", "start_time": None})
        self.assertEqual(result.status_code, 200)
        updated = result.json()
        self.assertEqual(updated["id"], original["id"])
        self.assertEqual(updated["path"], original["path"])
        self.assertEqual(updated["project_id"], "linked-project")
        self.assertEqual(updated["start_time"], "")
        self.assertEqual(updated["images"], self.images)
        for heading in ["안건", "회의 내용"]:
            self.assertEqual(self.vault.meeting_section(updated["body"], heading), self.vault.meeting_section(original["body"], heading))
        self.assertIn("- 두 번째 결정", updated["body"])
        self.assertIn("![기존 그림|60]", updated["body"])
        history = storage.split_change_log(updated["body"])[1]
        self.assertIn("| 등록", history)
        self.assertIn("| 수정", history)
        second = self.client.patch(f"/api/meetings/{original['id']}", json={"attendees": ["가이", "새 참석자"]}).json()
        self.assertEqual(storage.split_change_log(second["body"])[1].count("| 수정"), 2)
        self.assertEqual(len(self.client.get("/api/meetings").json()["items"]), 1)

    def test_explicit_meeting_content_edit_preserves_record_and_link(self):
        original = self.create_meeting()
        response = self.client.patch(f"/api/meetings/{original['id']}", json={
            "title": "회의 내용 수정", "date": "2026-09-27", "start_time": "", "attendees": [],
            "agenda": "새 안건", "notes": "새 내용\n\n## 다음 단계\n- 검토", "images": [],
        })
        self.assertEqual(response.status_code, 200)
        updated = response.json()
        self.assertEqual(updated["created_at"], original["created_at"])
        self.assertEqual(updated["project_id"], original["project_id"])
        self.assertEqual(updated["images"], [])
        self.assertEqual(self.vault.meeting_section(updated["body"], "회의 내용"), "새 내용\n\n## 다음 단계\n- 검토")
        self.assertEqual(self.client.patch(f"/api/meetings/{original['id']}", json={"title": ""}).status_code, 422)

    def test_wiki_edit_preserves_id_project_images_and_reloads_from_disk(self):
        original = self.client.post("/api/wiki", json={
            "title": "원래 위키", "project_id": "linked-project", "category": "운영", "tags": ["배포"],
            "content": "기존 문서\n\n![기존 그림|60](/api/assets/example.png)", "images": self.images,
        }).json()
        content = "수정한 문서\n\n## 체크리스트\n- 첫 항목\n\n![기존 그림|60](/api/assets/example.png)"
        response = self.client.patch(f"/api/wiki/{original['id']}", json={"title": "개정 위키", "category": "팀 지식", "tags": ["운영", "검토"], "content": content})
        self.assertEqual(response.status_code, 200)
        updated = response.json()
        self.assertEqual(updated["id"], original["id"])
        self.assertEqual(updated["project_id"], original["project_id"])
        self.assertEqual(updated["images"], self.images)
        self.assertIn(content, updated["body"])
        reopened = storage.ObsidianVault(self.root).list_wiki_pages()
        self.assertEqual(len(reopened), 1)
        self.assertEqual(reopened[0], updated)

    def test_missing_document_returns_404_instead_of_creating_new_note(self):
        for path in ["meetings", "wiki"]:
            self.assertEqual(self.client.patch(f"/api/{path}/missing", json={"title": "수정"}).status_code, 404)
            self.assertEqual(self.client.get(f"/api/{path}").json()["items"], [])


if __name__ == "__main__":
    unittest.main()
