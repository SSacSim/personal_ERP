from contextlib import ExitStack
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import auth, storage, vault_answer
from app.main import app
from app.routers import attendance, calendar, dashboard, meetings, projects, tasks, todos
from auth_support import authorize


DAY = "2026-09-28"


class PrivateWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.vault = storage.ObsidianVault(self.root / "Notes")
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", self.vault.root))
        for module in (attendance, calendar, dashboard, meetings, projects, tasks, todos, vault_answer):
            self.stack.enter_context(patch.object(module, "vault", self.vault))
        # Search tests must never scan the real workspace or its notes.
        self.stack.enter_context(patch.object(vault_answer, "BASE_DIR", self.root))
        self.stack.enter_context(patch.object(vault_answer, "DOCS_DIR", self.root / "docs"))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        self.accounts = authorize(self.client, self.stack, self.root)
        self.admin = self.accounts.list_users()[0]
        self.a = self.accounts.create_user("alice", "test-password-a", "동명이인", "대리")
        self.b = self.accounts.create_user("bob", "test-password-b", "동명이인", "대리")
        self.login(self.a)

    def login(self, user):
        self.client.cookies.clear()
        self.client.cookies.set(auth.COOKIE_NAME, self.accounts.create_session(user["id"]))

    def post(self, route, data):
        response = self.client.post(route, json=data)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def task(self, title="Alice private task", **extra):
        return self.post("/api/tasks", {"title": title, "start_date": DAY, "end_date": DAY, **extra})

    def todo(self, title="Alice private todo", **extra):
        return self.post("/api/todos", {"title": title, "date": DAY, **extra})

    def test_same_name_accounts_have_separate_lists_dashboard_and_ordering(self):
        task_a, todo_a = self.task(), self.todo()
        self.assertEqual(task_a["user_id"], self.a["id"])
        self.assertEqual(todo_a["user_id"], self.a["id"])
        self.login(self.b)
        self.assertEqual(self.client.get("/api/tasks").json()["items"], [])
        self.assertEqual(self.client.get(f"/api/todos?date={DAY}").json()["items"], [])
        task_b, todo_b = self.task("Bob task"), self.todo("Bob todo")
        self.assertEqual(int(task_b["order"]), 0)
        self.assertEqual(int(todo_b["order"]), 0)
        for user, task, todo in ((self.a, task_a, todo_a), (self.b, task_b, todo_b)):
            self.login(user)
            data = self.client.get(f"/api/dashboard?date={DAY}").json()
            self.assertEqual([entry["id"] for entry in data["active_tasks"]], [task["id"]])
            self.assertEqual([entry["id"] for entry in data["todos"]], [todo["id"]])
            self.assertEqual(data["counts"]["active_tasks"], 1)
            self.assertEqual(data["counts"]["todos_total"], 1)
        self.login(self.admin)
        data = self.client.get(f"/api/dashboard?date={DAY}").json()
        self.assertEqual(data["todos"], [])
        self.assertEqual(data["active_tasks"], [])

    def test_other_account_ids_cannot_be_edited_deleted_or_parented(self):
        task_a, todo_a = self.task(), self.todo()
        originals = {entry["path"]: (self.vault.root / entry["path"]).read_bytes() for entry in (task_a, todo_a)}
        for user in (self.b, self.admin):
            self.login(user)
            for resource, entry in (("tasks", task_a), ("todos", todo_a)):
                url = f"/api/{resource}/{entry['id']}"
                self.assertEqual(self.client.patch(url, json={"title": "stolen"}).status_code, 404)
                self.assertEqual(self.client.delete(url).status_code, 404)
            response = self.client.post("/api/tasks", json={"title": "child", "start_date": DAY, "end_date": DAY, "parent_id": task_a["id"]})
            self.assertEqual(response.status_code, 422)
            own = self.task("Own task")
            self.assertEqual(self.client.patch(f"/api/tasks/{own['id']}", json={"parent_id": task_a["id"]}).status_code, 422)
        for path, original in originals.items():
            self.assertEqual((self.vault.root / path).read_bytes(), original)

    def test_owner_is_display_only_and_identity_spoofing_is_rejected(self):
        task = self.task(owner=self.b["name"])
        self.assertEqual(task["user_id"], self.a["id"])
        response = self.client.patch(f"/api/tasks/{task['id']}", json={"owner": "Someone else"})
        self.assertEqual(response.json()["user_id"], self.a["id"])
        for route, data in (("tasks", {"title": "fake", "start_date": DAY, "end_date": DAY}),
                            ("todos", {"title": "fake", "date": DAY})):
            self.assertEqual(self.client.post(f"/api/{route}", json={**data, "user_id": self.b["id"]}).status_code, 422)
        self.assertEqual(self.client.patch(f"/api/tasks/{task['id']}", json={"user_id": self.b["id"]}).status_code, 422)
        todo = self.todo()
        self.assertEqual(self.client.patch(f"/api/todos/{todo['id']}", json={"user_id": self.b["id"]}).status_code, 422)

    def test_own_crud_and_task_cascade_preserve_other_users(self):
        parent = self.task()
        child = self.task("Child", parent_id=parent["id"])
        self.assertEqual(self.client.patch(f"/api/tasks/{parent['id']}", json={"parent_id": child["id"]}).status_code, 422)
        self.assertEqual(self.client.patch(f"/api/tasks/{child['id']}", json={"status": "done"}).status_code, 200)
        self.login(self.b)
        other = self.task("Other user")
        self.login(self.a)
        self.assertEqual(self.client.delete(f"/api/tasks/{parent['id']}").status_code, 200)
        self.assertEqual(self.client.get("/api/tasks").json()["items"], [])
        self.assertFalse(self.vault.find_by_id("work_task", other["id"]).metadata.get("deleted"))
        todo = self.todo()
        self.assertEqual(self.client.patch(f"/api/todos/{todo['id']}", json={"completed": True}).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/todos/{todo['id']}").status_code, 200)

    def test_mixed_account_reorder_rejects_every_write(self):
        a1, a2 = self.todo(), self.todo("Second")
        self.login(self.b)
        b1 = self.todo("Bob")
        originals = {entry["path"]: (self.vault.root / entry["path"]).read_bytes() for entry in (a1, a2, b1)}
        self.login(self.a)
        response = self.client.post("/api/todos/reorder", json={"ids": [a2["id"], b1["id"], a1["id"]]})
        self.assertEqual(response.status_code, 404)
        for path, original in originals.items():
            self.assertEqual((self.vault.root / path).read_bytes(), original)
        response = self.client.post("/api/todos/reorder", json={"ids": [a2["id"], a1["id"]]})
        self.assertEqual([entry["id"] for entry in response.json()["items"]], [a2["id"], a1["id"]])

    def test_rollover_and_completion_are_private(self):
        a = self.todo(date="2026-09-27")
        self.login(self.b)
        b = self.todo("Bob earlier", date="2026-09-27")
        original = (self.vault.root / b["path"]).read_bytes()
        self.login(self.a)
        self.client.get(f"/api/dashboard?date={DAY}")
        rolled = self.client.get(f"/api/todos?date={DAY}").json()["items"]
        self.assertEqual(len(rolled), 1)
        self.assertEqual(rolled[0]["source_id"], a["id"])
        self.assertEqual(rolled[0]["user_id"], self.a["id"])
        self.assertEqual(self.client.post(f"/api/todos/rollover?date={DAY}").json()["items"], [])
        self.client.patch(f"/api/todos/{rolled[0]['id']}", json={"completed": True})
        self.assertTrue(self.vault.find_by_id("todo", a["id"]).metadata["completed"])
        self.assertEqual((self.vault.root / b["path"]).read_bytes(), original)

    def test_weekly_reports_and_search_exclude_other_private_records(self):
        self.task("Alpha secret task")
        self.todo("Alpha secret todo")
        report_a = self.client.post(f"/api/todos/weekly-report?week_start={DAY}").json()
        self.assertEqual(report_a["user_id"], self.a["id"])
        self.assertIn("Alpha secret todo", report_a["body"])
        self.login(self.b)
        self.task("Beta private task")
        self.todo("Beta private todo")
        report_b = self.client.post(f"/api/todos/weekly-report?week_start={DAY}").json()
        self.assertNotIn("Alpha secret", report_b["body"])
        self.assertNotIn("Alpha secret", todos.weekly_report_context(date.fromisoformat(DAY), self.b["id"]))
        sources = vault_answer.iter_vault_sources(self.b["id"])
        self.assertNotIn(report_a["id"], [s.metadata.get("id") for s in sources])
        self.assertIn(report_b["id"], [s.metadata.get("id") for s in sources])
        response = self.client.post("/api/chat/ask", json={"question": "Alpha secret"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Alpha secret", response.text)
        own = self.client.post("/api/chat/ask", json={"question": "Beta private"}).json()
        self.assertIn("Beta private", own["answer"])
        self.assertEqual(own["mode"], "vault_search")

    def test_legacy_migration_preserves_content_and_is_idempotent(self):
        old = []
        for note_type in storage.PRIVATE_NOTE_TYPES:
            metadata = {"title": "Legacy", "deleted": True}
            if note_type == "todo":
                metadata["user_id"] = ""
            note = self.vault.write(note_type, "Legacy", metadata, "# Legacy\n\noriginal history")
            old.append((note, note.body, dict(note.metadata)))
        own = self.todo()
        original = (self.vault.root / own["path"]).read_bytes()
        self.assertEqual(self.vault.migrate_private_notes(self.admin["id"]), 3)
        self.assertEqual(self.vault.migrate_private_notes(self.b["id"]), 0)
        for before, body, metadata in old:
            after = self.vault.read(before.path)
            self.assertEqual(after.body, body)
            self.assertEqual(after.metadata, {**metadata, "user_id": self.admin["id"]})
            self.assertEqual(before.path.read_text(encoding="utf-8").count("user_id:"), 1)
        self.assertEqual((self.vault.root / own["path"]).read_bytes(), original)

    def test_unassigned_private_notes_are_not_shared_by_search(self):
        for note_type in storage.PRIVATE_NOTE_TYPES:
            self.vault.write(note_type, "UnassignedSecret", {"title": "UnassignedSecret"}, "secret content")
        (self.vault.root / "Tasks" / "no-frontmatter.md").write_text("# UnassignedSecret", encoding="utf-8")
        self.assertFalse(any(s.title == "UnassignedSecret" for s in vault_answer.iter_vault_sources(self.a["id"])))

    def test_public_notes_and_dashboard_remain_shared(self):
        project = self.post("/api/projects", {"name": "Shared project"})
        event = self.post("/api/calendar/events", {"title": "Team event", "date": DAY})
        meeting = self.post("/api/meetings", {"title": "Team meeting", "date": DAY})
        reference = self.post("/api/meetings", {"title": "Shared reference", "date": "2026-09-29", "notes": "Shared team knowledge"})
        leave = self.post("/api/attendance", {"kind": "annual_leave", "start_date": DAY})
        self.login(self.b)
        for url, item in (("/api/projects", project), (f"/api/calendar?date={DAY}", event),
                          ("/api/meetings", meeting), ("/api/meetings", reference), ("/api/attendance", leave)):
            self.assertIn(item["id"], [entry["id"] for entry in self.client.get(url).json()["items"]])
        data = self.client.get(f"/api/dashboard?date={DAY}").json()
        self.assertEqual(data["counts"]["meetings_today"], 1)
        self.assertEqual(data["counts"]["active_projects"], 1)
        self.assertEqual(data["counts"]["absence_people"], 1)
        shared = self.client.post("/api/chat/ask", json={"question": "Shared reference"}).json()
        self.assertTrue(any(s["title"] == "Shared reference" for s in shared["sources"]))

    def test_filesystem_capable_ai_is_not_invoked_even_when_enabled(self):
        with patch.dict("os.environ", {"GAI_ERP_USE_CODEX_SDK": "1"}), patch("openai_codex.Codex") as sdk:
            self.assertIsNone(vault_answer.answer_with_codex_sdk("Read another user's task file"))
            sdk.assert_not_called()


if __name__ == "__main__":
    unittest.main()
