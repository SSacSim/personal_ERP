from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import storage
from app.main import app
from app.routers import attendance, calendar, dashboard
from auth_support import authorize


class AttendanceTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.notes = self.root / "Notes"
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", self.notes))
        self.vault = storage.ObsidianVault(self.notes)
        for module in (attendance, calendar, dashboard):
            self.stack.enter_context(patch.object(module, "vault", self.vault))
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        authorize(self.client, self.stack, self.root, "김민수")

    def create(self, **changes):
        response = self.client.post("/api/attendance", json={"kind": "annual_leave", "start_date": "2026-09-28", **changes})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_each_kind_creates_one_calendar_note_with_logged_in_name(self):
        for kind, period, category in [("annual_leave", None, "연차"), ("half_day", "am", "오전 반차"),
                                       ("half_day", "pm", "오후 반차"), ("remote_work", None, "재택")]:
            with self.subTest(kind=kind, period=period):
                item = self.create(kind=kind, period=period, notes="일정 공유\n인수인계 완료")
                self.assertEqual(item["attendees"], ["김민수"])
                self.assertEqual(item["title"], f"김민수 · {category}")
                self.assertEqual(item["category"], category)
                self.assertEqual(item["end_date"], item["start_date"])
                self.assertEqual(item["notes"], "일정 공유\n인수인계 완료")
                calendar_items = self.client.get("/api/calendar?date=2026-09-28").json()["items"]
                self.assertEqual(sum(entry["id"] == item["id"] for entry in calendar_items), 1)
                persisted = (self.notes / item["path"]).read_text(encoding="utf-8")
                self.assertIn('attendees: ["김민수"]', persisted)
                self.assertIn("일정 공유\n인수인계 완료", persisted)
        self.assertEqual(len(list((self.notes / "Calendar").glob("*.md"))), 4)

    def test_ranges_span_months_and_years_and_filter_by_kind(self):
        annual = self.create(start_date="2026-12-30", end_date="2027-01-04")
        remote = self.create(kind="remote_work", start_date="2027-01-10", end_date="2027-01-12")
        self.assertEqual(self.client.get("/api/attendance?month=2026-12").json()["items"][0]["id"], annual["id"])
        january = self.client.get("/api/attendance?month=2027-01").json()
        self.assertEqual(january["total"], 2)
        self.assertEqual([item["id"] for item in january["items"]], [remote["id"], annual["id"]])
        filtered = self.client.get("/api/attendance?month=2027-01&kind=annual_leave").json()
        self.assertEqual([item["id"] for item in filtered["items"]], [annual["id"]])
        self.assertEqual(self.client.get("/api/attendance?month=2026-11").json()["total"], 0)
        self.assertEqual(self.client.get("/api/calendar?date=2027-01-04").json()["items"][0]["id"], annual["id"])
        self.assertEqual(self.client.get("/api/calendar?date=2027-01-05").json()["items"], [])

    def test_invalid_dates_half_day_ranges_and_spoofed_names_are_rejected(self):
        invalid = [{"start_date": "2026-02-30"}, {"start_date": "2026-9-28"}, {"start_date": 1800000000},
                   {"end_date": "2026-09-27"}, {"kind": "unknown"}, {"kind": "half_day"},
                   {"kind": "half_day", "period": "am", "end_date": "2026-09-29"},
                   {"period": "pm"}, {"notes": "a" * 4001}, {"name": "사칭"}, {"attendees": ["사칭"]}]
        for values in invalid:
            with self.subTest(values=list(values)):
                response = self.client.post("/api/attendance", json={"kind": "annual_leave", "start_date": "2026-09-28", **values})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.get("/api/attendance").json()["total"], 0)
        self.assertEqual(list((self.notes / "Calendar").glob("*.md")), [])
        for query in ["month=0000-01", "month=2026-13", "kind=meeting", "limit=0", "offset=-1"]:
            self.assertEqual(self.client.get(f"/api/attendance?{query}").status_code, 422)

    def test_calendar_edit_and_delete_are_reflected_without_duplicate_records(self):
        item = self.create(notes="원래 메모")
        path = f"/api/calendar/events/{item['id']}"
        edited = self.client.patch(path, json={"start_date": "2026-10-02", "end_date": "2026-10-03", "category": "재택", "notes": "변경한 메모"})
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(self.client.get("/api/attendance?month=2026-09").json()["total"], 0)
        listed = self.client.get("/api/attendance?month=2026-10&kind=remote_work").json()["items"]
        self.assertEqual(len(listed), 1)
        self.assertEqual((listed[0]["id"], listed[0]["notes"]), (item["id"], "변경한 메모"))
        self.assertEqual(self.client.delete(path).status_code, 200)
        self.assertEqual(self.client.get("/api/attendance").json()["total"], 0)
        self.assertEqual(self.client.get("/api/calendar?month=2026-10").json()["items"], [])
        self.assertEqual(len(list((self.notes / "Calendar").glob("*.md"))), 1)

    def test_existing_calendar_leave_and_remote_categories_are_included(self):
        for category in ["annual_leave", "half_day", "재택근무", "remote_work", "미팅"]:
            self.vault.create_calendar_event({"title": "기존 일정", "date": "2026-09-01", "category": category, "attendees": ["동료"]})
        result = self.client.get("/api/attendance?month=2026-09").json()
        self.assertEqual(result["total"], 4)
        self.assertTrue(all(item["notes"] == "" for item in result["items"]))
        self.assertEqual({item["kind"] for item in result["items"]}, {"annual_leave", "half_day", "remote_work"})

    def test_remote_work_is_in_team_absences_instead_of_today_or_tomorrow_schedule(self):
        remote = self.create(kind="remote_work", start_date="2026-10-02")
        regular = self.vault.create_calendar_event({
            "title": "팀 행사", "category": "회사 일정", "start_date": "2026-10-01", "end_date": "2026-10-02",
        })
        for target_date, day_key, event_key, absence_key, suffix in [
            ("2026-10-01", "tomorrow_day", "tomorrow_events", "tomorrow_absences", "_tomorrow"),
            ("2026-10-02", "today", "events", "absences", ""),
        ]:
            with self.subTest(date=target_date):
                response = self.client.get(f"/api/dashboard?date={target_date}")
                self.assertEqual(response.status_code, 200, response.text)
                data = response.json()
                self.assertEqual([item["id"] for item in data[day_key]["events"]], [regular["id"]])
                self.assertEqual(data[event_key], data[day_key]["events"])
                self.assertEqual([item["event_id"] for item in data[day_key]["absences"]], [remote["id"]])
                self.assertEqual(data[day_key]["absences"][0]["person"], "김민수")
                self.assertEqual(data[day_key]["absences"][0]["category"], "재택")
                self.assertEqual(data[absence_key], data[day_key]["absences"])
                self.assertEqual(data["counts"]["absence_people" + suffix], 1)
                self.assertEqual(data["counts"]["absence_events" + suffix], 1)
                self.assertEqual(data["counts"]["events_tomorrow" if suffix else "events_today"], 1)
        calendar_ids = [item["id"] for item in self.client.get("/api/calendar?date=2026-10-02").json()["items"]]
        self.assertCountEqual(calendar_ids, [remote["id"], regular["id"]])
        self.assertEqual(self.client.get("/api/attendance?kind=remote_work").json()["items"][0]["id"], remote["id"])

    def test_remote_categories_and_date_ranges_share_absence_counts(self):
        remote_ids = []
        for category in ["재택", "재택근무", "remote_work"]:
            item = self.vault.create_calendar_event({
                "title": "근무 일정", "category": category, "start_date": "2026-09-30", "end_date": "2026-10-02",
                "attendees": ["김민수", "동료"],
            })
            remote_ids.append(item["id"])
        self.create(kind="remote_work", start_date="2026-09-29")
        removed = self.create(kind="remote_work", start_date="2026-10-01")
        self.client.delete(f"/api/calendar/events/{removed['id']}")
        data = self.client.get("/api/dashboard?date=2026-09-30").json()
        for day, suffix in [(data["today"], ""), (data["tomorrow_day"], "_tomorrow")]:
            self.assertEqual(day["events"], [])
            self.assertEqual({item["event_id"] for item in day["absences"]}, set(remote_ids))
            self.assertEqual(len(day["absences"]), 6)
            self.assertEqual(data["counts"]["absence_people" + suffix], 2)
            self.assertEqual(data["counts"]["absence_events" + suffix], 3)
            self.assertEqual(data["counts"]["events_tomorrow" if suffix else "events_today"], 0)
        after = self.client.get("/api/dashboard?date=2026-10-03").json()
        self.assertEqual(after["today"]["absences"], [])

    def test_meeting_about_remote_work_remains_a_regular_schedule(self):
        meeting = self.vault.create_calendar_event({
            "title": "재택근무 운영 회의", "category": "미팅", "date": "2026-10-02", "notes": "remote_work 절차 검토",
        })
        remote = self.create(kind="remote_work", start_date="2026-10-02")
        self.client.patch(f"/api/calendar/events/{remote['id']}", json={"category": "회사 일정"})
        data = self.client.get("/api/dashboard?date=2026-10-01").json()
        self.assertCountEqual([item["id"] for item in data["tomorrow_day"]["events"]], [meeting["id"], remote["id"]])
        self.assertEqual(data["tomorrow_day"]["absences"], [])

    def test_pagination_and_reopening_vault_preserve_calendar_identity(self):
        entries = [self.create(start_date=f"2026-09-{day:02d}") for day in range(1, 28)]
        reopened = storage.ObsidianVault(self.notes)
        with patch.object(attendance, "vault", reopened), patch.object(calendar, "vault", reopened):
            first = self.client.get("/api/attendance?limit=25").json()
            rest = self.client.get("/api/attendance?limit=25&offset=25").json()
            self.assertEqual(first["total"], 27)
            self.assertEqual([item["id"] for item in first["items"] + rest["items"]], [item["id"] for item in reversed(entries)])
            self.assertEqual(len(self.client.get("/api/calendar?month=2026-09").json()["items"]), 27)

    def test_registration_page_and_apis_require_existing_login(self):
        self.assertEqual(self.client.get("/attendance").status_code, 200)
        for asset in ["attendance.js", "attendance.css"]:
            self.assertEqual(self.client.get(f"/static/{asset}").status_code, 200)
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/attendance", follow_redirects=False).status_code, 303)
        self.assertEqual(self.client.get("/api/attendance").status_code, 401)
        self.assertEqual(self.client.post("/api/attendance", json={}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
