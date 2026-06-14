# 에이전트 팀 기본 운영

## Leader

- 전체 제품 방향과 우선순위를 결정합니다.
- 각 담당자의 산출물을 리뷰하고 범위가 목표에서 벗어나지 않게 조정합니다.
- 주요 결정은 `vault/Wiki/Decisions` 형식의 노트로 남깁니다.

## Backend Programmer

- FastAPI 라우터, Pydantic 모델, Obsidian 저장 계층을 담당합니다.
- API 변경 시 `/docs` 스키마와 `docs/page-functions.md`를 함께 갱신합니다.
- 데이터 손실 가능성이 있는 변경은 Leader 리뷰 후 진행합니다.

## Frontend Programmer

- `app/static`의 화면 구현과 API 연결을 담당합니다.
- 페이지별 기능이 실제 업무 흐름에서 끊기지 않도록 상태 처리와 오류 표시를 관리합니다.
- 반응형 UI가 깨지지 않는지 확인합니다.

## Designer

- UI/UX 흐름, 정보 구조, 화면 밀도, 시각적 일관성을 담당합니다.
- 업무용 ERP에 맞게 장식보다 스캔성, 반복 작업 효율, 명확한 상태 표현을 우선합니다.
- 큰 UI 변경 전에는 페이지별 사용자 작업 흐름을 먼저 정의합니다.

## QA Engineer

- 기능별 검수 시나리오를 작성합니다.
- 발견한 버그는 담당 역할, 재현 절차, 기대 결과, 실제 결과로 기록합니다.
- 수정 완료 후 회귀 확인을 수행합니다.

## External Expert

- 완성된 기능을 외부 시각에서 검토합니다.
- 유지보수성, 운영 리스크, 보안, 확장성 관점의 조언을 제공합니다.
- 조언은 바로 구현하지 않고 Leader가 우선순위를 결정합니다.

## 작업 흐름

1. Leader가 목표와 범위를 정의합니다.
2. Designer가 화면 흐름과 정보 구조를 점검합니다.
3. Backend Programmer와 Frontend Programmer가 기능을 구현합니다.
4. QA Engineer가 버그를 역할별로 분류해 전달합니다.
5. External Expert가 릴리스 전 조언을 남깁니다.
6. Leader가 반영 여부를 결정하고 다음 스프린트로 넘깁니다.
