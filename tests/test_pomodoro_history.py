from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.pomodoro import PomodoroStore
from app.routers import pomodoro
from auth_support import authorize


NOW = 1800000000000


class PomodoroHistoryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory())) / "Pomodoro"
        self.store = PomodoroStore(self.root)
        self.stack.enter_context(patch.object(pomodoro, "store", self.store))
        self.clock = self.stack.enter_context(patch("app.pomodoro.now_ms", return_value=NOW))
        app = FastAPI()
        app.include_router(pomodoro.router)
        self.client = self.stack.enter_context(TestClient(app))
        self.session_id = str(uuid4())
        self.path = f"/api/pomodoro/history/{self.session_id}"

    def payload(self, **changes):
        return {"person": "김민수", "duration_ms": 1500000, "remaining_ms": 1500000, "status": "running", "started_at": NOW, "ends_at": NOW + 1500000, "revision": NOW, **changes}

    def save(self, **changes):
        response = self.client.put(self.path, json=self.payload(**changes))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_running_record_survives_restart_and_finishes_without_a_browser_callback(self):
        saved = self.save()
        self.assertEqual(saved["id"], self.session_id)
        self.assertEqual(saved["focused_ms"], 0)
        self.clock.return_value = NOW + 300000
        with patch.object(pomodoro, "store", PomodoroStore(self.root)):
            response = self.client.get("/api/pomodoro/history")
        self.assertEqual(response.headers["cache-control"], "no-store")
        item = response.json()["items"][0]
        self.assertEqual(item["focused_ms"], 300000)
        self.assertEqual(item["status"], "running")
        self.clock.return_value = NOW + 9000000
        item = self.store.list()["items"][0]
        self.assertEqual(item["focused_ms"], 1500000)
        self.assertEqual(item["remaining_ms"], 0)
        self.assertEqual(item["status"], "completed")

    def test_pause_and_resume_keep_one_record_and_exclude_paused_time(self):
        self.save()
        self.clock.return_value = NOW + 60000
        paused = self.save(status="paused", remaining_ms=1440000, ends_at=None, revision=NOW + 60000)
        self.assertEqual(paused["focused_ms"], 60000)
        self.clock.return_value = NOW + 3600000
        self.assertEqual(self.store.list()["items"][0]["focused_ms"], 60000)
        self.save(remaining_ms=1440000, ends_at=NOW + 3600000 + 1440000, revision=NOW + 3600000)
        self.clock.return_value += 120000
        result = self.store.list()
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["focused_ms"], 180000)
        self.assertEqual(result["items"][0]["started_at"], NOW)

    def test_stopped_session_keeps_the_actual_partial_duration(self):
        self.save()
        self.save(status="stopped", remaining_ms=1469500, ends_at=None, revision=NOW + 30500)
        self.clock.return_value = NOW + 99999999
        item = self.store.list()["items"][0]
        self.assertEqual(item["focused_ms"], 30500)
        self.assertEqual(item["status"], "stopped")

    def test_retries_and_delayed_snapshots_do_not_duplicate_or_rewind_history(self):
        initial = self.save()
        self.assertEqual(self.save(), initial)
        stopped = self.save(status="stopped", remaining_ms=1200000, ends_at=None, revision=NOW + 300000)
        self.assertEqual(self.save(), stopped)
        self.assertEqual(self.store.list()["total"], 1)
        self.assertEqual(self.client.put(self.path, json=self.payload(person="다른 이름")).status_code, 409)
        self.assertEqual(self.client.put(self.path, json=self.payload(duration_ms=60000, remaining_ms=60000)).status_code, 409)
        self.assertEqual(self.store.list()["items"], [stopped])

    def test_validation_rejects_inconsistent_or_unbounded_snapshots(self):
        for changes in [
            {"person": "  "}, {"person": "가" * 81}, {"duration_ms": 1}, {"duration_ms": 10860000},
            {"duration_ms": "1500000"}, {"remaining_ms": 1500001}, {"remaining_ms": -1},
            {"status": "idle"}, {"status": "completed"}, {"status": "paused", "ends_at": None, "remaining_ms": 0},
            {"status": "stopped"}, {"ends_at": None}, {"ends_at": NOW - 1},
            {"started_at": 0}, {"revision": -1}, {"extra": "field"},
        ]:
            with self.subTest(changes=changes):
                self.assertEqual(self.client.put(self.path, json=self.payload(**changes)).status_code, 422)
        self.assertEqual(self.client.put("/api/pomodoro/history/not-a-uuid", json=self.payload()).status_code, 422)
        self.assertEqual(self.store.list()["total"], 0)

    def test_concurrent_retries_keep_the_newest_revision(self):
        def save(index):
            values = self.payload(status="paused", ends_at=None, remaining_ms=1500000 - index * 1000, revision=NOW + index)
            return PomodoroStore(self.root).save(self.session_id, values)
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(save, [8, 2, 6, 1, 10, 3, 9, 5, 4, 7, 10]))
        records = self.store.list()
        self.assertEqual(records["total"], 1)
        self.assertEqual(records["items"][0]["revision"], NOW + 10)
        self.assertEqual(records["items"][0]["focused_ms"], 10000)

    def test_multiple_people_and_sessions_are_paginated_newest_first(self):
        first = self.save()
        second_id = str(uuid4())
        self.store.save(second_id, self.payload(person="이서연", started_at=NOW + 1, revision=NOW + 1))
        third_id = str(uuid4())
        self.store.save(third_id, self.payload(started_at=NOW + 2, revision=NOW + 2))
        result = self.client.get("/api/pomodoro/history?limit=2").json()
        self.assertEqual(result["total"], 3)
        self.assertEqual([item["id"] for item in result["items"]], [third_id, second_id])
        self.assertEqual(self.client.get("/api/pomodoro/history?limit=2&offset=2").json()["items"], [first])
        for query in ["limit=0", "limit=101", "offset=-1"]:
            self.assertEqual(self.client.get(f"/api/pomodoro/history?{query}").status_code, 422)

    def test_main_app_exposes_history_api_and_assets(self):
        from app.main import app
        client = TestClient(app)
        self.addCleanup(client.close)
        authorize(client, self.stack, self.root.parent)
        self.save()
        self.assertEqual(client.get("/api/pomodoro/history").json()["total"], 1)
        self.assertEqual(client.get("/static/pomodoro-history.js").status_code, 200)


if __name__ == "__main__":
    unittest.main()
