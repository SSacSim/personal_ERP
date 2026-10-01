import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app
from app.receipts import ReceiptStore
from app.routers import receipts
from auth_support import authorize
from test_receipts import PNG, GIF, jpeg_photo


class ReceiptGroupTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory())) / "Receipts"
        self.store = ReceiptStore(self.root)
        self.stack.enter_context(patch.object(receipts, "store", self.store))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        authorize(self.client, self.stack, self.root.parent)
        self.photos = [("Screenshot.JPG", jpeg_photo() + b"mobile metadata"), ("Screenshot.JPG", PNG), ("third.gif", GIF)]
        self.metadata = {"submission_id": str(uuid4()), "content": "출장 영수증", "registrant": "다른 이름"}

    def upload(self, photos=None, metadata=None, url="/api/receipts", method="POST"):
        photos = self.photos if photos is None else photos
        metadata = self.metadata if metadata is None else metadata
        return self.client.request(method, url, files=[
            ("metadata", (None, json.dumps(metadata), "application/json")),
            *[("images", (filename, data, "application/octet-stream")) for filename, data in photos],
        ])

    def test_three_photos_create_one_receipt_with_individual_original_downloads(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201, response.text)
        record = response.json()
        self.assertEqual(record["registrant"], "홍길동")
        self.assertEqual(record["image_count"], 3)
        self.assertEqual(len({photo["id"] for photo in record["images"]}), 3)
        self.assertEqual(self.client.get("/api/receipts").json()["items"], [record])
        self.assertEqual(len(list((self.root / record["id"]).iterdir())), 4)
        for photo, (filename, data), content_type in zip(record["images"], self.photos, ["image/jpeg", "image/png", "image/gif"]):
            self.assertEqual(photo["filename"], filename)
            self.assertNotIn("image_file", photo)
            self.assertNotIn("image_sha256", photo)
            for query in ["", "?download=true"]:
                response = self.client.get(photo["image_url"] + query)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, data)
                self.assertEqual(response.headers["content-type"], content_type)
                self.assertIn("attachment" if query else "inline", response.headers["content-disposition"])
        self.assertEqual(self.client.get(record["image_url"]).content, self.photos[0][1])
        self.assertEqual(ReceiptStore(self.root).list(0, 24)["items"], [record])

    def test_retry_reuses_receipt_and_rejects_changed_group(self):
        record = self.upload().json()
        self.assertEqual(self.upload().json(), record)
        for photos in [self.photos[:1], list(reversed(self.photos)), [self.photos[0], self.photos[0], self.photos[2]]]:
            self.assertEqual(self.upload(photos=photos).status_code, 409)
        self.assertEqual(self.upload(metadata={**self.metadata, "content": "다른 내용"}).status_code, 409)
        self.assertEqual(self.store.list(0, 24)["items"], [record])

    def test_concurrent_group_retries_publish_one_complete_receipt(self):
        request_id = uuid4()
        with ThreadPoolExecutor(max_workers=4) as pool:
            records = list(pool.map(lambda _: ReceiptStore(self.root).create(request_id, "홍길동", "식비", images=self.photos), range(8)))
        self.assertTrue(all(record == records[0] for record in records))
        self.assertEqual(len(list(self.root.iterdir())), 1)
        self.assertEqual(len(list((self.root / request_id.hex).iterdir())), 4)

    def test_invalid_groups_never_publish_partial_receipts(self):
        for photos in [[], self.photos * 7, [self.photos[0], ("broken.JPG", b"not an image")], [("empty.jpg", b"")], [("a" * 256, PNG)]]:
            with self.subTest(count=len(photos)):
                self.assertEqual(self.upload(photos=photos).status_code, 422)
                self.assertFalse(self.root.exists())
        with patch.object(receipts, "MAX_IMAGE_BYTES", 16):
            self.assertEqual(self.upload().status_code, 422)
        with patch.object(receipts, "MAX_MULTIPART_BYTES", 32):
            self.assertEqual(self.upload().status_code, 413)
        for metadata in [{}, {**self.metadata, "content": " "}, {**self.metadata, "extra": True}]:
            self.assertEqual(self.upload(metadata=metadata).status_code, 422)
        self.assertFalse(self.root.exists())

    def test_content_edit_preserves_all_photos_and_group_replacement_is_complete(self):
        record = self.upload().json()
        url = f"/api/receipts/{record['id']}"
        content_only = self.client.patch(url, json={"content": "내용만 수정"})
        self.assertEqual(content_only.status_code, 200)
        self.assertEqual(content_only.json()["images"], record["images"])
        changed = self.upload(photos=[("../new.JPG", jpeg_photo()), ("new.gif", GIF)], metadata={"content": "사진 전체 교체"}, url=url, method="PATCH")
        self.assertEqual(changed.status_code, 200, changed.text)
        updated = changed.json()
        self.assertEqual(updated["image_count"], 2)
        self.assertEqual(updated["images"][0]["filename"], "new.JPG")
        self.assertEqual(updated["created_at"], record["created_at"])
        for photo in record["images"]:
            self.assertEqual(self.client.get(photo["image_url"]).status_code, 404)
        self.assertEqual(len(list((self.root / record["id"]).iterdir())), 3)
        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertFalse((self.root / record["id"]).exists())
        for photo in updated["images"]:
            self.assertEqual(self.client.get(photo["image_url"]).status_code, 404)

    def test_failed_group_create_and_update_leave_no_partial_files(self):
        write_bytes = Path.write_bytes
        written = 0
        def fail_second_write(path, content):
            nonlocal written
            written += 1
            if written == 2:
                raise OSError("disk full")
            return write_bytes(path, content)
        with patch.object(Path, "write_bytes", fail_second_write), self.assertRaises(OSError):
            self.upload()
        self.assertEqual(list(self.root.iterdir()), [])
        record = self.upload().json()
        written = 0
        with patch.object(Path, "write_bytes", fail_second_write), self.assertRaises(OSError):
            self.upload(metadata={"content": "교체"}, url=f"/api/receipts/{record['id']}", method="PATCH")
        self.assertEqual(self.store.list(0, 24)["items"], [record])
        self.assertEqual(len(list((self.root / record["id"]).iterdir())), 4)
        for photo, (_, data) in zip(record["images"], self.photos):
            self.assertEqual(self.client.get(photo["image_url"]).content, data)

    def test_invalid_group_replacement_preserves_existing_photos(self):
        record = self.upload().json()
        response = self.upload(photos=[self.photos[0], ("bad.JPG", b"broken")], metadata={"content": "교체"}, url=f"/api/receipts/{record['id']}", method="PATCH")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.store.list(0, 24)["items"], [record])
        self.assertEqual(len(list((self.root / record["id"]).iterdir())), 4)

    def test_legacy_record_can_be_viewed_edited_and_upgraded(self):
        record = self.store.create(uuid4(), "홍길동", "기존 영수증", "old.png", PNG)
        path = self.root / record["id"] / "receipt.json"
        legacy = json.loads(path.read_text(encoding="utf-8"))
        legacy.pop("images")
        path.write_text(json.dumps(legacy), encoding="utf-8")
        listing = self.client.get("/api/receipts").json()["items"][0]
        self.assertEqual(listing["image_count"], 1)
        self.assertEqual(self.client.get(listing["images"][0]["image_url"]).content, PNG)
        url = f"/api/receipts/{record['id']}"
        self.assertEqual(self.client.patch(url, json={"content": "기존 기록 수정"}).status_code, 200)
        response = self.upload(metadata={"content": "여러 사진으로 교체"}, url=url, method="PATCH")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["image_count"], 3)

    def test_large_spooled_upload_and_missing_or_unauthorized_images(self):
        data = PNG + b"\x00" * (2 * 1024 * 1024)
        record = self.upload(photos=[("large.png", data)]).json()
        self.assertEqual(self.client.get(record["images"][0]["image_url"]).content, data)
        self.assertEqual(self.client.get(f"/api/receipts/{record['id']}/images/unknown").status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(record["images"][0]["image_url"]).status_code, 401)
        self.assertEqual(self.upload().status_code, 401)


if __name__ == "__main__":
    unittest.main()
