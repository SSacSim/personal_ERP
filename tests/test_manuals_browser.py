"""Real-browser manual workflows against the existing isolated test server."""
import os
from pathlib import Path
import unittest

import test_image_paste_browser as browser_support


expect = getattr(browser_support, "expect", None)


@unittest.skipUnless(browser_support.sync_playwright, "Playwright is optional")
class ManualBrowserTests(unittest.TestCase):
    setUpClass = classmethod(browser_support.ImagePasteBrowserTests.setUpClass.__func__)
    setUp = browser_support.ImagePasteBrowserTests.setUp

    def screenshot(self, name):
        directory = os.getenv("GAI_ERP_TEST_SCREENSHOTS")
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True)
            self.page.evaluate("window.scrollTo(0, 0)")
            self.page.screenshot(path=str(Path(directory) / name), full_page=True)

    def create_manual(self, title="브라우저 정산 매뉴얼", **extra):
        response = self.context.request.post(self.origin + "/api/manuals", data={"title": title, "owner": "재무 담당", **extra})
        self.assertEqual(response.status, 201)
        return response.json()

    def test_public_menu_standard_template_guidelines_publish_and_review_filter(self):
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        self.page.goto(self.origin + "/manuals")
        expect(self.page.locator('[data-menu-group="public"] [data-route="manuals"]')).to_be_visible()
        self.page.locator("[data-manual-guide] summary").click()
        expect(self.page.locator(".manual-guide-grid li")).to_have_count(8)
        expect(self.page.locator("[data-guide-content]")).to_contain_text("비밀번호")
        self.page.get_by_role("button", name="+ 새 매뉴얼", exact=True).click()
        expect(self.page.locator(".manual-form-section")).to_have_count(7)
        self.page.locator("input[name=title]").fill("UI 검증 월말 정산하기")
        self.page.locator("input[name=category]").fill("재무·정산")
        self.page.locator("select[name=status]").select_option("published")
        self.page.get_by_role("button", name="매뉴얼 저장", exact=True).click()
        expect(self.page.locator("[data-manual-form-notice]")).to_contain_text("목적과 완료 기준")
        self.page.locator("textarea[name=purpose]").fill("월말 정산 자료를 제출한다.")
        self.page.locator("textarea[name=scope]").fill("재무 담당 작성, 팀장 검토")
        self.page.locator("textarea[name=procedure]").fill("1. 회사 포털 > 정산에서 자료를 대조한다.\n2. 제출 후 접수 번호를 확인한다.")
        self.page.locator("textarea[name=checklist]").fill("- 건수와 금액 일치\n- 접수 번호 확인")
        self.page.locator("textarea[name=references]").fill('https://example.com/policy\n<script>alert("unsafe")</script>')
        self.page.locator("input[name=next_review_date]").fill("2000-01-01")
        self.page.get_by_role("button", name="매뉴얼 저장", exact=True).click()
        expect(self.page.locator(".manual-reader")).to_contain_text("UI 검증 월말 정산하기")
        expect(self.page.locator(".manual-reader-section")).to_have_count(7)
        expect(self.page.locator(".manual-reader")).to_contain_text("검토일이 되었습니다")
        expect(self.page.locator(".manual-history tbody tr")).to_have_count(1)
        expect(self.page.locator('.manual-text a[href="https://example.com/policy"]')).to_have_count(1)
        self.assertEqual(self.page.locator(".manual-reader script").count(), 0)
        self.page.locator("[data-manual-search]").fill("UI 검증 월말")
        self.page.locator("[data-manual-filter]").select_option("due")
        expect(self.page.locator("[data-manual-open]")).to_have_count(1)
        self.screenshot("manual-desktop.png")
        self.page.reload()
        expect(self.page.locator(".manual-reader")).to_contain_text("접수 번호")
        self.assertEqual(errors, [])

    def test_new_draft_survives_refresh_navigation_and_save_failure(self):
        self.page.goto(self.origin + "/manuals")
        self.page.get_by_role("button", name="+ 새 매뉴얼", exact=True).click()
        self.page.locator("input[name=title]").fill("복원할 매뉴얼 초안")
        self.page.locator("textarea[name=procedure]").fill("아직 작성 중인 절차\n두 번째 줄")
        self.page.reload()
        expect(self.page.locator("input[name=title]")).to_have_value("복원할 매뉴얼 초안")
        expect(self.page.locator("[data-draft-status]")).to_contain_text("복원")
        self.page.locator('[data-route="meetings"]').click()
        self.page.locator('[data-route="manuals"]').click()
        self.page.get_by_role("button", name="+ 새 매뉴얼", exact=True).click()
        expect(self.page.locator("textarea[name=procedure]")).to_have_value("아직 작성 중인 절차\n두 번째 줄")
        self.page.route("**/api/manuals", lambda route: route.fulfill(status=503, content_type="application/json", body='{"detail":"test save failure"}'), times=1)
        self.page.get_by_role("button", name="매뉴얼 저장", exact=True).click()
        expect(self.page.locator("[data-manual-form-notice]")).to_contain_text("작성 내용은 유지됩니다")
        expect(self.page.locator("textarea[name=procedure]")).to_have_value("아직 작성 중인 절차\n두 번째 줄")
        self.page.get_by_role("button", name="매뉴얼 저장", exact=True).click()
        expect(self.page.locator(".manual-reader")).to_contain_text("복원할 매뉴얼 초안")
        self.page.get_by_role("button", name="+ 새 매뉴얼", exact=True).click()
        expect(self.page.locator("input[name=title]")).to_have_value("")

    def test_update_history_version_conflict_and_latest_editor(self):
        manual = self.create_manual("수정 이력과 충돌 검증", sections={"procedure": "최초 업무 절차"})
        self.page.goto(self.origin + f'/manuals?manual={manual["id"]}')
        self.page.locator("[data-manual-edit]").click()
        self.page.locator("textarea[name=procedure]").fill("새로운 업무 절차")
        self.page.locator("select[name=review_cycle_days]").select_option("30")
        self.page.locator("textarea[name=change_summary]").fill("실제 업무에 맞춰 절차 변경")
        self.page.get_by_role("button", name="변경 내용 저장", exact=True).click()
        expect(self.page.locator(".manual-history tbody tr")).to_have_count(2)
        expect(self.page.locator(".manual-reader")).to_contain_text("실제 업무에 맞춰 절차 변경")
        expect(self.page.locator(".manual-reader")).to_contain_text("30일 주기")
        self.page.locator("[data-manual-edit]").click()
        self.page.locator("textarea[name=procedure]").fill("아직 저장하지 않은 내 변경")
        latest = self.context.request.get(self.origin + f'/api/manuals/{manual["id"]}').json()
        payload = {key: latest[key] for key in ("title", "category", "owner", "status", "review_cycle_days", "next_review_date", "sections", "version")}
        payload.update(change_summary="다른 동료의 변경", sections={**latest["sections"], "procedure": "동료가 먼저 저장한 절차"})
        self.assertEqual(self.context.request.patch(self.origin + f'/api/manuals/{manual["id"]}', data=payload).status, 200)
        self.page.locator("textarea[name=change_summary]").fill("내 변경 요약")
        self.page.get_by_role("button", name="변경 내용 저장", exact=True).click()
        expect(self.page.locator("[data-manual-form-notice]")).to_contain_text("다른 사용자가 먼저 수정")
        expect(self.page.locator("textarea[name=procedure]")).to_have_value("아직 저장하지 않은 내 변경")
        expect(self.page.get_by_role("link", name="최신본 새 창에서 확인")).to_be_visible()
        self.page.remove_listener("dialog", self.dismiss_dialog)
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.locator("[data-manual-latest]").click()
        expect(self.page.locator("textarea[name=procedure]")).to_have_value("동료가 먼저 저장한 절차")
        self.page.locator("textarea[name=change_summary]").fill("최신본 검토 완료")
        self.page.get_by_role("button", name="변경 내용 저장", exact=True).click()
        expect(self.page.locator(".manual-history tbody tr")).to_have_count(4)

    def test_mobile_layout_and_loading_failure_retry(self):
        manual = self.create_manual("모바일 매뉴얼", sections={"procedure": "화면에서 필요한 자료를 확인한다."})
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.route("**/api/manuals/guide", lambda route: route.fulfill(status=503, content_type="application/json", body='{"detail":"test guide failure"}'), times=1)
        self.page.goto(self.origin + f'/manuals?manual={manual["id"]}')
        expect(self.page.locator("[data-manual-notice]")).to_contain_text("불러오지 못했습니다")
        self.page.locator("[data-manual-refresh]").click()
        expect(self.page.locator(".manual-reader")).to_contain_text("모바일 매뉴얼")
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.screenshot("manual-mobile.png")
        self.page.locator("[data-manual-edit]").click()
        expect(self.page.locator("input[name=title]")).to_have_value("모바일 매뉴얼")
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.screenshot("manual-mobile-editor.png")
