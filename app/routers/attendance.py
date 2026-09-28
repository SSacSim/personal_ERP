from datetime import date
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.auth import current_user
from app.storage import split_change_log, vault


router = APIRouter(prefix="/api/attendance", tags=["attendance"])
AttendanceKind = Literal["annual_leave", "half_day", "remote_work"]
CATEGORY_KINDS = {
    "연차": "annual_leave", "annual_leave": "annual_leave",
    "반차": "half_day", "오전 반차": "half_day", "오후 반차": "half_day", "half_day": "half_day",
    "재택": "remote_work", "재택근무": "remote_work", "remote_work": "remote_work",
}


class AttendanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: AttendanceKind
    start_date: date
    end_date: date | None = None
    period: Literal["am", "pm"] | None = None
    notes: str = Field(default="", max_length=4000)

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def calendar_date(cls, value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
            raise ValueError("날짜는 YYYY-MM-DD 형식으로 입력해 주세요.")
        return value

    @model_validator(mode="after")
    def validate_schedule(self):
        self.end_date = self.end_date or self.start_date
        if self.end_date < self.start_date:
            raise ValueError("종료일은 시작일보다 빠를 수 없습니다.")
        if self.kind == "half_day":
            if self.period is None:
                raise ValueError("반차는 오전 또는 오후를 선택해 주세요.")
            if self.end_date != self.start_date:
                raise ValueError("반차는 하루씩 등록해 주세요.")
        elif self.period is not None:
            raise ValueError("오전·오후는 반차에만 지정할 수 있습니다.")
        self.notes = self.notes.strip()
        return self


def attendance_item(item: dict) -> dict:
    content, _ = split_change_log(item.get("body", ""))
    notes = re.sub(r"\A# [^\n]*(?:\n|$)", "", content).strip()
    return {**item, "kind": CATEGORY_KINDS.get(item.get("category")), "notes": notes}


@router.get("")
def list_attendance(month: str = Query(default="", pattern=r"^(?:[0-9]{4}-(?:0[1-9]|1[0-2]))?$"),
                    kind: Literal["", "annual_leave", "half_day", "remote_work"] = "",
                    limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0),
                    user: dict = Depends(current_user)):
    if month:
        try:
            date.fromisoformat(month + "-01")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="조회할 월을 확인해 주세요.") from exc
    # Use the calendar notes themselves: editing/deleting a calendar event also updates this list.
    items = [attendance_item(item) for item in vault.list_calendar_events(month=month or None)
             if CATEGORY_KINDS.get(item.get("category")) and (not kind or CATEGORY_KINDS[item["category"]] == kind)]
    items.sort(key=lambda item: (item.get("start_date") or item.get("date", ""), item.get("created_at", ""), item["id"]), reverse=True)
    return {"items": items[offset:offset + limit], "total": len(items)}


@router.post("", status_code=201)
def create_attendance(payload: AttendanceCreate, user: dict = Depends(current_user)):
    category = {"annual_leave": "연차", "remote_work": "재택", "half_day": "오전 반차" if payload.period == "am" else "오후 반차"}[payload.kind]
    item = vault.create_calendar_event({
        "title": f"{user['name']} · {category}", "category": category,
        "start_date": payload.start_date, "end_date": payload.end_date,
        "attendees": [user["name"]], "notes": payload.notes,
    })
    return attendance_item(item)
