# Containerlab 확장 설계 계획 (plan)

---

## 🚀 구현 현황 (Implementation Status)

### ✅ Phase 1: Foundation & Mock (완료)

**완료 항목:**
- [x] Pydantic 데이터 모델 정의 (`models/topology.py`)
  - TopologySpec, Node, Link, Interface
  - RuntimeLabState, RuntimeNodeInfo
  - ImageInfo, VersionInfo
  
- [x] Mock 시뮬레이션 서버 (`clab/mock_server.py`)
  - Image List 시뮬레이션
  - 3-node demo topology
  - Deploy/Inspect/Exec/Save/Logs/Graph 모의
  
- [x] ClabAPIClient (`clab/api_client.py`)
  - Mock/Real 모드 선택 가능
  - 모든 API 메서드 wrapper
  - Async/await 기반
  
- [x] FastAPI 백엔드 (`api/main.py`)
  - 모든 라우트 구현
  - Swagger/ReDoc 문서화
  - CORS 설정
  
- [x] API 통합 프론트 (`next_app_v2.js`, `main_api_v2.html`)
  - 토폴로지 로드 (API)
  - Lab 배포/제거 (API)
  - 노드 명령 실행 (API)
  - 레이아웃 전환
  
- [x] 개발 문서
  - QUICKSTART.md - 5분 시작 가이드
  - IMPLEMENTATION_GUIDE.md - 상세 아키텍처

**현재 상태**: ✅ Mock 모드 완전 작동 중. HTML을 열면 바로 사용 가능.

### 📋 Phase 2: Real API Ready (구조만 준비)

**준비 완료:**
- [x] API 클라이언트 구조 (`clab/api_client.py` - Real mode branch)
- [x] Pydantic 모델 정의 완료

**미구현 (Containerlab 준비 후):**
- [ ] Real clab-api-server 연동 테스트
- [ ] JWT 인증 통합
- [ ] Error handling & retry logic

### ⏳ Phase 3: 향후 (plan.md 참고)

- [x] 토폴로지 편집 UI (노드/링크 추가, 노드 삭제, YAML Export)
- [ ] pyATS 설정 자동화
- [ ] 자연어 intent 변환
- [ ] 웹 터미널 통합
- [ ] DB 영속 저장소

### ✅ Phase 4: 코드 구조화 & 리팩터링 (완료)

**완료 항목:**
- [x] `app_modules/remote_session_manager.js` - 원격 인증/토큰/폴링 책임 분리
- [x] `app_modules/interaction_controller.js` - 전역 리스너/배경 팬 책임 분리
- [x] `app_modules/render_helpers.js` - kind-image 테이블, deploy access 테이블 렌더 분리
- [x] `AppState` 네임스페이스 도입 (`topology`, `remote`, `interaction`, `ui`)
- [x] `updateCurrentLabId()` 헬퍼로 labId 중앙화
- [x] `closeAllTopologyTooltips()`, `openTopologyNodeTooltip()` tooltip 헬퍼 함수 추가
- [x] kind-image 테이블 XSS 위험 제거 (`escapeHtml` 적용)
- [x] Logger 사용 통일 (`console.warn/error` 대신 `Logger.*`)

**현재 상태**: ✅ 정적 오류 없음. 모듈 로드 HTTP 200 확인. 자동화 엔드포인트 체크 10/10 PASS.

---

## 목표
기존 토폴로지 생성 워크플로우를 확장해서, 아래 순서를 자동화한다.

1. clab-api-server를 통해 사용 가능한 Docker 이미지 탐지
2. 라우터/스위치 노드 추가 및 링크 생성 (management 인터페이스 제외)
3. mgmt 네트워크 선언 및 배포된 lab의 상태/SSH 접속성 확인
4. 전체 연결성 기반 containerlab YAML 생성 또는 YAML payload 배포
5. lab 기동 후 토폴로지 메타데이터와 inspect 결과를 사용해 장비 설정 적용
6. pyATS 기반 자연어 -> 인터페이스/라우팅 설정 변환
7. UI 아이콘 클릭 시 장비 접속(SSH/WebTTY) 트리거

---

## 기존 next_ui 분석 및 변경 가능성 판단

### 분석 목적
기존 `next_ui`는 LLDP discovery 결과를 시각화하는 구조다. 이번 변경의 목적은 이 구조를 그대로 유지하는 것이 아니라, clab-api-server를 통해 containerlab 서버의 이미지 목록을 조회하고, 노드를 선언하고, 링크를 만들고, 최종적으로 topology YAML을 생성 또는 직접 배포하는 "토폴로지 편집 및 실행 시스템"으로 전환 가능한지를 확인하는 것이다.

### 현재 구조 요약
- 현재 백엔드 역할은 `generate_topology.py`가 담당한다.
- 이 스크립트는 Nornir/NAPALM으로 장비에 SSH 접속 후 LLDP/facts를 수집한다.
- 수집 결과는 `topology.js`, `diff_topology.js` 같은 정적 JS 파일로 생성된다.
- `main.html`, `diff_page.html`는 이 정적 파일을 로드하고, `next_app.js`는 NeXt UI로 topology를 그리는 역할만 수행한다.

즉, 현재 구조는 아래 흐름이다.

1. 실장비 discovery 수행
2. Python이 topology 데이터를 파일로 생성
3. 브라우저가 생성된 JS를 읽어 렌더링

이 구조는 "발견된 토폴로지 뷰어"에는 적합하지만, "장비를 직접 추가/삭제하고 링크를 설계하는 편집기"로는 부족하다.

### 현재 코드에서 재사용 가능한 부분

#### 1. 프론트 렌더링 계층은 재사용 가치가 높음
- NeXt UI 기반 topology 렌더링은 이미 동작 중이다.
- 노드/링크 기본 표현(`nodes`, `links`, `source`, `target`, 인터페이스 라벨)도 builder형 시스템에서 그대로 활용 가능하다.
- 아이콘 타입, 툴팁, 레이아웃 전환(horizontal/vertical), 링크 라벨 표시는 containerlab 기반 토폴로지에서도 그대로 유용하다.

즉, `next_app.js`는 "viewer"로서의 기반이 이미 있으므로 완전 폐기 대상은 아니다.

#### 2. topology 데이터 스키마의 일부는 확장 가능함
- 현재 `topology.js`의 `nodes[]`, `links[]` 구조는 시각화에 필요한 최소 데이터 모델을 갖고 있다.
- 여기에 아래 필드를 추가하면 containerlab 토폴로지 편집에도 대응할 수 있다.
  - node: `kind`, `image`, `mgmt`, `interfaces`, `startup_config`, `deployment_state`
  - link: `a_if`, `b_if`, `is_mgmt_excluded`, `link_type`, `deployment_state`

즉, "표현용 모델"은 버리지 않고 "편집/배포용 메타데이터"를 추가하는 방식이 적절하다.

### 현재 코드의 한계

#### 1. 데이터 생성 방식이 batch 기반이며 interactive editing을 지원하지 않음
- 현재 topology는 Python 실행 결과로 파일이 생성된 후에만 바뀐다.
- 브라우저에서 장비 추가/삭제/링크 연결을 해도 저장할 API나 서버 상태 저장소가 없다.

containerlab builder로 가려면 "정적 파일 생성" 구조에서 "상태 기반 API" 구조로 변경해야 한다.

#### 2. discovery 중심 로직이라 image/kind 기반 설계 개념이 없음
- 현재 노드는 LLDP/facts에서 자동 발견된다.
- 하지만 containerlab에서는 먼저 장비 종류(kind)와 image를 선택해야 하며, 그 다음 인터페이스/링크를 설계해야 한다.
- 즉, 현재의 "발견 -> 시각화" 순서를 "이미지 선택 -> 노드 선언 -> 링크 생성 -> YAML 생성 -> 배포"로 뒤집어야 한다.

#### 3. 인터페이스 풀 관리가 없음
- 현재 링크 정보는 LLDP 결과를 그대로 표시하는 수준이다.
- 어떤 포트가 관리용인지, 어떤 포트가 이미 사용 중인지, 어떤 포트를 자동 할당해야 하는지에 대한 상태 관리가 없다.

따라서 link builder 계층을 새로 만들어야 한다.

#### 4. 배포/실행/상태확인 백엔드가 없음
- 현재는 clab-api-server 또는 `containerlab deploy`, `docker images`, `docker ps`, `docker inspect`를 다루는 코드가 전혀 없다.
- 장비 접속 가능 여부, mgmt IP, SSH 포트, 컨테이너 상태를 UI에 반영할 방법도 없다.

즉, clab-api-server와 통신하는 런타임 계층이 반드시 추가되어야 한다.

#### 5. 장비 설정 자동화 계층이 없음
- 현재 Python은 topology를 수집/가공만 하고, 장비에 설정을 push하지 않는다.
- pyATS/Unicon과 연결되는 testbed 생성, 명령 적용, dry-run, diff 저장 등의 기능이 전혀 없다.

즉, post-deploy automation은 신규 기능으로 설계해야 한다.

### 결론: 변경 가능 여부

#### 판단
변경은 가능하다. 다만 "기존 코드를 조금 수정"하는 수준이 아니라, 아래와 같이 역할을 재정의해야 한다.

- 유지 대상:
  - NeXt UI 렌더링 계층
  - 현재 topology JSON/JS의 기본 노드-링크 표현 방식
  - 아이콘/툴팁/레이아웃 표시 로직

- 교체 또는 신규 구축 대상:
  - discovery 중심 Python 로직
  - 정적 topology.js 생성 방식
  - 서버 상태 저장 구조
  - clab-api-server deploy/status/inspect 연동
  - pyATS 기반 설정 자동화

즉, 이 프로젝트는 "discovery viewer"에서 "topology designer + deployment orchestrator"로 성격이 바뀐다.

### 권장 전환 방향

#### 방향 1. 렌더러는 유지하고 데이터 공급 방식을 교체
- `next_app.js`는 최대한 재사용한다.
- 다만 `topology.js` 같은 정적 JS 파일 로딩 대신, 백엔드 API에서 topology state를 읽도록 변경한다.
- 예: `/api/topology`, `/api/clab/images`, `/api/clab/labs`, `/api/clab/labs/<id>/inspect`, `/api/devices/<id>/connect`

이 방식이 가장 현실적이다. 현재 UI 자산을 살리면서 backend capability를 확장할 수 있기 때문이다.

#### 방향 2. discovery 기능은 "import source"로 축소
- 기존 `generate_topology.py`는 주 실행 경로가 아니라, 선택적 import 기능으로 남기는 편이 좋다.
- 예: 실장비 LLDP 결과를 읽어 초기 토폴로지 초안으로 가져오기

즉, discovery는 primary workflow가 아니라 bootstrap 기능으로 격하하는 것이 맞다.

#### 방향 3. 단일 소스 모델을 중심으로 재구성
- 앞으로의 중심 객체는 LLDP 결과가 아니라 `TopologySpec`이어야 한다.
- Docker image, kind, interfaces, mgmt, links, deployment status, configuration intents를 모두 이 모델에 담아야 한다.
- UI, YAML 생성기, deploy 상태 조회, pyATS 설정 적용이 모두 이 모델을 공유해야 한다.

### 구현 시 주의사항

#### 1. topology.js를 JS 변수 파일로 유지할지 JSON API로 바꿀지 먼저 결정해야 함
- 편집기/배포기로 가려면 JSON API가 훨씬 적합하다.
- JS 파일 생성 방식은 브라우저 표시에는 단순하지만 상태 저장, 부분 업데이트, 동시성 처리, 검증 에러 반환에 취약하다.

#### 2. 노드 추가 UI보다 먼저 백엔드 검증 모델이 필요함
- 장비 종류, 이미지, 인터페이스, mgmt 제외 규칙, 링크 가능 여부는 서버에서 검증되어야 한다.
- 프론트에서만 처리하면 YAML 생성 시점에 충돌이 한꺼번에 발생한다.

#### 3. "장비 아이콘 클릭 접속"은 viewer 기능이 아니라 runtime 기능임
- 단순 링크 필드 추가만으로는 부족하다.
- deploy 이후 실제 mgmt IP/SSH port를 조회한 결과와 연결되어야 한다.
- 따라서 connect action은 topology static data가 아니라 runtime inventory와 연동해야 한다.

### 실무적으로 권장하는 최종 형태

1. 프론트는 NeXt UI 기반 topology editor/viewer로 유지
2. 백엔드는 Python API 서버로 확장
3. 상태 저장은 `TopologySpec` JSON 또는 DB로 관리
4. containerlab YAML은 항상 `TopologySpec`에서 재생성
5. 배포 후 runtime inventory를 topology 상태에 merge
6. pyATS는 deploy 이후 설정 단계에서만 사용
7. containerlab 실행 제어는 로컬 CLI가 아니라 clab-api-server를 기본 경로로 사용

이 방향이면 기존 `next_ui` 자산을 활용하면서도, 목표한 containerlab 기반 장비 추가/링크 생성/배포/설정 자동화까지 자연스럽게 확장할 수 있다.

---

## 전체 아키텍처

### A. 제어 평면 전환: CLI 우선이 아니라 API 우선
기존 계획은 Docker CLI와 `containerlab deploy`를 직접 실행하는 흐름을 전제로 했지만, 운영성과 다중 사용자 지원을 고려하면 clab-api-server를 제어 평면으로 두는 것이 더 적절하다.

- next_ui 백엔드는 clab-api-server의 API client 역할을 수행
- 토폴로지 편집 결과를 YAML 또는 JSON payload로 변환해 API에 전달
- 실험실 수명 주기 관리, 노드 제어, 이미지 목록 조회, 버전 확인은 모두 API 호출로 수행
- 로컬 CLI는 예외적 fallback 또는 개발용 진단 경로로만 남김

### B. 모듈 분리
아래처럼 책임을 분리하면 기능 확장과 테스트가 쉬워진다.

- `clab/api_client.py`
  - clab-api-server 인증 처리(JWT)
  - lab lifecycle API 호출 래핑
  - inspect, exec, save, logs, graph, image list, version 조회

- `clab/image_inventory.py`
  - Image List API 결과 파싱
  - 벤더/노드 kind별 추천 이미지 매핑
  - "필수 이미지 누락" 검증

- `clab/topology_model.py`
  - 공통 데이터 모델(노드, 링크, 인터페이스, role, mgmt 정보)
  - 기존 LLDP 결과(JSON)와 수동 입력을 동일 모델로 정규화

- `clab/link_builder.py`
  - 노드별 사용 가능 인터페이스 풀 관리
  - `mgmt`, `Management`, `eth0`, `mgmt0` 등 제외 규칙 처리
  - 링크 충돌(중복/자기연결/포트 재사용) 검증

- `clab/yaml_renderer.py`
  - containerlab 토폴로지 YAML 생성
  - mgmt 네트워크/주소 풀 선언
  - 노드별 kind/image/startup-config 바인딩

- `clab/lab_runtime.py`
  - clab-api-server의 Deploy/Destroy/List/Inspect 호출
  - Inspect 결과로 상태/SSH 포트 확인
  - 결과를 연결 상태 테이블로 반환

- `clab/node_control.py`
  - 특정 노드에 대한 Exec/Save/Logs 호출
  - Graph API 결과를 UI topology 상태와 동기화

- `clab/auth.py`
  - JWT 발급/갱신/만료 처리
  - 사용자별 API 호출 권한 추적

- `clab/device_configurator.py`
  - pyATS/Unicon으로 접속 세션 생성
  - 인터페이스 IP, OSPF, router-id 등 설정 적용
  - 장비별 템플릿 + 공통 추상화

- `clab/nl_config.py`
  - 자연어 요청을 구조화 명령(JSON intent)으로 변환
  - 안전 가드레일(허용 명령 whitelist, dry-run, diff 확인)

- `ui/device_actions.js` (또는 기존 `next_app.js` 확장)
  - 아이콘 클릭 이벤트 -> 백엔드 API 호출
  - SSH deep-link 또는 웹 터미널 URL 오픈

- `ui/clab_status.js`
  - lab 목록/상태/버전/로그 스트림 표시
  - API 에러 및 인증 만료 처리

---

## 데이터 모델 제안

### Node
- `id`: 고유 식별자
- `name`: 장비명
- `role`: core/distribution/access/edge 등
- `kind`: containerlab kind (`nokia_srlinux`, `vr-xrv`, `linux` 등)
- `image`: Docker 이미지
- `mgmt`: `{ ipv4, ssh_port, username, password }`
- `interfaces`: `[ { name, is_mgmt, speed, used } ]`
- `bootstrap`: 초기 설정 파일 경로

### Link
- `a_node`, `a_if`
- `b_node`, `b_if`
- `type`: p2p/trunk/access
- `state`: planned/deployed/failed

### TopologySpec
- `lab_name`
- `mgmt_network`: `{ name, subnet, gateway }`
- `nodes`: `Node[]`
- `links`: `Link[]`

### RuntimeLabState
- `lab_id`
- `status`: planned/deploying/running/failed/destroyed
- `api_source`: clab-api-server endpoint
- `nodes_runtime`: `{ name, container_id, mgmt_ip, ssh_port, state, image }[]`
- `graph`: API graph 결과 캐시
- `last_sync_at`

### AuthContext
- `access_token`
- `refresh_token` 또는 재인증 정보
- `user`
- `roles`
- `expires_at`

---

## 1) 이미지 탐지 및 환경 확인 설계

### 수집 방식
- clab-api-server의 Image List API 호출
- 필요 시 Version Check API로 containerlab/API 서버 버전 확인
- 응답의 `Repository:Tag`를 canonical name으로 저장

### 검증 규칙
- kind별 최소 1개 이미지가 있어야 함
- 같은 벤더 이미지가 여러 tag면 우선순위 정책 적용
  - 예: latest 금지, semver 최신 선호
- API 서버 버전과 target 기능(Deploy/Exec/Graph/Auth)의 지원 여부를 사전 확인

### 코드 레벨 포인트
- `detect_images() -> dict[kind, list[image]]`
- `get_server_versions() -> {containerlab, api_server}`
- `resolve_image(kind, preferred=None) -> image | error`
- 오류는 "실행 전 차단(preflight)"으로 반환

---

## 2) 노드/링크 생성 (mgmt 인터페이스 제외)

### 인터페이스 정책
- 제외 패턴(정규식):
  - `^mgmt$`, `^mgmt0$`, `^management`, `^eth0$`
- 장비 kind별 기본 데이터 포트 패턴 유지
  - 예: `eth1+`, `Gi0/0+`, `Ethernet1/+`

### 링크 생성 절차
1. 노드 추가 시 인터페이스 풀 생성
2. 링크 생성 요청 시 양쪽에서 "미사용+비관리" 포트 자동 선택
3. 수동 지정 포트가 mgmt면 즉시 거부
4. 링크 생성 후 양쪽 포트 `used=true`

### 검증
- 중복 링크, self-loop, 인터페이스 over-subscription 방지

---

## 3) mgmt 네트워크 및 SSH 접속성

### mgmt 선언
containerlab YAML의 `mgmt` 섹션에 네트워크/서브넷 지정.

예시(개념):

```yaml
mgmt:
  network: clab-mgmt
  ipv4-subnet: 172.20.20.0/24
```

### 접속성 확인
- deploy 후 아래 순서로 확인
1. Inspect API로 노드별 관리 IP, 상태, 이미지 조회
2. 필요 시 List API로 lab 전체 상태 확인
3. pyATS/Unicon으로 SSH handshake 테스트

결과 상태:
- `running + ssh_ok`
- `running + ssh_failed`
- `not_running`

---

## 4) containerlab YAML 생성

### 생성 시점
- 노드/링크 검증 완료 후 단일 소스(TopologySpec)에서 렌더링
- 이후 두 가지 경로 중 하나를 사용
  - YAML 파일을 생성해 Deploy API에 전달
  - YAML 문자열/데이터를 직접 API payload로 전달

### 출력 파일
- `clab/<lab_name>.clab.yml`
- 선택: `startup-configs/<node>.cfg`

### 템플릿 전략
- Jinja2 템플릿 사용 권장
- kind별 필수 필드 분기
- deterministic output (정렬/일관된 key 순서)

### API 연동 포인트
- Deploy API: 실험실 생성 및 기동
- Destroy API: 실험실 정리
- List API: 서버에서 관리 중인 lab 목록 조회
- Inspect API: 특정 lab의 runtime inventory 동기화

---

## 5) lab 기동 후 장비 설정 자동화

### 실행 플로우
1. Auth API 또는 로그인 절차로 JWT 확보
2. Deploy API 호출로 lab 생성/기동
3. Inspect API 호출로 런타임 인벤토리 수집(관리 IP, 컨테이너 이름)
4. pyATS testbed 동적 생성
5. 공통/역할 기반 Day0/Day1 설정 적용

### 예시 기능
- 인터페이스 IP 설정
- OSPF 인터페이스/프로세스 설정
- router-id 설정
- Loopback 생성
- 필요 시 Exec API로 show 명령 검증 수행
- 필요 시 Save API로 현재 설정 영속화

### 구현 방식
- `device_configurator.apply_config(topology_spec, intents)`
- 변경 전/후 diff 저장
- 롤백 포인트(초기 config backup) 유지

### 노드 제어 API 활용
- Exec: 배포 후 상태 확인, show 명령 실행, 설정 결과 검증
- Save: running config 또는 vendor별 저장 명령 이후 영속화 보조
- Logs: 초기 부팅 실패, image mismatch, 프로세스 에러 조사
- Graph: 배포된 lab의 실제 연결 관계를 UI에 재반영

---

## 6) pyATS + 자연어 설정

### 권장 파이프라인
1. 사용자 자연어 입력
2. `nl_config`가 intent JSON으로 변환
3. schema 검증 (Pydantic)
4. 장비별 커맨드 렌더링
5. dry-run 출력 확인
6. pyATS로 실제 반영

### intent 예시

```json
{
  "targets": ["core-rtr01", "core-rtr02"],
  "actions": [
    {"type": "set_interface_ip", "if": "Gi0/0", "ipv4": "10.0.0.1/30"},
    {"type": "set_ospf_interface", "if": "Gi0/0", "area": 0},
    {"type": "set_router_id", "process": 1, "router_id": "1.1.1.1"}
  ]
}
```

### 안전장치
- 금지 명령 차단(`reload`, `write erase` 등)
- 장비별 지원 명령 체크
- 실패 시 장비 단위 에러 격리

---

## 7) 아이콘 클릭 시 장비 접속

### UI 동작
- topology node 클릭 이벤트에서 장비 ID 전달
- 백엔드가 Inspect API 기반 runtime 정보를 조회해 장비 접속 URL/명령 생성

### 구현 옵션
- 옵션 A: 로컬 SSH 스킴 링크
  - `ssh://user@ip:port`
- 옵션 B: 웹 터미널(예: wetty/ttyd) URL 연결
  - 브라우저에서 바로 접속
- 옵션 C: Exec API 기반 브라우저 내 명령 실행 패널
  - 읽기 전용 show 명령부터 시작

### 보안
- 비밀번호 직접 노출 금지
- 단기 토큰 기반 세션 발급
- 접근 로그 기록

---

## 8) 인증, 사용자 관리, 문서화

### 인증
- clab-api-server의 JWT 기반 인증을 기본으로 사용
- next_ui 백엔드는 사용자 대신 토큰을 획득하거나 전달받아 API를 호출
- 토큰 만료 처리와 재로그인 흐름이 필요

### 사용자 관리
- 다중 사용자 환경을 고려하면 lab 소유자, 읽기 전용 사용자, 운영자 권한을 분리하는 것이 좋다
- API가 제공하는 사용자 관리 기능과 UI의 사용자 모델을 맞춰야 한다

### 문서화 및 개발 흐름
- `/docs` 또는 `/redoc`를 통해 실제 API 스펙을 기준으로 client wrapper를 작성
- 초기 개발 단계에서는 Swagger UI를 활용해 Deploy/Inspect/Exec 응답 형태를 고정하고, 그 후 내부 데이터 모델에 매핑한다
- plan 차원에서는 "문서 우선 검증 -> client wrapper 구현 -> UI 연결" 순서가 가장 안전하다

---

## 단계별 구현 로드맵

1. `TopologySpec` 데이터 모델 정의
2. clab-api-server 인증 방식 및 Swagger/ReDoc 스펙 검증
3. Image List/Version Check client 구현 + kind/image 매핑
4. mgmt 제외 인터페이스 정책 + 링크 검증 엔진
5. YAML 렌더러(Jinja2) + Deploy payload 생성
6. Deploy/List/Inspect/Destroy client 구현
7. Exec/Save/Logs/Graph client 구현
8. pyATS 연동 기본 설정(인터페이스 IP부터)
9. 자연어 intent 변환기 + dry-run
10. UI 클릭 접속 API + 프론트 상태 패널 연결

---

## 최소 성공 기준 (MVP)

- 이미지 탐지 실패 시 배포 차단
- Version Check 실패 시 기능 제한 또는 차단
- mgmt 인터페이스 자동 제외 링크 생성
- YAML 또는 Deploy payload 자동 생성
- Deploy API 성공 + Inspect 기반 SSH 가능 상태 표기
- pyATS로 인터페이스 IP 1개 이상 적용 성공
- UI 클릭으로 대상 장비 접속 트리거 성공
- JWT 인증 후 권한 있는 사용자만 lab 제어 가능
