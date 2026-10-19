"""Shared, structured work manuals stored as readable Markdown notes."""
from datetime import datetime, timedelta, timezone
from threading import RLock
from uuid import uuid4

from app.storage import ObsidianVault, render_note, slugify


KST = timezone(timedelta(hours=9))
LOCK = RLock()
SECTIONS = [
    {"key": "purpose", "title": "목적과 완료 기준", "required": True,
     "hint": "왜 이 업무를 하는지, 어떤 결과물이 나오면 완료인지 적으세요.", "placeholder": "예: 매월 사용한 법인카드 내역과 증빙을 대조해 정산 자료를 제출한다."},
    {"key": "scope", "title": "적용 범위와 담당 역할", "required": True,
     "hint": "적용 대상·진행 시점·담당자·검토자·승인자를 구분하세요.", "placeholder": "대상: / 수행 시점: / 담당: / 검토·승인: / 제외 대상:"},
    {"key": "preparation", "title": "사전 준비", "required": False,
     "hint": "필요한 시스템 권한, 입력 자료, 파일 위치와 선행 업무를 적으세요.", "placeholder": "필요 권한: / 준비 자료: / 자료 위치: / 시작 전 확인:"},
    {"key": "procedure", "title": "단계별 업무 절차", "required": True,
     "hint": "한 단계에 한 행동씩, 담당자 → 화면·경로 → 입력·실행 → 예상 결과 순으로 작성하세요.", "placeholder": "1. [담당자] [시스템 > 메뉴]에서 [입력값]을 입력하고 [실행]한다.\n   확인할 결과: ...\n2. 다음 행동과 확인할 결과를 적는다."},
    {"key": "checklist", "title": "완료 확인 체크리스트", "required": True,
     "hint": "다른 동료도 동일하게 판정할 수 있도록 확인 항목과 증빙 위치를 적으세요.", "placeholder": "- 원본 자료와 처리 결과의 건수·금액이 일치한다.\n- 검토·승인 결과를 확인했다.\n- 결과물을 지정 위치에 보관하고 담당자에게 전달했다."},
    {"key": "exceptions", "title": "예외와 문제 대응", "required": False,
     "hint": "문제 상황별 판단 기준, 중단·복구 절차와 문의 대상을 적으세요.", "placeholder": "상황: / 확인할 사항: / 조치 또는 중단 기준: / 문의 대상:"},
    {"key": "references", "title": "관련 자료와 참고 링크", "required": False,
     "hint": "공식 사내 규정, 서식, 관련 매뉴얼의 링크·버전·확인일을 적으세요.", "placeholder": "자료명: / 링크 또는 보관 위치: / 버전·확인일:"},
]
GUIDELINES = [
    {"title": "한 매뉴얼에 한 업무", "text": "제목은 ‘월말 법인카드 정산하기’처럼 대상과 행동이 드러나게 씁니다. 여러 업무는 나누고 관련 자료로 연결하세요."},
    {"title": "처음 맡은 동료가 따라 할 수 있게", "text": "약어는 풀어 쓰고 필요한 권한·시작 조건·시스템 메뉴 경로를 명시하세요. ‘적절히 처리’ 대신 실제 입력값과 판단 기준을 적으세요."},
    {"title": "행동과 확인 결과를 한 쌍으로", "text": "각 단계에 수행 주체, 화면 위치, 입력·실행할 행동, 예상 결과를 씁니다. 화면 예시가 필요하면 민감 정보를 가린 자료의 위치를 함께 적으세요."},
    {"title": "완료를 확인할 수 있게", "text": "산출물, 대조할 수치, 검토·승인 대상, 결과물 보관 위치를 체크리스트에 적으세요. 필요한 항목이 없으면 해당 없음을 명시하세요."},
    {"title": "예외 상황의 다음 행동까지", "text": "오류·누락·권한 부족 시 무엇을 확인하고 언제 멈추며 누구에게 문의할지 적으세요. 승인 없이 진행하면 안 되는 단계도 표시하세요."},
    {"title": "비밀번호와 개인정보는 넣지 않기", "text": "실제 비밀번호, 인증키, 고객·직원 개인정보 대신 가린 예시를 사용하세요. 필요한 원본 자료는 접근 권한이 설정된 사내 보관 위치로 연결하세요."},
    {"title": "실제 업무로 검증한 뒤 공유", "text": "작성 중 상태에서 실제 절차를 따라 확인하고, 가능하면 다른 동료의 검토를 받으세요. 확인되지 않은 내용은 표시하고 사내 규정·승인 절차의 최신 기준을 확인하세요."},
    {"title": "담당자와 다음 검토일을 정하기", "text": "업무 변경 시 즉시 갱신하고 정기 검토 시에도 내용을 확인하세요. 수정 이유와 변경 범위를 남기고 다음 검토일을 갱신하세요. 변경이 없으면 그 사실을 변경 요약에 기록하세요."},
]
REVIEW_CYCLES = [{"days": days, "label": label} for days, label in (
    (30, "매월 · 30일"), (90, "분기 · 90일"), (180, "반기 · 180일"), (365, "매년 · 365일"))]


class ManualConflict(ValueError):
    pass


def list_manuals(vault: ObsidianVault):
    items = [manual_dict(note) for note in vault.list_notes("manual")]
    return sorted(items, key=lambda item: (item["updated_at"], item["id"]), reverse=True)


def manual_dict(note):
    item = note.as_dict()
    for key in ("version", "review_cycle_days"):
        item[key] = int(item[key])
    return item


def save_manual(vault: ObsidianVault, data: dict, user: dict, manual_id: str | None = None):
    with LOCK:
        previous = vault.find_by_id("manual", manual_id) if manual_id else None
        if manual_id and previous is None:
            return None
        if previous and data["version"] != int(previous.metadata["version"]):
            raise ManualConflict("다른 사용자가 먼저 수정했습니다. 작성 내용은 유지됩니다. 최신 매뉴얼을 확인한 뒤 내용을 반영해 주세요.")
        now = datetime.now(KST)
        metadata = dict(previous.metadata) if previous else {"id": uuid4().hex, "created_at": now.isoformat(timespec="seconds"), "created_by": user["name"]}
        for key in ("title", "category", "owner", "status", "review_cycle_days", "sections"):
            metadata[key] = data[key]
        metadata["type"] = "manual"
        metadata["version"] = int(metadata.get("version", 0)) + 1
        metadata["updated_at"] = now.isoformat(timespec="seconds")
        metadata["updated_by"] = user["name"]
        metadata["next_review_date"] = (data.get("next_review_date") or (now.date() + timedelta(days=data["review_cycle_days"]))).isoformat()
        if data["status"] == "published":
            metadata["last_reviewed_date"] = now.date().isoformat()
        entry = {"version": metadata["version"], "date": metadata["updated_at"], "author": user["name"],
                 "summary": data.get("change_summary") or "매뉴얼 최초 작성"}
        metadata["revision_history"] = [entry, *metadata.get("revision_history", [])]
        status_label = {"draft": "작성 중", "published": "사용 중", "archived": "보관"}[metadata["status"]]
        lines = [f'# {metadata["title"]}', "", f'담당: {metadata["owner"]} · 상태: {status_label} · 버전: {metadata["version"]}',
                 f'검토 주기: {metadata["review_cycle_days"]}일 · 다음 검토일: {metadata["next_review_date"]}']
        for index, section in enumerate(SECTIONS, 1):
            lines.extend(["", f'## {index}. {section["title"]}', "", metadata["sections"].get(section["key"]) or "아직 작성되지 않았습니다."])
        lines.extend(["", "## 변경 로그", ""])
        for revision in metadata["revision_history"]:
            summary = revision["summary"].replace("\n", " ")
            lines.append(f'- v{revision["version"]} · {revision["date"]} · {revision["author"]}: {summary}')
        path = previous.path if previous else vault.folder_for("manual") / f'{now.date()}-{slugify(metadata["title"], "manual")}-{metadata["id"][:8]}.md'
        temporary = path.with_suffix(".tmp")
        try:
            temporary.write_text(render_note(metadata, "\n".join(lines)), encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return manual_dict(vault.read(path))
