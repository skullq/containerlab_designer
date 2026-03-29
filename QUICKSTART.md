# Quick Start Guide

이 문서는 현재 코드 기준(2026-03-30)으로 정리된 빠른 실행 가이드입니다.
기본 모드는 Mock API이며, UI 편집(+Node, Add Link, Delete Node, YAML Export)까지 바로 확인할 수 있습니다.

## 1. 요구 사항

- Python 3.13+
- uv

확인 예시:

```bash
python3 --version
uv --version
```

## 2. 설치

```bash
uv sync
```

## 3. 서버 실행

Mock 모드로 실행(기본값):

```bash
export USE_MOCK_API=true
uv run uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

접속 URL:

- UI: http://localhost:8000/main_api_v2.html
- Swagger: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
- Health: http://localhost:8000/health

## 4. 5분 검증 시나리오

1. UI에서 `Deploy Current Topology` 클릭
2. 헤더 상태 점 확인
- `Lab` 점이 초록색이면 배포됨
- `API` 점이 초록색이면 백엔드 API 연결됨
3. `Refresh` 클릭 후 토폴로지 유지 확인
4. 노드를 클릭하고 `Run Command`로 `show ip interface brief` 실행
5. 노드 우클릭 후 `SSH Connect` 클릭해 접속 정보 팝업 확인

## 5. 현재 동작하는 UI 기능

### Topology 편집

- `New`: 빈 토폴로지로 초기화
- `+ Node`: 노드 추가 모달
- 노드 우클릭 `Add Link`: 링크 추가
- 노드 우클릭 `Delete Node`: 노드 삭제
- `YAML`: 현재 토폴로지를 containerlab YAML로 내보내기

### Lab 제어

- `Deploy Current Topology`: 현재 그려진 노드/링크를 백엔드로 배포 요청
- `Destroy`: 현재 lab 삭제
- `Refresh`: 서버에서 lab/graph 재조회

### Node 상호작용

- 노드 클릭 후 `Run Command`
- 우클릭 `SSH Connect`
- JS 콘솔에서 직접 호출 가능:

```javascript
nextUI.execNodeCommand("core-rtr01", "show ip route").then(console.log);
nextUI.getNodeLogs("core-rtr01", 50).then(console.log);
nextUI.connectToNode("core-rtr01");
```

## 6. 레이아웃 저장 방식

노드 좌표는 자동 저장됩니다.

- 서버 저장: `PUT /api/clab/labs/{lab_id}/layout`
- 조회: `GET /api/clab/labs/{lab_id}/layout`
- 삭제: `DELETE /api/clab/labs/{lab_id}/layout`
- 로컬 fallback: `localStorage` (`next_ui.layout.<lab_id>`)

서버 측 저장 파일:

- `clab/node_layouts.json`

## 7. 주요 API 엔드포인트

### 환경/상태

- `GET /health`
- `GET /api/clab/images`
- `GET /api/clab/version`

### Lab 라이프사이클

- `POST /api/clab/labs`
- `GET /api/clab/labs`
- `GET /api/clab/labs/{lab_id}`
- `DELETE /api/clab/labs/{lab_id}`
- `GET /api/clab/labs/{lab_id}/graph`

### Node 제어

- `POST /api/clab/labs/{lab_id}/nodes/{node_name}/exec`
- `POST /api/clab/labs/{lab_id}/nodes/{node_name}/save`
- `GET /api/clab/labs/{lab_id}/nodes/{node_name}/logs?lines=100`

### Layout

- `GET /api/clab/labs/{lab_id}/layout`
- `PUT /api/clab/labs/{lab_id}/layout`
- `DELETE /api/clab/labs/{lab_id}/layout`

## 8. Real API 모드 전환 시 주의

실행:

```bash
export USE_MOCK_API=false
uv run uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

현재 코드 기준 제한 사항:

- `USE_MOCK_API`는 반영됨
- `CLAB_API_BASE_URL`, `CLAB_API_TOKEN`은 아직 `create_api_client()`에 연결되어 있지 않음
- Real 모드 base URL은 현재 `http://localhost:8001` 고정

즉, Real 모드 테스트 시 실제 clab-api-server가 `localhost:8001`에서 떠 있어야 합니다.

## 9. 트러블슈팅

### UI가 비어 보일 때

1. `http://localhost:8000/health` 확인
2. `http://localhost:8000/api/clab/images` 확인
3. 브라우저 DevTools 콘솔 에러 확인

### 노드 명령 실행이 실패할 때

- 먼저 lab이 배포되어 있어야 함 (`Deploy Current Topology` 수행)
- `currentLabId`가 없으면 exec/log API는 동작하지 않음

### 레이아웃이 유지되지 않을 때

1. `clab/node_layouts.json` 쓰기 권한 확인
2. 브라우저 localStorage 사용 가능 여부 확인

## 10. 재시작

```bash
# 서버 중지: Ctrl+C
uv run uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

## 11. 참고 문서

- 전체 설계: [plan.md](plan.md)
- 구현 상세: [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md)
