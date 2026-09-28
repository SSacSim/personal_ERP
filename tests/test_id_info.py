from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth, auth_store
from app.auth_store import hash_password
from app.id_info import IdInfoStore
from app.routers import id_info
from auth_support import authorize


class IdInfoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.access_password = "test-info-access-password"
        cls.access_hash = hash_password(cls.access_password)

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory())) / "IdInfo"
        self.store = IdInfoStore(self.root)
        self.stack.enter_context(patch.object(id_info, "store", self.store))
        self.stack.enter_context(patch.object(auth_store, "INFO_ACCESS_HASH", self.access_hash))
        app = FastAPI()
        app.add_middleware(auth.AuthenticationMiddleware)
        app.include_router(id_info.router)
        self.client = self.stack.enter_context(TestClient(app))
        self.accounts = authorize(self.client, self.stack, self.root.parent)
        self.admin = self.accounts.list_users()[0]
        self.session = self.client.cookies.get(auth.COOKIE_NAME)
        self.unlock()

    def unlock(self):
        response = self.client.post("/api/id-info/unlock", json={"password": self.access_password})
        self.assertEqual(response.status_code, 200, response.text)
        self.access_token = response.json()["token"]
        self.client.headers["X-ERP-Info-Token"] = self.access_token
        return response

    def create(self, **changes):
        response = self.client.post("/api/id-info", json={
            "category": "회사 메일", "login_id": "shared@example.test", "password": "  Test<&>Pwd!  ",
            "notes": "접속 주소: https://example.test\n회사 공용 계정", **changes,
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_create_list_masked_password_and_restart(self):
        item = self.create()
        self.assertTrue(item["has_password"])
        self.assertNotIn("password", item)
        with patch.object(id_info, "store", IdInfoStore(self.root)):
            response = self.client.get("/api/id-info")
            self.assertEqual(response.json()["items"], [item])
            self.assertNotIn("Test<&>Pwd", response.text)
            secret = self.client.get(f"/api/id-info/{item['id']}/password")
        self.assertEqual(secret.json(), {"password": "  Test<&>Pwd!  "})
        for response in [response, secret]:
            self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertTrue((self.root / "id-info.sqlite3").exists())

    def test_edit_preserves_omitted_password_and_allows_explicit_clear(self):
        item = self.create()
        path = f"/api/id-info/{item['id']}"
        changed = self.client.patch(path, json={"category": "  NAS  ", "notes": "새 접속 정보"}).json()
        self.assertEqual(changed["category"], "NAS")
        self.assertEqual(changed["notes"], "새 접속 정보")
        self.assertEqual(changed["created_at"], item["created_at"])
        self.assertEqual(changed["login_id"], item["login_id"])
        self.assertEqual(self.client.get(path + "/password").json()["password"], "  Test<&>Pwd!  ")
        self.assertEqual(self.client.patch(path, json={"password": "new password"}).status_code, 200)
        self.assertEqual(self.client.get(path + "/password").json()["password"], "new password")
        cleared = self.client.patch(path, json={"password": "", "login_id": "", "notes": ""}).json()
        self.assertFalse(cleared["has_password"])
        self.assertEqual(cleared["login_id"], "")
        self.assertEqual(cleared["notes"], "")
        self.assertEqual(self.client.get(path + "/password").json()["password"], "")

    def test_category_only_can_store_miscellaneous_information(self):
        response = self.client.post("/api/id-info", json={"category": "업무 연락처", "notes": "내선 123"})
        self.assertEqual(response.status_code, 201)
        item = response.json()
        self.assertEqual(item["login_id"], "")
        self.assertFalse(item["has_password"])

    def test_delete_and_missing_records(self):
        item = self.create()
        path = f"/api/id-info/{item['id']}"
        response = self.client.delete(path)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/api/id-info").json()["items"], [])
        for response in [self.client.delete(path), self.client.patch(path, json={"notes": "수정"}), self.client.get(path + "/password")]:
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_invalid_fields_never_echo_submitted_password(self):
        for changes in [
            {"category": "   "}, {"category": "a" * 101}, {"login_id": "a" * 201},
            {"password": "PRIVATE-TEST-PASSWORD" * 60}, {"notes": "a" * 4001}, {"unknown": "field"},
        ]:
            with self.subTest(field=next(iter(changes))):
                response = self.client.post("/api/id-info", json={"category": "공용 계정", "password": "PRIVATE-TEST-PASSWORD", **changes})
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("PRIVATE-TEST-PASSWORD", response.text)
                self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/api/id-info").json()["items"], [])
        item = self.create()
        self.assertEqual(self.client.patch(f"/api/id-info/{item['id']}", json={"category": " "}).status_code, 422)
        self.assertEqual(self.client.get("/api/id-info").json()["items"], [item])

    def test_concurrent_additions_are_not_lost(self):
        def save(number):
            return IdInfoStore(self.root).create({"category": f"계정 {number}", "login_id": "shared", "password": "test", "notes": ""})
        with ThreadPoolExecutor(max_workers=6) as pool:
            saved = list(pool.map(save, range(12)))
        self.assertEqual(len({item["id"] for item in saved}), 12)
        self.assertEqual(len(self.store.list()), 12)

    def test_ids_and_text_are_parameterized(self):
        item = self.create(category="' OR 1=1 --", notes="<script>alert('text')</script>")
        self.assertIsNone(self.store.update("' OR 1=1 --", {"password": "overwritten"}))
        self.assertFalse(self.store.delete("' OR 1=1 --"))
        self.assertIsNone(self.store.password("' OR 1=1 --"))
        self.assertEqual(self.store.list(), [item])
        self.assertEqual(self.store.password(item["id"]), "  Test<&>Pwd!  ")

    def test_locked_apis_reject_list_create_edit_delete_and_password(self):
        item = self.create()
        del self.client.headers["X-ERP-Info-Token"]
        for method, path, data in [
            ("GET", "/api/id-info", None),
            ("POST", "/api/id-info", {"category": "blocked"}),
            ("PATCH", f"/api/id-info/{item['id']}", {"notes": "blocked"}),
            ("DELETE", f"/api/id-info/{item['id']}", None),
            ("GET", f"/api/id-info/{item['id']}/password", None),
        ]:
            response = self.client.request(method, path, json=data)
            self.assertEqual(response.status_code, 403, response.text)
            self.assertEqual(response.headers["X-ERP-Info-Locked"], "1")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertNotIn("shared@example.test", response.text)
        self.assertEqual(self.store.list(), [item])
        self.client.headers["X-ERP-Info-Token"] = "forged-token"
        self.assertEqual(self.client.get("/api/id-info").status_code, 403)

    def test_unlock_checks_password_and_never_echoes_it(self):
        del self.client.headers["X-ERP-Info-Token"]
        response = self.client.post("/api/id-info/unlock", json={"password": "wrong-private-password"})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("wrong-private-password", response.text)
        self.assertNotIn("token", response.json())
        response = self.client.post("/api/id-info/unlock", json={"password": "sensitive" * 200})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("sensitive", response.text)
        response = self.unlock()
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.json()["expires_in"], auth_store.INFO_ACCESS_SECONDS)
        self.assertNotIn(self.access_password, response.text)
        self.assertEqual(self.client.get("/api/id-info").status_code, 200)
        with self.accounts.connect() as db:
            row = db.execute("SELECT * FROM info_access WHERE token_hash = ?", (hashlib.sha256(self.access_token.encode()).hexdigest(),)).fetchone()
        self.assertIsNotNone(row)
        self.assertNotIn(self.access_token, tuple(row))

    def test_grant_cannot_be_reused_by_another_login_or_account(self):
        item = self.create()
        second_session = self.accounts.create_session(self.admin["id"])
        self.client.cookies.set(auth.COOKIE_NAME, second_session)
        self.assertEqual(self.client.get("/api/id-info").status_code, 403)
        member = self.accounts.create_user("member", "test-member-password", "김민수", "대리")
        self.client.cookies.set(auth.COOKIE_NAME, self.accounts.create_session(member["id"]))
        self.assertEqual(self.client.get("/api/id-info").status_code, 403)
        self.unlock()
        self.assertEqual(self.client.get("/api/id-info").json()["items"], [item])

    def test_lock_expiry_and_logout_revoke_access(self):
        self.assertEqual(self.client.post("/api/id-info/lock").status_code, 204)
        self.assertEqual(self.client.get("/api/id-info").status_code, 403)
        self.unlock()
        with self.accounts.connect() as db:
            db.execute("UPDATE info_access SET expires_at = ?", (int(time.time()) - 1,))
        self.assertEqual(self.client.get("/api/id-info").status_code, 403)
        self.unlock()
        self.accounts.logout(self.session)
        self.assertEqual(self.client.get("/api/id-info").status_code, 401)
        with self.accounts.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM info_access").fetchone()[0], 0)
        self.client.cookies.set(auth.COOKIE_NAME, self.accounts.create_session(self.admin["id"]))
        self.assertEqual(self.client.get("/api/id-info").status_code, 403)

    def test_wrong_password_attempts_are_limited_across_logins(self):
        for _ in range(10):
            response = self.client.post("/api/id-info/unlock", json={"password": "wrong"})
            self.assertEqual(response.status_code, 403)
        self.client.cookies.set(auth.COOKIE_NAME, self.accounts.create_session(self.admin["id"]))
        response = self.client.post("/api/id-info/unlock", json={"password": self.access_password})
        self.assertEqual(response.status_code, 429)
        with self.accounts.connect() as db:
            db.execute("UPDATE login_attempts SET since = ? WHERE key = ?", (int(time.time()) - 901, "info:" + self.admin["id"]))
        self.unlock()

    def test_unlock_requires_erp_login_and_cross_origin_is_rejected(self):
        response = self.client.post("/api/id-info/unlock", json={"password": self.access_password}, headers={"Origin": "https://untrusted.example"})
        self.assertEqual(response.status_code, 403)
        self.client.cookies.clear()
        for path in ["/api/id-info/unlock", "/api/id-info/lock"]:
            self.assertEqual(self.client.post(path, json={"password": self.access_password}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
