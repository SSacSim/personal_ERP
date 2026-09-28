from datetime import date, timedelta
import textwrap

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import current_user
from app.models import TodoCreate, TodoReorder, TodoUpdate
from app.storage import parse_iso_date, vault
from app.vault_answer import answer_with_codex_sdk


router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.get("")
def list_todos(target_date: date | None = Query(default=None, alias="date"), user: dict = Depends(current_user)):
    day = target_date or date.today()
    vault.rollover_todos(day, user["id"])
    return {"items": vault.list_todos(day, user["id"])}


@router.post("", status_code=201)
def create_todo(payload: TodoCreate, user: dict = Depends(current_user)):
    return vault.create_todo(payload.model_dump(), user["id"])


@router.patch("/{todo_id}")
def update_todo(todo_id: str, payload: TodoUpdate, user: dict = Depends(current_user)):
    updated = vault.update_todo(todo_id, payload.model_dump(exclude_unset=True), user["id"])
    if updated is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return updated


@router.delete("/{todo_id}")
def delete_todo(todo_id: str, user: dict = Depends(current_user)):
    deleted = vault.delete_todo(todo_id, user["id"])
    if deleted is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return {"deleted": True, "item": deleted}


@router.post("/reorder")
def reorder_todos(payload: TodoReorder, user: dict = Depends(current_user)):
    try:
        return {"items": vault.reorder_todos(payload.ids, user["id"])}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="todo not found") from exc


@router.post("/rollover")
def rollover_todos(target_date: date | None = Query(default=None, alias="date"), user: dict = Depends(current_user)):
    day = target_date or date.today()
    return {"items": vault.rollover_todos(day, user["id"])}


@router.post("/weekly-report")
def create_weekly_report(week_start: date | None = None, user: dict = Depends(current_user)):
    today = date.today()
    start = week_start or default_report_week_start(today)
    summary, mode, codex_error = summarize_weekly_report(start, user["id"])
    report = vault.weekly_report(start, user["id"], codex_summary=summary)
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


def summarize_weekly_report(week_start: date, user_id: str) -> tuple[str | None, str, str]:
    context = weekly_report_context(week_start, user_id)
    prompt = textwrap.dedent(
        f"""
        너는 회사 내부 ERP의 Obsidian LLM Wiki를 읽고 주간 TODO 보고서를 정리하는 한국어 어시스턴트다.
        아래 CONTEXT는 로그인한 사용자의 개인 기록이다. 제공된 내용만 사용한다.

        기준:
        - 아래 TODO CONTEXT는 이미 보고서 기준 주차로 필터링되고, 이월된 같은 TODO는 하나의 업무로 통합된 목록이다.
        - 월~금에 생성하면 지난주 TODO, 토~일에 생성하면 이번주 TODO를 기준으로 삼는다. 이 기준 주차 계산은 서버가 이미 적용했다.
        - TODO 목록을 주 근거로 삼고, CONTEXT에 포함된 작업 목록을 보조 맥락으로 사용한다.
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


def weekly_report_context(week_start: date, user_id: str) -> str:
    week_end = week_start + timedelta(days=6)
    lines = [f"week: {week_start.isoformat()} ~ {week_end.isoformat()}"]
    todo_groups = vault.weekly_todo_groups(week_start, week_end, user_id)
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
    for note in vault.private_notes("work_task", user_id):
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
