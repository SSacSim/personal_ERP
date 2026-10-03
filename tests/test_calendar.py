from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import storage
from app.routers import calendar


class CalendarRangeTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.stack.enter_context(patch.object(storage, "VAULT_DIR", root))
        self.vault = storage.ObsidianVault(root)
        self.stack.enter_context(patch.object(calendar, "vault", self.vault))
        app = FastAPI()
        app.include_router(calendar.router)
        self.client = self.stack.enter_context(TestClient(app))

    def create(self, start, end=None):
        result = self.client.post("/api/calendar/events", json={
            "title": f"일정 {start}", "start_date": start, "end_date": end or start,
        })
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()["id"]

    def ids(self, **params):
        response = self.client.get("/api/calendar", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return [item["id"] for item in response.json()["items"]]

    def test_visible_september_and_october_ranges_include_adjacent_month_days(self):
        august = self.create("2026-08-31")
        september = [self.create(f"2026-09-{day}") for day in (28, 29, 30)]
        october = [self.create(f"2026-10-{day:02}") for day in (1, 2, 3, 4)]
        later = self.create("2026-10-05")
        november = self.create("2026-11-01")
        self.assertEqual(self.ids(start_date="2026-08-31", end_date="2026-10-04"), [august, *september, *october])
        self.assertEqual(self.ids(start_date="2026-09-28", end_date="2026-11-01"), [*september, *october, later, november])
        # Monthly lists and the dashboard's exact-day query keep their existing scope.
        self.assertEqual(self.ids(month="2026-09"), september)
        self.assertEqual(self.ids(date="2026-10-01"), october[:1])

    def test_period_events_overlap_inclusively_and_deleted_events_stay_hidden(self):
        before = self.create("2026-08-01", "2026-08-30")
        touches_start = self.create("2026-08-20", "2026-08-31")
        spans_grid = self.create("2026-08-01", "2026-11-30")
        crosses_month = self.create("2026-09-29", "2026-10-03")
        touches_end = self.create("2026-10-04", "2026-10-10")
        after = self.create("2026-10-05", "2026-10-10")
        removed = self.create("2026-09-15")
        self.assertEqual(self.client.delete(f"/api/calendar/events/{removed}").status_code, 200)
        result = self.ids(start_date="2026-08-31", end_date="2026-10-04")
        self.assertCountEqual(result, [touches_start, spans_grid, crosses_month, touches_end])
        self.assertFalse({before, after, removed} & set(result))
        self.assertEqual(len(result), len(set(result)))

    def test_year_boundary_leap_day_and_single_day_ranges(self):
        december = self.create("2026-12-28", "2027-01-02")
        january = self.create("2027-01-03")
        self.assertEqual(self.ids(start_date="2026-12-28", end_date="2027-01-31"), [december, january])
        leap = self.create("2028-02-29")
        self.assertEqual(self.ids(start_date="2028-02-29", end_date="2028-02-29"), [leap])

    def test_legacy_date_only_events_are_included_in_visible_range(self):
        legacy = self.vault.write("calendar_event", "기존 일정", {"title": "기존 일정", "date": "2026-10-02"}, "# 기존 일정")
        self.assertEqual(self.ids(start_date="2026-08-31", end_date="2026-10-04"), [legacy.metadata["id"]])

    def test_visible_range_includes_holidays_without_adding_calendar_events(self):
        event = self.create("2026-10-05")
        response = self.client.get("/api/calendar", params={
            "start_date": "2026-09-21", "end_date": "2026-10-25",
        })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual([item["id"] for item in data["items"]], [event])
        self.assertEqual(set(data["holidays"]), {
            "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-03", "2026-10-05", "2026-10-09",
        })
        self.assertIn("추석", data["holidays"]["2026-09-25"])
        self.assertIn("대체", data["holidays"]["2026-10-05"])

    def test_lunar_new_year_and_substitute_holidays_change_with_year(self):
        for year, expected in [
            (2026, {"2026-02-16", "2026-02-17", "2026-02-18"}),
            (2027, {"2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09"}),
        ]:
            with self.subTest(year=year):
                response = self.client.get("/api/calendar", params={
                    "start_date": f"{year}-02-01", "end_date": f"{year}-02-28",
                })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(set(response.json()["holidays"]), expected)

    def test_holidays_include_both_years_and_exact_range_boundaries(self):
        response = self.client.get("/api/calendar", params={
            "start_date": "2026-12-25", "end_date": "2027-01-01",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()["holidays"]), {"2026-12-25", "2027-01-01"})
        response = self.client.get("/api/calendar", params={
            "start_date": "2026-12-26", "end_date": "2026-12-31",
        })
        self.assertEqual(response.json()["holidays"], {})

    def test_invalid_or_incomplete_ranges_are_rejected(self):
        for params in [
            {"start_date": "2026-09-28"}, {"end_date": "2026-10-04"},
            {"start_date": "2026-10-04", "end_date": "2026-09-28"},
            {"start_date": "2026-02-30", "end_date": "2026-10-04"},
        ]:
            with self.subTest(params=params):
                self.assertEqual(self.client.get("/api/calendar", params=params).status_code, 422)


if __name__ == "__main__":
    unittest.main()
