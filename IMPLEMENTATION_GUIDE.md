# next_ui Containerlab API 구현 가이드

## 개요

이 문서는 현재 코드 기준(2026-03-30)으로 정리된 구현 가이드입니다.
프로젝트는 다음 2가지를 동시에 만족하도록 설계되어 있습니다.

- 프론트엔드(`main_api_v2.html`, `next_app_v2.js`)는 API 중심으로 동작
- 백엔드는 Mock/Real 모드를 전환할 수 있는 `ClabAPIClient` 구조 제공

핵심 포인트는 다음과 같습니다.

- 기본 모드는 Mock (`USE_MOCK_API=true`)
- 토폴로지 편집 기능(노드/링크 추가, 노드 삭제, YAML Export)이 프론트에 구현됨
- 노드 좌표(layout) 서버 저장 + 브라우저 localStorage fallback 지원

---

## 현재 디렉터리 기준 핵심 구성

```text
containerlab_designer/
├── api/
│   └── main.py                 # FastAPI 앱, API 라우트, 정적 파일 서빙
├── app_modules/
│   ├── remote_session_manager.js   # 원격 인증/토큰/폴링 모듈
│   ├── interaction_controller.js   # 전역 리스너/배경 팬 모듈
│   └── render_helpers.js           # kind-image/deploy access 테이블 렌더 모듈
├── clab/
│   ├── api_client.py           # Mock/Real 분기 클라이언트
│   ├── mock_server.py          # Mock 동작/샘플 데이터
│   └── node_layouts.json       # (런타임 생성) 레이아웃 저장 파일
├── models/
│   └── topology.py             # Pydantic 모델
├── main_api_v2.html            # UI(콘트롤 패널 + topology canvas)
├── next_app_v2.js              # 프론트 코어 로직(API 호출/편집/내보내기)
├── QUICKSTART.md               # 빠른 실행 가이드
└── IMPLEMENTATION_GUIDE.md     # 본 문서
```

---

## 백엔드 아키텍처

### 1) FastAPI 앱 (`api/main.py`)

역할:

- API 엔드포인트 제공 (`/api/clab/...`)
- 상태 확인 (`/health`)
- 루트(`/`)를 UI로 리다이렉트
- 프로젝트 루트를 정적 파일로 마운트

구현 포인트:

- CORS 허용(`allow_origins=["*"]`)
- `get_api_client()`에서 최초 1회 클라이언트 생성
- `USE_MOCK_API` 환경변수로 Mock/Real 결정

### 2) API 클라이언트 (`clab/api_client.py`)

`ClabAPIClient`는 동일한 메서드 인터페이스로 두 모드를 지원합니다.

- Mock: `MockClabServer` 메서드 직접 호출
- Real: `httpx.AsyncClient`로 clab API 호출

주요 메서드:

- `get_images()`, `get_version()`
- `deploy_lab()`, `list_labs()`, `inspect_lab()`, `destroy_lab()`
- `exec_node()`, `save_node_config()`, `get_node_logs()`
- `get_graph()`

### 2) 원격 세션 모듈 (`app_modules/remote_session_manager.js`)

`createRemoteSessionManager(deps)` 팩토리 패턴으로 생성됩니다.

- `connect(url, password)` → `/api/tester/login` 프록시 호출 후 JWT 저장
- `startPolling()` / `stopPolling()` → 주기적 lab 상태 폴링
- 토큰 자동 갱신 (`loginAndStoreToken`) 포함
- 원격 요청은 `/api/tester/request` 프록시를 경유

### 3) 개발 서버 (`clab/mock_server.py`)

역할:

- 컨테이너 없이 개발 가능한 샘플 동작 제공
- 3노드 토폴로지/링크/명령 출력/로그/그래프 응답 생성

샘플 토폴로지 성격:

- 코어 라우터 2 + 디스트리뷰션 스위치 1
- mgmt IP, ssh port, container_id 같은 런타임 정보 자동 생성

### 4) 데이터 모델 (`models/topology.py`)

핵심 모델:

- `TopologySpec`, `Node`, `Link`, `Interface`
- `RuntimeLabState`, `RuntimeNodeInfo`
- `ImageInfo`, `VersionInfo`
- `DeviceRole`, `LinkType`, `LinkState`, `LabState`

---

## 프론트엔드 아키텍처

### 1) UI 파일 (`main_api_v2.html`)

컨트롤 영역:

- Lab Control: Deploy / Destroy / Refresh
- Topology Editor: Lab name / New / + Node / YAML
- Node Control: Command
- Developer: Toggle Debug HitTest / API Docs / Health

캔버스 및 모달:

- topology 렌더 영역
- 노드 컨텍스트 메뉴(우클릭): Add Link / Delete Node / SSH Connect
- Add Node 모달
- YAML Export 모달
- Link Interface 선택 모달

### 2) 로직 파일 (`next_app_v2.js` + `app_modules/`)

모듈 구조:

- `remote_session_manager.js` → `window.createRemoteSessionManager` 노출
- `interaction_controller.js` → `window.createInteractionController` 노출
- `render_helpers.js` → `window.NextUIRenderHelpers` 노출
- `next_app_v2.js` → 위 3개 모듈 로드 후 IIFE 실행

`next_app_v2.js` 코어 주요 동작:

- API 연동: lab 조회/배포/삭제, 노드 명령/로그/연결 정보
- 에디터: 노드 추가, 링크 추가, 노드 삭제
- YAML 생성/복사/다운로드
- 레이아웃 저장/복원

공개 함수(`window.nextUI`) 예시:

- `deployCurrentTopology()`, `destroyLab()`, `fetchTopology()`
- `openAddNodeModal()`, `addNodeFromForm()`
- `startAddLinkFromContextMenu()`, `deleteNodeFromContextMenu()`
- `openExportYAML()`, `generateYAML()`, `downloadYAML()`
- `execNodeCommand()`, `getNodeLogs()`, `connectToNode()`

---

## 데이터/호출 흐름

### 1) 초기 로드

```text
브라우저 로드
  -> next_app_v2.js fetchTopology()
  -> GET /api/clab/labs
  -> (lab 존재 시) GET /api/clab/labs/{lab_id}/graph
  -> (선택) GET /api/clab/labs/{lab_id}/layout
  -> 그래프 렌더링
```

### 2) 배포

```text
UI Deploy 버튼
  -> deployCurrentTopology()
  -> 현재 노드/링크를 TopologySpec 형태로 변환
  -> POST /api/clab/labs/deploy-yaml
  -> 응답 lab_id 저장
  -> fetchTopology() 재호출로 그래프 동기화
```

### 3) 노드 명령 실행

```text
노드 선택 + Command 버튼
  -> runSelectedNodeCommand()
  -> POST /api/clab/labs/{lab_id}/nodes/{node_name}/exec
  -> output 표시(alert)
```

### 4) 레이아웃 저장

```text
노드 이동
  -> queueSaveNodePositions()
  -> localStorage 저장
  -> PUT /api/clab/labs/{lab_id}/layout
```

---

## API 엔드포인트 (현재 구현)

### Health

- `GET /health`

### 원격 세셔 (CORS 프록시)

- `POST /api/tester/login`
- `POST /api/tester/request`

### 설정

- `GET /api/settings/kind-image-login`
- `PUT /api/settings/kind-image-login`
- `DELETE /api/settings/kind-image-login/{kind}`
- `PUT /api/settings/default-login-name`

### 정보

- `GET /api/clab/images`
- `GET /api/clab/version`

### Lab

- `POST /api/clab/labs/deploy-yaml`
- `GET /api/clab/labs`
- `GET /api/clab/labs/{lab_id}`
- `DELETE /api/clab/labs/{lab_id}`
- `GET /api/clab/labs/{lab_id}/graph`

### Node

- `POST /api/clab/labs/{lab_id}/nodes/{node_name}/exec`
- `POST /api/clab/labs/{lab_id}/nodes/{node_name}/save`
- `GET /api/clab/labs/{lab_id}/nodes/{node_name}/logs`
- `POST /api/clab/labs/{lab_id}/nodes/{node_name}/ssh`

### Layout

- `GET /api/clab/labs/{lab_id}/layout`
- `PUT /api/clab/labs/{lab_id}/layout`
- `DELETE /api/clab/labs/{lab_id}/layout`

---

## 운영 모드

### Mock 모드 (기본)

실행:

```bash
export USE_MOCK_API=true
uv run uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

특징:

- containerlab 없이 UI/API 개발 가능
- Mock lab/image/version/exec/logs 시뮬레이션

### Real 모드

실행:

```bash
export USE_MOCK_API=false
uv run uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

현재 코드 기준 제약:

- `USE_MOCK_API`는 반영됨
- `CLAB_API_BASE_URL`, `CLAB_API_TOKEN`은 아직 `create_api_client()`에 연결되어 있지 않음
- Real 모드의 기본 대상은 `http://localhost:8001`

즉, 현재는 real API 서버가 `localhost:8001`에 떠 있어야 정상 동작합니다.

---

## 개발 워크플로우 권장

### 1) Mock에서 UI/기능 개발

```bash
uv sync
export USE_MOCK_API=true
uv run uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
```

브라우저:

- `http://localhost:8000/main_api_v2.html`
- `http://localhost:8000/docs`

### 2) API 계약 점검

Swagger에서 아래를 우선 확인:

- `POST /api/clab/labs` payload/response
- `GET /api/clab/labs/{lab_id}/graph` 응답 포맷
- `POST /api/clab/labs/{lab_id}/nodes/{node_name}/exec` 응답

### 3) Real 전환 준비

- `create_api_client()`에 base URL/token 주입 로직 추가
- 인증/권한 요구사항(JWT) 정리
- 에러 코드/타임아웃 처리 표준화

---

## 트러블슈팅

### 1) UI에 아무 것도 안 보일 때

- `GET /health` 확인
- `GET /api/clab/images` 확인
- 브라우저 콘솔 네트워크 에러 확인

### 2) Command 실행이 실패할 때

- 배포 완료 후 진행했는지 확인 (`currentLabId` 필요)
- 대상 노드명과 lab_id 일치 여부 확인

### 3) 레이아웃이 복원되지 않을 때

- `clab/node_layouts.json` 파일 권한 확인
- 브라우저 localStorage 접근 가능 여부 확인

---

## 향후 개선 포인트

- Real 모드 환경변수(`CLAB_API_BASE_URL`, `CLAB_API_TOKEN`) 완전 연동
- 인증/권한 모델 추가
- DB 기반 토폴로지 영속화
- 웹 터미널 통합
- pyATS 워크플로우 통합

---

## 참고

- [QUICKSTART.md](QUICKSTART.md)
- [plan.md](plan.md)
- [api/main.py](api/main.py)
- [clab/api_client.py](clab/api_client.py)
- [clab/mock_server.py](clab/mock_server.py)
- [models/topology.py](models/topology.py)
- [main_api_v2.html](main_api_v2.html)
- [next_app_v2.js](next_app_v2.js)
