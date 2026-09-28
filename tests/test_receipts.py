import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app as erp_app
from app.receipts import KST, ReceiptStore
from app.routers import receipts
from auth_support import authorize


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory())) / "Receipts"
        self.store = ReceiptStore(self.root)
        self.stack.enter_context(patch.object(receipts, "store", self.store))
        # Exercise the real routes without startup touching unrelated live stores.
        self.erp = TestClient(erp_app)
        self.stack.callback(self.erp.close)
        authorize(self.erp, self.stack, self.root.parent)

    def payload(self, **changes):
        return {
            "submission_id": str(uuid4()), "registrant": "홍길동", "content": "팀 회의 식비\n참석자 3명",
            "filename": "영수증.png", "image_base64": base64.b64encode(PNG).decode(), **changes,
        }

    def test_upload_then_read_from_separate_store_and_serve_original_photo(self):
        before = datetime.now(KST)
        payload = self.payload()
        response = self.erp.post("/api/receipts", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        record = response.json()
        created_at = datetime.fromisoformat(record["created_at"])
        self.assertGreaterEqual(created_at, before)
        self.assertLessEqual(created_at, datetime.now(KST))
        self.assertEqual(record["date"], created_at.date().isoformat())
        self.assertEqual(created_at.utcoffset().total_seconds(), 9 * 3600)
        self.assertEqual(record["content"], payload["content"])
        self.assertEqual(record["registrant"], payload["registrant"])
        self.assertEqual(record["size"], len(PNG))
        self.assertNotIn("image_sha256", record)
        self.assertTrue((self.root / record["id"] / "receipt.json").is_file())
        self.assertEqual((self.root / record["id"] / "image.png").read_bytes(), PNG)
        # Simulate the ERP process reading the shared folder after a restart.
        with patch.object(receipts, "store", ReceiptStore(self.root)):
            listing = self.erp.get("/api/receipts").json()
            self.assertEqual(listing["items"], [record])
            photo = self.erp.get(record["image_url"])
        self.assertEqual(photo.status_code, 200)
        self.assertEqual(photo.content, PNG)
        self.assertEqual(photo.headers["content-type"], "image/png")
        self.assertEqual(photo.headers["x-content-type-options"], "nosniff")
        self.assertIn("inline", photo.headers["content-disposition"])

    def test_registration_page_and_assets_share_the_erp_origin(self):
        page = self.erp.get("/receipt-upload")
        self.assertEqual(page.status_code, 200)
        self.assertIn('id="receipt-form"', page.text)
        self.assertNotIn('class="sidebar"', page.text)
        self.assertEqual(self.erp.get("/receipt-upload/").url.path, "/receipt-upload")
        for filename in ["receipt-upload.js", "receipt-upload.css"]:
            self.assertIn(f'/receipt-static/{filename}', page.text)
            self.assertEqual(self.erp.get(f"/receipt-static/{filename}").status_code, 200)
        erp_page = self.erp.get("/receipts")
        self.assertEqual(erp_page.status_code, 200)
        self.assertIn('class="sidebar"', erp_page.text)
        script = self.erp.get("/static/receipts.js")
        self.assertIn('href="/receipt-upload"', script.text)
        record = self.erp.post("/api/receipts", json=self.payload()).json()
        self.assertEqual(self.erp.get("/api/receipts").json()["items"], [record])
        self.assertEqual(self.erp.get(record["image_url"]).content, PNG)

    def test_retry_keeps_single_record_and_changed_request_conflicts(self):
        payload = self.payload()
        first = self.erp.post("/api/receipts", json=payload)
        second = self.erp.post("/api/receipts", json=payload)
        self.assertEqual(first.json(), second.json())
        payload["content"] = "다른 영수증"
        self.assertEqual(self.erp.post("/api/receipts", json=payload).status_code, 409)
        self.assertEqual(self.erp.get("/api/receipts").json()["total"], 1)

    def test_concurrent_retries_commit_one_complete_folder(self):
        submission_id = uuid4()
        def save(_):
            return ReceiptStore(self.root).create(submission_id, "동료", "식비", "사진.png", PNG)
        with ThreadPoolExecutor(max_workers=6) as pool:
            records = list(pool.map(save, range(12)))
        self.assertTrue(all(record == records[0] for record in records))
        self.assertEqual(len(list(self.root.iterdir())), 1)
        self.assertEqual(self.store.list(0, 24)["total"], 1)

    def test_newest_first_pagination_and_same_filename_does_not_overwrite(self):
        saved = [self.erp.post("/api/receipts", json=self.payload(content=f"영수증 {number}")).json() for number in range(3)]
        page = self.erp.get("/api/receipts?offset=1&limit=1").json()
        self.assertEqual(page["total"], 3)
        self.assertEqual(page["items"], [saved[1]])
        self.assertEqual(self.erp.get("/api/receipts").json()["items"], list(reversed(saved)))
        self.assertEqual(len(list(self.root.glob("*/image.png"))), 3)
        for query in ["offset=-1", "limit=0", "limit=101"]:
            self.assertEqual(self.erp.get(f"/api/receipts?{query}").status_code, 422)

    def test_invalid_submissions_leave_no_files(self):
        invalid = [
            {"registrant": "   "}, {"registrant": "이" * 51}, {"content": "\n "}, {"content": "a" * 4001},
            {"image_base64": "@@@"}, {"image_base64": ""}, {"image_base64": base64.b64encode(b"<svg onload='alert(1)'/>").decode()},
            {"submission_id": "../escape"}, {"created_at": "2000-01-01"}, {"date": "2000-01-01"},
        ]
        for changes in invalid:
            with self.subTest(changes=changes.keys()):
                response = self.erp.post("/api/receipts", json=self.payload(**changes))
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.store.list(0, 24)["total"], 0)
        self.assertFalse(self.root.exists())

    def test_request_size_limit_and_unsupported_content_type(self):
        with patch.object(receipts, "MAX_REQUEST_BYTES", 32):
            response = self.erp.post("/api/receipts", json=self.payload())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.erp.post("/api/receipts", content="not-json").status_code, 415)
        self.assertEqual(self.erp.post("/api/receipts", content="{", headers={"Content-Type": "application/json"}).status_code, 422)
        self.assertFalse(self.root.exists())

    def test_failed_disk_write_does_not_publish_partial_receipt(self):
        with patch.object(Path, "write_text", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.store.create(uuid4(), "홍길동", "식비", "사진.png", PNG)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.store.list(0, 24)["total"], 0)

    def test_filename_and_missing_ids_cannot_access_outside_receipt_folder(self):
        record = self.erp.post("/api/receipts", json=self.payload(filename="../../secret.png")).json()
        self.assertEqual(record["filename"], "secret.png")
        self.assertEqual(self.erp.get("/api/receipts/not-an-id/image").status_code, 404)
        self.assertEqual(self.erp.get(f"/api/receipts/{uuid4().hex}/image").status_code, 404)
        self.assertEqual(self.erp.get(record["image_url"]).content, PNG)


if __name__ == "__main__":
    unittest.main()
