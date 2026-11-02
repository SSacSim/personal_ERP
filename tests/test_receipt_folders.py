import base64
import json
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from threading import Event
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.receipts import ReceiptConflict, ReceiptStore
from app.routers import receipts
from auth_support import authorize
from test_receipts import PNG


def pdf_receipt():
    output = BytesIO()
    with Image.new("RGB", (100, 160), "white") as image:
        image.save(output, format="PDF")
    return output.getvalue()


class ReceiptFolderTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory())) / "Receipts"
        self.store = ReceiptStore(self.root)
        self.stack.enter_context(patch.object(receipts, "store", self.store))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        authorize(self.client, self.stack, self.root.parent)

    def folder(self, name="출장비"):
        response = self.client.post("/api/receipts/folders", json={"name": name})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def payload(self, folder_id=None, **changes):
        payload = {"submission_id": str(uuid4()), "content": "영수증", "filename": "receipt.png",
                   "image_base64": base64.b64encode(PNG).decode(), **changes}
        if folder_id is not None:
            payload["folder_id"] = folder_id
        return payload

    def test_empty_folders_survive_restart_and_duplicate_or_invalid_names_are_rejected(self):
        default = self.client.get("/api/receipts/folders").json()["items"][0]
        self.assertEqual((default["id"], default["name"], default["status"], default["receipt_count"]), ("unfiled", "미분류", "in_progress", 0))
        self.assertTrue(default["can_upload"])
        folder = self.folder("  출장비  ")
        self.assertEqual(folder["name"], "출장비")
        self.assertTrue(folder["can_upload"])
        self.assertEqual(ReceiptStore(self.root).list_folders()["items"], [default, folder])
        self.assertEqual(self.client.post("/api/receipts/folders", json={"name": "출장비"}).status_code, 409)
        for name in ["", "   ", "a" * 81]:
            self.assertEqual(self.client.post("/api/receipts/folders", json={"name": name}).status_code, 422)
        self.assertEqual(self.client.post("/api/receipts/folders", json={"name": "미분류"}).status_code, 409)
        self.assertEqual(len(list((self.root / ".folders").iterdir())), 2)

    def test_registration_requires_an_existing_folder_in_json_and_multipart(self):
        for folder_id in [None, "../outside", uuid4().hex]:
            payload = self.payload(folder_id)
            self.assertEqual(self.client.post("/api/receipts", json=payload).status_code, 422)
            metadata = {key: value for key, value in payload.items() if key not in {"filename", "image_base64"}}
            response = self.client.post("/api/receipts", files=[
                ("metadata", (None, json.dumps(metadata))), ("images", ("receipt.png", PNG, "image/png")),
            ])
            self.assertEqual(response.status_code, 422)
        self.assertFalse(self.root.exists())
        with self.assertRaises(ValueError):
            self.store.create(uuid4(), "등록자", "내용", "a.png", PNG, folder_id=uuid4().hex)

    def test_folder_lists_counts_pagination_and_retry_do_not_mix_receipts(self):
        first, second = self.folder(), self.folder("식비")
        payload = self.payload(first["id"])
        record = self.client.post("/api/receipts", json=payload).json()
        self.assertEqual(self.client.post("/api/receipts", json=payload).json(), record)
        other = self.client.post("/api/receipts", json=self.payload(second["id"])).json()
        self.assertEqual(self.client.post("/api/receipts", json={**payload, "folder_id": second["id"]}).status_code, 409)
        for folder, expected in [(first, record), (second, other)]:
            listing = self.client.get("/api/receipts", params={"folder_id": folder["id"], "limit": 1}).json()
            self.assertEqual(listing["items"], [expected])
            self.assertEqual(listing["total"], 1)
        self.assertEqual(self.client.get("/api/receipts", params={"folder_id": uuid4().hex}).status_code, 404)
        self.assertEqual([folder["receipt_count"] for folder in self.store.list_folders()["items"]], [0, 1, 1])
        self.client.delete(f"/api/receipts/{record['id']}")
        counts = {folder["id"]: folder["receipt_count"] for folder in ReceiptStore(self.root).list_folders()["items"]}
        self.assertEqual(counts, {"unfiled": 0, first["id"]: 0, second["id"]: 1})

    def test_legacy_unfiled_receipts_remain_readable_and_editable(self):
        folder = self.folder()
        record = self.client.post("/api/receipts", json=self.payload(folder["id"])).json()
        path = self.root / record["id"] / "receipt.json"
        legacy = json.loads(path.read_text(encoding="utf-8"))
        del legacy["folder_id"]
        path.write_text(json.dumps(legacy), encoding="utf-8")
        folders = self.store.list_folders()["items"]
        self.assertEqual((folders[0]["id"], folders[0]["name"], folders[0]["receipt_count"], folders[0]["can_upload"]), ("unfiled", "미분류", 1, True))
        migrated = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(migrated, {**legacy, "folder_id": "unfiled"})
        self.assertEqual(ReceiptStore(self.root).list_folders(), self.store.list_folders())
        self.assertEqual(self.client.get("/api/receipts?folder_id=unfiled").json()["items"][0]["id"], record["id"])
        self.assertEqual(self.client.get(record["image_url"]).content, PNG)
        self.assertEqual(self.client.patch(f"/api/receipts/{record['id']}", json={"content": "기존 내용 수정"}).status_code, 200)

    def test_default_folder_accepts_json_and_multipart_and_keeps_moved_receipts_after_restart(self):
        first = self.client.post("/api/receipts", json=self.payload("unfiled"))
        self.assertEqual(first.status_code, 201, first.text)
        metadata = {"submission_id": str(uuid4()), "folder_id": "unfiled", "content": "미분류 등록"}
        second = self.client.post("/api/receipts", files=[
            ("metadata", (None, json.dumps(metadata))), ("images", ("receipt.png", PNG)),
        ])
        self.assertEqual(second.status_code, 201, second.text)
        target = self.folder()
        record = first.json()
        moved = self.client.post(f"/api/receipts/{record['id']}/move", json={"folder_id": target["id"]})
        self.assertEqual(moved.status_code, 200, moved.text)
        for key in ["id", "created_at", "registrant", "content", "images", "image_url"]:
            self.assertEqual(moved.json()[key], record[key])
        self.assertEqual(self.client.get(record["image_url"]).content, PNG)
        self.assertEqual(self.client.post(f"/api/receipts/{record['id']}/move", json={"folder_id": target["id"]}).json(), moved.json())
        self.assertEqual(ReceiptStore(self.root).list(0, 24, target["id"])["items"], [moved.json()])
        self.assertEqual(self.client.get("/api/receipts?folder_id=unfiled").json()["total"], 1)
        returned = self.client.post(f"/api/receipts/{record['id']}/move", json={"folder_id": "unfiled"})
        self.assertEqual(returned.status_code, 200)
        self.assertEqual(ReceiptStore(self.root).list(0, 24, "unfiled")["total"], 2)

    def test_completed_folders_block_new_receipts_and_incoming_moves_until_reopened(self):
        folder = self.folder()
        payload = self.payload(folder["id"])
        original = self.client.post("/api/receipts", json=payload).json()
        waiting = self.client.post("/api/receipts", json=self.payload("unfiled")).json()
        status_url = f"/api/receipts/folders/{folder['id']}"
        completed = self.client.patch(status_url, json={"status": "completed"})
        self.assertEqual(completed.status_code, 200)
        self.assertFalse(completed.json()["can_upload"])
        self.assertEqual(completed.json()["receipt_count"], 1)
        self.assertEqual(ReceiptStore(self.root).get_folder(folder["id"])["status"], "completed")
        self.assertEqual(self.client.post("/api/receipts", json=self.payload(folder["id"])).status_code, 409)
        self.assertEqual(self.client.post("/api/receipts", json=payload).json(), original)
        metadata = {"submission_id": str(uuid4()), "folder_id": folder["id"], "content": "완료 후 등록 시도"}
        blocked = self.client.post("/api/receipts", files=[
            ("metadata", (None, json.dumps(metadata))), ("images", ("receipt.png", PNG)),
        ])
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(self.client.post(f"/api/receipts/{waiting['id']}/move", json={"folder_id": folder["id"]}).status_code, 409)
        self.assertEqual(self.store.get(waiting["id"])["folder_id"], "unfiled")
        # Receipts can be corrected or moved out of a completed folder.
        self.assertEqual(self.client.patch(f"/api/receipts/{original['id']}", json={"content": "내용 정정"}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/receipts/{original['id']}/move", json={"folder_id": "unfiled"}).status_code, 200)
        reopened = self.client.patch(status_url, json={"status": "in_progress"})
        self.assertTrue(reopened.json()["can_upload"])
        self.assertEqual(self.client.post(f"/api/receipts/{waiting['id']}/move", json={"folder_id": folder["id"]}).status_code, 200)
        self.assertEqual(self.client.post("/api/receipts", json=self.payload(folder["id"])).status_code, 201)

    def test_default_folder_can_be_completed_and_existing_folder_status_defaults_to_in_progress(self):
        folder = self.folder()
        path = self.root / ".folders" / folder["id"] / "folder.json"
        legacy = json.loads(path.read_text(encoding="utf-8"))
        del legacy["status"]
        path.write_text(json.dumps(legacy), encoding="utf-8")
        self.assertEqual(self.store.get_folder(folder["id"])["status"], "in_progress")
        self.assertEqual(self.client.patch("/api/receipts/folders/unfiled", json={"status": "completed"}).status_code, 200)
        self.assertEqual(self.client.post("/api/receipts", json=self.payload("unfiled")).status_code, 409)
        self.assertEqual(self.store.list_folders()["items"][0]["status"], "completed")

    def test_failed_move_or_status_write_keeps_previous_metadata_and_files(self):
        folder = self.folder()
        record = self.client.post("/api/receipts", json=self.payload("unfiled")).json()
        with patch.object(Path, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.store.move(record["id"], folder["id"])
            with self.assertRaises(OSError):
                self.store.set_folder_status(folder["id"], "completed")
        self.assertEqual(self.store.public(self.store.get(record["id"])), record)
        self.assertEqual(self.store.get_folder(folder["id"])["status"], "in_progress")
        self.assertEqual(self.client.get(record["image_url"]).content, PNG)
        self.assertEqual({path.name for path in (self.root / record["id"]).iterdir()}, {"receipt.json", "image.png"})

    def test_folder_completed_while_upload_is_staging_cannot_receive_that_upload(self):
        folder = self.folder()
        staged, release = Event(), Event()

        class BlockingStream(BytesIO):
            reads = 0

            def read(self, size=-1):
                self.reads += 1
                if self.reads == 2:
                    staged.set()
                    if not release.wait(10):
                        raise RuntimeError("Upload staging timed out")
                return super().read(size)

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.store.create, uuid4(), "등록자", "완료와 동시 업로드",
                                 folder_id=folder["id"], images=[("receipt.png", BlockingStream(PNG))])
            try:
                self.assertTrue(staged.wait(5))
                self.store.set_folder_status(folder["id"], "completed")
            finally:
                release.set()
            with self.assertRaises(ReceiptConflict):
                future.result(timeout=10)
        self.assertEqual(self.store.list(0, 24, folder["id"])["total"], 0)
        self.assertEqual([path.name for path in self.root.iterdir()], [".folders"])

    def test_move_and_status_validate_targets_and_require_login(self):
        folder = self.folder()
        record = self.client.post("/api/receipts", json=self.payload("unfiled")).json()
        move_url = f"/api/receipts/{record['id']}/move"
        status_url = f"/api/receipts/folders/{folder['id']}"
        for payload in [{}, {"folder_id": "../outside"}, {"folder_id": folder["id"], "content": "추가 필드"}]:
            self.assertEqual(self.client.post(move_url, json=payload).status_code, 422)
        self.assertEqual(self.client.post(move_url, json={"folder_id": uuid4().hex}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/receipts/{uuid4().hex}/move", json={"folder_id": folder["id"]}).status_code, 404)
        self.assertEqual(self.client.patch(status_url, json={"status": "unknown"}).status_code, 422)
        self.assertEqual(self.client.patch(f"/api/receipts/folders/{uuid4().hex}", json={"status": "completed"}).status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.post(move_url, json={"folder_id": folder["id"]}).status_code, 401)
        self.assertEqual(self.client.patch(status_url, json={"status": "completed"}).status_code, 401)

    def test_pdf_and_images_upload_together_and_pdf_originals_survive_reload_and_replacement(self):
        folder = self.folder()
        pdf = pdf_receipt()
        metadata = {"submission_id": str(uuid4()), "folder_id": folder["id"], "content": "PDF 및 사진"}
        response = self.client.post("/api/receipts", files=[
            ("metadata", (None, json.dumps(metadata))),
            ("images", ("영수증.PDF", pdf, "application/octet-stream")),
            ("images", ("사진.png", PNG, "image/png")),
        ])
        self.assertEqual(response.status_code, 201, response.text)
        record = response.json()
        self.assertEqual(record["image_count"], 2)
        self.assertEqual(record["content_type"], "application/pdf")
        self.assertEqual(ReceiptStore(self.root).list(0, 24, folder["id"])["items"], [record])
        for query in ["", "?download=true"]:
            original = self.client.get(record["images"][0]["image_url"] + query)
            self.assertEqual(original.content, pdf)
            self.assertEqual(original.headers["content-type"], "application/pdf")
            self.assertIn("attachment" if query else "inline", original.headers["content-disposition"])
        updated = self.client.patch(f"/api/receipts/{record['id']}", json={
            "content": "PDF 교체", "filename": "교체.pdf", "image_base64": base64.b64encode(pdf).decode(),
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["image_count"], 1)
        self.assertEqual(updated.json()["folder_id"], folder["id"])
        self.assertEqual(self.client.get(updated.json()["image_url"]).content, pdf)
        self.assertEqual(self.client.get(record["images"][1]["image_url"]).status_code, 404)

    def test_invalid_pdf_cannot_replace_existing_receipt_or_publish_a_partial_group(self):
        folder = self.folder()
        record = self.client.post("/api/receipts", json=self.payload(folder["id"])).json()
        for data in [b"not a PDF", b"%PDF-1.7\n%%EOF", pdf_receipt()[:-30]]:
            response = self.client.patch(f"/api/receipts/{record['id']}", json={
                "content": "교체", "filename": "bad.pdf", "image_base64": base64.b64encode(data).decode(),
            })
            self.assertEqual(response.status_code, 422)
            self.assertEqual(self.client.get(record["image_url"]).content, PNG)
            metadata = {"submission_id": str(uuid4()), "folder_id": folder["id"], "content": "잘못된 PDF 묶음"}
            response = self.client.post("/api/receipts", files=[
                ("metadata", (None, json.dumps(metadata))),
                ("images", ("receipt.png", PNG)), ("images", ("bad.pdf", data)),
            ])
            self.assertEqual(response.status_code, 422)
            self.assertEqual(self.store.list(0, 24)["items"], [record])
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/api/receipts/folders").status_code, 401)
        self.assertEqual(self.client.post("/api/receipts/folders", json={"name": "차단"}).status_code, 401)
