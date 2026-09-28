const imageExtensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
let imageNumber = 0;

export function clipboardImage(blob, type = blob.type) {
  const extension = imageExtensions[type];
  if (!extension) throw new Error("클립보드 이미지는 JPG, PNG, GIF, WEBP 형식을 지원합니다.");
  return new File([blob], `붙여넣은 이미지-${Date.now()}-${++imageNumber}.${extension}`, { type });
}

export function pastedImages(data) {
  const items = Array.from(data?.items || []);
  const images = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter(Boolean);
  return images.length ? images : Array.from(data?.files || []).filter((file) => file.type.startsWith("image/"));
}

export async function readClipboardImages(clipboard) {
  if (!clipboard?.read) throw new Error("내용 입력창에서 Ctrl+V(맥은 ⌘V)로 복사한 이미지를 붙여넣어 주세요.");
  const items = await clipboard.read();
  const images = [];
  for (const item of items) {
    // One image can have several clipboard representations. Prefer PNG and add it once.
    const type = Object.keys(imageExtensions).find((type) => item.types.includes(type));
    if (type) images.push(clipboardImage(await item.getType(type), type));
    else if (item.types.some((type) => type.startsWith("image/"))) {
      throw new Error("클립보드 이미지는 JPG, PNG, GIF, WEBP 형식을 지원합니다.");
    }
  }
  return images;
}

export function hasDraggedFiles(data) {
  return Array.from(data?.types || []).includes("Files") || Array.from(data?.items || []).some((item) => item.kind === "file");
}
