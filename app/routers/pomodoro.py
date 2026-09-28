from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import VAULT_DIR
from app import auth
from app.pomodoro import PomodoroStore


router = APIRouter(prefix="/api/pomodoro/history", tags=["pomodoro"])
store = PomodoroStore(VAULT_DIR / "Pomodoro")


class SessionSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    person: str = Field(default="", min_length=1, max_length=80)
    duration_ms: int = Field(strict=True, ge=60000, le=10800000, multiple_of=60000)
    remaining_ms: int = Field(strict=True, ge=0, le=10800000)
    status: Literal["running", "paused", "completed", "stopped"]
    started_at: int = Field(strict=True, ge=1, le=253402300799999)
    ends_at: int | None = Field(default=None, strict=True, ge=1, le=253402300799999)
    revision: int = Field(strict=True, ge=1, le=9007199254740991)

    @field_validator("person", mode="before")
    @classmethod
    def clean_person(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def valid_snapshot(self):
        if self.remaining_ms > self.duration_ms:
            raise ValueError("남은 시간이 설정 시간을 초과합니다.")
        if self.status == "running":
            if not self.ends_at or self.ends_at < self.started_at or self.remaining_ms == 0:
                raise ValueError("실행 중인 타이머의 종료 시각과 남은 시간을 확인해 주세요.")
        elif self.ends_at is not None:
            raise ValueError("멈춘 타이머에는 종료 예정 시각을 지정할 수 없습니다.")
        if self.status == "completed" and self.remaining_ms != 0:
            raise ValueError("완료된 타이머의 남은 시간은 0이어야 합니다.")
        if self.status == "paused" and self.remaining_ms == 0:
            raise ValueError("일시정지 상태의 남은 시간을 확인해 주세요.")
        return self


@router.get("")
def list_history(response: Response, limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0)):
    response.headers["Cache-Control"] = "no-store"
    return store.list(limit=limit, offset=offset)


@router.put("/{session_id}")
def save_history(session_id: UUID, payload: SessionSnapshot, response: Response, request: Request):
    response.headers["Cache-Control"] = "no-store"
    try:
        values = payload.model_dump()
        user = getattr(request.state, "user", None)
        if user:
            values["person"] = auth.store.pomodoro_person(str(session_id), user)
        if not values["person"]:
            raise ValueError("실행 사용자를 확인해 주세요.")
        return store.save(str(session_id), values)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
