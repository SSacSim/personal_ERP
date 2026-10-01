from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock
from typing import BinaryIO
from uuid import UUID, uuid4

from PIL import Image


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGES = 20
MAX_CONTENT_LENGTH = 4000
KST = timezone(timedelta(hours=9))
logger = logging.getLogger(__name__)
_mutation_lock = RLock()


def image_format(content: bytes) -> tuple[str, str]:
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("영수증 사진은 0바이트보다 크고 10MB 이하여야 합니다.")
    if content.startswith(b"\x89PNG\r\n\x1a\n") and content[12:16] == b"IHDR" and len(content) >= 33:
        return ".png", "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        # JPEGs can have extra data after the end-of-image marker. Decode the
        # primary image instead of requiring that marker at the end of the file.
        # Keep the uploaded bytes intact, including metadata, when storing it.
        try:
            with Image.open(BytesIO(content), formats=("JPEG",)) as image:
                image.load()
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
            raise ValueError("JPG 사진을 읽을 수 없습니다. 손상되지 않은 사진을 선택해 주세요.") from exc
        return ".jpg", "image/jpeg"
    if content[:6] in {b"GIF87a", b"GIF89a"} and len(content) >= 14:
        return ".gif", "image/gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP" and len(content) >= 20:
        return ".webp", "image/webp"
    raise ValueError("JPG, PNG, WEBP, GIF 형식의 사진을 선택해 주세요.")


class ReceiptConflict(ValueError):
    pass


class ReceiptStore:
    """Each committed folder contains all original images and one JSON record."""

    def __init__(self, root: Path):
        self.root = root

    def get(self, receipt_id: str) -> dict | None:
        try:
            normalized = UUID(receipt_id).hex
        except (ValueError, AttributeError):
            return None
        record = self.root / normalized / "receipt.json"
        try:
            return json.loads(record.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    @staticmethod
    def photos(record: dict) -> list[dict]:
        # Older receipts have just the first image's fields on the record.
        return record.get("images") or [{
            "id": "primary", **{key: record[key] for key in
                ("filename", "content_type", "size", "image_file", "image_sha256", "image_url")},
        }]

    @staticmethod
    def public(record: dict) -> dict:
        private = {"image_file", "image_sha256", "images"}
        photos = ReceiptStore.photos(record)
        return {
            **{key: value for key, value in record.items() if key not in private},
            "images": [{key: value for key, value in photo.items() if key not in private} for photo in photos],
            "image_count": len(photos),
        }

    @staticmethod
    def prepare_images(receipt_key: str, images: list[tuple[str, bytes | BinaryIO]],
                       initial: bool = False) -> list[tuple[dict, BinaryIO]]:
        if not 1 <= len(images) <= MAX_IMAGES:
            raise ValueError(f"사진은 1장 이상 {MAX_IMAGES}장 이하로 선택해 주세요.")
        prepared = []
        for index, (filename, source) in enumerate(images):
            stream = BytesIO(source) if isinstance(source, bytes) else source
            stream.seek(0)
            image = stream.read(MAX_IMAGE_BYTES + 1)
            extension, content_type = image_format(image)
            image_id = uuid4().hex
            prepared.append(({
                "id": image_id,
                "filename": filename.replace("\\", "/").rsplit("/", 1)[-1][:180] or f"영수증{extension}",
                "content_type": content_type, "size": len(image),
                "image_file": f"image{extension}" if initial and index == 0 else f"image-{image_id}{extension}",
                "image_sha256": hashlib.sha256(image).hexdigest(),
                "image_url": f"/api/receipts/{receipt_key}/images/{image_id}",
            }, stream))
            stream.seek(0)
        return prepared

    @staticmethod
    def with_images(record: dict, photos: list[dict]) -> dict:
        # Preserve the original single-image API as an alias for the first photo.
        return {**record, **{key: photos[0][key] for key in
                ("filename", "content_type", "size", "image_file", "image_sha256")},
                "image_url": f"/api/receipts/{record['id']}/image", "images": photos}

    def create(self, receipt_id: UUID, registrant: str, content: str, filename: str = "", image: bytes | None = None,
               *, images: list[tuple[str, bytes | BinaryIO]] | None = None) -> dict:
        receipt_key = receipt_id.hex
        prepared = self.prepare_images(receipt_key, images if images is not None else [(filename, image or b"")], initial=True)
        photos = [photo for photo, _ in prepared]
        image_hashes = [photo["image_sha256"] for photo in photos]

        def existing_result() -> dict | None:
            existing = self.get(receipt_key)
            if existing is None:
                return None
            if (existing["registrant"], existing["content"], [photo["image_sha256"] for photo in self.photos(existing)]) != (registrant, content, image_hashes):
                raise ReceiptConflict("이미 저장된 등록 요청입니다. 새 영수증 등록을 시작해 주세요.")
            return self.public(existing)

        existing = existing_result()
        if existing is not None:
            return existing
        created_at = datetime.now(KST).isoformat(timespec="microseconds")
        record = self.with_images({
            "id": receipt_key,
            "registrant": registrant,
            "content": content,
            "created_at": created_at,
            "date": created_at[:10],
        }, photos)
        self.root.mkdir(parents=True, exist_ok=True)
        # Publish the complete group at once; a failed image never becomes a receipt.
        with TemporaryDirectory(prefix=".pending-", dir=self.root) as temporary:
            staged = Path(temporary) / receipt_key
            staged.mkdir()
            for photo, stream in prepared:
                (staged / photo["image_file"]).write_bytes(stream.read(MAX_IMAGE_BYTES + 1))
            (staged / "receipt.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                staged.rename(self.root / receipt_key)
            except OSError:
                existing = existing_result()
                if existing is not None:
                    return existing
                raise
        return self.public(record)

    def update(self, receipt_id: str, content: str, filename: str | None = None,
               image: bytes | None = None, *, images: list[tuple[str, bytes | BinaryIO]] | None = None) -> dict | None:
        with _mutation_lock:
            record = self.get(receipt_id)
            if record is None:
                return None
            folder = (self.root / UUID(receipt_id).hex).resolve()
            if folder.parent != self.root.resolve():
                return None
            updated = {**record, "content": content, "updated_at": datetime.now(KST).isoformat(timespec="microseconds")}
            if images is None and image is not None:
                images = [(filename or "", image)]
            prepared = self.prepare_images(record["id"], images) if images is not None else []
            if prepared:
                updated = self.with_images(updated, [photo for photo, _ in prepared])
            # Publish metadata only after the replacement image is fully written.
            # A failed write leaves the previous record and image available.
            committed = False
            try:
                with TemporaryDirectory(prefix=".update-", dir=folder) as temporary:
                    staged = Path(temporary)
                    for photo, stream in prepared:
                        image_path = folder / photo["image_file"]
                        (staged / image_path.name).write_bytes(stream.read(MAX_IMAGE_BYTES + 1))
                        (staged / image_path.name).replace(image_path)
                    metadata = staged / "receipt.json"
                    metadata.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
                    metadata.replace(folder / "receipt.json")
                    committed = True
            except OSError:
                if committed:
                    logger.warning("Could not clean up receipt update staging files %s", receipt_id)
                else:
                    for photo, _ in prepared:
                        (folder / photo["image_file"]).unlink(missing_ok=True)
                    raise
            if prepared:
                for photo in self.photos(record):
                    old_image = (folder / photo["image_file"]).resolve()
                    if old_image.parent == folder:
                        try:
                            old_image.unlink(missing_ok=True)
                        except OSError:
                            logger.warning("Could not remove replaced receipt image %s", receipt_id)
            return self.public(updated)

    def delete(self, receipt_id: str) -> bool:
        with _mutation_lock:
            if self.get(receipt_id) is None:
                return False
            folder = (self.root / UUID(receipt_id).hex).resolve()
            if folder.parent != self.root.resolve():
                return False
            # Remove the record from listings atomically, then remove its files.
            with TemporaryDirectory(prefix=".deleted-", dir=self.root) as temporary:
                folder.rename(Path(temporary) / folder.name)
            return True

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

    def image(self, receipt_id: str, image_id: str | None = None) -> tuple[Path, dict] | None:
        record = self.get(receipt_id)
        if record is None:
            return None
        photos = self.photos(record)
        photo = photos[0] if image_id is None else next((photo for photo in photos if photo["id"] == image_id), None)
        if photo is None:
            return None
        folder = (self.root / UUID(receipt_id).hex).resolve()
        path = (folder / photo["image_file"]).resolve()
        if path.parent != folder or not path.is_file():
            return None
        return path, photo
