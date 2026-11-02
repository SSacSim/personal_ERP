"""Folder and PDF receipt workflows against an isolated real browser/server."""
import os
import base64
import json
from pathlib import Path
import unittest
from uuid import uuid4

import test_image_paste_browser as browser_support
from test_receipt_folders import pdf_receipt
from test_receipts import PNG


expect = getattr(browser_support, "expect", None)


@unittest.skipUnless(browser_support.sync_playwright, "Playwright is optional")
class ReceiptFolderBrowserTests(unittest.TestCase):
    setUpClass = classmethod(browser_support.ImagePasteBrowserTests.setUpClass.__func__)
    setUp = browser_support.ImagePasteBrowserTests.setUp

    def screenshot(self, name):
        directory = os.getenv("GAI_ERP_TEST_SCREENSHOTS")
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True)
            if self.page.locator(".receipt-pdf-preview").count():
                self.page.wait_for_timeout(1500)
            self.page.screenshot(path=str(Path(directory) / name), full_page=True)

    def test_folder_creation_pdf_registration_preview_download_and_replacement(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        for width in [1280, 390]:
            with self.subTest(width=width):
                name = f"출장 경비 {width} {uuid4().hex[:6]}"
                self.page.set_viewport_size({"width": width, "height": 900})
                self.page.goto(self.origin + "/receipts")
                expect(self.page.locator("[data-upload]")).to_be_hidden()
                self.page.locator("[data-create-folder]").click()
                self.page.locator("#receipt-folder-name").fill(name)
                self.page.locator("[data-folder-save]").click()
                expect(self.page.locator("[data-heading]")).to_have_text(name)
                expect(self.page.locator("[data-upload]")).to_be_visible()
                self.page.locator("[data-upload]").click()
                expect(self.page.locator("#receipt-folder")).to_contain_text(name)
                pdf = pdf_receipt()
                self.page.locator("#image").set_input_files([
                    {"name": "출장영수증.PDF", "mimeType": "application/pdf", "buffer": pdf},
                    {"name": "추가영수증.png", "mimeType": "image/png", "buffer": PNG},
                ])
                expect(self.page.locator(".preview-pdf")).to_be_visible()
                expect(self.page.locator("#submit-button")).to_be_enabled()
                self.page.locator("#content").fill("출장 교통비 PDF")
                with self.page.expect_response(lambda response: response.url.endswith("/api/receipts") and response.request.method == "POST") as saved:
                    self.page.locator("#submit-button").click()
                self.assertEqual(saved.value.status, 201)
                record = saved.value.json()
                self.assertEqual(record["content_type"], "application/pdf")
                expect(self.page.locator("#notice")).to_contain_text(name)
                self.page.locator("#receipt-list-link").click()
                expect(self.page.locator("tbody .receipt-pdf-icon")).to_be_visible()
                self.page.locator(".receipt-open").click()
                expect(self.page.locator(".receipt-pdf-preview")).to_have_attribute("src", record["images"][0]["image_url"])
                self.page.locator('[data-photo-index="1"]').click()
                expect(self.page.locator(".receipt-detail-photo img")).to_be_visible()
                self.page.locator('[data-photo-index="0"]').click()
                expect(self.page.locator(".receipt-pdf-preview")).to_be_visible()
                with self.page.expect_download() as download:
                    self.page.locator("[data-photo-download]").click()
                self.assertEqual(download.value.suggested_filename, "출장영수증.PDF")
                self.assertEqual(Path(download.value.path()).read_bytes(), pdf)
                self.screenshot(f"receipt-pdf-{width}.png")
                self.page.locator("[data-edit]").click()
                self.page.locator("#receipt-photo").set_input_files({"name": "교체.pdf", "mimeType": "application/octet-stream", "buffer": pdf})
                expect(self.page.locator("[data-save]")).to_be_enabled()
                self.page.locator("[data-save]").click()
                expect(self.page.locator("[data-detail-notice]")).to_have_text("저장했습니다.")
                expect(self.page.locator("[data-photo-filename]")).to_have_text("교체.pdf")
                self.page.locator("[data-close]").click()
                self.page.reload()
                expect(self.page.locator("[data-heading]")).to_have_text(name)
                expect(self.page.locator(".receipt-open")).to_have_count(1)
                self.page.locator("[data-folder-back]").click()
                expect(self.page.locator("[data-upload]")).to_be_hidden()
                expect(self.page.locator(f'[data-folder-id="{record["folder_id"]}"]')).to_contain_text("영수증 1건")
                self.screenshot(f"receipt-folders-{width}.png")
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
        self.assertEqual(errors, [])

    def test_direct_registration_without_valid_folder_is_blocked(self):
        for query in ["", f"?folder_id={uuid4().hex}"]:
            self.page.goto(self.origin + "/receipt-upload" + query)
            expect(self.page.locator("#notice")).to_be_visible()
            expect(self.page.locator("#receipt-form")).to_be_hidden()
            expect(self.page.locator("#submit-button")).to_be_disabled()
            expect(self.page.locator("#receipt-list-link")).to_have_attribute("href", "/receipts")

    def create_folder(self, name):
        response = self.context.request.post(self.origin + "/api/receipts/folders", data={"name": name + uuid4().hex[:6]})
        self.assertEqual(response.status, 201)
        return response.json()

    def test_default_folder_migration_move_picker_and_folder_completion(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        for width in [1280, 390]:
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 900})
                self.context.request.patch(self.origin + "/api/receipts/folders/unfiled", data={"status": "in_progress"})
                target = self.create_folder("이동할 경비 ")
                closed = self.create_folder("완료된 경비 ")
                self.context.request.patch(self.origin + f"/api/receipts/folders/{closed['id']}", data={"status": "completed"})
                response = self.context.request.post(self.origin + "/api/receipts", data={
                    "submission_id": str(uuid4()), "folder_id": "unfiled", "content": f"기존 영수증 이동 {width}",
                    "filename": "기존영수증.png", "image_base64": base64.b64encode(PNG).decode(),
                })
                self.assertEqual(response.status, 201)
                record = response.json()
                path = Path(self.temp.name) / "Receipts" / record["id"] / "receipt.json"
                legacy = json.loads(path.read_text(encoding="utf-8"))
                del legacy["folder_id"]
                path.write_text(json.dumps(legacy), encoding="utf-8")
                self.page.goto(self.origin + "/receipts")
                expect(self.page.locator('[data-folder-id="unfiled"]')).to_contain_text("미분류")
                expect(self.page.locator(f'[data-folder-id="{closed["id"]}"] .receipt-folder-badge')).to_have_text("완료")
                self.page.locator('[data-folder-id="unfiled"]').click()
                expect(self.page.locator("[data-heading]")).to_have_text("미분류")
                expect(self.page.locator("[data-upload]")).to_be_visible()
                row = self.page.locator(f'[data-receipt-id="{record["id"]}"]')
                row.locator(".receipt-move").click()
                expect(self.page.locator('[data-target-folder="unfiled"]')).to_be_disabled()
                expect(self.page.locator(f'[data-target-folder="{closed["id"]}"]')).to_be_disabled()
                expect(self.page.locator(f'[data-target-folder="{target["id"]}"]')).to_be_enabled()
                self.screenshot(f"receipt-move-{width}.png")
                self.page.locator("[data-move-close]").click()
                expect(row).to_be_visible()
                row.locator(".receipt-move").click()
                self.page.locator(f'[data-target-folder="{target["id"]}"]').click()
                expect(self.page.locator(".receipt-move-dialog")).to_be_hidden()
                expect(row).to_have_count(0)
                expect(self.page.locator("[data-page-notice]")).to_contain_text(target["name"])
                self.assertEqual(self.context.request.get(self.origin + record["image_url"]).body(), PNG)
                self.page.locator("[data-folder-back]").click()
                self.page.locator(f'[data-folder-id="{target["id"]}"]').click()
                expect(self.page.locator("[data-heading]")).to_have_text(target["name"])
                self.page.locator("[data-folder-state]").select_option("completed")
                expect(self.page.locator("[data-page-notice]")).to_contain_text("완료 처리")
                expect(self.page.locator("[data-upload]")).to_be_hidden()
                self.page.reload()
                expect(self.page.locator("[data-folder-state]")).to_have_value("completed")
                self.screenshot(f"receipt-completed-{width}.png")
                self.page.goto(self.origin + f"/receipt-upload?folder_id={target['id']}")
                expect(self.page.locator("#receipt-form")).to_be_hidden()
                expect(self.page.locator("#notice")).to_contain_text("완료된 폴더")
                self.page.goto(self.origin + f"/receipts?folder_id={target['id']}")
                self.page.locator(".receipt-open").click()
                self.page.locator("[data-move]").click()
                self.page.locator('[data-target-folder="unfiled"]').click()
                expect(self.page.locator(".receipt-move-dialog")).to_be_hidden()
                expect(self.page.locator(".receipt-dialog")).to_be_hidden()
                expect(self.page.locator(".receipt-open")).to_have_count(0)
                self.page.locator("[data-folder-state]").select_option("in_progress")
                expect(self.page.locator("[data-page-notice]")).to_contain_text("진행으로 변경")
                expect(self.page.locator("[data-upload]")).to_be_visible()
        self.assertEqual(errors, [])

    def test_move_rechecks_folder_completion_after_the_picker_was_opened(self):
        target = self.create_folder("이동 중 완료 ")
        response = self.context.request.post(self.origin + "/api/receipts", data={
            "submission_id": str(uuid4()), "folder_id": "unfiled", "content": "이동 시점 완료 확인",
            "filename": "receipt.png", "image_base64": base64.b64encode(PNG).decode(),
        })
        record = response.json()
        self.page.goto(self.origin + "/receipts?folder_id=unfiled")
        self.page.locator(f'[data-receipt-id="{record["id"]}"] .receipt-move').click()
        choice = self.page.locator(f'[data-target-folder="{target["id"]}"]')
        expect(choice).to_be_enabled()
        self.context.request.patch(self.origin + f"/api/receipts/folders/{target['id']}", data={"status": "completed"})
        choice.click()
        expect(self.page.locator("[data-move-notice]")).to_contain_text("완료된 폴더")
        expect(choice).to_be_disabled()
        expect(self.page.locator(".receipt-move-dialog")).to_be_visible()
        records = self.context.request.get(self.origin + "/api/receipts?folder_id=unfiled").json()["items"]
        self.assertTrue(any(item["id"] == record["id"] for item in records))
