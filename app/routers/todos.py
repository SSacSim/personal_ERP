from datetime import date, timedelta
import textwrap

from fastapi import APIRouter, HTTPException, Query

from app.models import TodoCreate, TodoReorder, TodoUpdate
from app.storage import parse_iso_date, vault
from app.vault_answer import answer_with_codex_sdk


router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.get("")
def list_todos(target_date: date | None = Query(default=None, alias="date")):
    day = target_date or date.today()
    vault.rollover_todos(day)
    return {"items": vault.list_todos(day)}


@router.post("", status_code=201)
def create_todo(payload: TodoCreate):
    return vault.create_todo(payload.model_dump())


@router.patch("/{todo_id}")
def update_todo(todo_id: str, payload: TodoUpdate):
    updated = vault.update_todo(todo_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return updated


@router.delete("/{todo_id}")
def delete_todo(todo_id: str):
    deleted = vault.delete_todo(todo_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return {"deleted": True, "item": deleted}


@router.post("/reorder")
def reorder_todos(payload: TodoReorder):
    return {"items": vault.reorder_todos(payload.ids)}


@router.post("/rollover")
def rollover_todos(target_date: date | None = Query(default=None, alias="date")):
    day = target_date or date.today()
    return {"items": vault.rollover_todos(day)}


@router.post("/weekly-report")
def create_weekly_report(week_start: date | None = None):
    today = date.today()
    start = week_start or default_report_week_start(today)
    summary, mode, codex_error = summarize_weekly_report(start)
    report = vault.weekly_report(start, codex_summary=summary)
    report["mode"] = mode
    report["codex_error"] = codex_error
    report["basis"] = "이번주" if start == today - timedelta(days=today.weekday()) else "지난주"
    report["week_start"] = start.isoformat()
    report["week_end"] = (start + timedelta(days=6)).isoformat()
    return report


def default_report_week_start(today: date) -> date:
    this_monday = today - timedelta(days=today.weekday())
    if today.weekday() >= 5:
        return this_monday
    return this_monday - timedelta(days=7)


def summarize_weekly_report(week_start: date) -> tuple[str | None, str, str]:
    context = weekly_report_context(week_start)
    prompt = textwrap.dedent(
        f"""
        너는 회사 내부 ERP의 Obsidian LLM Wiki를 읽고 주간 TODO 보고서를 정리하는 한국어 어시스턴트다.
        현재 작업 디렉터리의 vault 폴더는 Obsidian 저장소이며, 필요하면 read-only로 관련 Markdown 노트를 확인해도 된다.

        기준:
        - 아래 TODO CONTEXT는 이미 보고서 기준 주차로 필터링되고, 이월된 같은 TODO는 하나의 업무로 통합된 목록이다.
        - 월~금에 생성하면 지난주 TODO, 토~일에 생성하면 이번주 TODO를 기준으로 삼는다. 이 기준 주차 계산은 서버가 이미 적용했다.
        - TODO 목록을 주 근거로 삼고, vault/Wiki, vault/Projects, vault/Meetings, vault/Tasks의 관련 노트는 보조 맥락으로만 활용한다.
        - 확인되지 않는 내용은 만들지 않는다.

        출력 형식:
        요약
        * 핵심 진행상황 2~4개

        완료한 일
        * 완료된 TODO를 업무 단위로 묶어서 정리

        미완료 / 이월
        * 남은 TODO와 다음에 볼 일을 정리

        다음 액션
        * 바로 이어서 처리할 항목 1~4개

        규칙:
        - Markdown heading은 쓰지 말고 위 섹션명과 "* " bullet만 사용한다.
        - 노트 경로, 파일 경로, JSON, 코드블록은 쓰지 않는다.
        - 장황한 설명 없이 깔끔하게 쓴다.

        TODO CONTEXT:
        {context}
        """
    ).strip()
    answer = answer_with_codex_sdk(prompt)
    if not answer:
        return None, "vault_search", ""
    if answer.startswith("Codex Python SDK 실행 실패"):
        return None, "codex_sdk_error", answer
    return answer, "codex_sdk", ""


def weekly_report_context(week_start: date) -> str:
    week_end = week_start + timedelta(days=6)
    lines = [f"week: {week_start.isoformat()} ~ {week_end.isoformat()}"]
    todo_groups = vault.weekly_todo_groups(week_start, week_end)
    if not todo_groups:
        lines.append("TODO: none")
    for item in todo_groups:
        status = "완료" if item.get("completed") is True else "미완료"
        detail = str(item.get("detail") or "").replace("\n", " / ").strip()
        detail_text = f" | detail: {detail[:320]}" if detail else ""
        rollover_text = f" | rollover_dates: {', '.join(item.get('dates') or [])}" if int(item.get("count") or 1) > 1 else ""
        lines.append(
            f"- date: {item.get('date_label', '')} | status: {status} | title: {item.get('title', '')}{rollover_text}{detail_text}"
        )

    task_lines = []
    for note in vault.list_notes("work_task"):
        if note.metadata.get("deleted") is True:
            continue
        start = parse_iso_date(note.metadata.get("start_date"))
        end = parse_iso_date(note.metadata.get("end_date"))
        if start and end and start <= week_end and end >= week_start:
            task_lines.append(
                f"- {note.metadata.get('title', '')} | {note.metadata.get('status', '')} | {start.isoformat()} ~ {end.isoformat()}"
            )
    if task_lines:
        lines.append("")
        lines.append("overlapping task bars:")
        lines.extend(task_lines[:20])
    return "\n".join(lines)
