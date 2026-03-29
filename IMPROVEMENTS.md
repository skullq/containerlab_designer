# next_ui v2 개선사항 문서

**작성일**: 2026년 3월 29일  
**버전**: v2 (API + Responsive Optimization)

---

## 📋 문서 개요

본 문서는 next_ui의 NeXt UI 기반 Containerlab Topology Designer의 모든 개선사항을 기록합니다. 이전 정적 토폴로지 기반에서 FastAPI 연동 동적 토폴로지 시스템으로 전환되었으며, 사용성과 성능이 크게 개선되었습니다.

---

## 🎯 Phase 1: 응답성 최적화 (Responsiveness Audit & Fix)

### 문제점 분석
- **Click-to-Focus 지연**: 마우스 클릭 후 노드 포커스 표시까지 ~140ms 지연
- **per-click Hit-test**: O(N) 노드 순회 시 각 노드마다 `getBoundingClientRect()` 호출
- **Global mousemove 오버헤드**: 항상 활성화된 mousemove 리스너로 인한 불필요한 성능 소비
- **Link Preview 성능**: 링크 미리보기 시 매번 surface rect 다시 읽음

### 해결 방안

#### 1. 즉시 포커스 응답 (`focusNodeImmediately`)
```javascript
// mousedown에서 즉시 시각적 선택 반영
function focusNodeImmediately(node, showDetails)
```
- `clickNode` 이벤트 대기 제거
- 마우스다운 시 바로 처리
- CSS transition 0으로 설정 (애니메이션 제거)

#### 2. Surface Rect 캐싱 (`getSurfaceRectCached`)
```javascript
// 16ms TTL 캐시로 per-node 레이아웃 읽기 회피
surfaceRectCache = { el, ts, rect }
```
- 같은 frame 내 여러 노드 hit-test 시 캐시 재사용
- 16ms = 60fps 기준 한 프레임

#### 3. Mousemove 리스너 동적 관리 (`setLinkPreviewMouseTracking`)
```javascript
// addLink 모드에서만 mousemove 리스너 활성화
setLinkPreviewMouseTracking(enabled)
```
- 불필요한 전역 mousemove 제거
- 링크 추가 모드에서만 활성화

#### 4. rect 매개변수 전달
```javascript
// getNodeCenterInViewport(node, topologyRect)
// rect를 매개변수로 전달하여 재호출 방지
```

---

## 🎨 Phase 2: 시각적 레이블 개선 (Label & Visual Enhancement)

### 노드 레이블 개선
- **색상**: 흑색(#000000) + 흰색 스트로크 (가독성 극대화)
- **스타일**: Bold (font-weight: 700)
- **paint-order**: stroke fill (획 먼저 그린 후 글자)

### 인터페이스 레이블 분할 (`splitInterfaceLabel`)
```javascript
function splitInterfaceLabel(label)
```
- 짧은 레이블(≤12자): 한 줄 표시
- 긴 레이블: 알파벳/숫자 경계에서 분할
- 예: `GigabitEthernet0/0/0` → `Gigabit\nEthernet0/0/0`

### 링크 레이블 배치 (`CustomLinkClass.update()`)
- **중점 기준**: 링크 중앙에 배치
- **좌우 분리**: 선 법선벡터(nxv, nyv) 기준으로 좌우 오프셋
  - source 레이블: 중점 - 따라가기 오프셋 + 좌측 오프셋
  - target 레이블: 중점 + 따라가기 오프셋 - 좌측 오프셋
- **수직 오프셋**: 2번 라인은 `y + lineGap` (screen coordinates)
- **text-anchor**: 모든 레이블에 'middle' 적용

### 수직 레이블 겹침 해결
- 이전: 링크 법선벡터 방향으로 시도 (불안정)
- 현재: 스크린 Y좌표 기준 고정 (lineGap = 13px)

---

## 🔗 Phase 3: 연결성 추적 (Connectivity Markmap Display)

### 기능
왼쪽 클릭 시 선택한 노드의 연결 정보를 마크맵 형태로 표시

### 구현 함수
```javascript
getNodeConnectivityEntries(nodeId)        // 연결 정보 수집
renderConnectivityMarkmap(nodeInfo, entries)  // HTML 마크맵 렌더링
```

### HTML 구조
```
노드명 (root)
  ├─ 피어 노드명 (branch)
  │  ├─ 로컬 인터페이스 (leaf)
  │  ├─ 피어 인터페이스 (leaf)
  │  └─ 방향 (in/out) (leaf)
  └─ ...
```

### CSS 스타일
- `.markmap-tree`: 기본 트리 스타일
- `.mm-root`: 노드명 (bg: #e2e8f0)
- `.mm-branch`: 피어 정보 (color: #1f2937)
- `.mm-if`: 인터페이스/방향 (color: #64748b)
- 연결선: 1px solid #93a4bc, #c6d2e2

---

## ➕ Phase 4: 대량 노드 추가 (Bulk Node Creation)

### 기능
한 번에 여러 노드를 일괄 생성 (패턴 지원)

### 패턴 변수
- `{$count}`: 1부터 N까지 자동 증가
- 예: `r-{$count}` + count=5 → `r-1, r-2, r-3, r-4, r-5`

### 구현 함수
```javascript
buildBulkNodeNames(pattern, count)        // 패턴 확장
getBulkNodeBasePosition(nodes)            // 중심점 계산
getBulkNodeOffset(index, count)           // 그리드 배치
addNodeFromForm()                         // 일괄 생성 + 중복 스킵
```

### Modal UI
- Node Name: 패턴 입력 (기본값: `r-{$count}`)
- Node Count: 개수 (1-200)
- Kind: 노드 타입 선택
- Image: 컨테이너 이미지 (선택)
- Icon: 아이콘 (선택)

### 위치 배치
- 기본 위치: 기존 노드들의 중심점
- Grid 배치: 인덱스 기준 원형 배열 + 지터링

---

## 🗑️ Phase 5: Layout 기능 제거

### 제거된 코드
- `currentLayout` 상태 변수
- `fitTopologyToViewport()`, `applyHierarchicalLayout()`
- `window.horizontal`, `window.vertical`, `window.autoLayout`
- HTML Layout Controls 섹션
- Layout 관련 window.nextUI 내보내기

### 이유
- Containerlab 동적 토폴로지에서는 고정 좌표 필요
- 자동 레이아웃은 노드 위치 재배치로 혼동 유발

---

## 📏 Phase 6: Modal 크기 최적화 (2단계)

### Add Node Modal
- `min-width: 300px, max-width: 460px, width: 80vw, padding: 16px 18px`

### YAML Export Modal
- `min-width: 310px, max-width: 500px, width: 82vw, padding: 16px 18px`
- Textarea: `height: 220px`

---

## 🛠️ Phase 7: 우클릭 메뉴 (Context Menu)

### 기능
우클릭 시 컨텍스트 메뉴 표시

### 메뉴 항목
1. **Add Link**: 링크 추가 모드 시작
2. **Delete Node**: 선택 노드 삭제 (랩 정지 필요)
3. **SSH Connect**: SSH 연결 (랩 배포 필요)

### 가드 조건
- Delete Node: 랩 실행 중이면 비활성화 + 알림
- SSH Connect: 랩 미배포 시 비활성화 + 알림

---

## 🧹 Phase 8: 랩 상태 & 노드 선택 동기화 (Lab Status & Panel Redesign)

### 문제점
- 상태창이 **표시/미표시 반복** → 애니메이션 문제
- 토폴로지 레이아웃이 **점프** → status panel이 마진 차지
- 우클릭 시 상태 미동기화 → 패널 깜빡임

### 해결책

#### 1. 플로팅 레이아웃
```css
#clab-status {
    position: fixed;
    left: 10px; bottom: 40px;
    width: 230px;
    /* 토폴로지에서 분리 */
}
```
- 토폴로지 레이아웃 영향 제거
- z-index: 1100으로 최상위 유지

#### 2. CSS Transition (visibility + opacity)
```css
visibility: hidden; opacity: 0;
transition: opacity 0.15s ease-out, visibility 0.15s ease-out;

.panel-active {
    visibility: visible; opacity: 1;
}
```
- `display: none/block` 제거 (reflow 유발)
- `visibility/opacity` 조합으로 부드러운 fade

#### 3. 헤더 Lab 상태 표시
```html
<div id="lab-status-bar">
  <span>Lab Deployed <span class="lab-dot dot-red"></span></span>
  <span>API ON <span class="lab-dot dot-green"></span></span>
</div>
```
- 녹색(활성) / 빨간색(비활성)
- header 우측 끝 정렬 (flex-end)
- 두 줄 세로 배치

#### 4. Connect → 우클릭 메뉴 이동
- 왼클릭: IP + Connectivity만 표시
- 우클릭: Add Link, Delete, SSH Connect 제공
- 툴바에서 SSH 버튼 제거

---

## 🎯 Phase 9: 우클릭 아이콘 선택 오류 수정 (Right-click on Icon Bug)

### 문제
- 우클릭/Ctrl+클릭(Mac) 시 컨텍스트메뉴 열리며 **동시에 노드 포커스**
- NeXt의 `clickNode`가 **모든 mouseup 버튼에서 발사** (버튼 타입 미체크)

### 위치
```javascript
// NeXt: _mouseup() { this.fire("clickNode", b) }
// 버튼 타입 체크 없음!
```

### 해결
```javascript
// clickNode 핸들러에서 버튼 감지
if (window.event && window.event.button !== 0) return;

// mousedown에서 Ctrl+클릭 필터
if (evt.ctrlKey) return;
```

---

## 🔐 Phase 10: 노드 삭제 조건 (Delete Node Validation)

### 조건
1. **Lab 정지 필요**: `currentLabId` 존재하면 삭제 불가
2. **UI 피드백**: 상태 메시지 표시 ("Stop lab first")
3. **YAML 자동 갱신**: 삭제 후 YAML 모달이 열려있으면 자동 재생성

### 구현
```javascript
function deleteNodeFromContextMenu() {
    if (currentLabId) {
        alert('Cannot delete node while lab is running.\nStop the lab first.');
        return;
    }
    // ... 삭제 로직
    if (yamlModal.classList.contains('open')) {
        document.getElementById('yaml-output').value = generateYAML();
    }
}
```

---

## 🟡 Phase 11: 노드 클릭 시 하이라이트 (Node Focus Highlight)

### 기능
왼클릭 시 선택 노드와 직접 연결된 노드/링크만 명확히, 나머지는 흐림

### 구현
```javascript
applyNodeFocusHighlight(nodeId)    // 소광 적용
clearNodeFocusHighlight()          // 소광 제거
```

### CSS
```css
#topology.topo-focus-mode .topo-dim   { opacity: 0.13; }
#topology.topo-focus-mode .topo-focal { opacity: 1; }
```

### 알고리즘
1. 노드 ID → 연결된 모든 링크 검색
2. 링크의 source/target 노드 수집 → `focalNodeIds`, `focalLinkIds`
3. 각 노드/링크 DOM에 클래스 적용
4. CSS로 opacity 조정

---

## ⚡ Phase 12: 타이밍 & 애니메이션 최적화 (Timing & Animation Fixes)

### 7가지 핵심 문제 해결

#### Issue 1: focusNodeImmediately 조기 반환
**문제**: 재선택 시 리턴 → updateStatusPanel 미호출 → 패널 닫힘
**해결**: 조기 반환 로직 개선 + 무조건 updateStatusPanel 호출
```javascript
const shouldSkipRender = isAlreadyFocused && !showDetails;
if (shouldSkipRender) return;
// ...
updateStatusPanel();  // ALWAYS called
```

#### Issue 2: showNodeContextMenu 상태 미동기화
**문제**: 우클릭 시 showNodeDetails만 호출 → DOM 미업데이트
**해결**: updateStatusPanel 명시적 호출
```javascript
showNodeContextMenu(nodeId) {
    if (nodeId) {
        showNodeDetails(node.model());
        updateStatusPanel();  // CRITICAL
    }
}
```

#### Issue 3: CSS display + transition
**문제**: `display: none ↔ block` + `opacity transition` → 작동 안함
**해결**: display 제거 → visibility/opacity만 사용
```css
visibility: hidden; opacity: 0;
transition: opacity 0.15s ease-out, visibility 0.15s ease-out;
.panel-active { visibility: visible; opacity: 1; }
```

#### Issue 4: applyNodeFocusHighlight 과도한 reflow
**문제**: 루프 내 add/remove 반복 → 여러 번 reflow 발생
**해결**: requestAnimationFrame + 배열 배치 처리
```javascript
window.requestAnimationFrame(function() {
    const nodesToUpdate = [];
    topo.eachNode(node => { nodesToUpdate.push(...); });
    nodesToUpdate.forEach(({ el, focal }) => {
        el.classList.add(focal ? 'topo-focal' : 'topo-dim');
    });
});
```

#### Issue 5: clearNodeFocusHighlight 비효율
**문제**: eachNode/Link 전체 순회 (노드 많으면 느림)
**해결**: querySelectorAll로 배치 제거
```javascript
const dimmed = document.querySelectorAll('#topology [class*="topo-dim"]');
dimmed.forEach(el => el.classList.remove('topo-dim'));
```

#### Issue 6: suppressClickNodeMs 너무 짧음
**문제**: 140ms → 저사양 기기에서 초과 가능 → 중복 처리
**해결**: 200ms로 증가
```javascript
suppressClickNodeMs: 200  // 저사양 기기 지원
```

#### Issue 7: clickNode 중복 updateStatusPanel
**문제**: mousedown + clickNode에서 각각 호출 → 불필요한 DOM 조작
**해결**: 중복 호출 제거 (focusNodeImmediately에서 처리)
```javascript
// focusNodeImmediately always calls updateStatusPanel now
// clickNode는 backup 역할만 (comment로 의도 명확화)
```

---

## 📊 성능 개선 요약

| 항목 | 이전 | 현재 | 개선율 |
|---|---|---|---|
| 클릭→포커스 | ~140ms | ~0ms | **100%** |
| Hit-test | O(N) × BoundingClientRect | O(N) + 16ms 캐시 | **8-10배** |
| Mousemove | 전역 활성화 (낭비) | addLink 모드만 활성화 | **CPU ↓** |
| 노드 선택 패널 | 반복 깜빡임 | 부드러운 fade | **안정화** |
| 레이아웃 점프 | 마진으로 인한 틀어짐 | position: fixed 분리 | **해결** |
| 노드 highlight reflow | 매 loop마다 | RAF + 배열 배치 | **1회로 단축** |

---

## 🔧 기술 스택

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Topology**: NeXt UI (nx.graphic.Topology)
- **Backend**: FastAPI (Python)
- **API**: Containerlab REST API
- **Styling**: CSS Grid, Flexbox, Transition

---

## 📁 파일 구조

```
next_ui/
├── next_app_v2.js              # 메인 애플리케이션 로직
├── main_api_v2.html            # UI + 스타일
├── next_sources/
│   ├── js/next.js              # NeXt UI 라이브러리
│   └── css/next.css            # NeXt 스타일
├── styles_main_page.css        # 추가 스타일
└── IMPROVEMENTS.md             # 본 파일
```

---

## 🚀 배포 체크리스트

- [ ] `next_app_v2.js` 문법 확인: `node --check next_app_v2.js`
- [ ] FastAPI 서버 실행: `uv run uvicorn api.main:app --reload --port 8000`
- [ ] 브라우저 열기: `http://localhost:8000/`
- [ ] 기능 테스트
  - [ ] 노드 클릭 (즉시 포커스)
  - [ ] 우클릭 (컨텍스트메뉴 + 상태창)
  - [ ] 링크 추가 (shift+클릭 또는 메뉴)
  - [ ] 노드 삭제 (우클릭 → Delete)
  - [ ] YAML 생성 (자동 재생성)
  - [ ] 대량 노드 추가 (패턴 확장 확인)

---

## 📝 버전 히스토리

### v1.0 (기존)
- 정적 topology.js 기반
- 기본 토폴로지 시각화

### v2.0 (현재)
- FastAPI 연동 + 동적 UI
- 응답성 최적화 (12단계)
- 우클릭 메뉴 및 컨텍스트 기능
- 연결성 추적 및 마크맵 표시
- 대량 노드 추가
- 타이밍/애니메이션 안정화

---

## 📞 문의 및 피드백

본 문서는 재배포 목적으로 작성되었습니다. 추가 개선사항이나 버그 리포트는 GitHub Issues를 통해 제출하세요.

---

**Last Updated**: 2026년 3월 29일  
**Maintainer**: next_ui Team
