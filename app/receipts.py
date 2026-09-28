from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_CONTENT_LENGTH = 4000
KST = timezone(timedelta(hours=9))
logger = logging.getLogger(__name__)


def image_format(content: bytes) -> tuple[str, str]:
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("영수증 사진은 0바이트보다 크고 10MB 이하여야 합니다.")
    if content.startswith(b"\x89PNG\r\n\x1a\n") and content[12:16] == b"IHDR" and len(content) >= 33:
        return ".png", "image/png"
    if content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9"):
        return ".jpg", "image/jpeg"
    if content[:6] in {b"GIF87a", b"GIF89a"} and len(content) >= 14:
        return ".gif", "image/gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP" and len(content) >= 20:
        return ".webp", "image/webp"
    raise ValueError("JPG, PNG, WEBP, GIF 형식의 사진을 선택해 주세요.")


class ReceiptConflict(ValueError):
    pass


class ReceiptStore:
    """Each committed folder contains the original image and its JSON record."""

    def __init__(self, root: Path):
        self.root = root

    def get(self, receipt_id: str) -> dict | None:
        try:
            normalized = UUID(receipt_id).hex
        except (ValueError, AttributeError):
            return None
        record = self.root / normalized / "receipt.json"
        if not record.is_file():
            return None
        return json.loads(record.read_text(encoding="utf-8"))

    @staticmethod
    def public(record: dict) -> dict:
        return {key: value for key, value in record.items() if key not in {"image_file", "image_sha256"}}

    def create(self, receipt_id: UUID, registrant: str, content: str, filename: str, image: bytes) -> dict:
        extension, content_type = image_format(image)
        image_hash = hashlib.sha256(image).hexdigest()
        receipt_key = receipt_id.hex

        def existing_result() -> dict | None:
            existing = self.get(receipt_key)
            if existing is None:
                return None
            if (existing["registrant"], existing["content"], existing["image_sha256"]) != (registrant, content, image_hash):
                raise ReceiptConflict("이미 저장된 등록 요청입니다. 새 영수증 등록을 시작해 주세요.")
            return self.public(existing)

        existing = existing_result()
        if existing is not None:
            return existing
        created_at = datetime.now(KST).isoformat(timespec="microseconds")
        record = {
            "id": receipt_key,
            "registrant": registrant,
            "content": content,
            "created_at": created_at,
            "date": created_at[:10],
            "filename": filename.replace("\\", "/").rsplit("/", 1)[-1][:180] or f"영수증{extension}",
            "content_type": content_type,
            "size": len(image),
            "image_file": f"image{extension}",
            "image_sha256": image_hash,
            "image_url": f"/api/receipts/{receipt_key}/image",
        }
        self.root.mkdir(parents=True, exist_ok=True)
        # Commit both files together so the other server never sees a partial upload.
        with TemporaryDirectory(prefix=".pending-", dir=self.root) as temporary:
            staged = Path(temporary) / receipt_key
            staged.mkdir()
            (staged / record["image_file"]).write_bytes(image)
            (staged / "receipt.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                staged.rename(self.root / receipt_key)
            except OSError:
                existing = existing_result()
                if existing is not None:
                    return existing
                raise
        return self.public(record)

    def list(self, offset: int, limit: int) -> dict:
        records = []
        for path in self.root.glob("*/receipt.json"):
            if path.parent.name.startswith("."):
                continue
            try:
                record = self.get(path.parent.name)
                if record:
                    records.append(self.public(record))
            except (OSError, ValueError, KeyError):
                logger.warning("Could not read receipt %s", path.parent.name)
        records.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
        return {"items": records[offset:offset + limit], "total": len(records), "offset": offset, "limit": limit}

    def image(self, receipt_id: str) -> tuple[Path, dict] | None:
        record = self.get(receipt_id)
        if record is None:
            return None
        folder = (self.root / UUID(receipt_id).hex).resolve()
        path = (folder / record["image_file"]).resolve()
        if path.parent != folder or not path.is_file():
            return None
        return path, record
