from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import base64
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.remote_work import RemoteWorkStore
from app.routers import remote_work
from auth_support import authorize


class RemoteWorkTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory())) / "RemoteWork"
        self.store = RemoteWorkStore(self.root)
        self.stack.enter_context(patch.object(remote_work, "store", self.store))
        app = FastAPI()
        app.include_router(remote_work.router)
        self.client = self.stack.enter_context(TestClient(app))

    def create(self, **changes):
        response = self.client.post("/api/remote-work", json={
            "work_date": "2026-09-28", "author": "김민수", "content": "문서 작성\n회의 내용 정리", **changes,
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def upload(self, content=b"work report", filename="report.txt", kind="file", file_id=None):
        response = self.client.post("/api/remote-work/files", params={
            "upload_id": file_id or uuid4().hex, "filename": filename, "kind": kind,
        }, content=content)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_images_and_files_survive_restart_and_download_original_bytes(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=")
        photo = self.upload(png, "작업 화면.png", "image")
        document = self.upload(b"%PDF-1.7\nwork report", "업무 보고.pdf")
        self.assertEqual(self.client.get(photo["preview_url"]).status_code, 404)
        item = self.create(attachment_ids=[photo["id"], document["id"]])
        self.assertEqual(item["attachments"], [photo, document])
        with patch.object(remote_work, "store", RemoteWorkStore(self.root)):
            self.assertEqual(self.client.get("/api/remote-work").json()["items"], [item])
            preview = self.client.get(photo["preview_url"])
            download = self.client.get(document["download_url"])
        self.assertEqual(preview.content, png)
        self.assertEqual(preview.headers["content-type"], "image/png")
        self.assertTrue(preview.headers["content-disposition"].startswith("inline"))
        self.assertEqual(download.content, b"%PDF-1.7\nwork report")
        self.assertTrue(download.headers["content-disposition"].startswith("attachment"))
        self.assertEqual(download.headers["x-content-type-options"], "nosniff")
        self.assertEqual(download.headers["cache-control"], "private, no-store")
        self.assertEqual((self.root / "Uploads" / photo["id"]).read_bytes(), png)

    def test_attachment_edits_preserve_omitted_files_and_remove_only_on_save(self):
        original = self.upload()
        replacement = self.upload(b"new report", "new.txt")
        item = self.create(attachment_ids=[original["id"]])
        path = f"/api/remote-work/{item['id']}"
        updated = self.client.patch(path, json={"content": "수정 내용"}).json()
        self.assertEqual(updated["attachments"], [original])
        self.assertEqual(self.client.delete(f"/api/remote-work/files/{original['id']}").status_code, 404)
        self.assertEqual(self.client.get(original["download_url"]).status_code, 200)
        updated = self.client.patch(path, json={"attachment_ids": [replacement["id"]]}).json()
        self.assertEqual(updated["attachments"], [replacement])
        self.assertEqual(updated["content"], "수정 내용")
        self.assertEqual(updated["created_at"], item["created_at"])
        self.assertFalse((self.root / "Uploads" / original["id"]).exists())
        self.assertEqual(self.client.get(original["download_url"]).status_code, 404)
        self.assertEqual(self.client.patch(path, json={"attachment_ids": []}).json()["attachments"], [])
        self.assertFalse((self.root / "Uploads" / replacement["id"]).exists())

    def test_delete_record_removes_its_files_and_preserves_other_records(self):
        first_file, second_file = self.upload(), self.upload()
        first = self.create(attachment_ids=[first_file["id"]])
        second = self.create(attachment_ids=[second_file["id"]])
        self.assertEqual(self.client.delete(f"/api/remote-work/{first['id']}").status_code, 204)
        self.assertFalse((self.root / "Uploads" / first_file["id"]).exists())
        self.assertEqual(self.client.get(first_file["download_url"]).status_code, 404)
        self.assertEqual(self.client.get(second_file["download_url"]).status_code, 200)
        self.assertEqual(self.client.get("/api/remote-work").json()["items"], [second])

    def test_invalid_attachment_save_is_atomic_and_does_not_steal_files(self):
        original = self.upload()
        owned = self.create(attachment_ids=[original["id"]])
        pending = self.upload()
        empty = self.create()
        for invalid_ids in [[pending["id"], uuid4().hex], [original["id"]], [pending["id"], pending["id"]], ["../remote-work.sqlite3"], None, [uuid4().hex for _ in range(11)]]:
            with self.subTest(ids=invalid_ids):
                response = self.client.patch(f"/api/remote-work/{empty['id']}", json={"content": "실패한 변경", "attachment_ids": invalid_ids})
                self.assertEqual(response.status_code, 422, response.text)
                response = self.client.post("/api/remote-work", json={"work_date": "2026-09-28", "author": "작성자", "content": "내용", "attachment_ids": invalid_ids})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.get("/api/remote-work").json(), {"items": [empty, owned], "total": 2})
        valid = self.client.patch(f"/api/remote-work/{empty['id']}", json={"attachment_ids": [pending["id"]]})
        self.assertEqual(valid.status_code, 200)
        self.assertEqual(valid.json()["attachments"], [pending])

    def test_legacy_database_adds_attachment_support_without_changing_records(self):
        self.root.mkdir(parents=True)
        with closing(sqlite3.connect(self.root / "remote-work.sqlite3")) as db, db:
            db.execute("CREATE TABLE remote_work (id TEXT PRIMARY KEY, work_date TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
            db.execute("INSERT INTO remote_work VALUES (?, ?, ?, ?, ?, ?)", ("legacy", "2026-09-01", "작성자", "기존 기록\n둘째 줄", "2026-09-01T01:00:00+00:00", "2026-09-01T02:00:00+00:00"))
        old = self.client.get("/api/remote-work").json()["items"][0]
        self.assertEqual(old["content"], "기존 기록\n둘째 줄")
        self.assertEqual(old["attachments"], [])
        uploaded = self.upload()
        updated = self.client.patch("/api/remote-work/legacy", json={"attachment_ids": [uploaded["id"]]}).json()
        for key in ["id", "work_date", "author", "content", "created_at"]:
            self.assertEqual(updated[key], old[key])
        self.assertEqual(updated["attachments"], [uploaded])

    def test_upload_cancel_and_expiry_only_remove_uncommitted_files(self):
        canceled = self.upload()
        self.assertEqual(self.client.delete(f"/api/remote-work/files/{canceled['id']}").status_code, 204)
        self.assertFalse((self.root / "Uploads" / canceled["id"]).exists())
        expired, committed = self.upload(), self.upload()
        self.create(attachment_ids=[committed["id"]])
        with self.store.connect() as db:
            db.execute("UPDATE remote_work_files SET created_at = ?", ("2000-01-01T00:00:00+00:00",))
        fresh = self.upload()
        self.assertFalse((self.root / "Uploads" / expired["id"]).exists())
        self.assertTrue((self.root / "Uploads" / fresh["id"]).is_file())
        self.assertEqual(self.client.get(committed["download_url"]).status_code, 200)

    def test_upload_limits_and_invalid_images_leave_no_partial_files(self):
        for content, kind, filename in [(b"", "file", "empty.txt"), (b"<script>alert(1)</script>", "image", "fake.png"), (b"<svg></svg>", "image", "drawing.svg"), (b"data", "file", "../.."), (b"data", "file", "bad\nname.txt")]:
            with self.subTest(kind=kind, filename=filename):
                response = self.client.post("/api/remote-work/files", params={"upload_id": uuid4().hex, "filename": filename, "kind": kind}, content=content)
                self.assertEqual(response.status_code, 422, response.text)
        with patch.object(remote_work, "MAX_FILE_BYTES", 8):
            for body in [b"123456789", iter([b"12345", b"67890"])]:
                response = self.client.post("/api/remote-work/files", params={"upload_id": uuid4().hex, "filename": "large.txt", "kind": "file"}, content=body)
                self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(list(self.store.uploads.iterdir()), [])
        self.assertEqual(self.store.list()["total"], 0)

    def test_arbitrary_files_are_download_only_and_paths_are_not_user_controlled(self):
        file = self.upload(b"<script>alert(1)</script>", "../../report.html")
        self.assertEqual(file["filename"], "report.html")
        self.assertEqual(file["media_type"], "application/octet-stream")
        self.create(attachment_ids=[file["id"]])
        response = self.client.get(file["download_url"])
        self.assertEqual(response.headers["content-type"], "application/octet-stream")
        self.assertTrue(response.headers["content-disposition"].startswith("attachment"))
        self.assertEqual(self.client.get(f"/api/remote-work/files/{file['id']}/preview").status_code, 404)
        self.assertIsNone(self.store.file("../remote-work.sqlite3"))
        self.assertIsNone(self.store.file("remote-work.sqlite3"))
        self.assertFalse(self.store.discard_upload("' OR 1=1 --"))

    def test_upload_retry_returns_same_file_without_overwriting_it(self):
        file_id = uuid4().hex
        first = self.upload(file_id=file_id)
        self.assertEqual(self.upload(file_id=file_id), first)
        self.assertEqual(len(list(self.store.uploads.iterdir())), 1)
        response = self.client.post("/api/remote-work/files", params={"upload_id": file_id, "filename": "different.txt", "kind": "file"}, content=b"new")
        self.assertEqual(response.status_code, 422)
        self.assertEqual((self.root / "Uploads" / file_id).read_bytes(), b"work report")

    def test_concurrent_attachment_registration_has_one_owner(self):
        attachment = self.upload()
        def save(number):
            try:
                return RemoteWorkStore(self.root).create({"work_date": "2026-09-28", "author": f"작성자 {number}", "content": "내용", "attachment_ids": [attachment["id"]]})
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            result = list(pool.map(save, range(2)))
        self.assertEqual(sum(item is not None for item in result), 1)
        self.assertEqual(self.store.list()["total"], 1)

    def test_create_and_restart_preserve_calendar_date_and_multiline_content(self):
        item = self.create(author="  김민수  ")
        self.assertEqual(item["author"], "김민수")
        self.assertEqual(item["work_date"], "2026-09-28")
        self.assertEqual(item["content"], "문서 작성\n회의 내용 정리")
        self.assertEqual(item["created_at"], item["updated_at"])
        self.assertIsNotNone(datetime.fromisoformat(item["created_at"]).tzinfo)
        with patch.object(remote_work, "store", RemoteWorkStore(self.root)):
            response = self.client.get("/api/remote-work")
        self.assertEqual(response.json(), {"items": [item], "total": 1})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertTrue((self.root / "remote-work.sqlite3").is_file())

    def test_partial_update_preserves_registration_time_and_omitted_fields(self):
        with patch("app.remote_work.datetime") as clock:
            clock.now.return_value = datetime(2026, 9, 28, 1, 0, tzinfo=timezone.utc)
            item = self.create()
            clock.now.return_value = datetime(2026, 9, 28, 2, 0, tzinfo=timezone.utc)
            response = self.client.patch(f"/api/remote-work/{item['id']}", json={"content": "개발 및 검증 완료"})
        self.assertEqual(response.status_code, 200)
        saved = response.json()
        self.assertEqual(saved["content"], "개발 및 검증 완료")
        for key in ["id", "work_date", "author", "created_at"]:
            self.assertEqual(saved[key], item[key])
        self.assertGreater(saved["updated_at"], saved["created_at"])
        self.assertEqual(self.client.patch(f"/api/remote-work/{item['id']}", json={}).json(), saved)
        moved = self.client.patch(f"/api/remote-work/{item['id']}", json={"work_date": "2026-10-01", "author": "이서연"}).json()
        self.assertEqual(moved["work_date"], "2026-10-01")
        self.assertEqual(moved["author"], "이서연")
        self.assertEqual(self.client.get("/api/remote-work", params={"month": "2026-09"}).json()["total"], 0)
        self.assertEqual(self.client.get("/api/remote-work", params={"month": "2026-10"}).json()["items"], [moved])

    def test_month_search_order_and_pagination(self):
        old = self.create(work_date="2026-08-31")
        first = self.create(work_date="2026-09-01", author="이서연", content="API 문서")
        last = self.create(work_date="2026-09-30", author="이서연", content="API 테스트")
        self.create(work_date="2026-10-01", content="API 배포")
        response = self.client.get("/api/remote-work", params={"month": "2026-09", "q": "API", "limit": 1})
        self.assertEqual(response.json(), {"items": [last], "total": 2})
        response = self.client.get("/api/remote-work", params={"month": "2026-09", "q": " 이서연 ", "limit": 1, "offset": 1})
        self.assertEqual(response.json(), {"items": [first], "total": 2})
        self.assertEqual(self.client.get("/api/remote-work", params={"month": "2026-08"}).json()["items"], [old])
        self.assertEqual(self.client.get("/api/remote-work", params={"offset": 100}).json(), {"items": [], "total": 4})

    def test_search_treats_sql_wildcards_and_quotes_as_literal_text(self):
        item = self.create(content="진행률 100%\nfile_name\nC:\\work\n' OR 1=1 --")
        self.create(content="일반 기록")
        for query in ["%", "_", "\\", "' OR 1=1 --"]:
            with self.subTest(query=query):
                self.assertEqual(self.client.get("/api/remote-work", params={"q": query}).json()["items"], [item])
        self.assertIsNone(self.store.update("' OR 1=1 --", {"content": "덮어쓰기"}))
        self.assertFalse(self.store.delete("' OR 1=1 --"))

    def test_invalid_fields_and_dates_do_not_create_or_change_records(self):
        bad_values = [
            {"work_date": "2026-02-30"}, {"work_date": "20260928"}, {"work_date": "2026-W40-1"},
            {"work_date": "2026-09-28T00:00:00Z"}, {"work_date": 1790553600}, {"work_date": None},
            {"author": "   "}, {"author": None}, {"author": "가" * 81},
            {"content": "\n  "}, {"content": None}, {"content": "가" * 10001},
            {"created_at": "2000-01-01"}, {"updated_at": "2000-01-01"}, {"id": "chosen-id"},
        ]
        item = self.create()
        for changes in bad_values:
            with self.subTest(changes=list(changes)):
                response = self.client.post("/api/remote-work", json={"work_date": "2026-09-28", "author": "작성자", "content": "내용", **changes})
                self.assertEqual(response.status_code, 422, response.text)
                response = self.client.patch(f"/api/remote-work/{item['id']}", json=changes)
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.get("/api/remote-work").json(), {"items": [item], "total": 1})
        self.assertEqual(self.create(work_date="2024-02-29")["work_date"], "2024-02-29")

    def test_invalid_filters_are_rejected(self):
        for params in [{"month": "2026-13"}, {"month": "2026-9"}, {"month": "invalid"}, {"q": "a" * 101}, {"limit": 0}, {"limit": 101}, {"offset": -1}]:
            with self.subTest(params=params):
                self.assertEqual(self.client.get("/api/remote-work", params=params).status_code, 422)

    def test_delete_and_missing_record_responses(self):
        item = self.create()
        path = f"/api/remote-work/{item['id']}"
        response = self.client.delete(path)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertEqual(self.client.delete(path).status_code, 404)
        self.assertEqual(self.client.patch(path, json={"content": "수정"}).status_code, 404)
        self.assertEqual(self.client.get("/api/remote-work").json(), {"items": [], "total": 0})

    def test_concurrent_records_are_not_lost(self):
        def save(number):
            return RemoteWorkStore(self.root).create({"work_date": "2026-09-28", "author": f"작성자 {number}", "content": "업무 완료"})
        with ThreadPoolExecutor(max_workers=6) as pool:
            records = list(pool.map(save, range(12)))
        self.assertEqual(len({record["id"] for record in records}), 12)
        self.assertEqual(self.store.list()["total"], 12)

    def test_main_app_serves_page_assets_and_api(self):
        from app.main import app
        # No lifespan here: page verification must not initialize the actual vault.
        client = TestClient(app)
        self.addCleanup(client.close)
        authorize(client, self.stack, self.root.parent)
        page = client.get("/remote-work")
        self.assertEqual(page.status_code, 200)
        self.assertIn('href="/remote-work" data-route="remote-work"', page.text)
        for asset in ["remote-work.js", "remote-work.css"]:
            self.assertEqual(client.get(f"/static/{asset}").status_code, 200)
        item = self.create()
        self.assertEqual(client.get("/api/remote-work").json()["items"], [item])


if __name__ == "__main__":
    unittest.main()
