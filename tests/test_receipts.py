import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app as erp_app
from app.receipts import KST, ReceiptStore
from app.routers import receipts
from auth_support import authorize


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


def jpeg_photo(**options):
    output = BytesIO()
    with Image.new("RGB", (16, 24), "white") as image:
        image.save(output, format="JPEG", **options)
    return output.getvalue()


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

    def test_uppercase_jpg_upload_preserves_photos_with_trailing_data(self):
        for progressive in [False, True]:
            for trailer in [b"", b"\x00\x00", b"\r\n", b"mobile metadata after JPEG image"]:
                with self.subTest(progressive=progressive, trailer=trailer):
                    image = jpeg_photo(progressive=progressive) + trailer
                    payload = self.payload(filename="Screenshot_20261001.JPG", image_base64=base64.b64encode(image).decode())
                    response = self.erp.post("/api/receipts", json=payload)
                    self.assertEqual(response.status_code, 201, response.text)
                    record = response.json()
                    self.assertEqual(record["filename"], payload["filename"])
                    self.assertEqual(record["content_type"], "image/jpeg")
                    self.assertEqual(record["size"], len(image))
                    self.assertEqual(self.erp.post("/api/receipts", json=payload).json(), record)
                    photo = self.erp.get(record["image_url"] + "?download=true")
                    self.assertEqual(photo.status_code, 200)
                    self.assertEqual(photo.headers["content-type"], "image/jpeg")
                    self.assertEqual(photo.content, image)

    def test_replace_photo_accepts_jpeg_with_trailing_metadata(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        image = jpeg_photo() + b"mobile metadata after JPEG image"
        response = self.erp.patch(f"/api/receipts/{original['id']}", json={
            "content": "휴대폰 스크린샷", "filename": "Screenshot.JPG", "image_base64": base64.b64encode(image).decode(),
        })
        self.assertEqual(response.status_code, 200, response.text)
        updated = response.json()
        self.assertEqual(updated["content_type"], "image/jpeg")
        self.assertEqual(updated["filename"], "Screenshot.JPG")
        self.assertEqual(updated["created_at"], original["created_at"])
        self.assertEqual(self.erp.get(updated["image_url"]).content, image)
        self.assertFalse((self.root / original["id"] / "image.png").exists())

    def test_invalid_jpeg_cannot_be_created_or_replace_an_existing_photo(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        photo = jpeg_photo()
        # A complete thumbnail must not conceal a truncated primary JPEG.
        thumbnail = b"Exif\x00\x00" + photo
        app1 = b"\xff\xe1" + (len(thumbnail) + 2).to_bytes(2, "big") + thumbnail
        invalid_images = [
            b"\xff\xd8\xff\xd9", b"\xff\xd8\xffnot a JPEG\xff\xd9",
            photo[:-12], photo[:2] + app1 + photo[2:-12],
        ]
        for image in invalid_images:
            with self.subTest(image_length=len(image)):
                encoded = base64.b64encode(image).decode()
                response = self.erp.post("/api/receipts", json=self.payload(filename="broken.JPG", image_base64=encoded))
                self.assertEqual(response.status_code, 422, response.text)
                response = self.erp.patch(f"/api/receipts/{original['id']}", json={
                    "content": "교체 시도", "filename": "broken.JPG", "image_base64": encoded,
                })
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.store.list(0, 24)["items"], [original])
                self.assertEqual(self.erp.get(original["image_url"]).content, PNG)
        self.assertEqual(list(self.root.iterdir()), [self.root / original["id"]])

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

    def test_edit_content_preserves_identity_date_and_image_after_reload(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        before = datetime.now(KST)
        response = self.erp.patch(f"/api/receipts/{original['id']}", json={"content": "  수정한 식비\n참석자 4명  "})
        self.assertEqual(response.status_code, 200, response.text)
        updated = response.json()
        self.assertEqual(updated["content"], "수정한 식비\n참석자 4명")
        self.assertGreaterEqual(datetime.fromisoformat(updated["updated_at"]), before)
        for key in ["id", "registrant", "created_at", "date", "filename", "image_url", "size"]:
            self.assertEqual(updated[key], original[key])
        self.assertNotIn("image_file", updated)
        self.assertNotIn("image_sha256", updated)
        self.assertEqual(ReceiptStore(self.root).list(0, 24)["items"], [updated])
        self.assertEqual(self.erp.get(updated["image_url"]).content, PNG)

    def test_replace_photo_updates_original_and_removes_previous_file(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        response = self.erp.patch(f"/api/receipts/{original['id']}", json={
            "content": "사진 교체", "filename": "../교체.GIF", "image_base64": base64.b64encode(GIF).decode(),
        })
        self.assertEqual(response.status_code, 200, response.text)
        updated = response.json()
        self.assertEqual(updated["filename"], "교체.GIF")
        self.assertEqual(updated["content_type"], "image/gif")
        self.assertEqual(updated["size"], len(GIF))
        self.assertEqual(updated["created_at"], original["created_at"])
        photo = self.erp.get(updated["image_url"] + "?download=true")
        self.assertEqual(photo.content, GIF)
        self.assertEqual(photo.headers["content-type"], "image/gif")
        self.assertIn("attachment", photo.headers["content-disposition"])
        folder = self.root / updated["id"]
        self.assertFalse((folder / "image.png").exists())
        self.assertEqual(len(list(folder.iterdir())), 2)

    def test_invalid_edits_leave_existing_receipt_unchanged(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        url = f"/api/receipts/{original['id']}"
        for changes in [
            {}, {"content": " "}, {"content": "x" * 4001},
            {"content": "수정", "registrant": "다른 사람"}, {"content": "수정", "created_at": "2000-01-01"},
            {"content": "수정", "filename": "photo.JPG"}, {"content": "수정", "image_base64": "AAAA"},
            {"content": "수정", "filename": "photo.JPG", "image_base64": "@@@"},
            {"content": "수정", "filename": "photo.JPG", "image_base64": base64.b64encode(b"not an image").decode()},
        ]:
            with self.subTest(changes=changes):
                self.assertEqual(self.erp.patch(url, json=changes).status_code, 422)
                self.assertEqual(self.store.list(0, 24)["items"], [original])
        with patch.object(receipts, "MAX_REQUEST_BYTES", 8):
            self.assertEqual(self.erp.patch(url, json={"content": "too long"}).status_code, 413)
        self.assertEqual(self.erp.patch(url, content="not-json").status_code, 415)
        self.assertEqual(self.erp.get(original["image_url"]).content, PNG)

    def test_failed_edit_keeps_original_metadata_and_photo(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        for method in ["write_bytes", "write_text", "replace"]:
            with self.subTest(method=method), patch.object(Path, method, side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    self.store.update(original["id"], "수정", "new.GIF", GIF)
            self.assertEqual(self.store.list(0, 24)["items"], [original])
            self.assertEqual(self.erp.get(original["image_url"]).content, PNG)
            self.assertEqual(len(list((self.root / original["id"]).iterdir())), 2)

    def test_delete_removes_receipt_and_photo_without_touching_other_receipts(self):
        deleted = self.erp.post("/api/receipts", json=self.payload()).json()
        kept = self.erp.post("/api/receipts", json=self.payload(content="유지")).json()
        response = self.erp.delete(f"/api/receipts/{deleted['id']}")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertFalse((self.root / deleted["id"]).exists())
        self.assertEqual(ReceiptStore(self.root).list(0, 24)["items"], [kept])
        self.assertEqual(self.erp.get(deleted["image_url"]).status_code, 404)
        self.assertEqual(self.erp.get(kept["image_url"]).content, PNG)
        self.assertEqual(self.erp.delete(f"/api/receipts/{deleted['id']}").status_code, 404)

    def test_edit_and_delete_require_login_and_valid_existing_id(self):
        original = self.erp.post("/api/receipts", json=self.payload()).json()
        for receipt_id in ["not-an-id", uuid4().hex]:
            self.assertEqual(self.erp.patch(f"/api/receipts/{receipt_id}", json={"content": "수정"}).status_code, 404)
            self.assertEqual(self.erp.delete(f"/api/receipts/{receipt_id}").status_code, 404)
        self.assertIsNone(self.store.update("../outside", "수정"))
        self.assertFalse(self.store.delete("../outside"))
        self.erp.cookies.clear()
        self.assertEqual(self.erp.patch(f"/api/receipts/{original['id']}", json={"content": "수정"}).status_code, 401)
        self.assertEqual(self.erp.delete(f"/api/receipts/{original['id']}").status_code, 401)
        self.assertEqual(self.store.list(0, 24)["items"], [original])


if __name__ == "__main__":
    unittest.main()
