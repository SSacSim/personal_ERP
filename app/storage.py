from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
import json
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from app.config import VAULT_DIR


FOLDERS = {
    "calendar_event": "Calendar",
    "work_task": "Tasks",
    "todo": "Todos",
    "project": "Projects",
    "meeting": "Meetings",
    "wiki_page": "Wiki",
    "project_file": "Files",
    "project_record": "Records",
    "report": "Reports",
}

CHANGE_LOG_HEADING = "## 변경 로그"
ASSET_CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
MAX_ASSET_BYTES = 10 * 1024 * 1024
MAX_PROJECT_FILE_BYTES = 50 * 1024 * 1024
DEFAULT_FILE_CONTENT_TYPE = "application/octet-stream"
ABSENCE_KEYWORDS = (
    "연차",
    "휴가",
    "반차",
    "병가",
    "공가",
    "휴무",
    "휴직",
    "출장",
    "외근",
    "annual_leave",
    "half_day",
    "business_trip",
    "vacation",
    "leave",
    "sick",
)


def today_iso() -> str:
    return date.today().isoformat()


def parse_iso_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def slugify(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9가-힣_-]+", "-", value.strip()).strip("-")
    return cleaned[:60] or fallback


def encode_value(value: Any) -> str:
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if value is None:
        return ""
    text = str(value).replace("\n", " ").strip()
    if text.startswith(("[", "{")) or ":" in text or "#" in text:
        return json.dumps(text, ensure_ascii=False)
    return text


def decode_value(value: str) -> Any:
    text = value.strip()
    if text == "":
        return ""
    if text in {"true", "false"}:
        return text == "true"
    if text.startswith(("[", "{", '"')):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text.strip('"')
    return text


def parse_note(raw: str) -> tuple[dict[str, Any], str]:
    if not raw.startswith("---\n"):
        return {}, raw
    end = raw.find("\n---\n", 4)
    if end == -1:
        return {}, raw
    frontmatter = raw[4:end]
    body = raw[end + 5 :]
    data: dict[str, Any] = {}
    for line in frontmatter.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = decode_value(value)
    return data, body


def render_note(metadata: dict[str, Any], body: str) -> str:
    lines = ["---"]
    for key in sorted(metadata):
        lines.append(f"{key}: {encode_value(metadata[key])}")
    lines.append("---")
    lines.append(body.strip())
    lines.append("")
    return "\n".join(lines)


def split_change_log(body: str) -> tuple[str, str]:
    match = re.search(rf"(?m)^{re.escape(CHANGE_LOG_HEADING)}\s*$", body)
    if match is None:
        return body.strip(), ""
    return body[: match.start()].strip(), body[match.end() :].strip()


def append_change_log(body: str, action: str, timestamp: str, fields: list[str] | None = None) -> str:
    content, existing_log = split_change_log(body)
    field_text = f" ({', '.join(fields)})" if fields else ""
    entry = f"- {timestamp} | {action}{field_text}"
    log_lines = [existing_log, entry] if existing_log else [entry]
    return "\n\n".join([part for part in [content, CHANGE_LOG_HEADING, "\n".join(log_lines)] if part]).strip()


def body_with_replaced_content(existing_body: str, title: str, content: str) -> str:
    _, existing_log = split_change_log(existing_body)
    base = f"# {title}\n\n{content.strip()}".strip()
    if not existing_log:
        return base
    return "\n\n".join([base, CHANGE_LOG_HEADING, existing_log]).strip()


def todo_body_content(existing_body: str) -> str:
    content, _ = split_change_log(existing_body)
    return re.sub(r"^# .*(\r?\n)+", "", content).strip()


def project_body_with_metadata(existing_body: str, title: str, company_name: str) -> str:
    content, existing_log = split_change_log(existing_body)
    content = re.sub(r"^# .*(\r?\n)+", "", content).strip()
    lines = content.splitlines()
    company_name = company_name.strip()
    if lines and lines[0].startswith("회사명:"):
        if company_name:
            lines[0] = f"회사명: {company_name}"
        else:
            lines = lines[1:]
            if lines and not lines[0].strip():
                lines = lines[1:]
    elif company_name:
        lines = [f"회사명: {company_name}", ""] + lines

    body_content = "\n".join(lines).strip()
    base = f"# {title}\n\n{body_content}".strip()
    if not existing_log:
        return base
    return "\n\n".join([base, CHANGE_LOG_HEADING, existing_log]).strip()


@dataclass
class Note:
    metadata: dict[str, Any]
    body: str
    path: Path

    def as_dict(self) -> dict[str, Any]:
        payload = dict(self.metadata)
        payload["body"] = self.body.strip()
        payload["path"] = str(self.path.relative_to(VAULT_DIR))
        return payload


class ObsidianVault:
    def __init__(self, root: Path = VAULT_DIR) -> None:
        self.root = root
        self.ensure()

    def ensure(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for folder in {*FOLDERS.values(), "Dashboard", "Wiki"}:
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / "Assets").mkdir(parents=True, exist_ok=True)
        readme = self.root / "README.md"
        if not readme.exists():
            readme.write_text(
                "# GAI ERP Vault\n\n"
                "이 폴더는 ERP 데이터의 원본 저장소입니다. 각 항목은 Markdown 노트와 frontmatter로 저장되어 Obsidian과 LLM Wiki에서 바로 읽을 수 있습니다.\n",
                encoding="utf-8",
            )

    def folder_for(self, note_type: str) -> Path:
        return self.root / FOLDERS[note_type]

    def read(self, path: Path) -> Note:
        metadata, body = parse_note(path.read_text(encoding="utf-8"))
        return Note(metadata=metadata, body=body, path=path)

    def list_notes(self, note_type: str) -> list[Note]:
        folder = self.folder_for(note_type)
        notes = []
        for path in sorted(folder.glob("*.md")):
            note = self.read(path)
            if note.metadata.get("type") == note_type:
                notes.append(note)
        return notes

    def find_by_id(self, note_type: str, note_id: str) -> Note | None:
        for note in self.list_notes(note_type):
            if note.metadata.get("id") == note_id:
                return note
        return None

    def write(
        self,
        note_type: str,
        title: str,
        metadata: dict[str, Any],
        body: str,
        existing_path: Path | None = None,
        log_action: str | None = None,
        log_fields: list[str] | None = None,
    ) -> Note:
        metadata = dict(metadata)
        metadata.setdefault("id", uuid4().hex)
        metadata["type"] = note_type
        timestamp = datetime.now().isoformat(timespec="seconds")
        metadata["updated_at"] = timestamp
        metadata.setdefault("created_at", metadata["updated_at"])
        if log_action:
            body = append_change_log(body, log_action, timestamp, log_fields)

        path = existing_path
        if path is None:
            prefix = metadata.get("date") or metadata.get("start_date") or metadata.get("created_at", "")[:10]
            filename = f"{prefix}-{slugify(title, note_type)}-{metadata['id'][:8]}.md"
            path = self.folder_for(note_type) / filename
        path.write_text(render_note(metadata, body), encoding="utf-8")
        return self.read(path)

    def save_asset(self, filename: str, content_type: str, content: bytes) -> dict[str, str]:
        if content_type not in ASSET_CONTENT_TYPES:
            raise ValueError("unsupported image type")
        if len(content) > MAX_ASSET_BYTES:
            raise ValueError("image is too large")
        suffix = Path(filename).suffix.lower() or ASSET_CONTENT_TYPES[content_type]
        if suffix not in set(ASSET_CONTENT_TYPES.values()) | {".jpeg"}:
            suffix = ASSET_CONTENT_TYPES[content_type]
        stem = slugify(Path(filename).stem, "image")
        asset_dir = self.root / "Assets" / datetime.now().strftime("%Y-%m")
        asset_dir.mkdir(parents=True, exist_ok=True)
        asset_name = f"{uuid4().hex[:12]}-{stem}{suffix}"
        path = asset_dir / asset_name
        path.write_bytes(content)
        asset_path = path.relative_to(self.root / "Assets").as_posix()
        return {
            "name": filename,
            "path": asset_path,
            "url": f"/api/assets/{asset_path}",
            "content_type": content_type,
        }

    def asset_file(self, asset_path: str) -> Path | None:
        assets_root = (self.root / "Assets").resolve()
        target = (assets_root / asset_path).resolve()
        try:
            target.relative_to(assets_root)
        except ValueError:
            return None
        if not target.is_file():
            return None
        return target

    def save_project_file(self, data: dict[str, Any], content: bytes) -> dict[str, Any]:
        if len(content) > MAX_PROJECT_FILE_BYTES:
            raise ValueError("file is too large")
        original_name = Path(str(data.get("filename") or "file")).name or "file"
        content_type = str(data.get("content_type") or DEFAULT_FILE_CONTENT_TYPE).strip() or DEFAULT_FILE_CONTENT_TYPE
        content_type = content_type[:160]
        file_id = uuid4().hex
        stem = slugify(Path(original_name).stem, "file")
        suffix = re.sub(r"[^A-Za-z0-9.]+", "", Path(original_name).suffix)[:24]
        if suffix in {"", "."} or not suffix.startswith("."):
            suffix = ""
        upload_dir = self.folder_for("project_file") / "Uploads" / datetime.now().strftime("%Y-%m")
        upload_dir.mkdir(parents=True, exist_ok=True)
        (upload_dir.parent / ".gitkeep").touch(exist_ok=True)
        (upload_dir / ".gitkeep").touch(exist_ok=True)
        stored_name = f"{file_id[:12]}-{stem}{suffix}"
        path = upload_dir / stored_name
        path.write_bytes(content)
        file_path = path.relative_to(self.folder_for("project_file")).as_posix()
        metadata = {
            "id": file_id,
            "title": original_name,
            "project_id": data.get("project_id") or "",
            "filename": original_name,
            "content_type": content_type,
            "size": len(content),
            "file_path": file_path,
            "url": f"/api/project-files/{file_id}/download",
        }
        body = "\n".join(
            [
                f"# {original_name}",
                "",
                f"- 파일명: {original_name}",
                f"- 크기: {len(content)} bytes",
                f"- 형식: {content_type}",
            ]
        )
        return self.write("project_file", original_name, metadata, body, log_action="업로드").as_dict()

    def list_project_files(self, project_id: str | None = None) -> list[dict[str, Any]]:
        items = [note.as_dict() for note in self.list_notes("project_file") if note.metadata.get("deleted") is not True]
        if project_id is not None:
            items = [item for item in items if item.get("project_id") == project_id]
        for item in items:
            if item.get("id"):
                item["url"] = f"/api/project-files/{item['id']}/download"
        return sorted(items, key=lambda item: (item.get("updated_at", ""), item.get("filename", "")), reverse=True)

    def project_file(self, file_id: str) -> tuple[Path, dict[str, Any]] | None:
        note = self.find_by_id("project_file", file_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        files_root = self.folder_for("project_file").resolve()
        target = (files_root / str(note.metadata.get("file_path") or "")).resolve()
        try:
            target.relative_to(files_root)
        except ValueError:
            return None
        if not target.is_file():
            return None
        metadata = dict(note.metadata)
        metadata["url"] = f"/api/project-files/{file_id}/download"
        return target, metadata

    def delete_project_file(self, file_id: str) -> dict[str, Any] | None:
        note = self.find_by_id("project_file", file_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        metadata["deleted"] = True
        metadata["deleted_at"] = datetime.now().isoformat(timespec="seconds")
        title = str(metadata.get("title") or metadata.get("filename") or "file")
        return self.write("project_file", title, metadata, note.body, note.path, log_action="삭제").as_dict()

    def create_calendar_event(self, data: dict[str, Any]) -> dict[str, Any]:
        start_date = str(data.get("start_date") or data.get("date"))
        end_date = str(data.get("end_date") or start_date)
        body = f"# {data['title']}\n\n{data.get('notes', '').strip()}"
        metadata = {
            "title": data["title"],
            "date": start_date,
            "start_date": start_date,
            "end_date": end_date,
            "category": data.get("category", "미팅"),
            "start_time": data.get("start_time") or "",
            "end_time": data.get("end_time") or "",
            "attendees": data.get("attendees", []),
        }
        return self.write("calendar_event", data["title"], metadata, body, log_action="등록").as_dict()

    def update_calendar_event(self, event_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("calendar_event", event_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        if updates.get("date") is not None and updates.get("start_date") is None:
            updates["start_date"] = updates["date"]
        metadata = dict(note.metadata)
        for key, value in updates.items():
            if key == "notes":
                continue
            if value is None and key in {"start_time", "end_time"}:
                metadata[key] = ""
                continue
            if value is not None:
                metadata[key] = str(value) if isinstance(value, date) else value
        if "start_date" in metadata:
            metadata["date"] = metadata["start_date"]
        if "end_date" not in metadata or not metadata.get("end_date"):
            metadata["end_date"] = metadata.get("start_date") or metadata.get("date", "")
        start = parse_iso_date(metadata.get("start_date") or metadata.get("date"))
        end = parse_iso_date(metadata.get("end_date"))
        if start and end and end < start:
            metadata["end_date"] = start.isoformat()
        title = str(metadata.get("title", "calendar_event"))
        body = note.body
        if "notes" in updates and updates["notes"] is not None:
            body = body_with_replaced_content(note.body, title, str(updates["notes"]))
        fields = [key for key, value in updates.items() if value is not None]
        return self.write("calendar_event", title, metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()

    def delete_calendar_event(self, event_id: str) -> dict[str, Any] | None:
        note = self.find_by_id("calendar_event", event_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        deleted_at = datetime.now().isoformat(timespec="seconds")
        metadata["deleted"] = True
        metadata["deleted_at"] = deleted_at
        title = str(metadata.get("title", "calendar_event"))
        return self.write("calendar_event", title, metadata, note.body, note.path, log_action="삭제").as_dict()

    def list_calendar_events(self, month: str | None = None, target_date: date | None = None) -> list[dict[str, Any]]:
        month_start = None
        month_end = None
        if month:
            try:
                month_start = date.fromisoformat(f"{month}-01")
                next_month = date(month_start.year + (month_start.month // 12), (month_start.month % 12) + 1, 1)
                month_end = next_month - timedelta(days=1)
            except ValueError:
                month_start = None
                month_end = None

        items = []
        for note in self.list_notes("calendar_event"):
            if note.metadata.get("deleted") is True:
                continue
            event_start = parse_iso_date(note.metadata.get("start_date") or note.metadata.get("date"))
            event_end = parse_iso_date(note.metadata.get("end_date")) or event_start
            event_date = str(note.metadata.get("date", ""))
            if event_start is None:
                if month and not event_date.startswith(month):
                    continue
                if target_date and event_date != target_date.isoformat():
                    continue
                items.append(note.as_dict())
                continue

            if month_start and month_end and (event_end < month_start or event_start > month_end):
                continue
            if target_date and not (event_start <= target_date <= event_end):
                continue
            items.append(note.as_dict())
        return sorted(items, key=lambda item: (item.get("start_date") or item.get("date", ""), item.get("start_time", ""), item.get("title", "")))

    def is_absence_event(self, item: dict[str, Any]) -> bool:
        text = " ".join(
            [
                str(item.get("category", "")),
                str(item.get("title", "")),
                todo_body_content(str(item.get("body", ""))),
            ]
        ).lower()
        return any(keyword.lower() in text for keyword in ABSENCE_KEYWORDS)

    def event_people(self, item: dict[str, Any]) -> list[str]:
        attendees = item.get("attendees", [])
        if isinstance(attendees, list):
            people = [str(person).strip() for person in attendees]
        else:
            people = [part.strip() for part in re.split(r"\n|,", str(attendees))]
        return [person for person in people if person]

    def dashboard_absences(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        entries = []
        for event in events:
            if not self.is_absence_event(event):
                continue
            people = self.event_people(event) or ["대상 미지정"]
            time_text = "종일"
            if event.get("start_time") or event.get("end_time"):
                time_text = " - ".join([str(value) for value in [event.get("start_time"), event.get("end_time")] if value])
            start = str(event.get("start_date") or event.get("date") or "")
            end = str(event.get("end_date") or start)
            date_range = start if start == end else f"{start} → {end}"
            for person in people:
                entries.append(
                    {
                        "person": person,
                        "title": event.get("title", ""),
                        "category": event.get("category", ""),
                        "time": time_text,
                        "date_range": date_range,
                        "event_id": event.get("id", ""),
                    }
                )
        return sorted(entries, key=lambda item: (item.get("person", ""), item.get("category", ""), item.get("title", "")))

    def create_task(self, data: dict[str, Any]) -> dict[str, Any]:
        body = f"# {data['title']}\n\n{data.get('description', '').strip()}"
        metadata = {
            "title": data["title"],
            "start_date": str(data["start_date"]),
            "end_date": str(data["end_date"]),
            "project_id": data.get("project_id") or "",
            "owner": data.get("owner") or "",
            "status": data.get("status", "todo"),
            "priority": data.get("priority", "normal"),
        }
        return self.write("work_task", data["title"], metadata, body, log_action="등록").as_dict()

    def list_tasks(self) -> list[dict[str, Any]]:
        items = [note.as_dict() for note in self.list_notes("work_task")]
        return sorted(items, key=lambda item: (item.get("start_date", ""), item.get("end_date", "")))

    def update_task(self, task_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("work_task", task_id)
        if note is None:
            return None
        metadata = dict(note.metadata)
        for key, value in updates.items():
            if value is not None:
                metadata[key] = str(value) if isinstance(value, date) else value
        title = metadata.get("title", "task")
        body = note.body
        if "description" in updates and updates["description"] is not None:
            body = body_with_replaced_content(note.body, str(title), updates["description"])
        fields = [key for key, value in updates.items() if value is not None]
        return self.write("work_task", str(title), metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()

    def create_todo(self, data: dict[str, Any]) -> dict[str, Any]:
        body = f"# {data['title']}\n\n{data.get('note', '').strip()}"
        todo_date = str(data["date"])
        metadata = {
            "title": data["title"],
            "date": todo_date,
            "project_id": data.get("project_id") or "",
            "priority": data.get("priority", "normal"),
            "order": data.get("order") if data.get("order") is not None else self.next_todo_order(todo_date),
            "completed": False,
            "rolled_over_to": "",
            "source_id": data.get("source_id", ""),
        }
        if data.get("origin_created_at"):
            metadata["origin_created_at"] = data["origin_created_at"]
        return self.write("todo", data["title"], metadata, body, log_action="등록").as_dict()

    def list_todos(self, target_date: date) -> list[dict[str, Any]]:
        items = []
        notes = self.list_notes("todo")
        notes_by_id = {note.metadata.get("id"): note for note in notes}
        for note in notes:
            if note.metadata.get("deleted") is True:
                continue
            if note.metadata.get("date") == target_date.isoformat():
                item = note.as_dict()
                source_id = item.get("source_id")
                if source_id and not item.get("origin_created_at"):
                    source = notes_by_id.get(source_id)
                    if source is not None:
                        item["origin_created_at"] = source.metadata.get("origin_created_at") or source.metadata.get("created_at", "")
                items.append(item)
        return sorted(items, key=lambda item: (item.get("completed", False), self.todo_order(item), item.get("created_at", "")))

    def todo_order(self, item: dict[str, Any]) -> int:
        try:
            return int(item.get("order", 1_000_000))
        except (TypeError, ValueError):
            return 1_000_000

    def next_todo_order(self, target_date: str) -> int:
        orders = []
        for note in self.list_notes("todo"):
            if note.metadata.get("deleted") is not True and note.metadata.get("date") == target_date:
                orders.append(self.todo_order(note.metadata))
        return max(orders, default=-1) + 1

    def update_todo(self, todo_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("todo", todo_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        for key, value in updates.items():
            if value is not None:
                metadata[key] = value
        title = str(metadata.get("title", "todo"))
        body = note.body
        if ("note" in updates and updates["note"] is not None) or ("title" in updates and updates["title"] is not None):
            body = body_with_replaced_content(note.body, title, updates.get("note") if updates.get("note") is not None else todo_body_content(note.body))
        fields = [key for key, value in updates.items() if value is not None]
        updated = self.write("todo", title, metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()
        if "completed" in updates and updates["completed"] is not None:
            self.sync_related_todo_completion(str(metadata.get("id", todo_id)), bool(updates["completed"]))
        return updated

    def related_todo_notes(self, todo_id: str) -> list[Note]:
        notes = [note for note in self.list_notes("todo") if note.metadata.get("deleted") is not True]
        id_to_note = {str(note.metadata.get("id")): note for note in notes if note.metadata.get("id")}
        related_ids = {todo_id}
        changed = True
        while changed:
            changed = False
            for note in notes:
                note_id = str(note.metadata.get("id", ""))
                source_id = str(note.metadata.get("source_id", "") or "")
                rolled_over_to = str(note.metadata.get("rolled_over_to", "") or "")
                if not note_id:
                    continue
                linked = note_id in related_ids or source_id in related_ids or rolled_over_to in related_ids
                if linked and note_id not in related_ids:
                    related_ids.add(note_id)
                    changed = True
                if linked and source_id and source_id not in related_ids:
                    related_ids.add(source_id)
                    changed = True
                if linked and rolled_over_to and rolled_over_to not in related_ids:
                    related_ids.add(rolled_over_to)
                    changed = True
        return [note for note_id, note in id_to_note.items() if note_id in related_ids]

    def sync_related_todo_completion(self, todo_id: str, completed: bool) -> None:
        for related in self.related_todo_notes(todo_id):
            related_id = str(related.metadata.get("id", ""))
            if related_id == todo_id or related.metadata.get("completed") is completed:
                continue
            metadata = dict(related.metadata)
            metadata["completed"] = completed
            title = str(metadata.get("title", "todo"))
            self.write("todo", title, metadata, related.body, related.path, log_action="수정", log_fields=["completed"])

    def delete_todo(self, todo_id: str) -> dict[str, Any] | None:
        note = self.find_by_id("todo", todo_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        deleted_at = datetime.now().isoformat(timespec="seconds")
        metadata["deleted"] = True
        metadata["deleted_at"] = deleted_at
        title = str(metadata.get("title", "todo"))
        return self.write("todo", title, metadata, note.body, note.path, log_action="삭제").as_dict()

    def reorder_todos(self, todo_ids: list[str]) -> list[dict[str, Any]]:
        updated = []
        for index, todo_id in enumerate(todo_ids):
            note = self.find_by_id("todo", todo_id)
            if note is None or note.metadata.get("deleted") is True:
                continue
            metadata = dict(note.metadata)
            metadata["order"] = index
            title = str(metadata.get("title", "todo"))
            updated.append(self.write("todo", title, metadata, note.body, note.path).as_dict())
        return updated

    def rollover_todos(self, target_date: date) -> list[dict[str, Any]]:
        rolled = []
        for note in self.list_notes("todo"):
            if note.metadata.get("deleted") is True:
                continue
            todo_date = parse_iso_date(note.metadata.get("date"))
            if not todo_date or todo_date >= target_date:
                continue
            if note.metadata.get("completed") is True or note.metadata.get("rolled_over_to"):
                continue
            data = {
                "title": note.metadata.get("title", "Todo"),
                "date": target_date,
                "project_id": note.metadata.get("project_id") or "",
                "priority": note.metadata.get("priority", "normal"),
                "note": note.body.replace(f"# {note.metadata.get('title', 'Todo')}", "", 1).strip(),
                "order": note.metadata.get("order"),
                "origin_created_at": note.metadata.get("origin_created_at") or note.metadata.get("created_at", ""),
                "source_id": note.metadata.get("id", ""),
            }
            new_note = self.create_todo(data)
            note.metadata["rolled_over_to"] = new_note["id"]
            self.write("todo", str(note.metadata.get("title", "Todo")), note.metadata, note.body, note.path, log_action="자동 이월", log_fields=["rolled_over_to"])
            rolled.append(new_note)
        return rolled

    def create_project(self, data: dict[str, Any]) -> dict[str, Any]:
        goals = data.get("goals", [])
        links = data.get("links", [])
        company_name = data.get("company_name") or ""
        body = [
            f"# {data['name']}",
            "",
            f"회사명: {company_name}" if company_name else "",
            "",
            data.get("summary", "").strip(),
            "",
            "## Goals",
            *[f"- {goal}" for goal in goals],
            "",
            "## Links",
            *[f"- {link}" for link in links],
        ]
        metadata = {
            "name": data["name"],
            "company_name": company_name,
            "owner": data.get("owner") or "",
            "status": data.get("status", "active"),
            "start_date": str(data.get("start_date") or ""),
            "end_date": str(data.get("end_date") or ""),
            "goals": goals,
            "links": links,
        }
        return self.write("project", data["name"], metadata, "\n".join(body), log_action="등록").as_dict()

    def list_projects(self) -> list[dict[str, Any]]:
        items = [note.as_dict() for note in self.list_notes("project")]
        return sorted(items, key=lambda item: (item.get("company_name", ""), item.get("name", "")))

    def update_project(self, project_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("project", project_id)
        if note is None:
            return None
        metadata = dict(note.metadata)
        for key, value in updates.items():
            if value is not None:
                metadata[key] = str(value) if isinstance(value, date) else value
        name = str(metadata.get("name", "project"))
        summary = updates.get("summary")
        if summary is None:
            should_refresh_body_header = bool({"name", "company_name"} & set(updates))
            if should_refresh_body_header:
                body = project_body_with_metadata(note.body, name, str(metadata.get("company_name") or ""))
            else:
                body = note.body
        else:
            company_name = str(metadata.get("company_name") or "").strip()
            content_parts = [f"회사명: {company_name}" if company_name else "", str(summary).strip()]
            content = "\n\n".join([part for part in content_parts if part])
            body = body_with_replaced_content(note.body, name, content)
        fields = [key for key, value in updates.items() if value is not None]
        return self.write("project", name, metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()

    def create_meeting(self, data: dict[str, Any]) -> dict[str, Any]:
        attendees = data.get("attendees", [])
        project_id = data.get("project_id") or ""
        body = self.meeting_body(data)
        metadata = {
            "title": data["title"],
            "date": str(data["date"]),
            "project_id": project_id,
            "start_time": data.get("start_time") or "",
            "attendees": attendees,
            "images": data.get("images", []),
        }
        return self.write("meeting", data["title"], metadata, body, log_action="등록").as_dict()

    def list_meetings(self, project_id: str | None = None) -> list[dict[str, Any]]:
        items = [note.as_dict() for note in self.list_notes("meeting") if note.metadata.get("deleted") is not True]
        if project_id is not None:
            items = [item for item in items if item.get("project_id") == project_id]
        return sorted(items, key=lambda item: (item.get("date", ""), item.get("start_time", ""), item.get("created_at", "")), reverse=True)

    def update_meeting(self, meeting_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("meeting", meeting_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        for key in ["title", "date", "project_id", "start_time", "attendees", "images"]:
            if key in updates and updates[key] is not None:
                metadata[key] = str(updates[key]) if isinstance(updates[key], date) else updates[key]
        title = str(metadata.get("title", "meeting"))
        body = note.body
        if any(key in updates for key in ["agenda", "notes", "attendees", "title"]):
            payload = {
                "title": title,
                "attendees": metadata.get("attendees", []),
                "agenda": updates.get("agenda", self.meeting_section(note.body, "안건")),
                "notes": updates.get("notes", self.meeting_section(note.body, "회의 내용")),
            }
            body = self.meeting_body(payload)
        fields = [key for key, value in updates.items() if value is not None]
        return self.write("meeting", title, metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()

    def delete_meeting(self, meeting_id: str) -> dict[str, Any] | None:
        note = self.find_by_id("meeting", meeting_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        metadata["deleted"] = True
        metadata["deleted_at"] = datetime.now().isoformat(timespec="seconds")
        title = str(metadata.get("title", "meeting"))
        return self.write("meeting", title, metadata, note.body, note.path, log_action="삭제").as_dict()

    def meeting_body(self, data: dict[str, Any]) -> str:
        attendees = data.get("attendees", [])
        return "\n".join(
            [
                f"# {data['title']}",
                "",
                "## 참석자",
                *[f"- {person}" for person in attendees],
                "",
                "## 안건",
                data.get("agenda", "").strip(),
                "",
                "## 회의 내용",
                data.get("notes", "").strip(),
            ]
        )

    def meeting_section(self, body: str, heading: str) -> str:
        content, _ = split_change_log(body)
        match = re.search(rf"(?ms)^## {re.escape(heading)}\s*(.*?)(?=^## |\Z)", content)
        if not match:
            return ""
        return match.group(1).strip()

    def create_project_record(self, data: dict[str, Any]) -> dict[str, Any]:
        project_id = data.get("project_id") or ""
        body = f"# {data['title']}\n\n{data.get('content', '').strip()}"
        metadata = {
            "title": data["title"],
            "project_id": project_id,
            "images": data.get("images", []),
        }
        return self.write("project_record", data["title"], metadata, body, log_action="등록").as_dict()

    def list_project_records(self, project_id: str | None = None) -> list[dict[str, Any]]:
        items = [note.as_dict() for note in self.list_notes("project_record") if note.metadata.get("deleted") is not True]
        if project_id is not None:
            items = [item for item in items if item.get("project_id") == project_id]
        return sorted(items, key=lambda item: (item.get("updated_at", ""), item.get("title", "")), reverse=True)

    def update_project_record(self, record_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("project_record", record_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        for key in ["title", "project_id", "images"]:
            if key in updates and updates[key] is not None:
                metadata[key] = updates[key]
        title = str(metadata.get("title", "record"))
        body = note.body
        if "content" in updates and updates["content"] is not None:
            body = body_with_replaced_content(note.body, title, str(updates["content"]))
        elif "title" in updates and updates["title"] is not None:
            content = re.sub(r"^# .*(\r?\n)+", "", split_change_log(note.body)[0]).strip()
            body = body_with_replaced_content(note.body, title, content)
        fields = [key for key, value in updates.items() if value is not None]
        return self.write("project_record", title, metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()

    def delete_project_record(self, record_id: str) -> dict[str, Any] | None:
        note = self.find_by_id("project_record", record_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        metadata["deleted"] = True
        metadata["deleted_at"] = datetime.now().isoformat(timespec="seconds")
        title = str(metadata.get("title", "record"))
        return self.write("project_record", title, metadata, note.body, note.path, log_action="삭제").as_dict()

    def create_wiki_page(self, data: dict[str, Any]) -> dict[str, Any]:
        project_id = data.get("project_id") or ""
        body = f"# {data['title']}\n\n{data.get('content', '').strip()}"
        metadata = {
            "title": data["title"],
            "project_id": project_id,
            "category": data.get("category") or "General",
            "tags": data.get("tags", []),
            "images": data.get("images", []),
        }
        return self.write("wiki_page", data["title"], metadata, body, log_action="등록").as_dict()

    def list_wiki_pages(self, project_id: str | None = None) -> list[dict[str, Any]]:
        items = [note.as_dict() for note in self.list_notes("wiki_page") if note.metadata.get("deleted") is not True]
        if project_id is not None:
            items = [item for item in items if item.get("project_id") == project_id]
        return sorted(items, key=lambda item: (item.get("updated_at", ""), item.get("title", "")), reverse=True)

    def update_wiki_page(self, page_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        note = self.find_by_id("wiki_page", page_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        for key in ["title", "project_id", "category", "tags", "images"]:
            if key in updates and updates[key] is not None:
                metadata[key] = updates[key]
        title = str(metadata.get("title", "wiki"))
        body = note.body
        if "content" in updates and updates["content"] is not None:
            body = body_with_replaced_content(note.body, title, str(updates["content"]))
        elif "title" in updates and updates["title"] is not None:
            body = body_with_replaced_content(note.body, title, re.sub(r"^# .*(\r?\n)+", "", split_change_log(note.body)[0]).strip())
        fields = [key for key, value in updates.items() if value is not None]
        return self.write("wiki_page", title, metadata, body, note.path, log_action="수정", log_fields=fields).as_dict()

    def delete_wiki_page(self, page_id: str) -> dict[str, Any] | None:
        note = self.find_by_id("wiki_page", page_id)
        if note is None or note.metadata.get("deleted") is True:
            return None
        metadata = dict(note.metadata)
        metadata["deleted"] = True
        metadata["deleted_at"] = datetime.now().isoformat(timespec="seconds")
        title = str(metadata.get("title", "wiki"))
        return self.write("wiki_page", title, metadata, note.body, note.path, log_action="삭제").as_dict()

    def weekly_report(self, week_start: date) -> dict[str, Any]:
        week_end = week_start + timedelta(days=6)
        todos = []
        for note in self.list_notes("todo"):
            if note.metadata.get("deleted") is True:
                continue
            todo_date = parse_iso_date(note.metadata.get("date"))
            if todo_date and week_start <= todo_date <= week_end:
                todos.append(note.as_dict())
        tasks = []
        for note in self.list_notes("work_task"):
            start = parse_iso_date(note.metadata.get("start_date"))
            end = parse_iso_date(note.metadata.get("end_date"))
            if start and end and start <= week_end and end >= week_start:
                tasks.append(note.as_dict())
        completed = [item for item in todos if item.get("completed") is True]
        pending = [item for item in todos if item.get("completed") is not True]
        lines = [
            f"# Weekly Report {week_start.isoformat()} - {week_end.isoformat()}",
            "",
            "## Summary",
            f"- Completed todos: {len(completed)}",
            f"- Pending or rolled todos: {len(pending)}",
            f"- Active task bars: {len(tasks)}",
            "",
            "## Completed",
            *[f"- [{item.get('date')}] {item.get('title')}" for item in completed],
            "",
            "## Pending",
            *[f"- [{item.get('date')}] {item.get('title')}" for item in pending],
            "",
            "## Task Timeline",
            *[
                f"- {item.get('title')} ({item.get('start_date')} -> {item.get('end_date')}, {item.get('status')})"
                for item in tasks
            ],
        ]
        metadata = {
            "title": f"Weekly Report {week_start.isoformat()}",
            "week_start": week_start.isoformat(),
            "week_end": week_end.isoformat(),
        }
        note = self.write("report", metadata["title"], metadata, "\n".join(lines))
        return note.as_dict()

    def dashboard(self, target_date: date) -> dict[str, Any]:
        self.rollover_todos(target_date)
        tomorrow = target_date + timedelta(days=1)
        todos = self.list_todos(target_date)
        events = self.list_calendar_events(target_date=target_date)
        tomorrow_events = self.list_calendar_events(target_date=tomorrow)
        all_meetings = self.list_meetings()
        meetings = sorted(
            [meeting for meeting in all_meetings if meeting.get("date") == target_date.isoformat()],
            key=lambda item: (item.get("start_time", ""), item.get("title", "")),
        )
        tomorrow_meetings = sorted(
            [meeting for meeting in all_meetings if meeting.get("date") == tomorrow.isoformat()],
            key=lambda item: (item.get("start_time", ""), item.get("title", "")),
        )
        tasks = self.list_tasks()
        active_tasks = [
            task
            for task in tasks
            if task.get("status") not in {"done"} and str(task.get("start_date", "")) <= target_date.isoformat() <= str(task.get("end_date", "9999-12-31"))
        ]
        projects = [project for project in self.list_projects() if project.get("status") == "active"]
        absences = self.dashboard_absences(events)
        tomorrow_absences = self.dashboard_absences(tomorrow_events)
        absence_people = {item.get("person") for item in absences if item.get("person") and item.get("person") != "대상 미지정"}
        tomorrow_absence_people = {item.get("person") for item in tomorrow_absences if item.get("person") and item.get("person") != "대상 미지정"}
        return {
            "date": target_date.isoformat(),
            "tomorrow": tomorrow.isoformat(),
            "counts": {
                "todos_total": len(todos),
                "todos_done": len([todo for todo in todos if todo.get("completed") is True]),
                "events_today": len(events),
                "events_tomorrow": len(tomorrow_events),
                "meetings_today": len(meetings),
                "meetings_tomorrow": len(tomorrow_meetings),
                "absence_people": len(absence_people) if absence_people else len(absences),
                "absence_people_tomorrow": len(tomorrow_absence_people) if tomorrow_absence_people else len(tomorrow_absences),
                "absence_events": len({item.get("event_id") for item in absences if item.get("event_id")}),
                "absence_events_tomorrow": len({item.get("event_id") for item in tomorrow_absences if item.get("event_id")}),
                "active_tasks": len(active_tasks),
                "active_projects": len(projects),
            },
            "today": {
                "date": target_date.isoformat(),
                "events": events,
                "absences": absences,
                "meetings": meetings,
            },
            "tomorrow_day": {
                "date": tomorrow.isoformat(),
                "events": tomorrow_events,
                "absences": tomorrow_absences,
                "meetings": tomorrow_meetings,
            },
            "todos": todos,
            "events": events,
            "tomorrow_events": tomorrow_events,
            "absences": absences,
            "tomorrow_absences": tomorrow_absences,
            "meetings": meetings,
            "tomorrow_meetings": tomorrow_meetings,
            "active_tasks": active_tasks,
            "projects": projects,
        }


vault = ObsidianVault()
