// One request publishes all photos as one receipt. Freeze the request across
// retries so a lost response cannot create a second receipt or change its data.
export async function submitReceiptBatch(entries, details, submission, upload) {
  if (submission.result) return submission.result;
  if (!entries.length) throw new Error("사진을 선택해 주세요.");
  submission.details ||= { registrant: details.registrant, content: details.content };
  submission.files ||= entries.map((entry) => entry.file);
  const body = new FormData();
  body.append("metadata", JSON.stringify({ submission_id: submission.id, ...submission.details }));
  for (const file of submission.files) body.append("images", file, file.name);
  submission.result = await upload(body);
  return submission.result;
}
