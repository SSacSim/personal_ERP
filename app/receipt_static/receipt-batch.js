// Keep each receipt's request ID and details stable across partial failures.
export async function submitReceiptBatch(entries, details, upload, onChange = () => {}) {
  const pending = entries.filter((entry) => entry.status !== "saved");
  for (const [index, entry] of pending.entries()) {
    entry.details ||= { registrant: details.registrant, content: details.content };
    entry.status = "sending";
    entry.error = "";
    onChange({ current: index + 1, total: pending.length, processed: index });
    try {
      entry.result = await upload(entry);
      entry.status = "saved";
    } catch (error) {
      entry.status = "error";
      entry.error = error?.name === "AbortError"
        ? "응답이 지연되었습니다. 다시 등록하면 저장 여부를 확인합니다."
        : error?.message || "서버에 연결하지 못했습니다. 다시 시도해 주세요.";
    }
    onChange({ current: index + 1, total: pending.length, processed: index + 1 });
  }
  return {
    saved: entries.filter((entry) => entry.status === "saved").length,
    failed: entries.filter((entry) => entry.status === "error").length,
  };
}
