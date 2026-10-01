"""Optional UI regression tests: requires Playwright and its Chromium browser.

Runs the real application against a temporary vault; never touches live data.
"""
import base64
from io import BytesIO
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from urllib.request import Request, urlopen

try:
    from playwright.sync_api import sync_playwright, expect
except ImportError:
    sync_playwright = None

from app.auth_store import AuthStore
from PIL import Image


PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6M1sAAAAASUVORK5CYII="


@unittest.skipUnless(sync_playwright, "Playwright is optional; install it and Chromium to run UI tests")
class ImagePasteBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        store = AuthStore(Path(cls.temp.name) / "Auth")
        store.ensure()
        cls.session = store.create_session(store.list_users()[0]["id"])
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.origin = f"http://127.0.0.1:{port}"
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "GAI_ERP_VAULT": cls.temp.name},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        def stop_server():
            cls.server.terminate()
            cls.server.wait(timeout=15)
        cls.addClassCleanup(stop_server)
        for _ in range(100):
            try:
                with urlopen(Request(cls.origin + "/health", headers={"Cookie": f"erp_session={cls.session}"}), timeout=1):
                    break
            except OSError:
                if cls.server.poll() is not None:
                    raise RuntimeError("Temporary test server exited")
                time.sleep(0.1)
        else:
            raise RuntimeError("Temporary test server did not start")
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(headless=True, channel=os.getenv("GAI_ERP_TEST_BROWSER") or None)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context()
        self.addCleanup(self.context.close)
        self.context.add_cookies([{"name": "erp_session", "value": self.session, "url": self.origin}])
        self.page = self.context.new_page()
        self.page.on("dialog", lambda dialog: dialog.dismiss())

    def new_document(self, path, label):
        self.page.goto(self.origin + path)
        self.page.get_by_role("button", name=f"새 {label}").click()
        self.page.locator("input[name=title]").fill(f"{label} 붙여넣기 검증")

    def paste(self, selector, count=1, html=None):
        self.page.locator(selector).evaluate("""(surface, args) => {
          surface.focus();
          const range = document.createRange();
          range.selectNodeContents(surface);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
          const data = new DataTransfer();
          if (args.html !== null) data.setData('text/html', args.html);
          else for (let i = 0; i < args.count; i++) {
            data.items.add(new File([Uint8Array.from(atob(args.png), c => c.charCodeAt(0))],
              `clipboard-${i}.png`, {type: 'image/png'}));
          }
          surface.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
        }""", {"png": PNG, "count": count, "html": html})

    def test_meeting_and_wiki_images_survive_save_reload_and_edit(self):
        for path, label, field in [("/meetings", "회의록", "notes"), ("/wiki", "위키", "content")]:
            with self.subTest(path=path):
                self.new_document(path, label)
                selector = f"[data-rich-editor={field}]"
                self.page.locator(selector).fill("붙여넣기 앞 내용")
                self.paste(selector, count=2)
                expect(self.page.locator(f"{selector} .editor-rich-image")).to_have_count(2)
                self.page.get_by_role("button", name=f"{label} 저장", exact=True).click()
                expect(self.page.locator(".resource-reader img")).to_have_count(2)
                self.page.reload()
                expect(self.page.locator(".resource-reader img")).to_have_count(2)
                self.page.locator("[data-document-edit]").click()
                expect(self.page.locator(f"{selector} .editor-rich-image")).to_have_count(2)
                self.page.get_by_role("button", name=f"{label} 수정", exact=True).click()
                expect(self.page.locator(".resource-reader img")).to_have_count(2)
                self.assertTrue(self.page.locator(".resource-reader img").evaluate_all("images => images.every(image => image.complete && image.naturalWidth > 0)"))

    def test_pending_and_failed_uploads_block_save_and_can_retry(self):
        self.new_document("/wiki", "위키")
        requests = []
        self.page.route("**/api/assets", lambda route: requests.append(route))
        self.paste("[data-rich-editor=content]")
        self.page.get_by_role("button", name="위키 저장", exact=True).click()
        expect(self.page.locator("[data-image-upload-feedback]")).to_be_visible()
        expect(self.page.locator("#wiki-form")).to_be_visible()
        self.assertEqual(len(requests), 1)
        requests[0].fulfill(status=503, content_type="application/json", body='{"detail":"test upload failure"}')
        expect(self.page.locator('[data-image-upload="error"]')).to_be_visible()
        self.page.get_by_role("button", name="위키 저장", exact=True).click()
        expect(self.page.locator("#wiki-form")).to_be_visible()
        self.page.unroute("**/api/assets")
        self.page.get_by_role("button", name="다시 시도", exact=True).click()
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.get_by_role("button", name="위키 저장", exact=True).click()
        expect(self.page.locator(".resource-reader img")).to_have_count(1)

    def test_html_image_and_text_are_saved_without_temporary_data_url(self):
        self.new_document("/meetings", "회의록")
        self.paste("[data-rich-editor=agenda]", html=f'<p>앞 내용<strong><img src="data:image/png;base64,{PNG}"></strong>뒤 내용</p>')
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.get_by_role("button", name="회의록 저장", exact=True).click()
        expect(self.page.locator(".resource-reader img")).to_have_count(1)
        expect(self.page.locator(".resource-reader")).to_contain_text("앞 내용")
        expect(self.page.locator(".resource-reader")).to_contain_text("뒤 내용")
        self.page.locator("[data-document-edit]").click()
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.assertNotIn("data:image", self.page.locator("textarea[name=agenda]").input_value())

    def test_file_picker_and_removing_failed_image(self):
        self.new_document("/wiki", "위키")
        self.page.locator("[data-inline-image-input=content]").set_input_files({"name": "picture.png", "mimeType": "image/png", "buffer": base64.b64decode(PNG)})
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.locator("[data-inline-image-input=content]").set_input_files({"name": "bad.svg", "mimeType": "image/svg+xml", "buffer": b"<svg/>"})
        expect(self.page.locator('[data-image-upload="error"]')).to_be_visible()
        self.page.locator(".image-upload-placeholder").get_by_role("button", name="삭제", exact=True).click()
        self.page.get_by_role("button", name="위키 저장", exact=True).click()
        expect(self.page.locator(".resource-reader img")).to_have_count(1)

    def test_real_keyboard_image_and_plain_text_paste(self):
        self.new_document("/wiki", "위키")
        self.context.grant_permissions(["clipboard-read", "clipboard-write"])
        self.page.evaluate("""async () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 2;
          const blob = await new Promise(resolve => canvas.toBlob(resolve));
          await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
        }""")
        self.page.locator("[data-rich-editor=content]").click()
        self.page.keyboard.press("Control+V")
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.evaluate("navigator.clipboard.writeText('일반 텍스트\\n두 번째 줄')")
        self.page.keyboard.press("Control+V")
        expect(self.page.locator("[data-rich-editor=content]")).to_contain_text("일반 텍스트")
        self.page.get_by_role("button", name="위키 저장", exact=True).click()
        expect(self.page.locator(".resource-reader img")).to_have_count(1)
        expect(self.page.locator(".resource-reader")).to_contain_text("두 번째 줄")

    def test_chat_and_receipt_clipboard_images_use_attachment_lists(self):
        self.page.goto(self.origin + "/chat")
        self.paste(".tc-compose textarea")
        expect(self.page.locator(".tc-pending-file")).to_have_count(1)
        self.page.goto(self.origin + "/receipt-upload")
        self.paste("#content", count=2)
        expect(self.page.locator(".preview-card")).to_have_count(2)
        expect(self.page.locator("#selection-count")).to_contain_text("2장")

    def receipt_photos(self):
        photos = []
        for index, color in enumerate(["#f8e6cf", "#e0eee4", "#dfe7f3"], 1):
            output = BytesIO()
            with Image.new("RGB", (300, 440), color) as image:
                image.save(output, format="JPEG")
            photos.append({"name": f"Screenshot_{index}.JPG", "mimeType": "image/jpg", "buffer": output.getvalue() + b"mobile metadata"})
        return photos

    def test_receipt_group_registration_gallery_download_and_replacement(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        photos = self.receipt_photos()
        for width in [1200, 390]:
            with self.subTest(viewport=width):
                self.page.set_viewport_size({"width": width, "height": 844})
                before = self.context.request.get(self.origin + "/api/receipts").json()["total"]
                self.page.goto(self.origin + "/receipt-upload")
                self.page.locator("#image").set_input_files(photos)
                expect(self.page.locator(".preview-card")).to_have_count(3)
                self.page.locator("#content").fill(f"사진 3장 묶음 검증 {width}")
                with self.page.expect_response(lambda response: response.url.endswith("/api/receipts") and response.request.method == "POST") as saved:
                    self.page.locator("#submit-button").click()
                self.assertEqual(saved.value.status, 201)
                record = saved.value.json()
                self.assertEqual(record["image_count"], 3)
                expect(self.page.locator("#notice")).to_contain_text("사진 3장이 포함된 영수증 1건")
                self.assertEqual(self.context.request.get(self.origin + "/api/receipts").json()["total"], before + 1)
                self.page.goto(self.origin + "/receipts")
                self.page.locator(f'[data-receipt-id="{record["id"]}"] .receipt-open').click()
                expect(self.page.locator(".receipt-dialog")).to_be_visible()
                expect(self.page.locator("[data-photo-index]")).to_have_count(3)
                for index, photo in enumerate(photos):
                    self.page.get_by_role("button", name=f"사진 {index + 1} 보기", exact=True).click()
                    expect(self.page.locator("[data-photo-position]")).to_have_text(f"사진 {index + 1} / 3")
                    expect(self.page.locator(".receipt-detail-photo img")).to_have_attribute("src", record["images"][index]["image_url"])
                    with self.page.expect_download() as downloaded:
                        self.page.locator("[data-photo-download]").click()
                    self.assertEqual(downloaded.value.suggested_filename, photo["name"])
                    self.assertEqual(Path(downloaded.value.path()).read_bytes(), photo["buffer"])
                bounds = self.page.locator(".receipt-dialog").bounding_box()
                self.assertGreaterEqual(bounds["x"], 0)
                self.assertLessEqual(bounds["x"] + bounds["width"], width)
                if os.getenv("GAI_ERP_TEST_SCREENSHOTS"):
                    destination = Path(os.environ["GAI_ERP_TEST_SCREENSHOTS"])
                    destination.mkdir(parents=True, exist_ok=True)
                    self.page.screenshot(path=str(destination / f"receipt-group-{width}.png"))
                # A content edit sets updated_at; replacement Blob URLs must still decode.
                self.page.locator("[data-edit]").click()
                self.page.locator("#receipt-content").fill("내용 수정 후 사진 교체")
                self.page.locator("[data-save]").click()
                expect(self.page.locator("[data-detail-notice]")).to_have_text("저장했습니다.")
                self.page.locator("[data-edit]").click()
                self.page.locator("#receipt-photo").set_input_files(photos[:2])
                expect(self.page.locator("[data-detail-notice]")).to_contain_text("사진 2장으로 전체 교체")
                expect(self.page.locator("[data-save]")).to_be_enabled()
                self.page.get_by_role("button", name="사진 2 보기", exact=True).click()
                self.assertTrue(self.page.locator(".receipt-detail-photo img").evaluate("async image => { await image.decode(); return image.naturalWidth > 0; }"))
                self.page.locator("[data-save]").click()
                expect(self.page.locator("[data-detail-notice]")).to_have_text("저장했습니다.")
                expect(self.page.locator("[data-photo-index]")).to_have_count(2)
                self.page.locator("[data-close]").click()
                self.page.reload()
                self.page.locator(f'[data-receipt-id="{record["id"]}"] .receipt-open').click()
                expect(self.page.locator("[data-photo-index]")).to_have_count(2)
                self.page.locator("[data-close]").click()
        self.assertEqual(errors, [])

    def test_receipt_group_lost_response_retry_keeps_one_record(self):
        before = self.context.request.get(self.origin + "/api/receipts").json()["total"]
        self.page.goto(self.origin + "/receipt-upload")
        self.page.locator("#image").set_input_files(self.receipt_photos())
        self.page.locator("#content").fill("응답 유실 재시도 검증")
        saved_ids = []
        def lose_response(route):
            response = route.fetch()
            saved_ids.append(response.json()["id"])
            route.abort("failed")
        self.page.route("**/api/receipts", lose_response, times=1)
        self.page.locator("#submit-button").click()
        expect(self.page.locator("#notice")).to_contain_text("재시도")
        expect(self.page.locator("#image")).to_be_disabled()
        self.page.get_by_role("button", name="영수증 다시 등록하기", exact=True).click()
        expect(self.page.locator("#notice")).to_contain_text("사진 3장이 포함된 영수증 1건")
        listing = self.context.request.get(self.origin + "/api/receipts").json()
        self.assertEqual(listing["total"], before + 1)
        record = next(record for record in listing["items"] if record["id"] == saved_ids[0])
        self.assertEqual(record["image_count"], 3)

    def test_project_meeting_record_and_file_paste(self):
        project = self.context.request.post(self.origin + "/api/projects", data={"name": "이미지 붙여넣기 프로젝트"}).json()
        self.page.goto(self.origin + "/projects")
        self.page.locator(f'[data-project-open="{project["id"]}"]').click()
        self.page.locator("[data-project-resource-new]").click()
        self.page.locator("input[name=title]").fill("프로젝트 회의")
        self.paste("[data-rich-editor=notes]")
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.get_by_role("button", name="회의록 저장", exact=True).click()
        expect(self.page.locator(".resource-reader img")).to_have_count(1)
        self.page.locator("[data-project-tab=records]").click()
        self.paste("[data-rich-editor=content]")
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.get_by_role("button", name="기록 저장", exact=True).click()
        expect(self.page.locator(".record-feed-item img")).to_have_count(1)
        self.page.locator("[data-project-record-edit]").click()
        expect(self.page.locator(".editor-rich-image")).to_have_count(1)
        self.page.get_by_role("button", name="기록 수정", exact=True).click()
        expect(self.page.locator(".record-feed-item img")).to_have_count(1)
        self.page.locator("[data-project-tab=files]").click()
        with self.page.expect_response(lambda response: "/api/project-files" in response.url and response.request.method == "POST") as saved:
            self.paste("[data-project-file-dropzone]")
        self.assertEqual(saved.value.status, 201)
        self.page.reload()
        self.page.locator(f'[data-project-open="{project["id"]}"]').click()
        self.page.locator("[data-project-tab=records]").click()
        expect(self.page.locator(".record-feed-item img")).to_have_count(1)


if __name__ == "__main__":
    unittest.main()
