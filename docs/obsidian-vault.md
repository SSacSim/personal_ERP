# Obsidian LLM Wiki 저장 규칙

## 폴더 구조

- `vault/Dashboard`: 대시보드 운영 노트
- `vault/Calendar`: 일정 노트
- `vault/Tasks`: 작업 타임라인 노트
- `vault/Todos`: 일별 TODO 노트
- `vault/Projects`: 프로젝트 노트
- `vault/Reports`: 주간 보고서
- `vault/Meetings`: 회의록 노트
- `vault/Wiki`: 프로젝트 목표, 운영 규칙, 의사결정 기록
- `vault/Assets`: 회의록과 Wiki 첨부 이미지

## 노트 형식

각 노트는 다음 구조를 따릅니다.

```markdown
---
id: unique-id
type: todo
user_id: authenticated-account-id
date: 2026-06-13
completed: false
project_id:
updated_at: 2026-06-13T23:00:00
---
# 노트 제목

업무 맥락과 메모
```

## LLM Wiki 원칙

`work_task`, `todo`, `report`는 개인 노트입니다. ERP에서는 로그인 계정의 `user_id`와 일치하는 기록만 조회·변경·검색합니다. 저장 폴더는 유지하며 기존 소유자 없는 기록은 admin 계정으로 한 번만 귀속합니다. 계정 분리는 ERP 접근에 적용되며 Obsidian 파일 자체는 계속 로컬 저장소에서 관리합니다.

그 외 노트는 공용입니다. 개인 노트를 원문 파일로 읽을 수 있는 Codex SDK 실행은 사용하지 않고, 상담봇과 주간 보고서는 계정별 필터를 적용한 로컬 처리로 동작합니다.

- 한 업무 항목은 한 Markdown 파일로 저장합니다.
- frontmatter에는 검색과 필터링에 필요한 짧은 구조화 데이터를 둡니다.
- 본문에는 사람이 읽는 맥락, 결정 이유, 후속 작업을 기록합니다.
- 파일명보다 frontmatter의 `id`를 기준으로 연결합니다.
