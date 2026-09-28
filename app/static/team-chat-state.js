export const EDIT_WINDOW_MS = 120000;

export function formatChatName(name, jobTitle) {
  return [String(name ?? "").trim(), String(jobTitle ?? "").trim()].filter(Boolean).join("_");
}

export function canChangeMessage(message, participantId, now = Date.now()) {
  return Boolean(message && !message.deleted_at && message.participant_id === participantId
    && Number.isFinite(Date.parse(message.created_at)) && now < Date.parse(message.created_at) + EDIT_WINDOW_MS);
}

export function mergeChatMessages(existing, incoming) {
  const entries = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = entries.get(message.id);
    if (!previous || (message.revision || 0) >= (previous.revision || 0)) entries.set(message.id, message);
  }
  return [...entries.values()].sort((a, b) => a.id - b.id);
}
