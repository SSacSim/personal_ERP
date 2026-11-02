from __future__ import annotations

import hashlib
import json
import logging
import re
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
UNFILED_FOLDER = "unfiled"
KST = timezone(timedelta(hours=9))
logger = logging.getLogger(__name__)
_mutation_lock = RLock()


def image_format(content: bytes) -> tuple[str, str]:
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("영수증 파일은 0바이트보다 크고 10MB 이하여야 합니다.")
    if content.startswith(b"%PDF-"):
        if (not re.match(rb"%PDF-(?:1\.[0-7]|2\.0)[\r\n]", content)
                or b"%%EOF" not in content[-1024:] or b"startxref" not in content
                or not re.search(rb"\d+\s+\d+\s+obj\b", content)):
            raise ValueError("PDF 파일을 읽을 수 없습니다. 손상되지 않은 파일을 선택해 주세요.")
        return ".pdf", "application/pdf"
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
    raise ValueError("JPG, PNG, WEBP, GIF, PDF 형식의 파일을 선택해 주세요.")


class ReceiptConflict(ValueError):
    pass


class ReceiptStore:
    """Receipt files stay together; .folders holds their category metadata."""

    def __init__(self, root: Path):
        self.root = root

    def get_folder(self, folder_id: str) -> dict | None:
        if folder_id == UNFILED_FOLDER:
            normalized = UNFILED_FOLDER
        else:
            try:
                normalized = UUID(folder_id).hex
            except (ValueError, AttributeError):
                return None
        try:
            record = json.loads((self.root / ".folders" / normalized / "folder.json").read_text(encoding="utf-8"))
            return {"status": "in_progress", **record}
        except FileNotFoundError:
            return None

    def _save_new_folder(self, record: dict) -> None:
        folders = self.root / ".folders"
        folders.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".pending-", dir=folders) as temporary:
            staged = Path(temporary) / record["id"]
            staged.mkdir()
            (staged / "folder.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                staged.rename(folders / record["id"])
            except OSError:
                if self.get_folder(record["id"]) is None:
                    raise

    def _write_receipt_metadata(self, record: dict) -> None:
        folder = self.root / UUID(record["id"]).hex
        with TemporaryDirectory(prefix=".update-", dir=folder) as temporary:
            staged = Path(temporary) / "receipt.json"
            staged.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            staged.replace(folder / "receipt.json")

    def ensure_folders(self) -> None:
        """Create the default folder and durably assign legacy/orphan receipts."""
        with _mutation_lock:
            if self.get_folder(UNFILED_FOLDER) is None:
                self._save_new_folder({"id": UNFILED_FOLDER, "name": "미분류", "status": "in_progress",
                                       "created_at": datetime.now(KST).isoformat(timespec="microseconds")})
            folder_ids = {path.parent.name for path in (self.root / ".folders").glob("*/folder.json")}
            for path in self.root.glob("*/receipt.json"):
                if path.parent.name.startswith("."):
                    continue
                try:
                    record = self.get(path.parent.name)
                except (OSError, ValueError):
                    logger.warning("Could not migrate receipt %s", path.parent.name)
                    continue
                if record and record.get("folder_id") not in folder_ids:
                    self._write_receipt_metadata({**record, "folder_id": UNFILED_FOLDER})

    @staticmethod
    def folder_public(record: dict, count: int = 0) -> dict:
        return {**record, "receipt_count": count, "can_upload": record["status"] == "in_progress"}

    def create_folder(self, name: str) -> dict:
        name = name.strip()
        if not name or len(name) > 80:
            raise ValueError("폴더 이름을 1~80자로 입력해 주세요.")
        with _mutation_lock:
            if any(folder["name"].casefold() == name.casefold() for folder in self.list_folders()["items"]):
                raise ReceiptConflict("같은 이름의 폴더가 있습니다. 다른 이름을 입력해 주세요.")
            record = {"id": uuid4().hex, "name": name, "status": "in_progress",
                      "created_at": datetime.now(KST).isoformat(timespec="microseconds")}
            self._save_new_folder(record)
            return self.folder_public(record)

    def list_folders(self) -> dict:
        self.ensure_folders()
        folders = []
        for path in (self.root / ".folders").glob("*/folder.json"):
            try:
                record = self.get_folder(path.parent.name)
                if record:
                    folders.append(self.folder_public(record))
            except (OSError, ValueError, KeyError):
                logger.warning("Could not read receipt folder %s", path.parent.name)
        folders.sort(key=lambda folder: (folder["id"] != UNFILED_FOLDER, folder["name"].casefold(), folder["id"]))
        by_id = {folder["id"]: folder for folder in folders}
        for receipt in self._records():
            if receipt.get("folder_id") in by_id:
                by_id[receipt["folder_id"]]["receipt_count"] += 1
        return {"items": folders}

    def set_folder_status(self, folder_id: str, status: str) -> dict | None:
        if status not in {"in_progress", "completed"}:
            raise ValueError("폴더 상태는 진행 또는 완료로 선택해 주세요.")
        with _mutation_lock:
            self.ensure_folders()
            record = self.get_folder(folder_id)
            if record is None:
                return None
            updated = {**record, "status": status, "updated_at": datetime.now(KST).isoformat(timespec="microseconds")}
            folder = self.root / ".folders" / record["id"]
            with TemporaryDirectory(prefix=".update-", dir=folder) as temporary:
                staged = Path(temporary) / "folder.json"
                staged.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
                staged.replace(folder / "folder.json")
            return self.folder_public(updated, sum(item.get("folder_id") == record["id"] for item in self._records()))

    def require_open_folder(self, folder_id: str) -> dict:
        folder = self.get_folder(folder_id)
        if folder is None:
            raise ValueError("영수증을 등록할 폴더에 먼저 들어가 주세요.")
        if folder["status"] != "in_progress":
            raise ReceiptConflict("완료된 폴더에는 영수증을 등록하거나 이동할 수 없습니다. 진행 중인 폴더를 선택해 주세요.")
        return folder

    def move(self, receipt_id: str, folder_id: str) -> dict | None:
        with _mutation_lock:
            self.ensure_folders()
            record = self.get(receipt_id)
            if record is None:
                return None
            target = self.get_folder(folder_id)
            if target is None:
                raise ValueError("이동할 폴더를 찾을 수 없습니다.")
            if record.get("folder_id") == target["id"]:
                return self.public(record)
            self.require_open_folder(target["id"])
            updated = {**record, "folder_id": target["id"], "updated_at": datetime.now(KST).isoformat(timespec="microseconds")}
            self._write_receipt_metadata(updated)
            return self.public(updated)

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
            raise ValueError(f"파일은 1개 이상 {MAX_IMAGES}개 이하로 선택해 주세요.")
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
               *, folder_id: str, images: list[tuple[str, bytes | BinaryIO]] | None = None) -> dict:
        if folder_id == UNFILED_FOLDER:
            self.ensure_folders()
        folder = self.get_folder(folder_id)
        if folder is None:
            raise ValueError("영수증을 등록할 폴더에 먼저 들어가 주세요.")
        folder_id = folder["id"]
        receipt_key = receipt_id.hex
        prepared = self.prepare_images(receipt_key, images if images is not None else [(filename, image or b"")], initial=True)
        photos = [photo for photo, _ in prepared]
        image_hashes = [photo["image_sha256"] for photo in photos]

        def existing_result() -> dict | None:
            existing = self.get(receipt_key)
            if existing is None:
                return None
            if (existing.get("folder_id"), existing["registrant"], existing["content"], [photo["image_sha256"] for photo in self.photos(existing)]) != (folder_id, registrant, content, image_hashes):
                raise ReceiptConflict("이미 저장된 등록 요청입니다. 새 영수증 등록을 시작해 주세요.")
            return self.public(existing)

        existing = existing_result()
        if existing is not None:
            return existing
        self.require_open_folder(folder_id)
        created_at = datetime.now(KST).isoformat(timespec="microseconds")
        record = self.with_images({
            "id": receipt_key,
            "folder_id": folder_id,
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
            # Completion and incoming receipts use the same lock. Recheck after
            # staging so an upload cannot enter a folder completed meanwhile.
            with _mutation_lock:
                existing = existing_result()
                if existing is not None:
                    return existing
                self.require_open_folder(folder_id)
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

    def _records(self) -> list[dict]:
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
        return records

    def list(self, offset: int, limit: int, folder_id: str | None = None) -> dict:
        self.ensure_folders()
        records = self._records()
        if folder_id is not None:
            normalized = UNFILED_FOLDER if folder_id == UNFILED_FOLDER else UUID(folder_id).hex
            records = [record for record in records if record.get("folder_id") == normalized]
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
