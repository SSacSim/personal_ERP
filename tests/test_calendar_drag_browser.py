"""Drag actual calendar chips in a real browser, using a temporary vault."""
import unittest

import test_image_paste_browser as browser_support


expect = getattr(browser_support, "expect", None)


@unittest.skipUnless(browser_support.sync_playwright, "Playwright is optional")
class CalendarDragBrowserTests(unittest.TestCase):
    setUpClass = classmethod(browser_support.ImagePasteBrowserTests.setUpClass.__func__)
    setUp = browser_support.ImagePasteBrowserTests.setUp

    def create_event(self, **changes):
        response = self.context.request.post(self.origin + "/api/calendar/events", data={
            "title": "드래그 이동 검증", "start_date": "2026-10-19", "end_date": "2026-10-19",
            "start_time": "10:30", "end_time": "11:00", "attendees": ["동료"], "notes": "이동해도 보존할 메모", **changes,
        })
        self.assertEqual(response.status, 201)
        return response.json()

    def open_calendar(self):
        self.page.set_viewport_size({"width": 1440, "height": 1000})
        self.page.goto(self.origin + "/calendar?date=2026-10-01")
        self.page.locator(".modal-head [data-close-calendar-dialog]").click()
        expect(self.page.locator(".modal-backdrop")).to_have_count(0)

    def chip(self, item, day):
        return self.page.locator(f'.day[data-date="{day}"] [data-calendar-drag-id="{item["id"]}"]')

    def move(self, item, origin, target):
        self.chip(item, origin).drag_to(self.page.locator(f'.day[data-date="{target}"]'))

    def saved(self, item):
        return self.context.request.get(self.origin + f'/api/calendar/events/{item["id"]}').json()

    def test_drag_19_to_22_persists_and_preserves_details_and_normal_clicks(self):
        item = self.create_event()
        self.open_calendar()
        self.move(item, "2026-10-19", "2026-10-22")
        expect(self.page.locator("[data-calendar-drag-feedback]")).to_contain_text("이동했습니다")
        expect(self.chip(item, "2026-10-19")).to_have_count(0)
        expect(self.chip(item, "2026-10-22")).to_be_visible()
        expect(self.page.locator(".modal-backdrop")).to_have_count(0)
        saved = self.saved(item)
        self.assertEqual((saved["date"], saved["start_date"], saved["end_date"]), ("2026-10-22",) * 3)
        for key in ("id", "path", "created_at", "title", "category", "start_time", "end_time", "attendees"):
            self.assertEqual(saved[key], item[key])
        self.assertIn("이동해도 보존할 메모", saved["body"])
        self.assertIn("수정", saved["body"])
        self.page.reload()
        self.page.locator(".modal-head [data-close-calendar-dialog]").click()
        expect(self.chip(item, "2026-10-22")).to_be_visible()
        self.chip(item, "2026-10-22").click()
        expect(self.page.locator(".event-list")).to_contain_text(item["title"])

    def test_range_drag_from_middle_keeps_duration_and_crosses_month(self):
        item = self.create_event(start_date="2026-10-19", end_date="2026-10-21", category="연차")
        self.open_calendar()
        self.move(item, "2026-10-20", "2026-10-22")
        expect(self.page.locator("[data-calendar-drag-feedback]")).to_contain_text("이동했습니다")
        saved = self.saved(item)
        self.assertEqual((saved["start_date"], saved["end_date"]), ("2026-10-21", "2026-10-23"))
        self.move(item, "2026-10-21", "2026-11-01")
        expect(self.page.locator(".calendar-title span")).to_have_text("2026-11")
        expect(self.page.locator("[data-calendar-drag-feedback]")).to_contain_text("2026-11-01 ~ 2026-11-03")
        saved = self.saved(item)
        self.assertEqual((saved["start_date"], saved["end_date"]), ("2026-11-01", "2026-11-03"))
        expect(self.chip(item, "2026-11-03")).to_be_visible()
        self.assertEqual(saved["category"], "연차")

    def test_same_day_and_external_drop_do_not_save_and_failure_keeps_original(self):
        origin, target = "2026-10-26", "2026-10-29"
        item = self.create_event(start_date=origin, end_date=origin)
        self.open_calendar()
        writes = []
        self.page.on("request", lambda request: writes.append(request) if request.method == "PATCH" else None)
        self.move(item, origin, origin)
        self.page.locator(f'.day[data-date="{target}"]').evaluate("""day => {
          const data = new DataTransfer(); data.setData('text/plain', 'external text');
          day.dispatchEvent(new DragEvent('drop', {dataTransfer: data, bubbles: true, cancelable: true}));
        }""")
        self.assertEqual(writes, [])
        self.page.route(f'**/api/calendar/events/{item["id"]}', lambda route: route.fulfill(status=503, content_type="application/json", body='{"detail":"test save failure"}'), times=1)
        self.move(item, origin, target)
        expect(self.page.locator("[data-calendar-drag-feedback]")).to_contain_text("기존 날짜를 유지합니다")
        expect(self.chip(item, origin)).to_be_visible()
        expect(self.chip(item, target)).to_have_count(0)
        self.assertEqual(self.saved(item)["start_date"], origin)
        self.move(item, origin, target)
        expect(self.chip(item, target)).to_be_visible()

    def test_failed_refresh_reports_that_the_date_was_saved(self):
        item = self.create_event(start_date="2026-10-12", end_date="2026-10-12")
        self.open_calendar()
        self.page.route("**/api/calendar?**", lambda route: route.fulfill(status=503, content_type="application/json", body='{"detail":"test refresh failure"}'), times=1)
        self.move(item, "2026-10-12", "2026-10-15")
        expect(self.page.locator("[data-calendar-drag-feedback]")).to_contain_text("일정 날짜는 저장했지만")
        self.assertEqual(self.saved(item)["start_date"], "2026-10-15")
        self.page.reload()
        self.page.locator(".modal-head [data-close-calendar-dialog]").click()
        expect(self.chip(item, "2026-10-15")).to_be_visible()

    def test_refresh_arriving_after_navigation_does_not_replace_the_new_page(self):
        item = self.create_event(start_date="2026-10-05", end_date="2026-10-05")
        self.open_calendar()
        requests = []
        self.page.route("**/api/calendar?**", lambda route: requests.append(route))
        self.move(item, "2026-10-05", "2026-10-08")
        expect(self.page.locator(".calendar-panel")).to_have_attribute("aria-busy", "true")
        self.assertEqual(self.saved(item)["start_date"], "2026-10-08")
        self.assertEqual(len(requests), 1)
        self.page.locator('[data-route="projects"]').click()
        with self.page.expect_response(lambda response: "/api/calendar?" in response.url):
            requests[0].fulfill(response=requests[0].fetch())
        expect(self.page.locator("#page-title")).to_have_text("프로젝트")
        expect(self.page.locator(".calendar-panel")).to_have_count(0)

    def test_pending_save_blocks_duplicate_moves_and_does_not_reopen_after_navigation(self):
        item = self.create_event()
        self.open_calendar()
        requests = []
        self.page.route(f'**/api/calendar/events/{item["id"]}', lambda route: requests.append(route))
        self.move(item, "2026-10-19", "2026-10-22")
        expect(self.page.locator("[data-calendar-drag-feedback]")).to_contain_text("이동하는 중")
        expect(self.page.locator('.day[data-date="2026-10-19"]')).to_be_disabled()
        self.assertEqual(len(requests), 1)
        self.page.locator('[data-route="projects"]').click()
        requests[0].fulfill(response=requests[0].fetch())
        expect(self.page.locator("#page-title")).to_have_text("프로젝트")
        expect(self.page.locator(".calendar-panel")).to_have_count(0)
        self.page.unroute(f'**/api/calendar/events/{item["id"]}')
        self.assertEqual(self.saved(item)["start_date"], "2026-10-22")
