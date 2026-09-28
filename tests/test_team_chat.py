from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import team_chat
from app.team_chat import ChatStore
from app import auth
from app.auth_store import AuthStore


class TeamChatTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.store = ChatStore(self.root / "Chat")
        self.store.ensure()
        self.stack.enter_context(patch.object(team_chat, "store", self.store))
        self.auth_store = AuthStore(self.root / "Auth")
        self.stack.enter_context(patch.object(auth, "store", self.auth_store))
        app = FastAPI()
        app.add_middleware(auth.AuthenticationMiddleware)
        app.include_router(team_chat.router)
        self.client = TestClient(app)
        self.stack.callback(self.client.close)
        self.alice = self.account("가이", "대리")
        self.bob = self.account("동료", "팀장")

    def account(self, name, job_title="대리"):
        user = self.auth_store.create_user(uuid4().hex, "test-password", name, job_title)
        session = {"token": self.auth_store.create_session(user["id"]), "user_id": user["id"]}
        response = self.client.get("/api/team-chat/session", headers=self.headers(session))
        self.assertEqual(response.status_code, 200)
        return {**session, **response.json()}

    @staticmethod
    def headers(session):
        return {"Cookie": f"{auth.COOKIE_NAME}={session['token']}"}

    def send(self, session, text="안녕하세요", files=None, client_id=None):
        return self.client.post("/api/team-chat/messages", headers=self.headers(session), json={
            "text": text, "attachment_ids": files or [], "client_id": client_id or str(uuid4()),
        })

    def upload(self, session, content=b"shared contents", filename="공유 자료.txt", upload_id=None):
        return self.client.post("/api/team-chat/files", params={"filename": filename, "upload_id": upload_id or str(uuid4())},
                                headers=self.headers(session), content=content)

    def test_account_identity_automatically_joins_without_manual_name_routes(self):
        joined = self.account("같은 이름", "대리")
        self.assertEqual(joined["participant"]["name"], "같은 이름")
        self.assertEqual(joined["participant"]["job_title"], "대리")
        other = self.account("같은 이름", "팀장")
        self.assertNotEqual(joined["participant"]["id"], other["participant"]["id"])
        self.assertEqual(self.client.get("/api/team-chat/messages").status_code, 401)
        self.assertEqual(self.client.get("/api/team-chat/messages", headers={"Authorization": "Bearer invalid"}).status_code, 401)
        self.assertEqual(self.client.post("/api/team-chat/join", headers=self.headers(joined), json={"name": "사칭"}).status_code, 404)
        self.assertEqual(self.client.patch("/api/team-chat/session", headers=self.headers(joined), json={"name": "사칭"}).status_code, 405)

    def test_message_idempotency_and_sender_snapshot(self):
        client_id = str(uuid4())
        first = self.send(self.alice, "첫 메시지", client_id=client_id)
        again = self.send(self.alice, "첫 메시지", client_id=client_id)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json()["id"], again.json()["id"])
        with self.auth_store.connect() as db:
            db.execute("UPDATE users SET name = ?, job_title = ? WHERE id = ?", ("새 이름", "과장", self.alice["user_id"]))
        second = self.send(self.alice, "다음 메시지").json()
        self.assertEqual(first.json()["sender_name"], "가이")
        self.assertEqual(first.json()["sender_job_title"], "대리")
        self.assertEqual(second["sender_name"], "새 이름")
        self.assertEqual(second["sender_job_title"], "과장")
        listed = self.store.messages(after=None, before=None, limit=60)["items"]
        self.assertEqual([item["sender_job_title"] for item in listed], ["대리", "과장"])
        self.assertEqual(self.send(self.bob, "별도 세션", client_id=client_id).status_code, 201)

    def test_empty_message_and_length_limits(self):
        self.assertEqual(self.send(self.alice, " \n ").status_code, 422)
        self.assertEqual(self.send(self.alice, "가" * 4001).status_code, 422)
        self.assertEqual(self.send(self.alice, "가" * 4000).status_code, 201)
        self.assertEqual(self.send(self.alice, "파일", files=["a" * 32] * 6).status_code, 422)
        self.assertEqual(self.send(self.alice, "파일", files=["../../README.md"]).status_code, 422)

    def test_shared_file_round_trip_and_private_staging(self):
        content = b"<script>alert('download only')</script>"
        upload = self.upload(self.alice, content, "../../공유 자료.html")
        self.assertEqual(upload.status_code, 201)
        file = upload.json()
        self.assertEqual(file["filename"], "공유 자료.html")
        path = f"/api/team-chat/files/{file['id']}/download"
        self.assertEqual(self.client.get(path, headers=self.headers(self.bob)).status_code, 404)
        self.assertEqual(self.send(self.bob, "", [file["id"]]).status_code, 422)
        message = self.send(self.alice, "", [file["id"]])
        self.assertEqual(message.status_code, 201)
        self.assertEqual(message.json()["attachments"][0]["id"], file["id"])
        result = self.client.get(path, headers=self.headers(self.bob))
        self.assertEqual(result.content, content)
        self.assertTrue(result.headers["content-disposition"].startswith("attachment;"))
        self.assertEqual(result.headers["content-type"], "application/octet-stream")
        self.assertEqual(result.headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.send(self.alice, "다시 첨부", [file["id"]]).status_code, 422)
        self.assertEqual(self.client.delete(f"/api/team-chat/files/{file['id']}", headers=self.headers(self.alice)).status_code, 404)
        files = self.client.get("/api/team-chat/files", headers=self.headers(self.bob)).json()["items"]
        self.assertEqual(files[0]["sender_name"], "가이")
        self.assertEqual(files[0]["sender_job_title"], "대리")

    def test_upload_retries_and_discard_are_owned(self):
        upload_id = str(uuid4())
        first = self.upload(self.alice, upload_id=upload_id).json()
        repeat = self.upload(self.alice, upload_id=upload_id).json()
        self.assertEqual(first["id"], repeat["id"])
        url = f"/api/team-chat/files/{first['id']}"
        self.assertEqual(self.client.delete(url, headers=self.headers(self.bob)).status_code, 404)
        self.assertEqual(self.client.delete(url, headers=self.headers(self.alice)).status_code, 200)
        self.assertFalse((self.store.uploads / first["id"]).exists())

    def test_upload_size_checks_header_and_stream_and_cleans_partials(self):
        with patch.object(team_chat, "MAX_FILE_BYTES", 4):
            self.assertEqual(self.upload(self.alice, b"12345").status_code, 413)
            self.assertEqual(self.upload(self.alice, iter([b"123", b"45"])).status_code, 413)
        self.assertEqual(list(self.store.uploads.iterdir()), [])
        self.assertEqual(self.upload(self.alice, b"", "empty.txt").status_code, 201)

    def test_cursor_pagination_has_no_gaps(self):
        ids = [self.send(self.alice, str(index)).json()["id"] for index in range(5)]
        latest = self.client.get("/api/team-chat/messages?limit=2", headers=self.headers(self.bob)).json()
        self.assertEqual([item["id"] for item in latest["items"]], ids[-2:])
        self.assertTrue(latest["has_more"])
        older = self.client.get(f"/api/team-chat/messages?before={ids[-2]}&limit=2", headers=self.headers(self.bob)).json()
        self.assertEqual([item["id"] for item in older["items"]], ids[1:3])
        after = self.client.get(f"/api/team-chat/messages?after={ids[1]}&limit=2", headers=self.headers(self.bob)).json()
        self.assertEqual([item["id"] for item in after["items"]], ids[2:4])
        self.assertTrue(after["has_more"])

    def test_restart_retains_messages_sessions_and_attachments(self):
        file = self.upload(self.alice).json()
        original = self.send(self.alice, "서버 재시작 후에도 유지", [file["id"]]).json()
        reopened = ChatStore(self.store.root)
        reopened.ensure()
        self.assertEqual(reopened.account_participant(self.alice["user_id"], "가이", "대리"), self.alice["participant"])
        result = reopened.messages(after=None, before=None, limit=60)
        self.assertEqual(result["items"][0], original)
        self.assertEqual(reopened.download(file["id"])[0].read_bytes(), b"shared contents")

    def test_concurrent_messages_are_unique_and_retry_safe(self):
        participant = self.alice["participant"]
        with ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(lambda index: self.store.send(participant, str(index), [], str(uuid4())), range(20)))
        self.assertEqual(len({item["id"] for item in results}), 20)
        client_id = str(uuid4())
        with ThreadPoolExecutor(max_workers=6) as executor:
            retries = list(executor.map(lambda _: self.store.send(participant, "한 번만 저장", [], client_id), range(6)))
        self.assertEqual(len({item["id"] for item in retries}), 1)

    def test_inactive_participants_and_expired_sessions(self):
        with self.store.connect() as db:
            db.execute("UPDATE participants SET last_seen='2000-01-01T00:00:00.000+00:00' WHERE id=?", (self.alice["participant"]["id"],))
        with self.auth_store.connect() as db:
            db.execute("UPDATE sessions SET expires_at = 0 WHERE user_id = ?", (self.alice["user_id"],))
        self.assertEqual(self.client.get("/api/team-chat/session", headers=self.headers(self.alice)).status_code, 401)
        response = self.client.get("/api/team-chat/messages", headers=self.headers(self.bob)).json()
        self.assertEqual([item["id"] for item in response["participants"]], [self.bob["participant"]["id"]])

    def test_edit_requires_author_and_original_two_minute_window(self):
        started = datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc)
        with patch("app.team_chat.timestamp", return_value=started.isoformat()):
            original = self.send(self.alice, "원문").json()
        url = f"/api/team-chat/messages/{original['id']}"
        with patch("app.team_chat.timestamp", return_value=(started + timedelta(seconds=119)).isoformat()):
            self.assertEqual(self.client.patch(url, headers=self.headers(self.bob), json={"text": "사칭"}).status_code, 403)
            changed = self.client.patch(url, headers=self.headers(self.alice), json={"text": "수정한 글"})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(changed.json()["created_at"], original["created_at"])
            self.assertEqual(changed.json()["sender_name"], original["sender_name"])
            self.assertTrue(changed.json()["edited_at"])
            self.assertGreater(changed.json()["revision"], original["revision"])
        with patch("app.team_chat.timestamp", return_value=(started + timedelta(seconds=120)).isoformat()):
            self.assertEqual(self.client.patch(url, headers=self.headers(self.alice), json={"text": "시간 초과"}).status_code, 403)
            self.assertEqual(self.client.delete(url, headers=self.headers(self.alice)).status_code, 403)
        saved = self.store.messages(after=None, before=None, limit=60)["items"][0]
        self.assertEqual(saved["text"], "수정한 글")

    def test_edit_validation_and_attachments_are_preserved(self):
        message = self.send(self.alice).json()
        url = f"/api/team-chat/messages/{message['id']}"
        for payload in [{"text": "   "}, {"text": "a" * 4001}, {"text": "spoof", "participant_id": self.bob["participant"]["id"]}]:
            self.assertEqual(self.client.patch(url, headers=self.headers(self.alice), json=payload).status_code, 422)
        self.assertEqual(self.client.patch(url, json={"text": "수정"}).status_code, 401)
        file = self.upload(self.alice).json()
        attached = self.send(self.alice, "파일 설명", [file["id"]]).json()
        changed = self.client.patch(f"/api/team-chat/messages/{attached['id']}", headers=self.headers(self.alice), json={"text": ""}).json()
        self.assertEqual(changed["attachments"], attached["attachments"])
        self.assertEqual(changed["text"], "")
        self.assertEqual(self.client.patch("/api/team-chat/messages/99999", headers=self.headers(self.alice), json={"text": "없는 글"}).status_code, 404)

    def test_delete_hides_content_shared_files_and_downloads_without_resurrection(self):
        file = self.upload(self.alice).json()
        client_id = str(uuid4())
        message = self.send(self.alice, "삭제할 내용", [file["id"]], client_id).json()
        url = f"/api/team-chat/messages/{message['id']}"
        self.assertEqual(self.client.delete(url, headers=self.headers(self.bob)).status_code, 403)
        deleted = self.client.delete(url, headers=self.headers(self.alice))
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()["deleted_at"])
        self.assertEqual(deleted.json()["text"], "")
        self.assertEqual(deleted.json()["attachments"], [])
        self.assertEqual(self.client.get("/api/team-chat/files", headers=self.headers(self.bob)).json()["items"], [])
        self.assertEqual(self.client.get(f"/api/team-chat/files/{file['id']}/download", headers=self.headers(self.bob)).status_code, 404)
        retry = self.send(self.alice, "삭제할 내용", [file["id"]], client_id).json()
        self.assertEqual(retry, deleted.json())
        self.assertEqual(self.client.patch(url, headers=self.headers(self.alice), json={"text": "되살리기"}).status_code, 404)

    def test_changes_reach_other_clients_even_for_messages_before_their_cursor(self):
        original = self.send(self.alice, "원문").json()
        last = self.send(self.bob, "나중 글").json()
        previous = self.client.get("/api/team-chat/messages", headers=self.headers(self.bob)).json()
        self.client.patch(f"/api/team-chat/messages/{original['id']}", headers=self.headers(self.alice), json={"text": "수정"})
        polled = self.client.get("/api/team-chat/messages", params={"after": last["id"], "since_change": previous["change_cursor"]}, headers=self.headers(self.bob)).json()
        self.assertEqual(polled["items"], [])
        self.assertEqual([(item["id"], item["text"]) for item in polled["changes"]], [(original["id"], "수정")])
        self.client.delete(f"/api/team-chat/messages/{original['id']}", headers=self.headers(self.alice))
        again = self.client.get("/api/team-chat/messages", params={"after": last["id"], "since_change": polled["change_cursor"]}, headers=self.headers(self.bob)).json()
        self.assertTrue(again["changes"][0]["deleted_at"])
        self.assertGreater(again["change_cursor"], polled["change_cursor"])

    def test_change_feed_pagination_has_no_gaps(self):
        messages = [self.send(self.alice, str(index)).json() for index in range(5)]
        cursor = self.store.messages(after=None, before=None, limit=60)["change_cursor"]
        for item in messages:
            self.store.change_message(self.alice["participant"]["id"], item["id"], text="수정")
        seen = []
        for _ in range(3):
            page = self.store.messages(after=messages[-1]["id"], before=None, limit=2, since_change=cursor)
            cursor = page["change_cursor"]
            seen.extend(item["id"] for item in page["changes"])
        self.assertEqual(seen, [item["id"] for item in messages])
        self.assertFalse(page["has_more_changes"])

    def test_old_database_migrates_without_changing_existing_messages(self):
        old = ChatStore(self.store.root / "Legacy")
        old.root.mkdir()
        with old.connect() as db:
            db.executescript("""
                CREATE TABLE participants (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL);
                CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, participant_id TEXT NOT NULL REFERENCES participants(id), sender_name TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(participant_id, client_id));
                INSERT INTO participants VALUES ('legacy', 'hash', 'old name', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
                INSERT INTO messages (participant_id, sender_name, text, client_id, created_at) VALUES ('legacy', 'old name', 'original message', 'client', '2026-01-01T00:00:00+00:00');
            """)
        old.ensure()
        old.ensure()
        row = old.messages(after=None, before=None, limit=60)["items"][0]
        self.assertEqual(row["text"], "original message")
        self.assertEqual(row["revision"], 0)
        self.assertIsNone(row["deleted_at"])
        self.assertEqual(row["sender_job_title"], "")

    def test_previous_account_messages_resolve_titles_without_rewriting_content(self):
        file = self.upload(self.alice).json()
        original = self.send(self.alice, "이전 대화", [file["id"]]).json()
        with self.store.connect() as db:
            db.execute("UPDATE messages SET sender_job_title = NULL WHERE id = ?", (original["id"],))
            db.execute("UPDATE participants SET job_title = '' WHERE id = ?", (self.alice["participant"]["id"],))
        self.store.sync_account_profiles(self.auth_store.list_users())
        result = self.store.messages(after=None, before=None, limit=60)["items"][0]
        self.assertEqual(result, original)
        self.assertEqual(self.store.shared_files()[0]["sender_job_title"], "대리")
        with self.store.connect() as db:
            self.assertIsNone(db.execute("SELECT sender_job_title FROM messages WHERE id = ?", (original["id"],)).fetchone()[0])

    def test_sender_name_and_title_cannot_be_supplied_by_message_payload(self):
        response = self.client.post("/api/team-chat/messages", headers=self.headers(self.alice), json={
            "text": "사칭 요청", "client_id": str(uuid4()), "sender_name": "다른 사람", "sender_job_title": "대표",
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.store.messages(after=None, before=None, limit=60)["items"], [])


if __name__ == "__main__":
    unittest.main()
