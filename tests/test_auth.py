import base64
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from app import auth, auth_store, storage
from app.auth_store import AuthStore, hash_password, verify_password
from app.main import app
from app.pomodoro import PomodoroStore
from app.receipts import ReceiptStore
from app.remote_work import RemoteWorkStore
from app.routers import pomodoro, receipts, remote_work, team_chat, tasks, projects
from app.storage import ObsidianVault
from app.team_chat import ChatStore


class AuthenticationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_hash = hash_password("test-admin-password")

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.stack.enter_context(patch.object(auth_store, "INITIAL_ADMIN_HASH", self.admin_hash))
        self.store = AuthStore(self.root / "Auth")
        self.store.ensure()
        self.stack.enter_context(patch.object(auth, "store", self.store))
        self.admin = self.store.list_users()[0]
        for module, store_type, folder in [(receipts, ReceiptStore, "Receipts"), (remote_work, RemoteWorkStore, "RemoteWork"),
                                            (pomodoro, PomodoroStore, "Pomodoro"), (team_chat, ChatStore, "Chat")]:
            isolated = store_type(self.root / folder)
            if isinstance(isolated, ChatStore):
                isolated.ensure()
            self.stack.enter_context(patch.object(module, "store", isolated))
        vault = ObsidianVault(self.root / "Notes")
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", vault.root))
        vault.ensure()
        for module in (tasks, projects):
            self.stack.enter_context(patch.object(module, "vault", vault))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)

    def as_user(self, user=None):
        user = user or self.admin
        self.client.cookies.clear()
        self.client.cookies.set(auth.COOKIE_NAME, self.store.create_session(user["id"]))
        return user

    def employee(self, login_id="member", name="김민수"):
        return self.store.create_user(login_id, "test-member-password", name, "대리")

    def test_protected_pages_apis_and_attachments_require_login(self):
        for path in ["/", "/admin", "/dashboard", "/chat", "/receipt-upload", "/remote-work", "/docs"]:
            with self.subTest(path=path):
                response = self.client.get(path, follow_redirects=False)
                self.assertEqual(response.status_code, 303)
                self.assertTrue(response.headers["location"].startswith("/login?next="))
        for method, path in [("GET", "/api/auth/me"), ("GET", "/api/admin/users"), ("GET", "/api/id-info"),
                             ("GET", "/api/receipts/any/image"), ("POST", "/api/receipts"),
                             ("GET", "/api/team-chat/messages"), ("POST", "/api/team-chat/join"),
                             ("GET", "/api/team-chat/files/any/download"), ("GET", "/api/remote-work/files/any/download"),
                             ("PUT", "/api/pomodoro/history/any"), ("GET", "/api/assets/any")]:
            self.assertEqual(self.client.request(method, path, headers={"Authorization": "Bearer old-chat-token"}).status_code, 401)
        self.assertEqual(self.client.get("/login").status_code, 200)
        self.assertEqual(self.client.get("/static/auth-state.js").status_code, 200)

    def test_admin_login_landing_cookie_logout_and_expiry(self):
        result = self.client.post("/api/auth/login", json={"login_id": "admin", "password": "test-admin-password"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["redirect"], "/admin")
        self.assertNotIn("password", result.text)
        cookie = result.headers["set-cookie"].lower()
        self.assertIn("httponly", cookie)
        self.assertIn("samesite=lax", cookie)
        token = self.client.cookies.get(auth.COOKIE_NAME)
        self.assertEqual(self.client.get("/", follow_redirects=False).headers["location"], "/admin")
        self.assertIn('id="user-form"', self.client.get("/admin").text)
        self.assertEqual(self.client.get("/api/auth/me").json()["user"]["name"], "관리자")
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 204)
        self.assertIsNone(self.store.user_from_session(token))
        self.assertEqual(self.client.get("/api/auth/me").status_code, 401)
        self.as_user()
        with self.store.connect() as db:
            db.execute("UPDATE sessions SET expires_at = 0")
        self.assertEqual(self.client.get("/api/auth/me").status_code, 401)

    def test_admin_registers_user_and_passwords_never_leave_server(self):
        self.as_user()
        payload = {"login_id": "Member.One", "password": "test-new-password", "name": " 김민수 ", "job_title": " 대리 "}
        result = self.client.post("/api/admin/users", json=payload)
        self.assertEqual(result.status_code, 201, result.text)
        created = result.json()
        self.assertEqual((created["name"], created["job_title"], created["role"]), ("김민수", "대리", "user"))
        listing = self.client.get("/api/admin/users")
        self.assertEqual(len(listing.json()["items"]), 2)
        self.assertNotIn("password", listing.text)
        self.assertNotIn(payload["password"], result.text)
        with self.store.connect() as db:
            encoded = db.execute("SELECT password_hash FROM users WHERE id = ?", (created["id"],)).fetchone()[0]
        self.assertNotEqual(encoded, payload["password"])
        self.assertTrue(verify_password(payload["password"], encoded))
        self.assertEqual(self.client.post("/api/admin/users", json={**payload, "login_id": "member.one"}).status_code, 409)
        invalid = self.client.post("/api/admin/users", json={**payload, "role": "admin"})
        self.assertEqual(invalid.status_code, 422)
        self.assertNotIn(payload["password"], invalid.text)
        self.client.post("/api/auth/logout")
        signed_in = self.client.post("/api/auth/login", json={"login_id": "MEMBER.ONE", "password": payload["password"]})
        self.assertEqual(signed_in.json()["redirect"], "/dashboard")
        self.assertEqual(self.client.get("/dashboard").status_code, 200)
        for path in ["/admin", "/api/admin/users"]:
            self.assertEqual(self.client.get(path).status_code, 403)
        self.assertEqual(self.client.post("/api/admin/users", json=payload).status_code, 403)

    def test_bad_login_validation_rate_limit_and_restart(self):
        for login_id in ["admin", "unknown"]:
            result = self.client.post("/api/auth/login", json={"login_id": login_id, "password": "incorrect-password"})
            self.assertEqual(result.status_code, 401)
            self.assertNotIn("incorrect-password", result.text)
            self.assertNotIn(auth.COOKIE_NAME, self.client.cookies)
        with patch.object(auth_store, "verify_password", return_value=False):
            for _ in range(9):
                self.assertEqual(self.client.post("/api/auth/login", json={"login_id": "admin", "password": "wrong"}).status_code, 401)
            self.assertEqual(self.client.post("/api/auth/login", json={"login_id": "admin", "password": "wrong"}).status_code, 429)
        with patch.object(auth_store.time, "time", return_value=time.time() + 901):
            self.assertIsNotNone(self.store.authenticate("admin", "test-admin-password", "testclient"))
        member = self.employee()
        token = self.store.create_session(member["id"])
        reopened = AuthStore(self.store.root)
        reopened.ensure()
        self.assertEqual(reopened.list_users(), self.store.list_users())
        self.assertEqual(reopened.user_from_session(token), member)
        with reopened.connect() as db:
            self.assertNotEqual(db.execute("SELECT token_hash FROM sessions").fetchone()[0], token)
        self.assertNotEqual(hash_password("same-password"), hash_password("same-password"))

    def test_origin_and_stale_tab_identity_are_checked(self):
        user = self.as_user()
        self.assertEqual(self.client.post("/api/auth/logout", headers={"Origin": "https://different.example"}).status_code, 403)
        self.assertEqual(self.client.post("/api/auth/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code, 403)
        self.assertEqual(self.client.get("/api/auth/me", headers={"X-ERP-User": user["id"]}).status_code, 200)
        changed = self.client.post("/api/remote-work", json={}, headers={"X-ERP-User": "previous-account"})
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(changed.headers["X-ERP-Account-Changed"], "1")
        self.assertEqual(self.client.post("/api/auth/logout", headers={"Origin": "http://testserver"}).status_code, 204)

    def test_identity_is_derived_for_receipts_remote_work_and_chat(self):
        member = self.employee()
        self.as_user(member)
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
        receipt = self.client.post("/api/receipts", json={"submission_id": str(uuid4()), "registrant": "사칭", "content": "식비", "filename": "receipt.png", "image_base64": png})
        self.assertEqual(receipt.status_code, 201, receipt.text)
        self.assertEqual(receipt.json()["registrant"], member["name"])
        self.assertEqual(self.client.get(receipt.json()["image_url"]).content, base64.b64decode(png))
        remote = self.client.post("/api/remote-work", json={"work_date": "2026-09-28", "content": "재택 업무"})
        self.assertEqual(remote.status_code, 201, remote.text)
        self.assertEqual(remote.json()["author"], member["name"])
        session = self.client.get("/api/team-chat/session").json()["participant"]
        self.assertEqual(session["name"], member["name"])
        self.assertEqual(session["job_title"], member["job_title"])
        sent = self.client.post("/api/team-chat/messages", json={"text": "안녕하세요", "client_id": str(uuid4())})
        self.assertEqual(sent.json()["sender_name"], member["name"])
        self.assertEqual(sent.json()["sender_job_title"], member["job_title"])
        self.assertEqual(self.client.patch("/api/team-chat/session", json={"name": "사칭"}).status_code, 405)
        self.client.post("/api/auth/logout")
        self.as_user(member)
        self.assertEqual(self.client.get("/api/team-chat/session").json()["participant"], session)
        self.as_user()
        edited = self.client.patch(f"/api/remote-work/{remote.json()['id']}", json={"content": "내용 수정", "author": "사칭"})
        self.assertEqual(edited.json()["author"], member["name"])
        self.assertEqual(self.client.delete(f"/api/team-chat/messages/{sent.json()['id']}").status_code, 403)

    def test_pomodoro_is_bound_to_the_account_even_when_names_match(self):
        member = self.employee()
        self.as_user(member)
        now = int(time.time() * 1000)
        payload = {"person": "사칭", "duration_ms": 60000, "remaining_ms": 60000, "status": "running", "started_at": now, "ends_at": now + 60000, "revision": 1}
        path = f"/api/pomodoro/history/{uuid4()}"
        result = self.client.put(path, json=payload)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["person"], member["name"])
        self.as_user(self.employee("same-name", member["name"]))
        self.assertEqual(self.client.put(path, json={**payload, "revision": 2}).status_code, 403)
        self.as_user(member)
        self.assertEqual(self.client.put(path, json={**payload, "status": "paused", "ends_at": None, "revision": 2}).status_code, 200)

    def test_default_task_project_owner_allows_intentional_assignment(self):
        user = self.as_user(self.employee())
        for endpoint, payload in [("/api/tasks", {"title": "새 작업", "start_date": "2026-09-28", "end_date": "2026-09-28"}),
                                  ("/api/projects", {"name": "새 프로젝트"})]:
            result = self.client.post(endpoint, json=payload)
            self.assertEqual(result.status_code, 201, result.text)
            self.assertEqual(result.json()["owner"], user["name"])
            assigned = self.client.post(endpoint, json={**payload, "owner": "다른 팀원"})
            self.assertEqual(assigned.json()["owner"], "다른 팀원")


if __name__ == "__main__":
    unittest.main()
