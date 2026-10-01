import base64
import binascii
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
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


class ReceiptUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=MAX_CONTENT_LENGTH)
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    image_base64: str | None = Field(default=None, min_length=1, max_length=((MAX_IMAGE_BYTES + 2) // 3) * 4)

    @field_validator("content")
    @classmethod
    def trim_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("내용을 입력해 주세요.")
        return value.strip()

    @model_validator(mode="after")
    def paired_image(self):
        if (self.filename is None) != (self.image_base64 is None):
            raise ValueError("교체할 사진과 파일 이름을 함께 보내 주세요.")
        return self


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


async def read_payload(request: Request, model):
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise HTTPException(status_code=415, detail="JSON 형식으로 등록해 주세요.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="영수증 사진은 10MB까지 등록할 수 있습니다.")
        body.extend(chunk)
    try:
        return model.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="등록자(50자 이내), 내용(4,000자 이내), 사진을 확인해 주세요.") from exc


@router.post("", status_code=201)
async def create_receipt(request: Request):
    payload = await read_payload(request, ReceiptCreate)
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


@router.patch("/{receipt_id}")
async def update_receipt(receipt_id: str, request: Request):
    payload = await read_payload(request, ReceiptUpdate)
    try:
        image = base64.b64decode(payload.image_base64, validate=True) if payload.image_base64 is not None else None
        record = await run_in_threadpool(store.update, receipt_id, payload.content, payload.filename, image)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="사진 형식이 올바르지 않습니다. 10MB 이하의 JPG, PNG, WEBP, GIF를 선택해 주세요.") from exc
    if record is None:
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return record


@router.delete("/{receipt_id}", status_code=204)
def delete_receipt(receipt_id: str):
    if not store.delete(receipt_id):
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return Response(status_code=204)
