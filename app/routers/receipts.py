import base64
import binascii
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from app.config import VAULT_DIR
from app.receipts import MAX_CONTENT_LENGTH, MAX_IMAGE_BYTES, ReceiptConflict, ReceiptStore


router = APIRouter(prefix="/api/receipts", tags=["receipts"])
store = ReceiptStore(VAULT_DIR / "Receipts")
MAX_REQUEST_BYTES = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 64 * 1024


class ReceiptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    submission_id: UUID
    registrant: str = Field(default="", min_length=1, max_length=50)
    content: str = Field(min_length=1, max_length=MAX_CONTENT_LENGTH)
    filename: str = Field(min_length=1, max_length=255)
    image_base64: str = Field(min_length=1, max_length=((MAX_IMAGE_BYTES + 2) // 3) * 4)

    @field_validator("registrant", "content")
    @classmethod
    def trim_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("등록자와 내용을 입력해 주세요.")
        return value


@router.get("")
def list_receipts(offset: int = Query(default=0, ge=0), limit: int = Query(default=24, ge=1, le=100)):
    return store.list(offset, limit)


@router.get("/{receipt_id}/image")
def receipt_image(receipt_id: str, download: bool = False):
    result = store.image(receipt_id)
    if result is None:
        raise HTTPException(status_code=404, detail="영수증 사진을 찾을 수 없습니다.")
    path, record = result
    return FileResponse(path, media_type=record["content_type"], filename=record["filename"],
                        content_disposition_type="attachment" if download else "inline",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.post("", status_code=201)
async def create_receipt(request: Request):
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise HTTPException(status_code=415, detail="JSON 형식으로 등록해 주세요.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="영수증 사진은 10MB까지 등록할 수 있습니다.")
        body.extend(chunk)
    try:
        payload = ReceiptCreate.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="등록자(50자 이내), 내용(4,000자 이내), 사진을 확인해 주세요.") from exc
    try:
        image = base64.b64decode(payload.image_base64, validate=True)
        user = getattr(request.state, "user", None)
        registrant = user["name"] if user else payload.registrant
        if not registrant:
            raise ValueError("등록자를 확인해 주세요.")
        return await run_in_threadpool(store.create, payload.submission_id, registrant,
                                       payload.content, payload.filename, image)
    except ReceiptConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="사진 형식이 올바르지 않습니다. 10MB 이하의 JPG, PNG, WEBP, GIF를 선택해 주세요.") from exc
