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
date: 2026-06-13
completed: false
project_id:
updated_at: 2026-06-13T23:00:00
---
# 노트 제목

업무 맥락과 메모
```

## LLM Wiki 원칙

- 한 업무 항목은 한 Markdown 파일로 저장합니다.
- frontmatter에는 검색과 필터링에 필요한 짧은 구조화 데이터를 둡니다.
- 본문에는 사람이 읽는 맥락, 결정 이유, 후속 작업을 기록합니다.
- 파일명보다 frontmatter의 `id`를 기준으로 연결합니다.
