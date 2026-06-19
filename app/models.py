from __future__ import annotations

from datetime import date as Date
from typing import Literal

from pydantic import BaseModel, Field, model_validator


TaskStatus = Literal["todo", "in_progress", "review", "done", "blocked"]
Priority = Literal["low", "normal", "high", "urgent"]
ProjectStatus = Literal["planning", "active", "paused", "done"]


class CalendarEventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    date: Date | None = None
    start_date: Date | None = None
    end_date: Date | None = None
    category: str = Field(default="미팅", min_length=1, max_length=40)
    start_time: str | None = None
    end_time: str | None = None
    attendees: list[str] = Field(default_factory=list)
    notes: str = ""

    @model_validator(mode="after")
    def validate_range(self) -> "CalendarEventCreate":
        if self.start_date is None:
            self.start_date = self.date
        if self.start_date is None:
            raise ValueError("start_date or date is required")
        if self.date is None:
            self.date = self.start_date
        if self.end_date is None:
            self.end_date = self.start_date
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class CalendarEventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    date: Date | None = None
    start_date: Date | None = None
    end_date: Date | None = None
    category: str | None = Field(default=None, min_length=1, max_length=40)
    start_time: str | None = None
    end_time: str | None = None
    attendees: list[str] | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def validate_range(self) -> "CalendarEventUpdate":
        if self.start_date is None and self.date is not None:
            self.start_date = self.date
        if self.start_date is not None and self.end_date is not None and self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class WorkTaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    start_date: Date
    end_date: Date
    project_id: str | None = None
    owner: str | None = None
    status: TaskStatus = "todo"
    priority: Priority = "normal"
    description: str = ""

    @model_validator(mode="after")
    def validate_range(self) -> "WorkTaskCreate":
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class WorkTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    start_date: Date | None = None
    end_date: Date | None = None
    project_id: str | None = None
    owner: str | None = None
    status: TaskStatus | None = None
    priority: Priority | None = None
    description: str | None = None


class TodoCreate(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    date: Date
    project_id: str | None = None
    priority: Priority = "normal"
    note: str = ""
    order: int | None = None


class TodoUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    completed: bool | None = None
    project_id: str | None = None
    priority: Priority | None = None
    note: str | None = None
    order: int | None = None


class TodoReorder(BaseModel):
    ids: list[str] = Field(min_length=1)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    company_name: str | None = Field(default=None, max_length=120)
    owner: str | None = None
    status: ProjectStatus = "active"
    start_date: Date | None = None
    end_date: Date | None = None
    summary: str = ""
    goals: list[str] = Field(default_factory=list)
    links: list[str] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    company_name: str | None = Field(default=None, max_length=120)
    owner: str | None = None
    status: ProjectStatus | None = None
    start_date: Date | None = None
    end_date: Date | None = None
    summary: str | None = None
    goals: list[str] | None = None
    links: list[str] | None = None


class MeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    date: Date
    project_id: str | None = None
    start_time: str | None = None
    attendees: list[str] = Field(default_factory=list)
    agenda: str = ""
    notes: str = ""
    images: list[dict[str, str]] = Field(default_factory=list)


class MeetingUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    date: Date | None = None
    project_id: str | None = None
    start_time: str | None = None
    attendees: list[str] | None = None
    agenda: str | None = None
    notes: str | None = None
    images: list[dict[str, str]] | None = None


class WikiPageCreate(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    project_id: str | None = None
    category: str = Field(default="General", min_length=1, max_length=60)
    tags: list[str] = Field(default_factory=list)
    content: str = ""
    images: list[dict[str, str]] = Field(default_factory=list)


class WikiPageUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    project_id: str | None = None
    category: str | None = Field(default=None, min_length=1, max_length=60)
    tags: list[str] | None = None
    content: str | None = None
    images: list[dict[str, str]] | None = None


class ProjectRecordCreate(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    project_id: str | None = None
    content: str = ""
    images: list[dict[str, str]] = Field(default_factory=list)


class ProjectRecordUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    project_id: str | None = None
    content: str | None = None
    images: list[dict[str, str]] | None = None


class AssetUpload(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    content_type: str = Field(min_length=1, max_length=80)
    data_url: str = Field(min_length=1)


class ProjectFileUpload(BaseModel):
    project_id: str | None = None
    filename: str = Field(min_length=1, max_length=240)
    content_type: str = Field(default="application/octet-stream", min_length=1, max_length=160)
    data_url: str = Field(min_length=1)


class ChatQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
