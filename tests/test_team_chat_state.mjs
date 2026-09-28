import test from "node:test";
import assert from "node:assert/strict";
import { canChangeMessage, mergeChatMessages, formatChatName } from "../app/static/team-chat-state.js";

const NOW = Date.parse("2026-09-28T00:00:00Z");
const message = { id: 1, participant_id: "alice", sender_name: "동명이인", created_at: new Date(NOW).toISOString(), text: "original", revision: 1 };

test("chat identities use name_title and preserve older names without an unknown title", () => {
  assert.equal(formatChatName("김민수", "대리"), "김민수_대리");
  assert.equal(formatChatName(" 김민수 ", " 팀장 "), "김민수_팀장");
  assert.equal(formatChatName("이전 작성자", null), "이전 작성자");
  assert.equal(formatChatName("이전 작성자", ""), "이전 작성자");
});

test("message menu uses account identity and the original two-minute deadline", () => {
  assert.equal(canChangeMessage(message, "alice", NOW + 119999), true);
  assert.equal(canChangeMessage(message, "alice", NOW + 120000), false);
  assert.equal(canChangeMessage(message, "bob", NOW + 1), false);
  assert.equal(canChangeMessage({ ...message, deleted_at: "now" }, "alice", NOW + 1), false);
  assert.equal(canChangeMessage({ ...message, edited_at: new Date(NOW + 119000).toISOString() }, "alice", NOW + 121000), false);
  assert.equal(canChangeMessage({ ...message, created_at: "invalid" }, "alice", NOW), false);
});

test("edits and deletions replace loaded messages and stale polls cannot undo them", () => {
  const edited = { ...message, text: "edited", revision: 2 };
  const deleted = { ...edited, text: "", deleted_at: "now", revision: 3 };
  assert.deepEqual(mergeChatMessages([message], [edited, message]), [edited]);
  assert.deepEqual(mergeChatMessages([deleted], [edited, message]), [deleted]);
  assert.deepEqual(mergeChatMessages([message], [edited, deleted]), [deleted]);
});

test("overlapping history and change-feed pages merge once in chronological order", () => {
  const next = { ...message, id: 2, revision: 4 };
  const old = { ...message, id: 0, revision: 0 };
  assert.deepEqual(mergeChatMessages([next], [message, old, message, next]), [old, message, next]);
});
