from contextlib import ExitStack
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from app import auth
from app.documents import DocumentStore
from app.main import app
from app.routers import documents
from auth_support import authorize


class DocumentLibraryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.store = DocumentStore(self.root / "Documents")
        self.stack.enter_context(patch.object(documents, "store", self.store))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        self.accounts = authorize(self.client, self.stack, self.root)

    def folder(self, title="회사 소개 자료", description="소개서와 발표 자료"):
        response = self.client.post("/api/documents/folders", json={"title": title, "description": description})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def upload(self, folder, content=b"presentation", filename="발표 자료.pptx"):
        response = self.client.post(f"/api/documents/folders/{folder['id']}/files",
                                    params={"filename": filename}, content=content,
                                    headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_folders_validate_and_persist_title_description_and_edits(self):
        for title in ["", "  ", "a" * 141, None]:
            self.assertEqual(self.client.post("/api/documents/folders", json={"title": title}).status_code, 422)
        folder = self.folder("  소개 자료  ", "문서\n이미지")
        self.assertEqual(folder["title"], "소개 자료")
        response = self.client.patch(f"/api/documents/folders/{folder['id']}", json={"title": "수정 제목", "description": "새 설명"})
        self.assertEqual(response.status_code, 200)
        with patch.object(documents, "store", DocumentStore(self.store.root)):
            saved = self.client.get("/api/documents/folders").json()["items"][0]
        self.assertEqual(saved["title"], "수정 제목")
        self.assertEqual(saved["description"], "새 설명")
        self.assertEqual(saved["created_at"], folder["created_at"])
        self.assertEqual(saved["file_count"], 0)

    def test_mixed_files_original_bytes_names_dates_and_folder_isolation_survive_restart(self):
        folder = self.folder()
        other = self.folder("다른 폴더")
        before = datetime.now(timezone.utc)
        payloads = [("보고서.ppt", b"old ppt"), ("보고서.pptx", b"PK-pptx"), ("표.xlsx", b"PK-xlsx"),
                    ("자료.zip", b"PK-zip"), ("안내.pdf", b"%PDF"), ("README", b""),
                    ("같은 이름.txt", b"first"), ("같은 이름.txt", b"second")]
        saved = [self.upload(folder, content, filename) for filename, content in payloads]
        with patch.object(documents, "store", DocumentStore(self.store.root)):
            files = self.client.get(f"/api/documents/folders/{folder['id']}/files").json()["items"]
            self.assertEqual([item["id"] for item in files], [item["id"] for item in reversed(saved)])
            self.assertEqual(self.client.get(f"/api/documents/folders/{other['id']}/files").json()["items"], [])
            for item, (filename, content) in zip(saved, payloads):
                self.assertEqual(item["filename"], filename)
                self.assertGreaterEqual(datetime.fromisoformat(item["uploaded_at"]), before)
                self.assertEqual(next(f for f in files if f["id"] == item["id"])["uploaded_at"], item["uploaded_at"])
                response = self.client.get(item["download_url"])
                self.assertEqual(response.content, content)
                self.assertTrue(response.headers["content-disposition"].startswith("attachment"))
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        folders = self.client.get("/api/documents/folders").json()["items"]
        summary = next(f for f in folders if f["id"] == folder["id"])
        self.assertEqual(summary["file_count"], len(payloads))
        self.assertEqual(summary["total_size"], sum(len(content) for _, content in payloads))

    def test_verified_images_preview_but_active_content_only_downloads(self):
        folder = self.folder()
        output = BytesIO()
        Image.new("RGB", (2, 2), "blue").save(output, format="PNG")
        image = self.upload(folder, output.getvalue(), "이미지.png")
        preview = self.client.get(image["preview_url"])
        self.assertEqual(preview.content, output.getvalue())
        self.assertEqual(preview.headers["content-type"], "image/png")
        for name in ["악성.html", "악성.svg", "가짜.png"]:
            item = self.upload(folder, b"<script>alert(1)</script>", name)
            self.assertIsNone(item["preview_url"])
            self.assertEqual(self.client.get(f"/api/documents/files/{item['id']}/preview").status_code, 404)
            self.assertEqual(self.client.get(item["download_url"]).headers["content-type"], "application/octet-stream")

    def test_upload_limits_reject_streams_and_cleanup_temporary_files(self):
        folder = self.folder()
        url = f"/api/documents/folders/{folder['id']}/files?filename=test.bin"
        with patch.object(documents, "MAX_FILE_BYTES", 4):
            self.assertEqual(self.client.post(url, content=b"12345").status_code, 413)
            self.assertEqual(self.client.post(url, content=iter([b"123", b"456"])).status_code, 413)
        self.assertEqual(list(self.store.uploads.iterdir()), [])
        self.assertEqual(self.store.list_files(folder["id"]), [])
        self.assertEqual(self.client.post("/api/documents/folders/missing/files?filename=a", content=b"a").status_code, 404)

    def test_filenames_never_control_storage_paths(self):
        folder = self.folder()
        item = self.upload(folder, b"payload", "../../outside.txt")
        self.assertEqual(item["filename"], "outside.txt")
        self.assertTrue((self.store.uploads / item["id"]).is_file())
        self.assertFalse((self.root / "outside.txt").exists())
        for filename in ["..", ".", "bad\nname.txt", "bad\x00name"]:
            response = self.client.post(f"/api/documents/folders/{folder['id']}/files", params={"filename": filename}, content=b"a")
            self.assertEqual(response.status_code, 422)

    def test_folder_removed_during_upload_does_not_leave_orphaned_files(self):
        folder = self.folder()

        def chunks():
            yield b"first chunk"
            self.store.delete_folder(folder["id"])
            yield b"last chunk"

        response = self.client.post(f"/api/documents/folders/{folder['id']}/files?filename=report.ppt", content=chunks())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(list(self.store.uploads.iterdir()), [])

    def test_deletion_requires_empty_folder_and_removes_original_file(self):
        folder = self.folder()
        item = self.upload(folder)
        self.assertEqual(self.client.delete(f"/api/documents/folders/{folder['id']}").status_code, 409)
        self.assertEqual(self.client.delete(f"/api/documents/files/{item['id']}").status_code, 204)
        self.assertFalse((self.store.uploads / item["id"]).exists())
        self.assertEqual(self.client.get(item["download_url"]).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/documents/folders/{folder['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/documents/folders/{folder['id']}/files").status_code, 404)

    def test_public_library_is_shared_and_all_endpoints_require_login(self):
        folder = self.folder()
        item = self.upload(folder)
        other = self.accounts.create_user("coworker", "test-password", "동료", "연구원")
        self.client.cookies.clear()
        self.client.cookies.set(auth.COOKIE_NAME, self.accounts.create_session(other["id"]))
        self.assertEqual(self.client.get("/api/documents/folders").json()["items"][0]["id"], folder["id"])
        self.assertEqual(self.client.get(item["download_url"]).status_code, 200)
        self.assertEqual(self.client.get("/documents").status_code, 200)
        self.assertEqual(self.client.get("/wiki").status_code, 404)
        self.assertEqual(self.client.get("/api/wiki").status_code, 404)
        self.assertNotIn('data-route="wiki"', self.client.get("/documents").text)
        self.client.cookies.clear()
        for method, path in [("GET", "/folders"), ("POST", "/folders"), ("PATCH", f"/folders/{folder['id']}"),
                             ("DELETE", f"/folders/{folder['id']}"), ("GET", f"/folders/{folder['id']}/files"),
                             ("POST", f"/folders/{folder['id']}/files?filename=a"), ("GET", f"/files/{item['id']}/download"),
                             ("GET", f"/files/{item['id']}/preview"), ("DELETE", f"/files/{item['id']}")]:
            self.assertEqual(self.client.request(method, "/api/documents" + path).status_code, 401)


if __name__ == "__main__":
    unittest.main()
