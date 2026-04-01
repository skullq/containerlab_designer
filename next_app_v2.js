/**
 * next_ui topology application with containerlab API integration
 * Supports both legacy static topology.js and new API-driven mode
 */

(function (nx) {
    /**
     * API Configuration
     */
    const API_BASE_URL = "http://localhost:8000/api";
    const CLAB_API = API_BASE_URL + "/clab";
    const Logger = {
        warn: function() { console.warn.apply(console, arguments); },
        error: function() { console.error.apply(console, arguments); },
    };

    // Global state
    let currentTopology = null;
    let currentLabId = null;
    let topo = null;
    let selectedNodeInfo = null;
    let linkDraft = null;
    let linkPreviewLayer = null;
    let linkPreviewLine = null;
    let previewRafId = null;
    let lastMousePoint = null;
    let lastNodeClickTs = 0;
    let lastImmediateFocusTs = 0;
    let contextMenuActive = false;
    let tooltipBlockedUntilTs = 0;
    let lastNodeOpenRequest = { nodeId: null, ts: 0 };
    let lastNodeClickRecord = { nodeId: null, ts: 0 };
    let lastNodePrimaryDown = { nodeId: null, ts: 0 };
    let lastLinkPick = { nodeId: null, ts: 0 };
    let activeSelectedNodeId = null;
    let pendingBackgroundClick = null;
    let backgroundPanState = null;
    let pendingNodeDrag = null;
    let backgroundMoveCursorActive = false;
    let linkPreviewMousemoveBound = false;
    let surfaceRectCache = {
        el: null,
        ts: 0,
        rect: null,
    };
    let contextMenuNodeId = null;
    let debugMode = false;
    let debugOverlayEl = null;
    let debugHitCircleEl = null;
    let positionSaveTimer = null;
    const mgmtIpByNode = new Map();
    const MGMT_IP_PREFIX = '172.31.255';
    const LAYOUT_STORAGE_PREFIX = 'next_ui.layout.';
    const TOPOLOGY_SNAPSHOT_KEY = 'next_ui.topology_snapshot.v1';
    const DEPLOYED_EXPORTS_KEY = 'next_ui.deployed_exports.v1';
    const REMOTE_STORAGE_KEYS = {
        serverUrl: 'next_ui.remote_server_url',
        username: 'next_ui.remote_username',
        token: 'next_ui.remote_token',
        password: 'next_ui.remote_password',
    };
    const MGMT_NETWORK_STORAGE_KEYS = {
        name: 'next_ui.mgmt_network_name',
        subnet: 'next_ui.mgmt_network_subnet',
    };
    const SSH_PORT_RANGE_STORAGE_KEYS = {
        start: 'next_ui.ssh_port_range_start',
        end: 'next_ui.ssh_port_range_end',
    };
    const DEFAULT_MGMT_NETWORK = {
        name: 'clab-mgmt',
        ipv4Subnet: '172.20.20.0/24',
    };
    const DEBUG_SHOW_NODE_COORD_LABEL = true;
    let mgmtHostCounter = 10;
    let topologyApp = null;
    let remoteServerUrl = '';
    let remoteAuthToken = '';
    let remotePasswordCache = '';
    let remoteMetricsTimer = null;
    let labStatusTimer = null;
    let tokenRefreshTimer = null;
    let tokenRefreshInFlight = null;
    let lastRemoteCpuPercent = NaN;
    let lastRemoteMemPercent = NaN;
    let lastRemoteApiConnected = false;
    let lastRemoteApiLabel = 'Disconnected';
    let activeMainTab = 'topology';
    let exportPreviewFormat = 'yaml';
    let deploymentAccessPanelRequested = false;
    let lastDeploymentAccessStatusKey = '';
    let lastDeploymentAccessRowsKey = '';
    let kindImageRegistry = {};
    let defaultLoginName = 'admin';
    const LINK_PREVIEW_LAYER_ID = 'nextui-link-preview-layer';
    const LINK_PREVIEW_LINE_ID = 'nextui-link-preview-line';
    const INTERACTION = {
        contextPickRadius: 80,
        linkPickRadius: 68,
        focusPickRadius: 56,
        doubleClickPickRadius: 30,
        doubleClickMs: 340,
        dedupeMs: 120,
        suppressClickNodeMs: 200,  // Increased from 140ms for slower systems
        backgroundDragStartPx: 7,
        nodeDragHideTooltipPx: 2,
        menuMargin: 8,
    };

    let pendingRestoreCoordMap = null;
    const AppState = {
        topology: {
            currentLabId: null,
            selectedNodeInfo: null,
        },
        remote: {
            serverUrl: '',
            authToken: '',
            passwordCache: '',
        },
        interaction: {
            mode: 'view',
            pendingNodeDrag: null,
            backgroundPanState: null,
        },
        ui: {
            activeMainTab: 'topology',
            deploymentAccessPanelRequested: false,
        },
    };

    function updateCurrentLabId(nextLabId) {
        const normalized = String(nextLabId || '').trim();
        currentLabId = normalized || null;
        AppState.topology.currentLabId = currentLabId;
        return currentLabId;
    }

    function isTooltipBlocked(nowTs) {
        const now = Number.isFinite(nowTs) ? nowTs : Date.now();
        return contextMenuActive || now < tooltipBlockedUntilTs;
    }

    function blockTooltipAfterContextMenu(durationMs) {
        const ms = Number.isFinite(durationMs) ? durationMs : 650;
        tooltipBlockedUntilTs = Date.now() + Math.max(180, ms);
    }

    function buildCoordMapFromNodes(nodes) {
        const map = {};
        (nodes || []).forEach(function(node) {
            if (!node) return;
            const id = String(node.id || node.name || '');
            if (!id) return;
            const x = Number(node.x);
            const y = Number(node.y);
            map[id] = {
                x: Number.isFinite(x) ? Math.round(x) : 0,
                y: Number.isFinite(y) ? Math.round(y) : 0,
            };
        });
        return map;
    }

    function ensureGraphDebugLabels(graph) {
        if (!graph || !Array.isArray(graph.nodes)) return graph;
        graph.nodes.forEach(function(node) {
            if (!node) return;
            const name = String(node.name || node.id || 'node');
            const x = Number(node.x);
            const y = Number(node.y);
            node.debugLabel = formatNodeCoordLabel(name, x, y);
        });
        return graph;
    }

    function setServerAuthStatus(message, isError) {
        const el = document.getElementById('server-auth-status');
        if (!el) return;
        el.textContent = message || '';
        el.style.color = isError ? '#b91c1c' : '#64748b';
    }

    function simplifyServerLabel(url) {
        const raw = String(url || '').trim();
        if (!raw) return 'No server';
        try {
            const parsed = new URL(raw);
            return parsed.host || raw;
        } catch (e) {
            return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
        }
    }

    function formatStatusLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '-';
        return raw
            .split(/[-_\s]+/)
            .filter(Boolean)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function renderRemoteApiSummary() {
        const dot = document.getElementById('remote-api-dot');
        const stateEl = document.getElementById('remote-api-state');
        const metaEl = document.getElementById('remote-api-meta');

        if (dot) {
            dot.className = lastRemoteApiConnected ? 'lab-dot dot-green' : 'lab-dot dot-red';
            dot.title = lastRemoteApiConnected ? 'Remote API connected' : 'Remote API disconnected';
        }
        if (stateEl) {
            stateEl.textContent = lastRemoteApiLabel || (lastRemoteApiConnected ? 'Connected' : 'Disconnected');
        }
        if (metaEl) {
            const parts = [simplifyServerLabel(remoteServerUrl)];
            if (Number.isFinite(lastRemoteCpuPercent) || Number.isFinite(lastRemoteMemPercent)) {
                parts.push(`CPU ${Number.isFinite(lastRemoteCpuPercent) ? lastRemoteCpuPercent.toFixed(1) : '-'}%`);
                parts.push(`MEM ${Number.isFinite(lastRemoteMemPercent) ? lastRemoteMemPercent.toFixed(1) : '-'}%`);
            }
            metaEl.textContent = parts.join(' · ');
        }
    }

    function setRemoteApiIndicator(connected, label) {
        lastRemoteApiConnected = !!connected;
        lastRemoteApiLabel = label || (connected ? 'Connected' : 'Disconnected');
        renderRemoteApiSummary();
    }

    function setRemoteMetrics(cpuPercent, memPercent) {
        lastRemoteCpuPercent = cpuPercent;
        lastRemoteMemPercent = memPercent;
        renderRemoteApiSummary();
    }

    function setLabRuntimeIndicator(state, detail) {
        const dot = document.getElementById('lab-runtime-dot');
        const stateEl = document.getElementById('lab-runtime-state');
        const metaEl = document.getElementById('lab-runtime-meta');
        const label = String(state || '').toLowerCase();

        let cls = 'dot-amber';
        if (label === 'running' || label === 'healthy' || label === 'ok') cls = 'dot-green';
        else if (label === 'failed' || label === 'error' || label === 'not-found' || label === 'destroyed' || label === 'not-running') cls = 'dot-red';

        if (dot) {
            dot.className = `lab-dot ${cls}`;
            dot.title = detail || state || 'Lab status';
        }
        if (stateEl) {
            stateEl.textContent = formatStatusLabel(state || 'idle');
        }
        if (metaEl) {
            metaEl.textContent = detail || 'No active lab';
        }
    }

    function hasRemoteSession() {
        return !!(remoteServerUrl && remoteAuthToken);
    }

    function readStoredRemoteSession() {
        return {
            serverUrl: String(localStorage.getItem(REMOTE_STORAGE_KEYS.serverUrl) || '').trim(),
            username: String(localStorage.getItem(REMOTE_STORAGE_KEYS.username) || '').trim(),
            token: String(localStorage.getItem(REMOTE_STORAGE_KEYS.token) || '').trim(),
            password: String(sessionStorage.getItem(REMOTE_STORAGE_KEYS.password) || ''),
        };
    }

    function persistRemoteSession(session) {
        if (!session || typeof session !== 'object') return;

        if (Object.prototype.hasOwnProperty.call(session, 'serverUrl')) {
            const value = String(session.serverUrl || '').trim();
            if (value) localStorage.setItem(REMOTE_STORAGE_KEYS.serverUrl, value);
            else localStorage.removeItem(REMOTE_STORAGE_KEYS.serverUrl);
        }

        if (Object.prototype.hasOwnProperty.call(session, 'username')) {
            const value = String(session.username || '').trim();
            if (value) localStorage.setItem(REMOTE_STORAGE_KEYS.username, value);
            else localStorage.removeItem(REMOTE_STORAGE_KEYS.username);
        }

        if (Object.prototype.hasOwnProperty.call(session, 'token')) {
            const value = String(session.token || '').trim();
            if (value) localStorage.setItem(REMOTE_STORAGE_KEYS.token, value);
            else localStorage.removeItem(REMOTE_STORAGE_KEYS.token);
        }

        if (Object.prototype.hasOwnProperty.call(session, 'password')) {
            const value = String(session.password || '');
            if (value) sessionStorage.setItem(REMOTE_STORAGE_KEYS.password, value);
            else sessionStorage.removeItem(REMOTE_STORAGE_KEYS.password);
        }
    }

    function readStoredMgmtNetworkConfig() {
        return {
            name: String(localStorage.getItem(MGMT_NETWORK_STORAGE_KEYS.name) || '').trim(),
            ipv4Subnet: String(localStorage.getItem(MGMT_NETWORK_STORAGE_KEYS.subnet) || '').trim(),
        };
    }

    function persistMgmtNetworkConfig(config) {
        if (!config || typeof config !== 'object') return;

        if (Object.prototype.hasOwnProperty.call(config, 'name')) {
            const nameValue = String(config.name || '').trim();
            if (nameValue) localStorage.setItem(MGMT_NETWORK_STORAGE_KEYS.name, nameValue);
            else localStorage.removeItem(MGMT_NETWORK_STORAGE_KEYS.name);
        }

        if (Object.prototype.hasOwnProperty.call(config, 'ipv4Subnet')) {
            const subnetValue = String(config.ipv4Subnet || '').trim();
            if (subnetValue) localStorage.setItem(MGMT_NETWORK_STORAGE_KEYS.subnet, subnetValue);
            else localStorage.removeItem(MGMT_NETWORK_STORAGE_KEYS.subnet);
        }
    }

    function sanitizeMgmtNetworkConfig(config) {
        const source = (config && typeof config === 'object') ? config : {};
        const name = String(source.name || '').trim() || DEFAULT_MGMT_NETWORK.name;
        const ipv4Subnet = String(source.ipv4Subnet || source.ipv4_subnet || '').trim() || DEFAULT_MGMT_NETWORK.ipv4Subnet;
        return {
            name: name,
            ipv4Subnet: ipv4Subnet,
        };
    }

    function getMgmtNetworkConfig() {
        const nameEl = document.getElementById('mgmt-network-name-input');
        const subnetEl = document.getElementById('mgmt-network-subnet-input');
        const config = sanitizeMgmtNetworkConfig({
            name: nameEl ? nameEl.value : '',
            ipv4Subnet: subnetEl ? subnetEl.value : '',
        });
        return config;
    }

    function refreshMgmtNetworkPreview() {
        const config = getMgmtNetworkConfig();
        const previewEl = document.getElementById('mgmt-network-preview');
        const statusEl = document.getElementById('mgmt-network-status');

        if (previewEl) {
            previewEl.value = [
                'mgmt:',
                `  network: ${config.name}`,
                `  ipv4-subnet: ${config.ipv4Subnet}`,
            ].join('\n');
        }

        if (statusEl) {
            statusEl.textContent = `Using mgmt network ${config.name} with subnet ${config.ipv4Subnet}.`;
            statusEl.style.color = '#64748b';
        }

        persistMgmtNetworkConfig(config);
        return config;
    }

    function initMgmtNetworkSettingsUI() {
        const stored = sanitizeMgmtNetworkConfig(readStoredMgmtNetworkConfig());
        const nameEl = document.getElementById('mgmt-network-name-input');
        const subnetEl = document.getElementById('mgmt-network-subnet-input');

        if (nameEl) {
            nameEl.value = stored.name;
            nameEl.addEventListener('input', refreshMgmtNetworkPreview);
            nameEl.addEventListener('change', refreshMgmtNetworkPreview);
        }
        if (subnetEl) {
            subnetEl.value = stored.ipv4Subnet;
            subnetEl.addEventListener('input', refreshMgmtNetworkPreview);
            subnetEl.addEventListener('change', refreshMgmtNetworkPreview);
        }

        refreshMgmtNetworkPreview();
    }

    function toValidPortNumber(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return null;
        const port = Math.trunc(parsed);
        if (port < 1 || port > 65535) return null;
        return port;
    }

    function readStoredSshPortRangeConfig() {
        return {
            start: String(localStorage.getItem(SSH_PORT_RANGE_STORAGE_KEYS.start) || '').trim(),
            end: String(localStorage.getItem(SSH_PORT_RANGE_STORAGE_KEYS.end) || '').trim(),
        };
    }

    function persistSshPortRangeConfig(config) {
        if (!config || typeof config !== 'object') return;

        if (Object.prototype.hasOwnProperty.call(config, 'start')) {
            const startValue = String(config.start || '').trim();
            if (startValue) localStorage.setItem(SSH_PORT_RANGE_STORAGE_KEYS.start, startValue);
            else localStorage.removeItem(SSH_PORT_RANGE_STORAGE_KEYS.start);
        }

        if (Object.prototype.hasOwnProperty.call(config, 'end')) {
            const endValue = String(config.end || '').trim();
            if (endValue) localStorage.setItem(SSH_PORT_RANGE_STORAGE_KEYS.end, endValue);
            else localStorage.removeItem(SSH_PORT_RANGE_STORAGE_KEYS.end);
        }
    }

    function getSshPortRangeConfig() {
        const startEl = document.getElementById('ssh-port-range-start-input');
        const endEl = document.getElementById('ssh-port-range-end-input');
        const rawStart = String(startEl ? startEl.value : '').trim();
        const rawEnd = String(endEl ? endEl.value : '').trim();

        const isBlank = !rawStart && !rawEnd;
        const start = toValidPortNumber(rawStart);
        const end = toValidPortNumber(rawEnd);
        const isComplete = start !== null && end !== null;
        const isValid = isComplete && start <= end;

        return {
            rawStart: rawStart,
            rawEnd: rawEnd,
            start: start,
            end: end,
            isBlank: isBlank,
            isComplete: isComplete,
            isValid: isValid,
        };
    }

    function refreshSshPortRangePreview() {
        const config = getSshPortRangeConfig();
        const previewEl = document.getElementById('ssh-port-range-preview');
        const statusEl = document.getElementById('ssh-port-range-status');

        if (previewEl) {
            if (config.isBlank) {
                previewEl.value = [
                    '# Leave blank to omit ports from YAML',
                    'ports:',
                    '  - 3022:22',
                ].join('\n');
            } else if (!config.isValid) {
                previewEl.value = [
                    '# Invalid SSH port range',
                    '# Start and end must both be set, and start must be <= end',
                ].join('\n');
            } else {
                previewEl.value = [
                    '# Each node gets a sequential host port mapped to container port 22',
                    'ports:',
                    `  - ${config.start}:22`,
                ].join('\n');
            }
        }

        if (statusEl) {
            if (config.isBlank) {
                statusEl.textContent = 'No SSH port range configured. ports will be omitted from YAML.';
                statusEl.style.color = '#64748b';
            } else if (!config.isValid) {
                statusEl.textContent = 'Invalid SSH port range. Set both start and end, and ensure start <= end.';
                statusEl.style.color = '#b91c1c';
            } else {
                const count = (config.end - config.start) + 1;
                statusEl.textContent = `Using SSH host ports ${config.start}-${config.end} (${count} slots). Each node maps to :22.`;
                statusEl.style.color = '#64748b';
            }
        }

        persistSshPortRangeConfig({ start: config.rawStart, end: config.rawEnd });
        return config;
    }

    function initSshPortRangeSettingsUI() {
        const stored = readStoredSshPortRangeConfig();
        const startEl = document.getElementById('ssh-port-range-start-input');
        const endEl = document.getElementById('ssh-port-range-end-input');

        if (startEl) {
            startEl.value = stored.start;
            startEl.addEventListener('input', refreshSshPortRangePreview);
            startEl.addEventListener('change', refreshSshPortRangePreview);
        }
        if (endEl) {
            endEl.value = stored.end;
            endEl.addEventListener('input', refreshSshPortRangePreview);
            endEl.addEventListener('change', refreshSshPortRangePreview);
        }

        refreshSshPortRangePreview();
    }

    function updateRemoteSessionState(session) {
        if (!session || typeof session !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(session, 'serverUrl')) {
            remoteServerUrl = String(session.serverUrl || '').trim();
            AppState.remote.serverUrl = remoteServerUrl;
        }
        if (Object.prototype.hasOwnProperty.call(session, 'token')) {
            remoteAuthToken = String(session.token || '').trim();
            AppState.remote.authToken = remoteAuthToken;
        }
        if (Object.prototype.hasOwnProperty.call(session, 'password')) {
            remotePasswordCache = String(session.password || '');
            AppState.remote.passwordCache = remotePasswordCache;
        }
    }

    function readStoredDeployedExports() {
        try {
            const raw = localStorage.getItem(DEPLOYED_EXPORTS_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            Logger.warn('Failed to read deployed export cache:', e);
            return {};
        }
    }

    function writeStoredDeployedExports(payload) {
        try {
            localStorage.setItem(DEPLOYED_EXPORTS_KEY, JSON.stringify(payload || {}));
        } catch (e) {
            Logger.warn('Failed to write deployed export cache:', e);
        }
    }

    function persistDeployedExport(labId, exportData) {
        const normalizedLabId = String(labId || '').trim();
        if (!normalizedLabId || !exportData || typeof exportData !== 'object') return;
        const cache = readStoredDeployedExports();
        cache[normalizedLabId] = {
            savedAt: Date.now(),
            exportData: exportData,
        };
        writeStoredDeployedExports(cache);
    }

    function readDeployedExport(labId) {
        const normalizedLabId = String(labId || '').trim();
        if (!normalizedLabId) return null;
        const cache = readStoredDeployedExports();
        const entry = cache[normalizedLabId];
        if (!entry || typeof entry !== 'object') return null;
        const exportData = entry.exportData;
        return (exportData && typeof exportData === 'object') ? exportData : null;
    }

    function deleteDeployedExport(labId) {
        const normalizedLabId = String(labId || '').trim();
        if (!normalizedLabId) return;
        const cache = readStoredDeployedExports();
        if (!Object.prototype.hasOwnProperty.call(cache, normalizedLabId)) return;
        delete cache[normalizedLabId];
        writeStoredDeployedExports(cache);
    }

    function parseHostPortFromYamlPortMapping(portMapping) {
        const text = String(portMapping || '').trim();
        if (!text) return null;

        const withoutProto = text.split('/')[0].trim();
        const parts = withoutProto.split(':').map(function(part) { return String(part || '').trim(); }).filter(Boolean);
        if (parts.length < 2) return null;

        const hostPort = Number(parts.length === 2 ? parts[0] : parts[parts.length - 2]);
        if (!Number.isFinite(hostPort) || hostPort <= 0) return null;
        return Math.trunc(hostPort);
    }

    function buildYamlPortIndex(exportData) {
        const index = {};
        const nodes = exportData && exportData.topology && exportData.topology.nodes && typeof exportData.topology.nodes === 'object'
            ? exportData.topology.nodes
            : {};

        Object.keys(nodes).forEach(function(nodeName) {
            const node = nodes[nodeName] || {};
            const portMappings = Array.isArray(node.ports) ? node.ports : [];
            for (let i = 0; i < portMappings.length; i += 1) {
                const hostPort = parseHostPortFromYamlPortMapping(portMappings[i]);
                if (hostPort) {
                    index[String(nodeName || '').trim()] = hostPort;
                    break;
                }
            }
        });

        return index;
    }

    function buildSequentialYamlPortIndex(nodeNames) {
        const config = getSshPortRangeConfig();
        if (!config.isValid) return {};

        const normalizedNodeNames = Array.isArray(nodeNames)
            ? nodeNames.map(function(name) { return String(name || '').trim(); }).filter(Boolean).sort(function(a, b) {
                return a.localeCompare(b);
            })
            : [];

        const index = {};
        normalizedNodeNames.forEach(function(nodeName, offset) {
            const hostPort = config.start + offset;
            if (hostPort > config.end) return;
            index[nodeName] = hostPort;
        });
        return index;
    }

    function resolveYamlPortIndexForLab(labId, runtimeNodes) {
        const deployedExport = readDeployedExport(labId);
        const fromCache = buildYamlPortIndex(deployedExport);
        if (Object.keys(fromCache).length > 0) {
            return {
                portIndex: fromCache,
                source: 'deployed YAML cache',
            };
        }

        const currentExport = buildExportTopologyData();
        const currentExportLabName = String(currentExport && currentExport.name || '').trim();
        if (currentExport && currentExportLabName === String(labId || '').trim()) {
            const fromCurrentExport = buildYamlPortIndex(currentExport);
            if (Object.keys(fromCurrentExport).length > 0) {
                return {
                    portIndex: fromCurrentExport,
                    source: 'current editor YAML',
                };
            }
        }

        const shortNames = Array.isArray(runtimeNodes)
            ? runtimeNodes.map(function(nodeRuntime) {
                return shortenRuntimeNodeName(labId, nodeRuntime && nodeRuntime.name);
            })
            : [];
        const fromRange = buildSequentialYamlPortIndex(shortNames);
        if (Object.keys(fromRange).length > 0) {
            return {
                portIndex: fromRange,
                source: 'configured port range',
            };
        }

        return {
            portIndex: {},
            source: 'none',
        };
    }

    function getLabIdFromInput() {
        const el = document.getElementById('lab-name-input');
        const value = el ? String(el.value || '').trim() : '';
        return value || null;
    }

    function summarizeLabState(runtime) {
        const rawStatus = String((runtime && runtime.status) || '').trim().toLowerCase();
        const nodes = Array.isArray(runtime && runtime.nodes_runtime) ? runtime.nodes_runtime : [];
        const runningNodes = nodes.filter(n => String((n && n.state) || '').toLowerCase() === 'running').length;
        const totalNodes = nodes.length;

        const uptimeCandidates = nodes
            .map(n => String((n && n.status) || '').trim())
            .filter(Boolean)
            .filter(text => /^up\s+/i.test(text));
        const uptimeSummary = uptimeCandidates.length > 0 ? uptimeCandidates[0] : '';

        const status = rawStatus || (totalNodes > 0 && runningNodes === totalNodes ? 'running' : (totalNodes > 0 ? 'deploying' : 'unknown'));
        const labName = (runtime && (runtime.lab_name || runtime.lab_id)) || currentLabId || '-';
        const nodeSummary = totalNodes > 0 ? `running ${runningNodes}/${totalNodes}` : 'No nodes reported';
        const detailParts = [labName, nodeSummary];
        if (uptimeSummary) detailParts.push(uptimeSummary);
        const detail = detailParts.join(' · ');
        return { status, detail };
    }

    function resolveLabId(candidate) {
        if (!candidate || typeof candidate !== 'object') return null;
        const raw = candidate.lab_id || candidate.id || candidate.lab_name || candidate.name || candidate.lab;
        const value = String(raw || '').trim();
        return value || null;
    }

    async function refreshCurrentLabStatus(labIdHint) {
        const targetLabId = String(labIdHint || currentLabId || getLabIdFromInput() || '').trim();
        if (!targetLabId) {
            setLabRuntimeIndicator('idle', 'No active lab');
            setDeploymentAccessStatus('Lab is not running. No connectable instances.', true);
            renderDeploymentAccessRows([]);
            return null;
        }

        try {
            const response = await clabFetch(`/labs/${encodeURIComponent(targetLabId)}`);
            const payload = await parseApiResponse(response);
            if (response.status === 404) {
                setLabRuntimeIndicator('not-found', `${targetLabId} · not running or not found`);
                setDeploymentAccessStatus(`Lab ${targetLabId} is not running. No connectable instances.`, true);
                renderDeploymentAccessRows([]);
                return null;
            }

            ensureClabResponseOk(response, payload, `Failed to inspect lab ${targetLabId}`);
            const runtime = (payload && typeof payload === 'object') ? payload : {};
            updateCurrentLabId(runtime.lab_id || runtime.lab_name || targetLabId);
            const summary = summarizeLabState(runtime);
            setLabRuntimeIndicator(summary.status, summary.detail);
            refreshDeploymentAccessPanel(currentLabId, { silent: true }).catch(function(error) {
                Logger.warn('Failed to auto-refresh deployment access panel:', error);
            });
            return runtime;
        } catch (error) {
            setLabRuntimeIndicator('error', `Status check failed · ${error.message || error}`);
            throw error;
        }
    }

    async function refreshLabStatusNow() {
        if (!remoteServerUrl || !remoteAuthToken) {
            setLabRuntimeIndicator('idle', 'Connect to a remote server');
            return null;
        }

        const preferredLabId = String(currentLabId || getLabIdFromInput() || '').trim();
        if (preferredLabId) {
            try {
                return await refreshCurrentLabStatus(preferredLabId);
            } catch (error) {
                return null;
            }
        }

        try {
            const response = await clabFetch('/labs');
            const payload = await parseApiResponse(response);
            ensureClabResponseOk(response, payload, 'Failed to fetch labs');
            const data = (payload && typeof payload === 'object') ? payload : {};
            const labs = Array.isArray(data.labs) ? data.labs : [];

            if (labs.length === 0) {
                updateCurrentLabId(null);
                setLabRuntimeIndicator('not-running', 'No running labs');
                return null;
            }

            updateCurrentLabId(resolveLabId(labs[0]));
            if (!currentLabId) {
                setLabRuntimeIndicator('unknown', 'Lab discovered but identifier missing');
                return null;
            }

            return await refreshCurrentLabStatus(currentLabId);
        } catch (error) {
            setLabRuntimeIndicator('error', `Status check failed · ${error.message || error}`);
            return null;
        }
    }

    function parseJwtExpiryEpoch(token) {
        const raw = String(token || '').trim();
        if (!raw) return null;
        const parts = raw.split('.');
        if (parts.length < 2) return null;
        try {
            const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = payloadBase64 + '='.repeat((4 - payloadBase64.length % 4) % 4);
            const payloadJson = atob(padded);
            const payload = JSON.parse(payloadJson);
            const exp = Number(payload && payload.exp);
            return Number.isFinite(exp) ? exp : null;
        } catch (e) {
            return null;
        }
    }

    function isTokenExpired(token) {
        const exp = parseJwtExpiryEpoch(token);
        if (!exp) return false;
        const nowEpoch = Math.floor(Date.now() / 1000);
        return nowEpoch >= exp;
    }

    function getTokenExpiresInSeconds(token) {
        const exp = parseJwtExpiryEpoch(token);
        if (!exp) return null;
        const nowEpoch = Math.floor(Date.now() / 1000);
        return exp - nowEpoch;
    }

    const RemoteSessionManager = window.createRemoteSessionManager({
        getRemoteServerUrl: function() { return remoteServerUrl; },
        getRemoteAuthToken: function() { return remoteAuthToken; },
        getRemotePasswordCache: function() { return remotePasswordCache; },
        updateRemoteSessionState: updateRemoteSessionState,
        readStoredRemoteSession: readStoredRemoteSession,
        persistRemoteSession: persistRemoteSession,
        hasRemoteSession: hasRemoteSession,
        isTokenExpired: isTokenExpired,
        getTokenExpiresInSeconds: getTokenExpiresInSeconds,
        getCurrentLabId: function() { return currentLabId; },
        refreshDeploymentAccessPanel: refreshDeploymentAccessPanel,
        refreshLabStatusNow: refreshLabStatusNow,
        setServerAuthStatus: setServerAuthStatus,
        setRemoteApiIndicator: setRemoteApiIndicator,
        setRemoteMetrics: setRemoteMetrics,
        setLabRuntimeIndicator: setLabRuntimeIndicator,
        getRemoteMetricsTimer: function() { return remoteMetricsTimer; },
        setRemoteMetricsTimer: function(v) { remoteMetricsTimer = v; },
        getLabStatusTimer: function() { return labStatusTimer; },
        setLabStatusTimer: function(v) { labStatusTimer = v; },
        getTokenRefreshTimer: function() { return tokenRefreshTimer; },
        setTokenRefreshTimer: function(v) { tokenRefreshTimer = v; },
        getTokenRefreshInFlight: function() { return tokenRefreshInFlight; },
        setTokenRefreshInFlight: function(v) { tokenRefreshInFlight = v; },
        logWarn: Logger.warn,
    });
    const RenderHelpers = window.NextUIRenderHelpers || null;
    const InteractionController = (typeof window.createInteractionController === 'function')
        ? window.createInteractionController({})
        : null;

    function switchMainTab(tabName) {
        activeMainTab = tabName === 'server' ? 'server' : 'topology';
        AppState.ui.activeMainTab = activeMainTab;
        const topologyPanel = document.getElementById('controls-topology');
        const serverPanel = document.getElementById('controls-server');
        const topologyContainer = document.getElementById('topologyContainer');
        const topologyBtn = document.getElementById('tab-btn-topology');
        const serverBtn = document.getElementById('tab-btn-server');

        const showTopology = tabName === 'topology';
        const showServer = tabName === 'server';

        if (topologyPanel) topologyPanel.classList.toggle('hidden', !showTopology);
        if (serverPanel) serverPanel.classList.toggle('hidden', !showServer);
        if (topologyContainer) topologyContainer.classList.toggle('hidden', showServer);
        if (showServer) setDeploymentAccessPanelVisible(false);
        if (showTopology && deploymentAccessPanelRequested) setDeploymentAccessPanelVisible(true);

        if (topologyBtn) topologyBtn.classList.toggle('active', showTopology);
        if (serverBtn) serverBtn.classList.toggle('active', showServer);
    }

    function ensureDebugOverlay() {
        if (debugOverlayEl) return debugOverlayEl;
        debugOverlayEl = document.createElement('div');
        debugOverlayEl.style.position = 'fixed';
        debugOverlayEl.style.right = '12px';
        debugOverlayEl.style.bottom = '12px';
        debugOverlayEl.style.minWidth = '260px';
        debugOverlayEl.style.maxWidth = '360px';
        debugOverlayEl.style.padding = '10px 12px';
        debugOverlayEl.style.background = 'rgba(18, 18, 18, 0.9)';
        debugOverlayEl.style.color = '#9df7c4';
        debugOverlayEl.style.border = '1px solid #2e7d32';
        debugOverlayEl.style.borderRadius = '8px';
        debugOverlayEl.style.font = '12px/1.4 Menlo, Monaco, monospace';
        debugOverlayEl.style.zIndex = '3000';
        debugOverlayEl.style.pointerEvents = 'none';
        debugOverlayEl.style.whiteSpace = 'pre-wrap';
        debugOverlayEl.style.display = 'none';
        document.body.appendChild(debugOverlayEl);
        return debugOverlayEl;
    }

    function getDebugHitCircle(surface) {
        if (!surface) return null;
        if (!debugHitCircleEl || debugHitCircleEl.parentElement !== surface) {
            debugHitCircleEl = document.createElement('div');
            debugHitCircleEl.id = 'nextui-debug-hit-circle';
            debugHitCircleEl.style.position = 'absolute';
            debugHitCircleEl.style.border = '2px dashed rgba(255, 165, 0, 0.95)';
            debugHitCircleEl.style.borderRadius = '50%';
            debugHitCircleEl.style.pointerEvents = 'none';
            debugHitCircleEl.style.zIndex = '1200';
            debugHitCircleEl.style.display = 'none';
            surface.appendChild(debugHitCircleEl);
        }
        return debugHitCircleEl;
    }

    function showDebugHitCircle(clientX, clientY, radius) {
        if (!debugMode) return;
        const surface = getTopologySurfaceElement();
        if (!surface) return;
        const rect = surface.getBoundingClientRect();
        const cx = clientX - rect.left;
        const cy = clientY - rect.top;
        const circle = getDebugHitCircle(surface);
        if (!circle) return;
        circle.style.width = `${radius * 2}px`;
        circle.style.height = `${radius * 2}px`;
        circle.style.left = `${cx - radius}px`;
        circle.style.top = `${cy - radius}px`;
        circle.style.display = 'block';
    }

    function hideDebugVisuals() {
        if (debugOverlayEl) {
            debugOverlayEl.style.display = 'none';
        }
        if (debugHitCircleEl) {
            debugHitCircleEl.style.display = 'none';
        }
    }

    function updateDebugOverlay(info) {
        if (!debugMode) return;
        const overlay = ensureDebugOverlay();
        overlay.style.display = 'block';
        overlay.textContent = [
            'next_ui debug',
            `mode=${editorMode}`,
            `event=${info.event || '-'}`,
            `client=(${info.clientX ?? '-'}, ${info.clientY ?? '-'})`,
            `radius=${info.radius ?? '-'}`,
            `nearest=${info.nearestId || 'none'}`,
            `dist=${Number.isFinite(info.distance) ? info.distance.toFixed(1) : '-'}`,
            `selected=${selectedNodeInfo && selectedNodeInfo.id ? selectedNodeInfo.id : '-'}`,
        ].join('\n');
    }

    function setDebugMode(enabled) {
        debugMode = !!enabled;
        if (debugMode) {
            ensureDebugOverlay();
            updateDebugOverlay({ event: 'debug-on' });
        } else {
            hideDebugVisuals();
        }
    }

    function toggleDebugOverlay() {
        setDebugMode(!debugMode);
    }

    // Editor state
    let editorMode = 'view';         // 'view' | 'addLink' | 'delete'
    let linkSourceNodeId = null;     // first node selected in addLink mode
    let suppressNodeDetails = false; // block node detail popup while linking
    const nodeInterfaceCounters = new Map();  // nodeId -> interface counter

    // Kind → default image and icon mapping
    const KIND_DEFAULTS = {
        'linux':          { image: 'ubuntu:20.04',                    icon: 'host'   },
        'nokia_srlinux':  { image: 'ghcr.io/nokia/srlinux:latest',    icon: 'router' },
        'cisco_xrd':      { image: '',                                 icon: 'router' },
        'cisco_iol':      { image: '',                                 icon: 'router' },
        'k8s-kind':       { image: '',                                 icon: 'cloud'  },
        'vr-xrv':         { image: 'vrnetlab/vr-xrv:7.8.1',           icon: 'router' },
        'ceos':           { image: 'ceos:4.31.0F',                    icon: 'switch' },
        'bridge':         { image: '',                                 icon: 'switch' },
    };
    const CLAB_SUPPORTED_KINDS = [
        'linux', 'bridge', 'host', 'ovs-bridge',
        'cisco_xrd', 'cisco_iol',
        'k8s-kind',
        'nokia_srlinux', 'vr-sros', 'sros',
        'vr-xrv', 'xrv9k', 'c8000v', 'csr1000v', 'cat9kv', 'nxos',
        'ceos', 'veos',
        'vr-vmx', 'vr-vqfx', 'vr-vsrx',
        'sonic-vs', 'vyos', 'fortinet_fortigate'
    ];

    function getMappedImageForKind(kind) {
        const k = String(kind || '').trim();
        if (!k) return '';
        const mapped = kindImageRegistry[k];
        if (mapped && typeof mapped === 'object' && mapped.image) return String(mapped.image || '').trim();
        return (KIND_DEFAULTS[k] && KIND_DEFAULTS[k].image) ? KIND_DEFAULTS[k].image : '';
    }

    function getMappedLoginNameForKind(kind) {
        const k = String(kind || '').trim();
        if (!k) return String(defaultLoginName || 'admin').trim();
        const mapped = kindImageRegistry[k];
        if (mapped && typeof mapped === 'object' && mapped.login_name) {
            return String(mapped.login_name || '').trim();
        }
        return String(defaultLoginName || 'admin').trim();
    }

    function getRegisteredKindEntries() {
        return Object.keys(kindImageRegistry)
            .map(function(kind) {
                const mapping = kindImageRegistry[kind] || {};
                return {
                    kind,
                    image: String(mapping.image || '').trim(),
                    login_name: String(mapping.login_name || defaultLoginName || '').trim(),
                };
            })
            .filter(function(item) {
                return !!item.kind && !!item.image;
            })
            .sort(function(a, b) {
                return a.kind.localeCompare(b.kind);
            });
    }

    function getRegisteredImageForKind(kind) {
        const k = String(kind || '').trim();
        if (!k) return '';
        const mapping = kindImageRegistry[k] || {};
        return String(mapping.image || '').trim();
    }

    function refreshAddNodeKindOptions(preferredKind) {
        const kindSelect = document.getElementById('nodeKind');
        const imageSelect = document.getElementById('nodeImage');
        if (!kindSelect || !imageSelect) return false;

        const entries = getRegisteredKindEntries();
        if (entries.length === 0) {
            kindSelect.innerHTML = '<option value="">No registered kinds</option>';
            imageSelect.innerHTML = '<option value="">No registered images</option>';
            return false;
        }

        kindSelect.innerHTML = entries.map(function(entry) {
            return `<option value="${entry.kind}">${entry.kind}</option>`;
        }).join('');

        const targetKind = preferredKind && entries.some(function(e) { return e.kind === preferredKind; })
            ? preferredKind
            : entries[0].kind;
        kindSelect.value = targetKind;
        onKindChange();
        return true;
    }

    function setKindImageStatus(message, isError) {
        const el = document.getElementById('kind-image-status');
        if (!el) return;
        el.textContent = message || '';
        el.style.color = isError ? '#b91c1c' : '#64748b';
    }

    async function loadKindImageRegistryFromServer() {
        try {
            const response = await fetch('/api/settings/kind-image-login');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload && payload.detail ? payload.detail : `HTTP ${response.status}`);
            }

            const mappings = payload && typeof payload.mappings === 'object' ? payload.mappings : {};
            kindImageRegistry = {};
            resetInterfaceNamingRegistry();
            Object.keys(mappings).forEach(function(kind) {
                const item = mappings[kind];
                if (!item || typeof item !== 'object') return;
                const image = String(item.image || '').trim();
                const loginName = String(item.login_name || '').trim();
                if (!image) return;
                const kindKey = String(kind).trim();
                const entry = {
                    image: image,
                    login_name: loginName || String(payload.default_login_name || 'admin').trim() || 'admin',
                };

                const interfaceRule = normalizeInterfaceRulePayload(item.interface_rule);
                if (interfaceRule) {
                    entry.interface_rule = interfaceRule;
                    INTERFACE_NAMING_RULES[kindKey] = interfaceRule;
                }

                const reservedList = normalizeReservedInterfacesPayload(item.reserved_interfaces);
                if (reservedList.length > 0) {
                    entry.reserved_interfaces = reservedList.slice();
                    RESERVED_INTERFACES_BY_KIND[kindKey] = new Set(reservedList);
                }

                kindImageRegistry[kindKey] = entry;
            });

            defaultLoginName = String(payload.default_login_name || 'admin').trim() || 'admin';
            const defaultLoginEl = document.getElementById('registry-login-input');
            if (defaultLoginEl && !String(defaultLoginEl.value || '').trim()) {
                defaultLoginEl.value = defaultLoginName;
            }
            return true;
        } catch (error) {
            setKindImageStatus(`Failed to load server registry: ${error.message || error}`, true);
            kindImageRegistry = {};
            defaultLoginName = 'admin';
            resetInterfaceNamingRegistry();
            return false;
        }
    }

    function renderKindImageRegistry() {
        const body = document.getElementById('kind-image-mapping-body');
        if (!body) return;

        if (RenderHelpers && typeof RenderHelpers.buildKindImageRegistryRows === 'function') {
            body.innerHTML = RenderHelpers.buildKindImageRegistryRows(kindImageRegistry, defaultLoginName, escapeHtml);
            return;
        }

        const keys = Object.keys(kindImageRegistry).sort();
        if (keys.length === 0) {
            body.innerHTML = '<tr><td colspan="5">No mappings registered.</td></tr>';
            return;
        }

        body.innerHTML = keys.map(function(kind) {
            const item = kindImageRegistry[kind] || {};
            const image = String(item.image || '').trim();
            const loginName = String(item.login_name || defaultLoginName || 'admin').trim() || 'admin';
            const rule = item.interface_rule && typeof item.interface_rule === 'object' ? item.interface_rule : {};
            const prefix = String(rule.prefix || '').trim();
            const start = Number(rule.start);
            const max = Number(rule.max);
            const style = String(rule.style || '').trim();
            const ruleText = (prefix && Number.isFinite(start) && Number.isFinite(max))
                ? `${style ? `${style} | ` : ''}${prefix}[${start}..${start + max - 1}]`
                : '-';
            const reserved = Array.isArray(item.reserved_interfaces)
                ? item.reserved_interfaces.map(function(v) { return String(v || '').trim(); }).filter(Boolean)
                : [];
            const reservedText = reserved.length > 0 ? reserved.join(', ') : '-';
            return `<tr><td>${escapeHtml(kind)}</td><td>${escapeHtml(image)}</td><td>${escapeHtml(loginName)}</td><td>${escapeHtml(ruleText)}</td><td>${escapeHtml(reservedText)}</td></tr>`;
        }).join('');
    }

    function getRegistryFormInterfaceRule() {
        const styleEl = document.getElementById('registry-if-style-input');
        const prefixEl = document.getElementById('registry-if-prefix-input');
        const startEl = document.getElementById('registry-if-start-input');
        const maxEl = document.getElementById('registry-if-max-input');

        const style = String(styleEl && styleEl.value || '').trim();
        const prefix = String(prefixEl && prefixEl.value || '').trim();
        const start = Number(startEl && startEl.value);
        const max = Number(maxEl && maxEl.value);
        if (!prefix || !Number.isFinite(start) || !Number.isFinite(max) || max <= 0) {
            return null;
        }
        const rule = {
            prefix: prefix,
            start: Math.trunc(start),
            max: Math.trunc(max),
        };
        if (style) rule.style = style;
        return rule;
    }

    function getRegistryFormReservedInterfaces() {
        const reservedEl = document.getElementById('registry-if-reserved-input');
        const text = String(reservedEl && reservedEl.value || '').trim();
        if (!text) return [];
        return normalizeReservedInterfacesPayload(text.split(','));
    }

    function populateRegistryFormByKind(kind) {
        const kindKey = String(kind || '').trim();
        const imageEl = document.getElementById('registry-image-input');
        const loginEl = document.getElementById('registry-login-input');
        const styleEl = document.getElementById('registry-if-style-input');
        const prefixEl = document.getElementById('registry-if-prefix-input');
        const startEl = document.getElementById('registry-if-start-input');
        const maxEl = document.getElementById('registry-if-max-input');
        const reservedEl = document.getElementById('registry-if-reserved-input');

        if (imageEl) imageEl.value = getMappedImageForKind(kindKey);
        if (loginEl) loginEl.value = getMappedLoginNameForKind(kindKey);

        const rule = getInterfaceRule(kindKey);
        if (styleEl) styleEl.value = String(rule.style || '').trim();
        if (prefixEl) prefixEl.value = String(rule.prefix || '').trim();
        if (startEl) startEl.value = String(Number(rule.start) || 0);
        if (maxEl) maxEl.value = String(Number(rule.max) || 8);

        const reserved = Array.from(RESERVED_INTERFACES_BY_KIND[kindKey] || []);
        if (reservedEl) reservedEl.value = reserved.join(', ');

        refreshKindYamlInterpretationPreview();
    }

    function refreshKindYamlInterpretationPreview() {
        const outputEl = document.getElementById('registry-yaml-preview');
        if (!outputEl) return;

        const kindEl = document.getElementById('registry-kind-select');
        const kindKey = String(kindEl && kindEl.value || '').trim() || 'linux';
        const srcEl = document.getElementById('registry-test-src-if');
        const tgtEl = document.getElementById('registry-test-tgt-if');
        const srcRaw = String(srcEl && srcEl.value || '').trim() || 'eth0';
        const tgtRaw = String(tgtEl && tgtEl.value || '').trim() || 'eth1';

        const rule = getRegistryFormInterfaceRule() || getInterfaceRule(kindKey);
        const reservedList = getRegistryFormReservedInterfaces();
        const reservedSet = new Set(reservedList);

        const srcNormalized = normalizeInterfaceNameByRule(kindKey, srcRaw, rule, reservedSet);
        const tgtNormalized = normalizeInterfaceNameByRule(kindKey, tgtRaw, rule, reservedSet);

        const style = String(rule.style || '').trim();
        const summary = `${style ? `${style} | ` : ''}${rule.prefix}[${rule.start}..${rule.start + rule.max - 1}]`;
        const reservedText = reservedList.length > 0 ? reservedList.join(', ') : '-';

        outputEl.value = [
            `# Kind Registry YAML interpretation preview`,
            `kind: ${kindKey}`,
            `rule: ${summary}`,
            `reserved: ${reservedText}`,
            ``,
            `input source_if: ${srcRaw}`,
            `input target_if: ${tgtRaw}`,
            `normalized source_if: ${srcNormalized}`,
            `normalized target_if: ${tgtNormalized}`,
            ``,
            `# Exported endpoint example`,
            `- endpoints: ["node-a:${srcNormalized}", "node-b:${tgtNormalized}"]`
        ].join('\n');
    }

    async function initKindImageRegistryUI() {
        await loadKindImageRegistryFromServer();

        const selectEl = document.getElementById('registry-kind-select');
        if (selectEl) {
            const options = Array.from(new Set(CLAB_SUPPORTED_KINDS.concat(Object.keys(KIND_DEFAULTS)))).sort();
            selectEl.innerHTML = options.map(function(kind) {
                return `<option value="${kind}">${kind}</option>`;
            }).join('');

            if (options.includes('linux')) selectEl.value = 'linux';
            selectEl.addEventListener('change', function() {
                populateRegistryFormByKind(selectEl.value);
            });
        }

        [
            'registry-if-prefix-input',
            'registry-if-style-input',
            'registry-if-start-input',
            'registry-if-max-input',
            'registry-if-reserved-input',
            'registry-test-src-if',
            'registry-test-tgt-if',
        ].forEach(function(id) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', refreshKindYamlInterpretationPreview);
            el.addEventListener('change', refreshKindYamlInterpretationPreview);
        });

        if (selectEl) {
            populateRegistryFormByKind(selectEl.value);
        }

        renderKindImageRegistry();
        refreshAddNodeKindOptions('linux');
    }

    async function saveKindImageMapping() {
        const selectEl = document.getElementById('registry-kind-select');
        const imageEl = document.getElementById('registry-image-input');
        const loginEl = document.getElementById('registry-login-input');
        if (!selectEl || !imageEl || !loginEl) return;

        const kind = String(selectEl.value || '').trim();
        const image = String(imageEl.value || '').trim();
        const loginName = String(loginEl.value || '').trim();
        const interfaceRule = getRegistryFormInterfaceRule();
        const reservedInterfaces = getRegistryFormReservedInterfaces();
        if (!kind) {
            setKindImageStatus('Kind is required.', true);
            return;
        }
        if (!image) {
            setKindImageStatus('Image is required.', true);
            return;
        }
        if (!loginName) {
            setKindImageStatus('Initial login_name is required.', true);
            return;
        }
        if (!interfaceRule) {
            setKindImageStatus('Interface rule requires prefix/start/max.', true);
            return;
        }

        try {
            const defaultResp = await fetch('/api/settings/default-login-name', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ login_name: loginName }),
            });
            const defaultData = await defaultResp.json();
            if (!defaultResp.ok) {
                throw new Error(defaultData && defaultData.detail ? defaultData.detail : `HTTP ${defaultResp.status}`);
            }
            defaultLoginName = String(defaultData.default_login_name || loginName).trim() || loginName;

            const response = await fetch('/api/settings/kind-image-login', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    image,
                    login_name: loginName,
                    interface_rule: interfaceRule,
                    reserved_interfaces: reservedInterfaces,
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload && payload.detail ? payload.detail : `HTTP ${response.status}`);
            }

            kindImageRegistry[kind] = {
                image,
                login_name: loginName,
                interface_rule: interfaceRule,
                reserved_interfaces: reservedInterfaces,
            };
            applyInterfaceNamingOverridesFromRegistry();
            renderKindImageRegistry();
            refreshAddNodeKindOptions(kind);
            populateRegistryFormByKind(kind);
            setKindImageStatus(`Saved mapping: ${kind} -> ${image} (${loginName})`, false);
        } catch (error) {
            setKindImageStatus(`Save failed: ${error.message || error}`, true);
        }
    }

    async function removeKindImageMapping() {
        const selectEl = document.getElementById('registry-kind-select');
        if (!selectEl) return;
        const kind = String(selectEl.value || '').trim();
        if (!kind) return;

        if (!kindImageRegistry[kind]) {
            setKindImageStatus(`No saved mapping found for ${kind}.`, true);
            return;
        }

        try {
            const response = await fetch(`/api/settings/kind-image-login/${encodeURIComponent(kind)}`, {
                method: 'DELETE',
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload && payload.detail ? payload.detail : `HTTP ${response.status}`);
            }

            delete kindImageRegistry[kind];
            defaultLoginName = String(payload.default_login_name || defaultLoginName || 'admin').trim() || 'admin';
            applyInterfaceNamingOverridesFromRegistry();
            renderKindImageRegistry();
            refreshAddNodeKindOptions();
            populateRegistryFormByKind(kind);
            setKindImageStatus(`Removed mapping for ${kind}.`, false);
        } catch (error) {
            setKindImageStatus(`Remove failed: ${error.message || error}`, true);
        }
    }

    function isValidIpv4(ip) {
        if (!ip || typeof ip !== 'string') return false;
        const octets = ip.split('.');
        if (octets.length !== 4) return false;
        return octets.every(function(part) {
            if (!/^\d+$/.test(part)) return false;
            const n = Number(part);
            return n >= 0 && n <= 255;
        });
    }

    function getOrAssignMgmtIp(nodeId, preferredIp) {
        if (!nodeId) return `${MGMT_IP_PREFIX}.254`;

        if (isValidIpv4(preferredIp)) {
            mgmtIpByNode.set(nodeId, preferredIp);
            return preferredIp;
        }

        if (mgmtIpByNode.has(nodeId)) {
            return mgmtIpByNode.get(nodeId);
        }

        const used = new Set(Array.from(mgmtIpByNode.values()));
        while (mgmtHostCounter < 255) {
            const candidate = `${MGMT_IP_PREFIX}.${mgmtHostCounter}`;
            mgmtHostCounter += 1;
            if (!used.has(candidate)) {
                mgmtIpByNode.set(nodeId, candidate);
                return candidate;
            }
        }

        const fallback = `${MGMT_IP_PREFIX}.254`;
        mgmtIpByNode.set(nodeId, fallback);
        return fallback;
    }

    function ensureNodeMgmtIp(nodeModel) {
        if (!nodeModel) return 'N/A';
        const raw = (nodeModel.getData && nodeModel.getData()) || {};
        const nodeId = raw.id || raw.name || (nodeModel.id ? nodeModel.id() : 'node');
        const assignedIp = getOrAssignMgmtIp(nodeId, raw.primaryIP);

        raw.primaryIP = assignedIp;
        if (typeof nodeModel.set === 'function') {
            nodeModel.set('primaryIP', assignedIp);
        }
        return assignedIp;
    }

    const DEFAULT_INTERFACE_NAMING_RULES = {
        linux:         { style: 'eth', prefix: 'eth', start: 0, max: 16 },
        host:          { style: 'eth', prefix: 'eth', start: 0, max: 16 },
        bridge:        { style: 'eth', prefix: 'eth', start: 0, max: 16 },
        'ovs-bridge':  { style: 'eth', prefix: 'eth', start: 0, max: 16 },
        'k8s-kind':    { style: 'eth', prefix: 'eth', start: 0, max: 16 },

        nokia_srlinux: { style: 'slot-port', prefix: 'ethernet-1/', start: 1, max: 32 },
        sros:          { style: 'slot-port', prefix: 'ethernet-1/', start: 1, max: 32 },
        'vr-sros':     { style: 'slot-port', prefix: 'ethernet-1/', start: 1, max: 32 },

        ceos:          { style: 'eth-cap', prefix: 'Ethernet', start: 1, max: 32 },
        veos:          { style: 'eth-cap', prefix: 'Ethernet', start: 1, max: 32 },
        nxos:          { style: 'mod-port', prefix: 'Ethernet1/', start: 1, max: 48 },

        'vr-xrv':      { style: 'xr-gi', prefix: 'GigabitEthernet0/0/0/', start: 0, max: 16 },
        xrv9k:         { style: 'xr-gi', prefix: 'GigabitEthernet0/0/0/', start: 0, max: 16 },
        cisco_xrd:     { style: 'xr-gi', prefix: 'GigabitEthernet0/0/0/', start: 0, max: 16 },

        cisco_iol:     { style: 'iol-eth', prefix: 'Ethernet0/', start: 1, max: 8 },
        csr1000v:      { style: 'gi-flat', prefix: 'GigabitEthernet', start: 2, max: 8 },
        c8000v:        { style: 'gi-flat', prefix: 'GigabitEthernet', start: 2, max: 8 },
        cat9kv:        { style: 'gi-mod-port', prefix: 'GigabitEthernet0/0/', start: 0, max: 8 },

        'vr-vmx':      { style: 'junos-ge', prefix: 'ge-0/0/', start: 0, max: 32 },
        'vr-vqfx':     { style: 'junos-ge', prefix: 'ge-0/0/', start: 0, max: 32 },
        'vr-vsrx':     { style: 'junos-ge', prefix: 'ge-0/0/', start: 0, max: 32 },
    };

    const DEFAULT_RESERVED_INTERFACES_BY_KIND = {
        cisco_iol: ['Ethernet0/0'],
    };

    let INTERFACE_NAMING_RULES = {};
    let RESERVED_INTERFACES_BY_KIND = {};

    function normalizeInterfaceRulePayload(rule) {
        if (!rule || typeof rule !== 'object') return null;
        const prefix = String(rule.prefix || '').trim();
        const start = Number(rule.start);
        const max = Number(rule.max);
        if (!prefix || !Number.isFinite(start) || !Number.isFinite(max) || max <= 0) {
            return null;
        }
        const style = String(rule.style || '').trim();
        const normalized = {
            prefix: prefix,
            start: Math.trunc(start),
            max: Math.trunc(max),
        };
        if (style) normalized.style = style;
        return normalized;
    }

    function normalizeReservedInterfacesPayload(value) {
        if (!Array.isArray(value)) return [];
        const out = [];
        const seen = new Set();
        value.forEach(function(item) {
            const label = String(item || '').trim();
            if (!label || seen.has(label)) return;
            seen.add(label);
            out.push(label);
        });
        return out;
    }

    function resetInterfaceNamingRegistry() {
        INTERFACE_NAMING_RULES = {};
        Object.keys(DEFAULT_INTERFACE_NAMING_RULES).forEach(function(kind) {
            const rule = DEFAULT_INTERFACE_NAMING_RULES[kind] || {};
            INTERFACE_NAMING_RULES[kind] = {
                style: String(rule.style || '').trim(),
                prefix: String(rule.prefix || '').trim(),
                start: Number(rule.start) || 0,
                max: Number(rule.max) || 8,
            };
        });

        RESERVED_INTERFACES_BY_KIND = {};
        Object.keys(DEFAULT_RESERVED_INTERFACES_BY_KIND).forEach(function(kind) {
            RESERVED_INTERFACES_BY_KIND[kind] = new Set(DEFAULT_RESERVED_INTERFACES_BY_KIND[kind] || []);
        });
    }

    function applyInterfaceNamingOverridesFromRegistry() {
        resetInterfaceNamingRegistry();
        Object.keys(kindImageRegistry || {}).forEach(function(kind) {
            const item = kindImageRegistry[kind] || {};
            const rule = normalizeInterfaceRulePayload(item.interface_rule);
            if (rule) {
                INTERFACE_NAMING_RULES[kind] = rule;
            }
            const reserved = normalizeReservedInterfacesPayload(item.reserved_interfaces);
            if (reserved.length > 0) {
                RESERVED_INTERFACES_BY_KIND[kind] = new Set(reserved);
            }
        });
    }

    resetInterfaceNamingRegistry();

    function getInterfaceRule(kind) {
        const key = String(kind || '').trim();
        return INTERFACE_NAMING_RULES[key] || INTERFACE_NAMING_RULES.linux;
    }

    function isReservedInterface(kind, ifName) {
        const key = String(kind || '').trim();
        const label = String(ifName || '').trim();
        if (!key || !label) return false;
        const reserved = RESERVED_INTERFACES_BY_KIND[key];
        return !!(reserved && reserved.has(label));
    }

    function formatInterfaceByRule(rule, offset) {
        const start = Number(rule.start) || 0;
        const n = start + Math.max(0, Number(offset) || 0);
        return `${rule.prefix}${n}`;
    }

    function peekNextInterface(nodeId, kind) {
        const count = nodeInterfaceCounters.get(nodeId) || 0;
        const rule = getInterfaceRule(kind);
        return formatInterfaceByRule(rule, count);
    }

    // Generate and consume next available interface name for a node
    function getNextInterface(nodeId, kind) {
        const next = peekNextInterface(nodeId, kind);
        const count = nodeInterfaceCounters.get(nodeId) || 0;
        nodeInterfaceCounters.set(nodeId, count + 1);
        return next;
    }

    function getInterfaceCandidates(kind, suggested) {
        const candidates = [];
        if (suggested && !isReservedInterface(kind, suggested)) candidates.push(suggested);

        const rule = getInterfaceRule(kind);
        const maxCount = Number(rule.max) || 8;
        for (let i = 0; i < maxCount; i++) {
            const ifName = formatInterfaceByRule(rule, i);
            if (!isReservedInterface(kind, ifName)) {
                candidates.push(ifName);
            }
        }

        return Array.from(new Set(candidates));
    }

    function getUsedInterfacesByNode() {
        const used = new Map();
        topo.eachLink(function(link) {
            const m = link.model();
            const raw = (m.getData && m.getData()) || {};
            const srcId = m.sourceID ? m.sourceID() : raw.source;
            const tgtId = m.targetID ? m.targetID() : raw.target;
            const srcIf = raw.srcIfName;
            const tgtIf = raw.tgtIfName;

            if (srcId && srcIf) {
                if (!used.has(srcId)) used.set(srcId, new Set());
                used.get(srcId).add(srcIf);
            }
            if (tgtId && tgtIf) {
                if (!used.has(tgtId)) used.set(tgtId, new Set());
                used.get(tgtId).add(tgtIf);
            }
        });
        return used;
    }

    function getNodeDisplayNameById(nodeId) {
        if (!nodeId || !topo || typeof topo.getNode !== 'function') return nodeId || 'unknown';
        const node = topo.getNode(nodeId);
        if (!node || !node.model) return nodeId;
        const raw = (node.model().getData && node.model().getData()) || {};
        return raw.name || raw.id || nodeId;
    }

    function getNodeConnectivityEntries(nodeId) {
        if (!nodeId || !topo) return [];
        const entries = [];

        topo.eachLink(function(link) {
            const m = link.model();
            const raw = (m.getData && m.getData()) || {};
            const srcId = m.sourceID ? m.sourceID() : raw.source;
            const tgtId = m.targetID ? m.targetID() : raw.target;
            const srcIf = raw.srcIfName || '-';
            const tgtIf = raw.tgtIfName || '-';

            if (srcId === nodeId) {
                entries.push({
                    localIf: srcIf,
                    peerId: tgtId,
                    peerName: getNodeDisplayNameById(tgtId),
                    peerIf: tgtIf,
                    direction: 'out'
                });
            } else if (tgtId === nodeId) {
                entries.push({
                    localIf: tgtIf,
                    peerId: srcId,
                    peerName: getNodeDisplayNameById(srcId),
                    peerIf: srcIf,
                    direction: 'in'
                });
            }
        });

        entries.sort(function(a, b) {
            const byPeer = String(a.peerName).localeCompare(String(b.peerName));
            if (byPeer !== 0) return byPeer;
            return String(a.localIf).localeCompare(String(b.localIf));
        });

        return entries;
    }

    function renderConnectivityMarkmap(nodeInfo, entries) {
        if (!nodeInfo) return '';

        if (!entries || entries.length === 0) {
            return `<div class="panel-section">
  <div class="section-label">Connectivity</div>
  <div class="section-content">
    <div class="connectivity-empty">No links connected.</div>
  </div>
</div>`;
        }

        // Group entries by peer for cleaner display
        const byPeer = new Map();
        entries.forEach(entry => {
            if (!byPeer.has(entry.peerId)) {
                byPeer.set(entry.peerId, { peerName: entry.peerName, links: [] });
            }
            byPeer.get(entry.peerId).links.push(entry);
        });

        const listItems = Array.from(byPeer.values()).map(peer => {
            const linkInfo = peer.links.map(link => 
                `<strong>${escapeHtml(link.localIf)}</strong> ↔ <span class="peer-if">${escapeHtml(link.peerIf)}</span>`
            ).join('<br>');
            return `<li>
  <span class="peer-name">${escapeHtml(peer.peerName)}</span>
  <div style="margin-top:3px;font-size:11px;">${linkInfo}</div>
</li>`;
        }).join('');

        return `<div class="panel-section">
  <div class="section-label">Connectivity (${entries.length} link${entries.length !== 1 ? 's' : ''})</div>
  <div class="section-content">
    <ul class="connectivity-list">${listItems}</ul>
  </div>
</div>`;
    }

    function suggestAvailableInterface(nodeId, kind) {
        const usedByNode = getUsedInterfacesByNode();
        const used = usedByNode.get(nodeId) || new Set();
        const candidates = getInterfaceCandidates(kind, peekNextInterface(nodeId, kind));
        for (let i = 0; i < candidates.length; i++) {
            if (!used.has(candidates[i])) {
                return candidates[i];
            }
        }
        return `${peekNextInterface(nodeId, kind)}-new`;
    }

    function splitInterfaceLabel(label) {
        if (!label) return ['', ''];
        const text = String(label);

        // Keep compact interface names on a single line (e.g., Ethernet0/0, Eth0).
        if (text.length <= 12) {
            return [text, ''];
        }

        // Common short patterns should remain single-line for readability.
        if (/^(?:Eth|eth|Gi|gi|Fa|fa|Te|te)\d+(?:\/\d+){0,3}$/.test(text)) {
            return [text, ''];
        }

        const m = text.match(/^([A-Za-z-]+)(.*)$/);
        if (m && m[2]) {
            return [m[1], m[2]];
        }
        if (text.length > 14) {
            return [text.slice(0, 14), text.slice(14)];
        }
        return [text, ''];
    }

    /**
     * API Helper Functions
     */
    function clabFetch(path, options) {
        const headers = Object.assign({
            'Content-Type': 'application/json',
        }, options && options.headers);
        if (remoteServerUrl) headers['X-Clab-Server'] = remoteServerUrl;
        if (remoteAuthToken) headers['X-Clab-Token'] = remoteAuthToken;
        return fetch(CLAB_API + path, Object.assign({}, options, { headers }));
    }

    async function parseApiResponse(response) {
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const raw = await response.text();

        if (!raw) return null;
        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(raw);
            } catch (e) {
                return raw;
            }
        }
        return raw;
    }

    function apiErrorFromResponse(response, payload, fallbackMessage) {
        const base = fallbackMessage || `HTTP ${response.status}`;
        if (!payload) return `${base} (status=${response.status})`;
        if (typeof payload === 'string') return `${base}: ${payload}`;
        if (typeof payload === 'object') {
            const detail = payload.detail || payload.message || payload.error;
            if (detail) {
                return `${base}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
            }
            return `${base}: ${JSON.stringify(payload)}`;
        }
        return `${base}: ${String(payload)}`;
    }

    function ensureClabResponseOk(response, payload, fallbackMessage, options) {
        if (response.ok) return;
        const affectServerStatus = !(options && options.affectServerStatus === false);
        const message = apiErrorFromResponse(response, payload, fallbackMessage);
        if (affectServerStatus && response.status === 400) {
            // Surface backend server-target/configuration issues clearly in Server Auth UI.
            setRemoteApiIndicator(false, 'Server Error');
            setServerAuthStatus(message, true);
        }
        throw new Error(message);
    }

    async function fetchTopology() {
        try {
            const response = await clabFetch("/labs");
            const payload = await parseApiResponse(response);
            ensureClabResponseOk(response, payload, 'Failed to fetch labs');
            const data = (payload && typeof payload === 'object') ? payload : {};
            
            if (data.labs && data.labs.length > 0) {
                updateCurrentLabId(resolveLabId(data.labs[0]));
                if (!currentLabId) {
                    throw new Error('Lab list returned but no lab identifier was found.');
                }
                setLabRuntimeIndicator('running', `${currentLabId} · syncing details`);
                if (remoteServerUrl && remoteAuthToken) {
                    RemoteSessionManager.startLabStatusPolling();
                }
                // Fetch graph for first lab
                const graphResponse = await clabFetch(`/labs/${encodeURIComponent(currentLabId)}/graph`);
                const graphPayload = await parseApiResponse(graphResponse);
                ensureClabResponseOk(graphResponse, graphPayload, `Failed to fetch graph for ${currentLabId}`);
                const graph = (graphPayload && typeof graphPayload === 'object') ? graphPayload : { nodes: [], links: [] };
                const applied = await applySavedNodePositionsToGraph(graph, currentLabId);
                refreshDeploymentAccessPanel(currentLabId, { silent: true }).catch(function(error) {
                    Logger.warn('Failed to auto-refresh deployment access panel:', error);
                });
                return ensureGraphDebugLabels(applied);
            }

            updateCurrentLabId(null);
            setLabRuntimeIndicator('not-running', 'No running labs');
            setDeploymentAccessStatus('No running labs. No connectable instances.', true);
            renderDeploymentAccessRows([]);
            const localSnapshot = readTopologySnapshotLocal();
            if (localSnapshot) {
                ensureGraphDebugLabels(localSnapshot);
                return localSnapshot;
            }
            
            return { nodes: [], links: [] };
        } catch (error) {
            Logger.warn("API fetch failed, falling back to static topology:", error);
            const localSnapshot = readTopologySnapshotLocal();
            return localSnapshot || topologyData || { nodes: [], links: [] };
        }
    }

    async function deployTopology(topologySpec) {
        try {
            const response = await clabFetch("/labs", {
                method: "POST",
                body: JSON.stringify(topologySpec)
            });
            const result = await parseApiResponse(response);
            ensureClabResponseOk(response, result, 'Deploy failed');
            updateCurrentLabId(result.lab_id);
            return result;
        } catch (error) {
            Logger.error("Deploy failed:", error);
            throw error;
        }
    }

    async function deployTopologyFromYAML(yamlContent) {
        try {
            const response = await clabFetch("/labs/deploy-yaml", {
                method: "POST",
                body: JSON.stringify({ yaml: yamlContent })
            });
            const result = await parseApiResponse(response);
            ensureClabResponseOk(response, result, 'Failed to deploy from YAML');
            updateCurrentLabId(resolveLabId(result));
            return result;
        } catch (error) {
            Logger.error("YAML deploy failed:", error);
            throw error;
        }
    }

    async function destroyLab(options) {
        const cleanup = !!(options && options.cleanup);
        const targetLabId = String(currentLabId || getLabIdFromInput() || '').trim();
        if (!targetLabId) {
            alert('No target lab selected. Enter lab name or deploy/select a lab first.');
            return;
        }

        const confirmMessage = cleanup
            ? `Destroy and clean lab '${targetLabId}' on remote server? This also removes lab artifacts.`
            : `Destroy lab '${targetLabId}' on remote server?`;
        if (!confirm(confirmMessage)) return;

        try {
            const query = cleanup ? '?cleanup=true' : '';
            const response = await clabFetch(`/labs/${encodeURIComponent(targetLabId)}${query}`, { method: "DELETE" });
            const payload = await parseApiResponse(response);
            const actionLabel = cleanup ? 'destroy and clean' : 'destroy';
            ensureClabResponseOk(response, payload, `Failed to ${actionLabel} lab ${targetLabId}`);

            const removedLabId = targetLabId;
            updateCurrentLabId(null);
            deleteDeployedExport(removedLabId);
            setDeploymentAccessStatus(
                cleanup
                    ? `${removedLabId} destroyed and cleaned. No connectable instances.`
                    : `${removedLabId} destroyed. No connectable instances.`,
                true
            );
            renderDeploymentAccessRows([]);
            await clearSavedNodePositions(removedLabId);
            await fetchTopology();
            setLabRuntimeIndicator('destroyed', cleanup ? `${removedLabId} · destroyed and cleaned` : `${removedLabId} · destroyed`);
            alert(cleanup ? `Lab destroyed and cleaned: ${removedLabId}` : `Lab destroyed: ${removedLabId}`);
        } catch (error) {
            alert(`${cleanup ? 'Destroy & Clean' : 'Destroy'} failed: ${error.message || error}`);
            Logger.error("Destroy failed:", error);
        }
    }

    function destroyLabAndClean() {
        return destroyLab({ cleanup: true });
    }

    function getLayoutStorageKey(labId) {
        if (!labId) return null;
        return `${LAYOUT_STORAGE_PREFIX}${labId}`;
    }

    function readSavedNodePositionsLocal(labId) {
        const key = getLayoutStorageKey(labId);
        if (!key) return null;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (!parsed.positions || typeof parsed.positions !== 'object') return null;
            return parsed.positions;
        } catch (e) {
            console.warn('Failed to read saved node layout:', e);
            return null;
        }
    }

    function writeSavedNodePositionsLocal(labId, positions) {
        const key = getLayoutStorageKey(labId);
        if (!key) return;
        try {
            const payload = {
                savedAt: Date.now(),
                positions: positions || {},
            };
            localStorage.setItem(key, JSON.stringify(payload));
        } catch (e) {
            console.warn('Failed to save local node layout:', e);
        }
    }

    function clearSavedNodePositionsLocal(labId) {
        const key = getLayoutStorageKey(labId || currentLabId);
        if (!key) return;
        try {
            localStorage.removeItem(key);
        } catch (e) {
            console.warn('Failed to clear local node layout:', e);
        }
    }

    function collectTopologySnapshot() {
        const tf = getStageTransform();
        const size = getTopologyContainerSize();
        const snapshot = {
            savedAt: Date.now(),
            viewport: {
                scale: Number.isFinite(tf.scale) ? tf.scale : 1,
                tx: Number.isFinite(tf.tx) ? tf.tx : 0,
                ty: Number.isFinite(tf.ty) ? tf.ty : 0,
                containerWidth: Number.isFinite(size.width) ? size.width : 0,
                containerHeight: Number.isFinite(size.height) ? size.height : 0,
                windowWidth: Number.isFinite(window.innerWidth) ? window.innerWidth : 0,
                windowHeight: Number.isFinite(window.innerHeight) ? window.innerHeight : 0,
            },
            graph: {
                nodes: [],
                links: [],
            },
        };

        if (!topo) return snapshot;

        topo.eachNode(function(node) {
            if (!node) return;
            const model = node.model ? node.model() : null;
            const raw = (model && model.getData && model.getData()) || {};
            const pos = getStableNodeModelPosition(node);
            const nodeId = String(raw.id || raw.name || node.id());
            if (!nodeId) return;

            snapshot.graph.nodes.push({
                id: nodeId,
                name: raw.name || nodeId,
                label: raw.label || raw.name || nodeId,
                kind: raw.kind || 'linux',
                image: raw.image || '',
                icon: raw.icon || raw.iconType || 'host',
                iconType: raw.iconType || raw.icon || 'host',
                primaryIP: raw.primaryIP || getOrAssignMgmtIp(nodeId),
                x: Number.isFinite(pos && pos.x) ? pos.x : 0,
                y: Number.isFinite(pos && pos.y) ? pos.y : 0,
            });
        });

        topo.eachLink(function(link) {
            if (!link) return;
            const model = link.model ? link.model() : null;
            const raw = (model && model.getData && model.getData()) || {};
            const source = model && model.sourceID ? model.sourceID() : raw.source;
            const target = model && model.targetID ? model.targetID() : raw.target;
            if (!source || !target) return;

            snapshot.graph.links.push({
                id: String(raw.id || link.id() || `${source}-${target}`),
                source: String(source),
                target: String(target),
                srcIfName: raw.srcIfName || 'eth0',
                tgtIfName: raw.tgtIfName || 'eth0',
                srcDevice: raw.srcDevice || String(source),
                tgtDevice: raw.tgtDevice || String(target),
            });
        });

        return snapshot;
    }

    function saveTopologySnapshotLocal() {
        try {
            const payload = collectTopologySnapshot();
            localStorage.setItem(TOPOLOGY_SNAPSHOT_KEY, JSON.stringify(payload));
        } catch (e) {
            console.warn('Failed to save topology snapshot:', e);
        }
    }

    function readTopologySnapshotLocal() {
        try {
            const raw = localStorage.getItem(TOPOLOGY_SNAPSHOT_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const graph = parsed && parsed.graph ? parsed.graph : null;
            if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return null;
            ensureGraphDebugLabels(graph);
            const viewport = parsed && parsed.viewport && typeof parsed.viewport === 'object'
                ? parsed.viewport
                : null;
            return {
                nodes: graph.nodes.filter(Boolean),
                links: graph.links.filter(Boolean),
                __viewport: viewport,
            };
        } catch (e) {
            console.warn('Failed to read topology snapshot:', e);
            return null;
        }
    }

    function clearTopologySnapshotLocal() {
        try {
            localStorage.removeItem(TOPOLOGY_SNAPSHOT_KEY);
        } catch (e) {
            console.warn('Failed to clear topology snapshot:', e);
        }
    }

    async function fetchServerLayoutPositions(labId) {
        if (!labId) return null;
        try {
            const res = await clabFetch(`/labs/${encodeURIComponent(labId)}/layout`);
            if (!res.ok) return null;
            const payload = await res.json();
            if (!payload || typeof payload !== 'object') return null;
            if (!payload.positions || typeof payload.positions !== 'object') return null;
            return payload.positions;
        } catch (e) {
            return null;
        }
    }

    async function saveServerLayoutPositions(labId, positions) {
        if (!labId) return false;
        try {
            const res = await clabFetch(`/labs/${encodeURIComponent(labId)}/layout`, {
                method: 'PUT',
                body: JSON.stringify({ positions: positions || {} }),
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    async function deleteServerLayoutPositions(labId) {
        if (!labId) return false;
        try {
            const res = await clabFetch(`/labs/${encodeURIComponent(labId)}/layout`, {
                method: 'DELETE',
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    async function applySavedNodePositionsToGraph(graph, labId) {
        if (!graph || !Array.isArray(graph.nodes) || !labId) return graph;
        const serverSaved = await fetchServerLayoutPositions(labId);
        const saved = serverSaved || readSavedNodePositionsLocal(labId);
        if (!saved) return graph;

        graph.nodes.forEach(function(node) {
            if (!node) return;
            const nodeId = String(node.id || node.name || '');
            if (!nodeId) return;
            const pos = saved[nodeId];
            if (!pos) return;
            if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                node.x = pos.x;
                node.y = pos.y;
            }
        });

        return graph;
    }

    function collectNodePositions() {
        const positions = {};
        if (!topo) return positions;

        topo.eachNode(function(node) {
            if (!node) return;
            const pos = getStableNodeModelPosition(node);
            if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
            const raw = (node.model && node.model().getData && node.model().getData()) || {};
            const nodeId = String(raw.id || raw.name || node.id());
            if (!nodeId) return;
            positions[nodeId] = { x: pos.x, y: pos.y };
        });

        return positions;
    }

    async function saveNodePositionsNow() {
        syncNodeModelPositionFieldsFromView();
        updateNodeCoordinateDebugLabels();
        saveTopologySnapshotLocal();
        if (!currentLabId) return;
        const positions = collectNodePositions();

        // Keep local fallback for offline / API failure.
        writeSavedNodePositionsLocal(currentLabId, positions);
        const ok = await saveServerLayoutPositions(currentLabId, positions);
        if (!ok) {
            Logger.warn('Server layout save failed, local fallback kept.');
        }
    }

    function queueSaveNodePositions(delayMs) {
        // Save local snapshot immediately so fast reload does not lose latest edits.
        syncNodeModelPositionFieldsFromView();
        updateNodeCoordinateDebugLabels();
        saveTopologySnapshotLocal();
        const delay = Number.isFinite(delayMs) ? delayMs : 120;
        if (positionSaveTimer) {
            clearTimeout(positionSaveTimer);
        }
        positionSaveTimer = setTimeout(function() {
            positionSaveTimer = null;
            saveNodePositionsNow();
        }, Math.max(0, delay));
    }

    async function clearSavedNodePositions(labId) {
        const targetLabId = labId || currentLabId;
        if (!targetLabId) return;
        clearSavedNodePositionsLocal(targetLabId);
        await deleteServerLayoutPositions(targetLabId);
    }

    async function execNodeCommand(nodeName, command) {
        if (!currentLabId) {
            alert("No lab deployed");
            return;
        }
        try {
            const response = await clabFetch(`/labs/${currentLabId}/nodes/${nodeName}/exec`, {
                method: "POST",
                body: JSON.stringify({ command: command })
            });
            const result = await parseApiResponse(response);
            ensureClabResponseOk(response, result, 'Exec failed');
            return result.output;
        } catch (error) {
            console.error("Exec failed:", error);
            throw error;
        }
    }

    async function getNodeLogs(nodeName, lines = 100) {
        if (!currentLabId) {
            alert("No lab deployed");
            return;
        }
        try {
            const response = await clabFetch(`/labs/${currentLabId}/nodes/${nodeName}/logs?lines=${lines}`);
            const result = await parseApiResponse(response);
            ensureClabResponseOk(response, result, 'Get logs failed');
            return result.logs;
        } catch (error) {
            console.error("Get logs failed:", error);
            throw error;
        }
    }

    async function connectToNode(nodeName) {
        if (!currentLabId) {
            alert("No lab deployed");
            return;
        }
        
        try {
            const response = await clabFetch(`/labs/${currentLabId}`);
            const labState = await parseApiResponse(response);
            ensureClabResponseOk(response, labState, 'Failed to fetch lab details');

            const runtimeNodes = Array.isArray(labState && labState.nodes_runtime)
                ? labState.nodes_runtime
                : [];
            const requested = String(nodeName || '').trim();
            const preferred = runtimeNodes.find(n => String(n && n.name || '') === requested)
                || runtimeNodes.find(n => String(n && n.name || '').endsWith(`-${requested}`));
            const targetNodeName = String((preferred && preferred.name) || requested).trim();
            const shortNodeName = shortenRuntimeNodeName(currentLabId, targetNodeName);
            const kind = (selectedNodeInfo && String(selectedNodeInfo.kind || '').trim()) || '';
            const loginName = getMappedLoginNameForKind(kind) || String(defaultLoginName || 'admin').trim() || 'admin';
            const sshInfo = await requestNodeSshAccessWithFallback(currentLabId, targetNodeName, shortNodeName, loginName);

            const host = sshInfo && sshInfo.host ? String(sshInfo.host) : '127.0.0.1';
            const port = sshInfo && sshInfo.port ? String(sshInfo.port) : '-';
            const username = sshInfo && sshInfo.username ? String(sshInfo.username) : 'admin';
            const command = sshInfo && sshInfo.command ? String(sshInfo.command) : `ssh ${username}@${host} -p ${port}`;
            const expiration = sshInfo && sshInfo.expiration ? String(sshInfo.expiration) : 'n/a';

            alert(
                `SSH access ready:\n` +
                `Node: ${targetNodeName}\n` +
                `Host: ${host}\n` +
                `Port: ${port}\n` +
                `User: ${username}\n` +
                `Expires: ${expiration}\n\n` +
                `Command: ${command}`
            );
        } catch (error) {
            alert(`SSH connect failed: ${error.message || error}`);
            console.error("Connect to node failed:", error);
        }
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getTopologyContainerSize() {
        const el = document.getElementById('topology');
        if (!el) return { width: 1200, height: 700 };
        return {
            width: Math.max(480, el.clientWidth || 1200),
            height: Math.max(320, el.clientHeight || 700)
        };
    }

    function syncTopologyViewportSize() {
        if (!topo) return;
        const size = getTopologyContainerSize();
        if (typeof topo.width === 'function') topo.width(size.width);
        if (typeof topo.height === 'function') topo.height(size.height);
    }

    function formatNodeCoordLabel(name, x, y) {
        const base = String(name || 'node');
        if (!DEBUG_SHOW_NODE_COORD_LABEL) return base;
        const sx = Number.isFinite(x) ? Math.round(x) : 0;
        const sy = Number.isFinite(y) ? Math.round(y) : 0;
        return `${base} (${sx}, ${sy})`;
    }

    function getStableNodeModelPosition(node) {
        if (!node || !node.model || typeof node.model !== 'function') return { x: 0, y: 0 };
        const model = node.model();
        const raw = (model && model.getData && model.getData()) || {};

        const pos = node.position ? node.position() : null;
        const posX = Number(pos && pos.x);
        const posY = Number(pos && pos.y);
        if (Number.isFinite(posX) && Number.isFinite(posY)) {
            return { x: posX, y: posY };
        }

        const rawX = Number(raw.x);
        const rawY = Number(raw.y);
        if (Number.isFinite(rawX) && Number.isFinite(rawY)) {
            return { x: rawX, y: rawY };
        }

        return { x: 0, y: 0 };
    }

    function syncNodeModelPositionFieldsFromView() {
        if (!topo) return;
        topo.eachNode(function(node) {
            if (!node || !node.model || typeof node.model !== 'function') return;
            const model = node.model();
            if (!model || typeof model.set !== 'function') return;
            const stablePos = getStableNodeModelPosition(node);
            if (Number.isFinite(stablePos.x) && Number.isFinite(stablePos.y)) {
                model.set('x', stablePos.x);
                model.set('y', stablePos.y);
            }
        });
    }

    function updateNodeCoordinateDebugLabels() {
        if (!topo) return;
        topo.eachNode(function(node) {
            if (!node || !node.model || typeof node.model !== 'function') return;
            const model = node.model();
            const raw = (model.getData && model.getData()) || {};
            const x = Number(raw.x);
            const y = Number(raw.y);
            const nodeName = raw.name || raw.id || (node.id ? node.id() : 'node');

            if (model && typeof model.set === 'function') {
                model.set('debugLabel', formatNodeCoordLabel(nodeName, x, y));
            }
        });
    }

    function applyNodePositionsFromDataWithRetry(retryCount) {
        if (!topo) return;
        const restoreMap = pendingRestoreCoordMap && typeof pendingRestoreCoordMap === 'object'
            ? pendingRestoreCoordMap
            : null;

        topo.eachNode(function(node) {
            if (!node || !node.model || typeof node.model !== 'function') return;
            const raw = (node.model().getData && node.model().getData()) || {};
            const nodeId = String(raw.id || raw.name || (node.id ? node.id() : ''));
            const forced = (restoreMap && nodeId && restoreMap[nodeId]) ? restoreMap[nodeId] : null;
            const forcedX = Number(forced && forced.x);
            const forcedY = Number(forced && forced.y);
            const rawX = Number(raw.x);
            const rawY = Number(raw.y);
            const x = Number.isFinite(forcedX) ? forcedX : rawX;
            const y = Number.isFinite(forcedY) ? forcedY : rawY;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;

            if (node.model && typeof node.model === 'function') {
                const model = node.model();
                if (model && typeof model.set === 'function') {
                    model.set('x', x);
                    model.set('y', y);
                }
            }

            // Keep rendered icon location aligned with restored model coordinates.
            if (node.position && typeof node.position === 'function') {
                try {
                    node.position({ x: x, y: y });
                } catch (e) {
                    // Ignore on NeXt builds without writable node.position.
                }
            }
        });

        updateNodeCoordinateDebugLabels();
        pendingRestoreCoordMap = null;
    }

    /**
     * NeXt UI Topology Configuration
     */
    function initTopology() {
        const size = getTopologyContainerSize();
        topo = new nx.graphic.Topology({
            width: size.width,
            height: size.height,
            dataProcessor: '',
            identityKey: 'id',
            
            nodeConfig: {
                label: 'model.debugLabel',
                iconType: function(model) {
                    // Support both legacy graph data (icon) and editor data (iconType)
                    return model.get('icon') || model.get('iconType') || 'host';
                },
                color: function(model) {
                    if (model._data.is_new === 'yes') {
                        return '#148D09';
                    }
                },
                style: {
                    'stroke-width': 2,
                    'stroke': '#ccc'
                }
            },

            nodeSetConfig: {
                label: 'model.name',
                iconType: function(model) {
                    return model.get('icon') || model.get('iconType') || 'host';
                }
            },

            tooltipManagerConfig: {
                nodeTooltipContentClass: 'CustomNodeTooltip',
                linkTooltipContentClass: 'CustomLinkTooltip'
            },

            linkConfig: {
                linkType: 'curve',
                sourcelabel: 'model.srcIfName',
                targetlabel: 'model.tgtIfName',
                style: function(model) {
                    if (model._data.is_dead === 'yes') {
                        return { 'stroke-dasharray': '5' };
                    }
                },
                color: function(model) {
                    if (model._data.is_dead === 'yes') {
                        return '#E40039';
                    }
                    if (model._data.is_new === 'yes') {
                        return '#148D09';
                    }
                },
            },

            showIcon: true,
            linkInstanceClass: 'CustomLinkClass'
        });

        return topo;
    }

    function getTooltipManager() {
        if (!topo || typeof topo.tooltipManager !== 'function') return null;
        try {
            return topo.tooltipManager();
        } catch (e) {
            return null;
        }
    }

    function closeAllTopologyTooltips() {
        const manager = getTooltipManager();
        if (!manager || typeof manager.closeAll !== 'function') return false;
        try {
            manager.closeAll();
            return true;
        } catch (e) {
            return false;
        }
    }

    function openTopologyNodeTooltip(node) {
        const manager = getTooltipManager();
        if (!manager || typeof manager.openNodeTooltip !== 'function' || !node) return false;
        try {
            manager.openNodeTooltip(node);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Custom Tooltip Components
     */
    nx.define('CustomNodeTooltip', nx.ui.Component, {
        properties: {
            node: {
                set: function(val) { this._nv = val; },
                get: function() { return this._nv; }
            },
            topology: {}
        },
        view: {
            content: [{
                tag: 'div',
                name: 'tooltip_content',
                props: {
                    'style': 'color: #000; background: white; padding: 8px; width: 220px; font-size: 11px; font-family: Arial, sans-serif;'
                }
            }]
        },
        methods: {
            attach: function(owner) {
                var self = this;
                this.inherited(owner);

                // Tooltip content view can be created before real DOM handle is mounted.
                // Retry a few times to avoid empty/Loading-only tooltip on first click.
                self._renderWhenReady(0);
            },

            _resolveTooltipElement: function() {
                try {
                    var contentView = this.view('tooltip_content');
                    if (!contentView) return null;

                    if (contentView.$dom) {
                        return contentView.$dom;
                    }

                    if (typeof contentView.dom === 'function') {
                        var domHandle = contentView.dom();
                        if (domHandle && domHandle.$dom) {
                            return domHandle.$dom;
                        }
                    }
                } catch (e) {}

                return null;
            },

            _renderWhenReady: function(tryCount) {
                var self = this;
                var element = self._resolveTooltipElement();

                if (element) {
                    self._renderToElement(element);
                    return;
                }

                if (tryCount >= 20) {
                    return;
                }

                setTimeout(function() {
                    self._renderWhenReady(tryCount + 1);
                }, 25);
            },
            
            _renderToElement: function(element) {
                var nv = this._nv;
                if (!nv) {
                    return;
                }
                
                var model  = nv.model();
                var raw    = (model.getData && model.getData()) || {};
                var nodeId = nv.id();
                var name   = raw.name || nodeId;
                var ip     = ensureNodeMgmtIp(model);
                var kind   = raw.kind  || '';
                var state  = raw.state || '';
                var x      = Number(raw.x);
                var y      = Number(raw.y);
                var coordText = (Number.isFinite(x) && Number.isFinite(y))
                    ? ' (' + Math.round(x) + ', ' + Math.round(y) + ')'
                    : '';
                var entries = getNodeConnectivityEntries(nodeId);

                // Connectivity rows
                var connRows = '';
                if (entries.length === 0) {
                    connRows = '<div style="color:#666; font-style:italic; font-size:11px; padding:4px 0;">No links connected.</div>';
                } else {
                    var grouped = {};
                    entries.forEach(function(e) {
                        var key = String(e.peerId || e.peerName || 'unknown');
                        if (!grouped[key]) {
                            grouped[key] = {
                                peerName: e.peerName || key,
                                links: []
                            };
                        }
                        grouped[key].links.push(e);
                    });

                    var peerKeys = Object.keys(grouped).sort(function(a, b) {
                        return String(grouped[a].peerName).localeCompare(String(grouped[b].peerName));
                    });

                    connRows = peerKeys.map(function(k) {
                        var peer = grouped[k];
                        var linkRows = peer.links.map(function(e, idx) {
                            var topBorder = idx === 0 ? 'none' : '1px solid #e5edf5';
                            return '<div style="padding:5px 0; border-top:' + topBorder + ';">'
                                + '<div style="display:flex; align-items:center; gap:6px;">'
                                + '<span style="font-size:9px; font-weight:700; color:#0f4c81; background:#dbeafe; border:1px solid #bfdbfe; border-radius:999px; padding:1px 6px; letter-spacing:0.3px;">LOCAL</span>'
                                + '<span style="font-weight:600; color:#0b1220; font-size:11px;">' + escapeHtml(e.localIf) + '</span>'
                                + '</div>'
                                + '<div style="display:flex; align-items:center; gap:6px; margin-top:3px;">'
                                + '<span style="font-size:9px; font-weight:700; color:#14532d; background:#dcfce7; border:1px solid #bbf7d0; border-radius:999px; padding:1px 6px; letter-spacing:0.3px;">REMOTE</span>'
                                + '<span style="font-weight:600; color:#0b1220; font-size:11px;">' + escapeHtml(e.peerIf) + '</span>'
                                + '</div>'
                                + '</div>';
                        }).join('');

                        return '<div style="margin-bottom:6px; border:1px solid #dbe7f3; border-radius:7px; background:#f8fbff; padding:6px 8px;">'
                            + '<div style="font-size:11px; font-weight:700; color:#0f4c81; margin-bottom:4px;">' + escapeHtml(peer.peerName) + '</div>'
                            + linkRows
                            + '</div>';
                    }).join('');
                }

                // Build final HTML
                var html = '<div style="font-size:13px; font-weight:700; color:#000; margin-bottom:6px;">'
                    + escapeHtml(name)
                    + '<span style="font-size:11px; font-weight:500; color:#475569;">' + escapeHtml(coordText) + '</span>'
                    + '</div>';
                
                if (ip) html += '<div style="color:#333; font-size:11px; margin-bottom:2px;">IP: ' + escapeHtml(ip) + '</div>';
                if (kind) html += '<div style="color:#333; font-size:11px; margin-bottom:2px;">Kind: ' + escapeHtml(kind) + '</div>';
                if (state) html += '<div style="color:#333; font-size:11px; margin-bottom:6px;">State: ' + escapeHtml(state) + '</div>';
                
                html += '<div style="height:1px; background:#ddd; margin:6px 0;"></div>';
                html += '<div style="font-size:10px; font-weight:700; color:#333; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:5px;">Connections '
                    +   (entries.length ? '(' + entries.length + ')' : '')
                    + '</div>'
                    + connRows;

                try {
                    element.innerHTML = html;
                } catch(e) {
                    // Silently ignore innerHTML errors
                }
            }
        }
    });

    nx.define('CustomLinkTooltip', nx.ui.Component, {
        properties: {
            link: {},
            topology: {}
        },
        view: {
            content: [{
                tag: 'div',
                content: [{
                    tag: 'p',
                    content: [
                        { tag: 'label', content: 'Source: ' },
                        { tag: 'label', content: '{#link.model.srcDevice}({#link.model.srcIfName})' }
                    ],
                    props: { "style": "font-size:80%;" }
                }, {
                    tag: 'p',
                    content: [
                        { tag: 'label', content: 'Target: ' },
                        { tag: 'label', content: '{#link.model.tgtDevice}({#link.model.tgtIfName})' }
                    ],
                    props: { "style": "font-size:80%;" }
                }],
                props: { "style": "width: 180px;" }
            }]
        }
    });

    /**
     * Custom Link Display
     */
    nx.define('CustomLinkClass', nx.graphic.Topology.Link, {
        properties: {
            sourcelabel: null,
            targetlabel: null
        },
        view: function(view) {
            view.content.push({
                name: 'source',
                type: 'nx.graphic.Text',
                props: {
                    'class': 'sourcelabel',
                    'alignment-baseline': 'text-after-edge',
                    'text-anchor': 'middle',
                    'pointer-events': 'none'
                }
            }, {
                name: 'source2',
                type: 'nx.graphic.Text',
                props: {
                    'class': 'sourcelabel',
                    'alignment-baseline': 'text-after-edge',
                    'text-anchor': 'middle',
                    'pointer-events': 'none'
                }
            }, {
                name: 'target',
                type: 'nx.graphic.Text',
                props: {
                    'class': 'targetlabel',
                    'alignment-baseline': 'text-after-edge',
                    'text-anchor': 'middle',
                    'pointer-events': 'none'
                }
            }, {
                name: 'target2',
                type: 'nx.graphic.Text',
                props: {
                    'class': 'targetlabel',
                    'alignment-baseline': 'text-after-edge',
                    'text-anchor': 'middle',
                    'pointer-events': 'none'
                }
            });
            return view;
        },
        methods: {
            update: function() {
                this.inherited();
                var el, el2, point;
                var line = this.line();
                var stageScale = this.stageScale();
                var lineGap = 13 * stageScale;
                var sideOffset = 18 * stageScale;
                var alongSplit = 24 * stageScale;

                line = line.pad(20 * stageScale, 20 * stageScale);

                var start = line.start;
                var end = line.end;
                var dx = end.x - start.x;
                var dy = end.y - start.y;
                var len = Math.sqrt(dx * dx + dy * dy) || 1;
                var ux = dx / len;
                var uy = dy / len;
                var nxv = -uy;
                var nyv = ux;
                var mid = {
                    x: (start.x + end.x) / 2,
                    y: (start.y + end.y) / 2
                };

                if (this.sourcelabel()) {
                    var sourceParts = splitInterfaceLabel(this.sourcelabel());
                    el = this.view('source');
                    el2 = this.view('source2');
                    point = {
                        x: mid.x - ux * alongSplit + nxv * sideOffset,
                        y: mid.y - uy * alongSplit + nyv * sideOffset
                    };
                    el.set('x', point.x);
                    el.set('y', point.y);
                    el.set('text', sourceParts[0]);
                    el.setStyle('font-size', 12 * stageScale);

                    if (sourceParts[1]) {
                        // Stack line-2 below line-1 in screen coordinates to avoid overlap on vertical links.
                        el2.set('x', point.x);
                        el2.set('y', point.y + lineGap);
                        el2.set('text', sourceParts[1]);
                    } else {
                        el2.set('text', '');
                    }
                    el2.setStyle('font-size', 12 * stageScale);
                }

                if (this.targetlabel()) {
                    var targetParts = splitInterfaceLabel(this.targetlabel());
                    el = this.view('target');
                    el2 = this.view('target2');
                    point = {
                        x: mid.x + ux * alongSplit - nxv * sideOffset,
                        y: mid.y + uy * alongSplit - nyv * sideOffset
                    };
                    el.set('x', point.x);
                    el.set('y', point.y);
                    el.set('text', targetParts[0]);
                    el.setStyle('font-size', 12 * stageScale);

                    if (targetParts[1]) {
                        // Stack line-2 below line-1 in screen coordinates to avoid overlap on vertical links.
                        el2.set('x', point.x);
                        el2.set('y', point.y + lineGap);
                        el2.set('text', targetParts[1]);
                    } else {
                        el2.set('text', '');
                    }
                    el2.setStyle('font-size', 12 * stageScale);
                }
            }
        }
    });

    /**
     * Node / Link Click Handlers (mode-aware)
     */
    function getTopologySurfaceElement() {
        const container = document.getElementById('topology');
        if (container) {
            const mounted = container.querySelector('.n-topology');
            if (mounted) return mounted;
        }
        // Fallback for early lifecycle before remounting
        return document.querySelector('.n-topology') || container;
    }

    function ensureTopologyMountedInContainer() {
        const container = document.getElementById('topology');
        if (!container) return;

        let surface = container.querySelector('.n-topology');
        if (!surface) {
            surface = document.querySelector('.n-topology');
            if (surface && surface.parentElement !== container) {
                container.appendChild(surface);
            }
        }

        if (!surface) return;

        container.style.position = 'relative';
        surface.style.position = 'absolute';
        surface.style.inset = '0';
        surface.style.width = '100%';
        surface.style.height = '100%';
        surface.style.margin = '0';
    }

    function setLinkPreviewMouseTracking(enabled) {
        if (enabled && !linkPreviewMousemoveBound) {
            document.addEventListener('mousemove', updateLinkPreviewToMouse, true);
            linkPreviewMousemoveBound = true;
        } else if (!enabled && linkPreviewMousemoveBound) {
            document.removeEventListener('mousemove', updateLinkPreviewToMouse, true);
            linkPreviewMousemoveBound = false;
        }
    }

    function getSurfaceRectCached(surfaceEl) {
        if (!surfaceEl) return null;
        const now = performance.now();
        if (
            surfaceRectCache.el === surfaceEl &&
            surfaceRectCache.rect &&
            (now - surfaceRectCache.ts) < 16
        ) {
            return surfaceRectCache.rect;
        }

        const rect = surfaceEl.getBoundingClientRect();
        surfaceRectCache = {
            el: surfaceEl,
            ts: now,
            rect,
        };
        return rect;
    }

    function setupNodeClickHandler() {
        if (InteractionController && typeof InteractionController.bindGlobalListenersOnce === 'function') {
            InteractionController.bindGlobalListenersOnce({
                handleDocumentContextMenu: handleDocumentContextMenu,
                handleDocumentPointerDown: handleDocumentPointerDown,
                handleDocumentPointerMove: handleDocumentPointerMove,
                handleDocumentDoubleClick: handleDocumentDoubleClick,
                handleDocumentClick: handleDocumentClick,
                handleDocumentPointerUp: handleDocumentPointerUp,
                handleDocumentKeyDown: handleDocumentKeyDown,
                hideNodeContextMenu: hideNodeContextMenu,
            });
        } else if (!document.body.dataset.linkContextBound) {
            const menu = document.getElementById('nodeContextMenu');
            if (menu && !menu.dataset.bound) {
                menu.addEventListener('mousedown', function(evt) {
                    evt.stopPropagation();
                });
                menu.addEventListener('contextmenu', function(evt) {
                    evt.stopPropagation();
                });
                menu.dataset.bound = '1';
            }

            document.addEventListener('contextmenu', handleDocumentContextMenu, true);
            document.addEventListener('mousedown', handleDocumentPointerDown, false);
            document.addEventListener('mousemove', handleDocumentPointerMove, false);
            document.addEventListener('dblclick', handleDocumentDoubleClick, false);
            document.addEventListener('click', handleDocumentClick, false);
            document.addEventListener('mouseup', handleDocumentPointerUp, false);
            document.addEventListener('keydown', handleDocumentKeyDown, true);

            document.addEventListener('mousedown', function(evt) {
                // Only left-click outside the menu should close it.
                if (evt.button !== 0) return;
                const menu = document.getElementById('nodeContextMenu');
                if (menu && menu.classList.contains('open') && menu.contains(evt.target)) {
                    return;
                }
                hideNodeContextMenu();
            });
            document.body.dataset.linkContextBound = '1';
        }

        // NeXt UI fires 'clickNode' with (topology, nodeView) signature
        // NOTE: NeXt fires clickNode on _mouseup() for ANY button (including right-click).
        // We guard here using window.event which NeXt itself uses for shiftKey etc.
        topo.on('clickNode', function(topologyRef, node) {
            // Skip if triggered by a non-primary (right/middle) mouse button.
            if (window.event && typeof window.event.button === 'number' && window.event.button !== 0) return;
            if (window.event && window.event.ctrlKey) return;
            if (isTooltipBlocked()) return;
            const now = Date.now();
            lastNodeClickTs = now;
            if (editorMode === 'addLink') {
                processLinkNodeSelection(node);
            } else if (editorMode === 'delete') {
                topo.deleteNode(node.id());
                // One-shot delete: return to view mode after deletion.
                setEditorMode('view');
                queueSaveNodePositions(60);
            } else if (editorMode === 'view') {
                // In view mode, tooltip opening is handled on document mouseup only.
                // This prevents overly frequent tooltip popups from NeXt clickNode events.
                return;
            }
        });

        topo.on('dblclickNode', function(topologyRef, node) {
            if (isTooltipBlocked()) return;
            if (!node || editorMode !== 'view' || suppressNodeDetails) return;
            openNodeStatusWindowOnce(node, Date.now());
        });

        // Hook into NeXt's native drag events to close tooltip during drag
        topo.on('dragNode', function(topologyRef, node) {
            if (pendingNodeDrag && node && typeof node.id === 'function' && node.id() === pendingNodeDrag.nodeId) {
                const currentPos = getStableNodeModelPosition(node);
                const dx = Number(currentPos.x) - Number(pendingNodeDrag.startNodeX || 0);
                const dy = Number(currentPos.y) - Number(pendingNodeDrag.startNodeY || 0);
                const movedSq = dx * dx + dy * dy;
                const thresholdSq = INTERACTION.nodeDragHideTooltipPx * INTERACTION.nodeDragHideTooltipPx;
                if (movedSq >= thresholdSq) {
                    pendingNodeDrag.moved = true;
                    pendingNodeDrag.tooltipHidden = true;
                }
            }
            closeAllTopologyTooltips();
        });

        // Do not auto-open tooltip on drag end; mouseup logic decides click vs drag.
        topo.on('dragNodeEnd', function(topologyRef, node) {
            if (pendingNodeDrag && node && typeof node.id === 'function' && node.id() === pendingNodeDrag.nodeId) {
                const currentPos = getStableNodeModelPosition(node);
                const dx = Number(currentPos.x) - Number(pendingNodeDrag.startNodeX || 0);
                const dy = Number(currentPos.y) - Number(pendingNodeDrag.startNodeY || 0);
                const movedSq = dx * dx + dy * dy;
                const thresholdSq = INTERACTION.nodeDragHideTooltipPx * INTERACTION.nodeDragHideTooltipPx;
                if (movedSq >= thresholdSq) {
                    pendingNodeDrag.moved = true;
                    pendingNodeDrag.tooltipHidden = true;
                }
            }
        });

        // Allow deleting links in delete mode
        topo.on('clickLink', function(topologyRef, link) {
            if (editorMode === 'delete') {
                topo.deleteLink(link.id());
                // One-shot delete: return to view mode after deletion.
                setEditorMode('view');
                queueSaveNodePositions(60);
            }
        });
    }

    function handleDocumentContextMenu(evt) {
        const surface = getTopologySurfaceElement();
        if (!surface || !surface.contains(evt.target)) {
            hideNodeContextMenu();
            return;
        }
        contextMenuActive = true;
        blockTooltipAfterContextMenu(700);
        // Close any open NeXt tooltip before showing context menu
        closeAllTopologyTooltips();
        handleTopologyContextMenu(evt);
    }

    function processLinkNodeSelection(node) {
        if (!node) return;
        const now = Date.now();
        if (lastLinkPick.nodeId === node.id() && (now - lastLinkPick.ts) < INTERACTION.dedupeMs) {
            return;
        }
        lastLinkPick = { nodeId: node.id(), ts: now };
        handleLinkModeNodeClick(node);
    }

    function clearSelectedNodeVisuals(clearDetails) {
        if (activeSelectedNodeId) {
            const prev = topo.getNode(activeSelectedNodeId);
            if (prev) prev.selected(false);
        }
        activeSelectedNodeId = null;
        clearNodeFocusHighlight();

        if (clearDetails) {
            selectedNodeInfo = null;
            AppState.topology.selectedNodeInfo = null;
            updateStatusPanel();
        }
    }

    /**
     * Dim all nodes/links except the selected node and its direct connections.
     * Batched with requestAnimationFrame for efficiency.
     */
    function applyNodeFocusHighlight(nodeId) {
        if (!topo) return;
        const focalNodeIds = new Set();
        const focalLinkIds = new Set();
        focalNodeIds.add(String(nodeId));

        topo.eachLink(function(link) {
            const m = link.model();
            const raw = (m.getData && m.getData()) || {};
            const srcId = String(m.sourceID ? m.sourceID() : raw.source);
            const tgtId = String(m.targetID ? m.targetID() : raw.target);
            if (srcId === String(nodeId) || tgtId === String(nodeId)) {
                focalLinkIds.add(String(link.id()));
                focalNodeIds.add(srcId);
                focalNodeIds.add(tgtId);
            }
        });

        window.requestAnimationFrame(function() {
            const topoEl = document.getElementById('topology');
            if (topoEl) topoEl.classList.add('topo-focus-mode');

            // Batch DOM reads and writes to minimize reflow
            const nodesToUpdate = [];
            topo.eachNode(function(node) {
                const el = node.dom && node.dom() ? node.dom().$dom : null;
                if (!el) return;
                nodesToUpdate.push({
                    el,
                    focal: focalNodeIds.has(String(node.id()))
                });
            });

            const linksToUpdate = [];
            topo.eachLink(function(link) {
                const el = link.dom && link.dom() ? link.dom().$dom : null;
                if (!el) return;
                linksToUpdate.push({
                    el,
                    focal: focalLinkIds.has(String(link.id()))
                });
            });

            // Apply classes in single pass
            nodesToUpdate.forEach(({ el, focal }) => {
                if (focal) {
                    el.classList.add('topo-focal');
                    el.classList.remove('topo-dim');
                } else {
                    el.classList.add('topo-dim');
                    el.classList.remove('topo-focal');
                }
            });

            linksToUpdate.forEach(({ el, focal }) => {
                if (focal) {
                    el.classList.add('topo-focal');
                    el.classList.remove('topo-dim');
                } else {
                    el.classList.add('topo-dim');
                    el.classList.remove('topo-focal');
                }
            });
        });
    }

    function clearNodeFocusHighlight() {
        window.requestAnimationFrame(function() {
            const topoEl = document.getElementById('topology');
            if (topoEl) topoEl.classList.remove('topo-focus-mode');
            if (!topo) return;
            
            // Use QuerySelectorAll for batch removal (avoids eachNode iteration)
            const dimmed = document.querySelectorAll('#topology [class*="topo-dim"]');
            const focal = document.querySelectorAll('#topology [class*="topo-focal"]');
            dimmed.forEach(el => el.classList.remove('topo-dim'));
            focal.forEach(el => el.classList.remove('topo-focal'));
        });
    }

    function focusNodeImmediately(node, showDetails) {
        if (!node) return;
        const nodeId = node.id();
        if (!nodeId) return;

        // Only skip if already focused AND we're not forcing a re-render
        const isAlreadyFocused = activeSelectedNodeId === nodeId && selectedNodeInfo && selectedNodeInfo.id === nodeId;
        const shouldSkipRender = isAlreadyFocused && !showDetails;
        if (shouldSkipRender) return;

        if (activeSelectedNodeId && activeSelectedNodeId !== nodeId) {
            const prev = topo.getNode(activeSelectedNodeId);
            if (prev) prev.selected(false);
        }

        activeSelectedNodeId = nodeId;
        node.selected(true);
        applyNodeFocusHighlight(nodeId);

        if (showDetails) {
            showNodeDetails(node.model());
        }
        // CRITICAL: Always ensure panel is updated, even on re-selection
        updateStatusPanel();
    }

    function openNodeStatusWindow(node) {
        if (!node || !node.model) return;
        if (isTooltipBlocked()) return;
        showNodeDetails(node.model());
        updateStatusPanel();
        openTopologyNodeTooltip(node);
    }

    function openNodeStatusWindowOnce(node, nowTs) {
        if (!node || typeof node.id !== 'function') return;
        const now = Number.isFinite(nowTs) ? nowTs : Date.now();
        if (isTooltipBlocked(now)) return;
        const nodeId = node.id();
        if (
            lastNodeOpenRequest.nodeId === nodeId &&
            (now - lastNodeOpenRequest.ts) < 140
        ) {
            return;
        }
        focusNodeImmediately(node, true);
        openNodeStatusWindow(node);
        lastNodeOpenRequest = { nodeId: nodeId, ts: now };
    }

    function handleNodePrimaryClick(node, nowTs) {
        if (!node || typeof node.id !== 'function') return;
        openNodeStatusWindowOnce(node, nowTs);
    }

    function getNodeIdFromEventTarget(target) {
        if (!target || !target.closest) return null;

        const nodeEl = target.closest('.node, .nodeset, .nodeSet');
        if (nodeEl && typeof nodeEl.getAttribute === 'function') {
            const nodeId = String(nodeEl.getAttribute('data-id') || '').trim();
            if (nodeId && topo && typeof topo.getNode === 'function' && topo.getNode(nodeId)) {
                return nodeId;
            }
        }

        return null;
    }

    function disableDefaultHoverActivation() {
        if (!topo || typeof topo.scenesMap !== 'function') return;
        const scenes = topo.scenesMap() || {};
        const defaultScene = scenes.default;
        if (!defaultScene || defaultScene.__nextUiHoverPatched) return;

        // Keep default scene from auto-activating hover fade behavior, but avoid
        // calling internal recover APIs that can interfere with stage dragging.
        function ignoreHoverActivation() {}

        defaultScene.enterNode = ignoreHoverActivation;
        defaultScene.leaveNode = ignoreHoverActivation;
        defaultScene.enterNodeSet = ignoreHoverActivation;
        defaultScene.leaveNodeSet = ignoreHoverActivation;

        defaultScene.__nextUiHoverPatched = true;
    }

    function setBackgroundMoveCursor(enabled) {
        const shouldEnable = !!enabled;
        if (backgroundMoveCursorActive === shouldEnable) return;
        backgroundMoveCursorActive = shouldEnable;

        const surface = getTopologySurfaceElement();
        if (!surface) return;
        surface.style.cursor = shouldEnable ? 'move' : '';
    }

    function handleDocumentPointerDown(evt) {
        if (evt.button !== 0) return;
        // On macOS, Ctrl+left-click generates button=0 then contextmenu.
        // Skip focus handling here so only the context menu opens.
        if (evt.ctrlKey) return;

        const modal = document.getElementById('linkIfModal');
        if (modal && modal.classList.contains('open')) return;

        const menu = document.getElementById('nodeContextMenu');
        if (menu && menu.contains(evt.target)) return;

        const surface = getTopologySurfaceElement();
        if (!surface || !surface.contains(evt.target)) return;

        if (editorMode === 'view') {
            pendingBackgroundClick = null;
            backgroundPanState = null;
            const now = Date.now();
            let resolvedNodeId = getNodeIdFromEventTarget(evt.target);
            
            // Fallback: if DOM node class lookup failed, try proximity lookup
            if (!resolvedNodeId) {
                const nearbyNode = findNearestNodeByClientPoint(evt.clientX, evt.clientY, INTERACTION.focusPickRadius);
                if (nearbyNode) {
                    resolvedNodeId = nearbyNode.id();
                }
            }

            // Handle node focus on mousedown to avoid delayed click transitions.
            if (resolvedNodeId) {
                setBackgroundMoveCursor(false);
                const node = topo && typeof topo.getNode === 'function' ? topo.getNode(resolvedNodeId) : null;
                if (node) {
                    const startNodePos = getStableNodeModelPosition(node);
                    pendingNodeDrag = {
                        nodeId: resolvedNodeId,
                        startClientX: evt.clientX,
                        startClientY: evt.clientY,
                        startTs: now,
                        startNodeX: Number(startNodePos.x) || 0,
                        startNodeY: Number(startNodePos.y) || 0,
                        moved: false,
                        tooltipHidden: false,
                    };
                    lastNodePrimaryDown = { nodeId: resolvedNodeId, ts: now };
                    lastNodeClickTs = now;
                }
            } else {
                // If a node is focused, background click should clear focus, not start pan mode.
                if (activeSelectedNodeId) {
                    clearSelectedNodeVisuals(true);
                    closeAllTopologyTooltips();
                    setBackgroundMoveCursor(false);
                    stopBackgroundPanTracking();
                    return;
                }

                pendingNodeDrag = null;
                pendingBackgroundClick = {
                    clientX: evt.clientX,
                    clientY: evt.clientY,
                    moved: false,
                };
                backgroundPanState = {
                    startClientX: evt.clientX,
                    startClientY: evt.clientY,
                    lastClientX: evt.clientX,
                    lastClientY: evt.clientY,
                    engaged: false,
                };
                setBackgroundMoveCursor(true);
                startBackgroundPanTracking();
            }
            return;
        }

        if (editorMode !== 'addLink') return;

        if (Date.now() - lastNodeClickTs < INTERACTION.suppressClickNodeMs) return;

        // Fallback path when NeXt clickNode doesn't fire during icon focus animation.
        showDebugHitCircle(evt.clientX, evt.clientY, INTERACTION.linkPickRadius);
        const nearest = findNearestNodeByClientPoint(evt.clientX, evt.clientY, INTERACTION.linkPickRadius);
        if (nearest) {
            processLinkNodeSelection(nearest);
        }
    }

    function handleDocumentPointerMove(evt) {
        // Close tooltip when node drag movement is detected
        if (pendingNodeDrag && (evt.buttons & 1) === 1) {
            const dxNode = evt.clientX - pendingNodeDrag.startClientX;
            const dyNode = evt.clientY - pendingNodeDrag.startClientY;
            const distanceSq = dxNode * dxNode + dyNode * dyNode;
            const thresholdSq = INTERACTION.nodeDragHideTooltipPx * INTERACTION.nodeDragHideTooltipPx;
            
            // Only treat movement as drag after a meaningful pointer delta.
            if (distanceSq >= thresholdSq && !pendingNodeDrag.tooltipHidden) {
                pendingNodeDrag.moved = true;
                if (closeAllTopologyTooltips()) {
                    pendingNodeDrag.tooltipHidden = true;
                }
            }
        }

        if (backgroundPanState) {
            const startDx = evt.clientX - backgroundPanState.startClientX;
            const startDy = evt.clientY - backgroundPanState.startClientY;
            const startThresholdSq = INTERACTION.backgroundDragStartPx * INTERACTION.backgroundDragStartPx;

            if (!backgroundPanState.engaged) {
                if ((startDx * startDx + startDy * startDy) < startThresholdSq) {
                    return;
                }
                backgroundPanState.engaged = true;
                backgroundPanState.lastClientX = evt.clientX;
                backgroundPanState.lastClientY = evt.clientY;
                if (pendingBackgroundClick) {
                    pendingBackgroundClick.moved = true;
                }
                return;
            }

            const dxPan = evt.clientX - backgroundPanState.lastClientX;
            const dyPan = evt.clientY - backgroundPanState.lastClientY;
            if (dxPan !== 0 || dyPan !== 0) {
                const stage = topo && typeof topo.stage === 'function' ? topo.stage() : null;
                if (stage && typeof stage.applyTranslate === 'function') {
                    stage.applyTranslate(dxPan, dyPan);
                } else if (topo && typeof topo.move === 'function') {
                    topo.move(dxPan, dyPan, 0.2);
                }
                backgroundPanState.lastClientX = evt.clientX;
                backgroundPanState.lastClientY = evt.clientY;
                backgroundPanState.moved = true;
                if (pendingBackgroundClick) {
                    pendingBackgroundClick.moved = true;
                }
            }
            return;
        }

        if ((evt.buttons & 1) !== 1) return;

        if (!pendingBackgroundClick) return;

        const dx = evt.clientX - pendingBackgroundClick.clientX;
        const dy = evt.clientY - pendingBackgroundClick.clientY;
        if ((dx * dx + dy * dy) > 16) {
            pendingBackgroundClick.moved = true;
        }
    }

    function handleDocumentClick(evt) {
        if (evt.button !== 0) return;
        if (evt.ctrlKey) return;
        if (editorMode !== 'view') return;

        const surface = getTopologySurfaceElement();
        if (!surface || !surface.contains(evt.target)) return;

        const nodeId = getNodeIdFromEventTarget(evt.target);
        if (nodeId) {
            pendingBackgroundClick = null;
            return;
        }
        pendingBackgroundClick = null;
    }

    function handleDocumentDoubleClick(evt) {
        if (editorMode !== 'view') return;

        const surface = getTopologySurfaceElement();
        if (!surface || !surface.contains(evt.target)) return;

        let node = null;
        const nodeId = getNodeIdFromEventTarget(evt.target);
        if (nodeId) {
            node = topo && typeof topo.getNode === 'function' ? topo.getNode(nodeId) : null;
        }
        if (!node) {
            // Fallback for SVG/text targets that don't expose a node data-id directly.
            const pickRadius = Math.max(
                INTERACTION.focusPickRadius,
                INTERACTION.linkPickRadius,
                INTERACTION.contextPickRadius
            );
            node = findNearestNodeByClientPoint(evt.clientX, evt.clientY, pickRadius);
        }
        if (!node) return;

        openNodeStatusWindowOnce(node, Date.now());
        evt.preventDefault();
    }

    function handleDocumentPointerUp(evt) {
        if (evt.button !== 0) return;
        const finishedNodeDrag = pendingNodeDrag;
        
        pendingNodeDrag = null;
        setBackgroundMoveCursor(false);

        if (editorMode === 'view' && !suppressNodeDetails && finishedNodeDrag && finishedNodeDrag.nodeId) {
            // Only open tooltip on left-button release when no drag movement occurred.
            if (!finishedNodeDrag.moved) {
                const node = topo && typeof topo.getNode === 'function' ? topo.getNode(finishedNodeDrag.nodeId) : null;
                if (node && !isTooltipBlocked()) {
                    const now = Date.now();
                    lastNodeClickRecord = { nodeId: node.id(), ts: now };
                    handleNodePrimaryClick(node, now);
                    lastImmediateFocusTs = now;
                }
            }
        }

        pendingBackgroundClick = null;
        backgroundPanState = null;
        stopBackgroundPanTracking();

        // Always capture final position on left-button release.
        // Drag release can happen slightly outside topology element, so do not gate by event target.
        queueSaveNodePositions(140);
    }

    function startBackgroundPanTracking() {
        if (InteractionController && typeof InteractionController.startBackgroundPanTracking === 'function') {
            InteractionController.startBackgroundPanTracking({
                handleDocumentPointerMove: handleDocumentPointerMove,
                handleDocumentPointerUp: handleDocumentPointerUp,
            });
            return;
        }
        if (window.__nextuiBgPanMoveBound) return;
        window.addEventListener('mousemove', handleDocumentPointerMove, true);
        window.addEventListener('mouseup', handleDocumentPointerUp, true);
        window.__nextuiBgPanMoveBound = true;
    }

    function stopBackgroundPanTracking() {
        if (InteractionController && typeof InteractionController.stopBackgroundPanTracking === 'function') {
            InteractionController.stopBackgroundPanTracking({
                handleDocumentPointerMove: handleDocumentPointerMove,
                handleDocumentPointerUp: handleDocumentPointerUp,
                setBackgroundMoveCursor: setBackgroundMoveCursor,
            });
            return;
        }
        if (!window.__nextuiBgPanMoveBound) return;
        window.removeEventListener('mousemove', handleDocumentPointerMove, true);
        window.removeEventListener('mouseup', handleDocumentPointerUp, true);
        window.__nextuiBgPanMoveBound = false;
        setBackgroundMoveCursor(false);
    }

    function cancelActiveLinkCreation() {
        closeModal('linkIfModal');
        clearLinkDraft();
        setEditorMode('view');
        updateEditorStatus();
    }

    function handleDocumentKeyDown(evt) {
        if (evt.key !== 'Escape') return;

        const modal = document.getElementById('linkIfModal');
        const modalOpen = !!(modal && modal.classList.contains('open'));
        if (editorMode === 'addLink' || modalOpen) {
            evt.preventDefault();
            cancelActiveLinkCreation();
        }
    }

    function findNearestNodeByClientPoint(clientX, clientY, threshold) {
        const topologyEl = getTopologySurfaceElement();
        if (!topologyEl) return null;
        const rect = topologyEl.getBoundingClientRect();
        const clickX = clientX - rect.left;
        const clickY = clientY - rect.top;

        let nearest = null;
        let nearestDist = Number.POSITIVE_INFINITY;
        topo.eachNode(function(node) {
            const center = getNodeCenterInViewport(node, rect);
            if (!center) return;
            const dx = center.x - clickX;
            const dy = center.y - clickY;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = node;
            }
        });

        if (nearest && nearestDist <= threshold) {
            updateDebugOverlay({
                event: 'hit-test',
                clientX,
                clientY,
                radius: threshold,
                nearestId: nearest.id(),
                distance: nearestDist,
            });
            return nearest;
        }
        updateDebugOverlay({
            event: 'hit-test',
            clientX,
            clientY,
            radius: threshold,
            nearestId: nearest ? nearest.id() : null,
            distance: nearestDist,
        });
        return null;
    }

    function showNodeContextMenu(nodeId, clientX, clientY) {
        const menu = document.getElementById('nodeContextMenu');
        if (!menu) return;

        if (!nodeId) {
            hideNodeContextMenu();
            hideDebugVisuals();
            return;
        }

        contextMenuActive = true;
        blockTooltipAfterContextMenu(700);
        contextMenuNodeId = nodeId;

        const addBtn = document.getElementById('ctxAddLinkBtn');
        if (addBtn) {
            addBtn.disabled = !nodeId;
            addBtn.textContent = nodeId ? `Add Link (${nodeId})` : 'Add Link (Select node first)';
        }

        const deleteBtn = document.getElementById('ctxDeleteNodeBtn');
        if (deleteBtn) {
            const labRunning = !!currentLabId;
            deleteBtn.disabled = !nodeId || labRunning;
            if (labRunning) {
                deleteBtn.textContent = 'Delete Node (Stop lab first)';
                deleteBtn.title = 'Lab is running. Stop the lab before deleting nodes.';
            } else {
                deleteBtn.title = '';
                deleteBtn.textContent = nodeId ? `Delete Node (${nodeId})` : 'Delete Node (Select node first)';
            }
        }

        const maxX = window.innerWidth - menu.offsetWidth - INTERACTION.menuMargin;
        const maxY = window.innerHeight - menu.offsetHeight - INTERACTION.menuMargin;
        const safeX = Math.max(INTERACTION.menuMargin, Math.min(clientX, maxX));
        const safeY = Math.max(INTERACTION.menuMargin, Math.min(clientY, maxY));

        menu.style.left = `${safeX}px`;
        menu.style.top = `${safeY}px`;
        menu.classList.add('open');
    }

    function hideNodeContextMenu() {
        const menu = document.getElementById('nodeContextMenu');
        if (!menu) return;
        contextMenuNodeId = null;
        contextMenuActive = false;
        menu.classList.remove('open');
    }

    function handleTopologyContextMenu(evt) {
        // Own the right-click interaction in topology area.
        evt.preventDefault();
        evt.stopPropagation();

        const directNodeId = getNodeIdFromEventTarget(evt.target);
        if (directNodeId) {
            showNodeContextMenu(directNodeId, evt.clientX, evt.clientY);
            return;
        }

        // Be tolerant for right-click hit-testing; user intent is usually nearby.
        showDebugHitCircle(evt.clientX, evt.clientY, INTERACTION.contextPickRadius);
        const nearest = findNearestNodeByClientPoint(evt.clientX, evt.clientY, INTERACTION.contextPickRadius);
        if (!nearest) {
            hideNodeContextMenu();
            hideDebugVisuals();
            return;
        }
        showNodeContextMenu(nearest.id(), evt.clientX, evt.clientY);
    }

    function startAddLinkFromNode(nodeId) {
        const node = topo.getNode(nodeId);
        if (!node) {
            hideNodeContextMenu();
            return;
        }

        hideNodeContextMenu();
        setEditorMode('addLink');
        clearLinkDraft();

        linkSourceNodeId = nodeId;
        node.selected(true);
        startLinkPreviewFromNode(nodeId);
        updateEditorStatus('Add Link: select second node');
    }

    function startAddLinkFromContextMenu() {
        if (!contextMenuNodeId) {
            hideNodeContextMenu();
            return;
        }
        startAddLinkFromNode(contextMenuNodeId);
    }

    function deleteNodeFromContextMenu() {
        const nodeId = contextMenuNodeId;
        hideNodeContextMenu();

        if (!nodeId) return;

        if (currentLabId) {
            alert('Cannot delete node while lab is running.\nStop the lab first.');
            return;
        }

        const node = topo.getNode(nodeId);
        if (!node) return;

        const nodeData = (node.model && node.model().getData && node.model().getData()) || {};
        const nodeName = nodeData.name || nodeId;
        if (!confirm(`Delete node '${nodeName}'?`)) {
            return;
        }

        topo.deleteNode(nodeId);

        if (selectedNodeInfo && selectedNodeInfo.id === nodeId) {
            selectedNodeInfo = null;
        }
        if (activeSelectedNodeId === nodeId) {
            activeSelectedNodeId = null;
        }
        if (linkSourceNodeId === nodeId) {
            clearLinkDraft();
        }

        updateStatusPanel();
        updateEditorStatus();
        queueSaveNodePositions(60);

        // Refresh YAML modal if it is currently open
        const yamlModal = document.getElementById('yamlModal');
        if (yamlModal && yamlModal.classList.contains('open')) {
            refreshExportModalOutput();
        }
    }

    function getNodeCenterInViewport(node, topologyRect) {
        if (!node || !node.position) return null;
        const pos = node.position();
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
        const rect = topologyRect || (function() {
            const topologyEl = getTopologySurfaceElement();
            return topologyEl ? topologyEl.getBoundingClientRect() : { left: 0, top: 0 };
        })();

        // Prefer NeXt absolute position API, then fall back to matrix transform.
        if (typeof topo.getAbsolutePosition === 'function') {
            const abs = topo.getAbsolutePosition(pos);
            if (abs && Number.isFinite(abs.x) && Number.isFinite(abs.y)) {
                return {
                    x: abs.x - rect.left,
                    y: abs.y - rect.top
                };
            }
        }

        const tf = getStageTransform();
        return {
            x: pos.x * tf.scale + tf.tx,
            y: pos.y * tf.scale + tf.ty
        };
    }

    function handleTopologyBackgroundClick(evt) {
        if (editorMode !== 'addLink') return;

        // Wider pick radius so nearby clicks are still treated as node selection.
        const nearest = findNearestNodeByClientPoint(evt.clientX, evt.clientY, INTERACTION.linkPickRadius);
        if (nearest) {
            processLinkNodeSelection(nearest);
        }
    }

    function ensureLinkPreviewLayer() {
        const topologyEl = getTopologySurfaceElement();
        if (!topologyEl) return null;

        if (getComputedStyle(topologyEl).position === 'static') {
            topologyEl.style.position = 'relative';
        }

        // Remove orphan preview layers that can remain after remount/reload cycles.
        const staleLayers = topologyEl.querySelectorAll(`#${LINK_PREVIEW_LAYER_ID}`);
        if (staleLayers.length > 1 || (staleLayers.length === 1 && staleLayers[0] !== linkPreviewLayer)) {
            staleLayers.forEach(function(layer) {
                if (layer !== linkPreviewLayer) {
                    try { layer.remove(); } catch (e) {}
                }
            });
        }

        if (!linkPreviewLayer) {
            const svgNS = 'http://www.w3.org/2000/svg';
            linkPreviewLayer = document.createElementNS(svgNS, 'svg');
            linkPreviewLayer.setAttribute('id', LINK_PREVIEW_LAYER_ID);
            linkPreviewLayer.setAttribute('viewBox', `0 0 ${topologyEl.clientWidth || 1} ${topologyEl.clientHeight || 1}`);
            linkPreviewLayer.style.position = 'absolute';
            linkPreviewLayer.style.left = '0';
            linkPreviewLayer.style.top = '0';
            linkPreviewLayer.style.width = '100%';
            linkPreviewLayer.style.height = '100%';
            linkPreviewLayer.style.pointerEvents = 'none';
            linkPreviewLayer.style.zIndex = '500';

            linkPreviewLine = document.createElementNS(svgNS, 'line');
            linkPreviewLine.setAttribute('id', LINK_PREVIEW_LINE_ID);
            linkPreviewLine.setAttribute('stroke', '#FF9800');
            linkPreviewLine.setAttribute('stroke-width', '3');
            linkPreviewLine.setAttribute('stroke-dasharray', '6 4');
            linkPreviewLine.setAttribute('stroke-linecap', 'round');
            linkPreviewLine.style.display = 'none';

            linkPreviewLayer.appendChild(linkPreviewLine);
            topologyEl.appendChild(linkPreviewLayer);
        }

        linkPreviewLayer.setAttribute('viewBox', `0 0 ${topologyEl.clientWidth || 1} ${topologyEl.clientHeight || 1}`);
        return { topologyEl, line: linkPreviewLine };
    }

    function cleanupLinkPreviewArtifacts() {
        hideLinkPreview();
        const allLayers = document.querySelectorAll(`#${LINK_PREVIEW_LAYER_ID}`);
        allLayers.forEach(function(layer) {
            try { layer.remove(); } catch (e) {}
        });
        linkPreviewLayer = null;
        linkPreviewLine = null;
    }

    function showLinkPreview(startX, startY, endX, endY) {
        const preview = ensureLinkPreviewLayer();
        if (!preview || !preview.line) return;
        preview.line.setAttribute('x1', String(startX));
        preview.line.setAttribute('y1', String(startY));
        preview.line.setAttribute('x2', String(endX));
        preview.line.setAttribute('y2', String(endY));
        preview.line.style.display = 'block';
    }

    function hideLinkPreview() {
        if (linkPreviewLine) {
            linkPreviewLine.style.display = 'none';
        }
        const existing = document.getElementById(LINK_PREVIEW_LINE_ID);
        if (existing) {
            existing.style.display = 'none';
        }
    }

    function startLinkPreviewFromNode(nodeId) {
        const node = topo.getNode(nodeId);
        const preview = ensureLinkPreviewLayer();
        if (!node || !node.position || !preview) return;

        const center = getNodeCenterInViewport(node);
        if (!center) return;
        const startX = center.x;
        const startY = center.y;

        linkDraft = {
            srcId: nodeId,
            srcX: startX,
            srcY: startY,
            tgtId: null,
        };
        showLinkPreview(startX, startY, startX, startY);
    }

    function updateLinkPreviewToMouse(evt) {
        if (editorMode !== 'addLink' || !linkDraft || linkDraft.tgtId) return;
        const topologyEl = getTopologySurfaceElement();
        if (!topologyEl) return;
        if (!topologyEl.contains(evt.target)) return;
        const rect = getSurfaceRectCached(topologyEl);
        if (!rect) return;
        lastMousePoint = {
            x: evt.clientX - rect.left,
            y: evt.clientY - rect.top
        };

        if (previewRafId) return;
        previewRafId = window.requestAnimationFrame(function() {
            previewRafId = null;
            if (!lastMousePoint || editorMode !== 'addLink' || !linkDraft || linkDraft.tgtId) return;
            showLinkPreview(linkDraft.srcX, linkDraft.srcY, lastMousePoint.x, lastMousePoint.y);
        });
    }

    function clearLinkDraft() {
        if (linkSourceNodeId) {
            const node = topo.getNode(linkSourceNodeId);
            if (node) node.selected(false);
        }
        linkSourceNodeId = null;
        linkDraft = null;
        hideLinkPreview();
        lastMousePoint = null;
        if (previewRafId) {
            window.cancelAnimationFrame(previewRafId);
            previewRafId = null;
        }
        hideLinkPreview();
        contextMenuNodeId = null;
        lastLinkPick = { nodeId: null, ts: 0 };
        surfaceRectCache = { el: null, ts: 0, rect: null };
    }

    function buildSelectOptions(selectEl, candidates, selected, usedSet) {
        if (!selectEl) return;
        selectEl.innerHTML = '';
        candidates.forEach(function(ifName) {
            const opt = document.createElement('option');
            opt.value = ifName;
            const isUsed = !!(usedSet && usedSet.has(ifName));
            opt.textContent = `${ifName}${isUsed ? ' (used)' : ''}`;
            if (isUsed && ifName !== selected) {
                opt.disabled = true;
            }
            selectEl.appendChild(opt);
        });
        if (selected) {
            selectEl.value = selected;
        }
    }

    function openLinkInterfaceModal(srcId, tgtId) {
        const srcNode = topo.getNode(srcId);
        const tgtNode = topo.getNode(tgtId);
        if (!srcNode || !tgtNode) {
            alert('Cannot open interface selector. Node lookup failed.');
            clearLinkDraft();
            setEditorMode('view');
            return;
        }

        const srcData = (srcNode.model().getData && srcNode.model().getData()) || {};
        const tgtData = (tgtNode.model().getData && tgtNode.model().getData()) || {};
        const srcName = srcData.name || srcId;
        const tgtName = tgtData.name || tgtId;
        const srcKind = srcData.kind || 'linux';
        const tgtKind = tgtData.kind || 'linux';
        const usedByNode = getUsedInterfacesByNode();
        const srcUsed = usedByNode.get(srcId) || new Set();
        const tgtUsed = usedByNode.get(tgtId) || new Set();
        const srcSuggested = suggestAvailableInterface(srcId, srcKind);
        const tgtSuggested = suggestAvailableInterface(tgtId, tgtKind);

        linkDraft = {
            srcId,
            tgtId,
            srcName,
            tgtName,
            srcKind,
            tgtKind,
            srcIfName: srcSuggested,
            tgtIfName: tgtSuggested,
            srcX: linkDraft ? linkDraft.srcX : null,
            srcY: linkDraft ? linkDraft.srcY : null,
        };

        const srcNodeEl = document.getElementById('linkIfSourceNode');
        const tgtNodeEl = document.getElementById('linkIfTargetNode');
        const srcIfEl = document.getElementById('linkIfSourceSelect');
        const tgtIfEl = document.getElementById('linkIfTargetSelect');
        if (!srcNodeEl || !tgtNodeEl || !srcIfEl || !tgtIfEl) {
            alert('Interface modal UI elements are missing.');
            clearLinkDraft();
            setEditorMode('view');
            return;
        }

        srcNodeEl.value = srcName;
        tgtNodeEl.value = tgtName;
        buildSelectOptions(srcIfEl, getInterfaceCandidates(srcKind, srcSuggested), srcSuggested, srcUsed);
        buildSelectOptions(tgtIfEl, getInterfaceCandidates(tgtKind, tgtSuggested), tgtSuggested, tgtUsed);

        const modal = document.getElementById('linkIfModal');
        if (modal) modal.classList.add('open');
        updateEditorStatus(`Choose interfaces for ${srcName} ↔ ${tgtName}`);
    }

    function confirmLinkInterfaceSelection() {
        if (!linkDraft || !linkDraft.srcId || !linkDraft.tgtId) {
            alert('No pending link selection.');
            return;
        }

        const srcIfEl = document.getElementById('linkIfSourceSelect');
        const tgtIfEl = document.getElementById('linkIfTargetSelect');
        const srcIfName = srcIfEl ? srcIfEl.value : '';
        const tgtIfName = tgtIfEl ? tgtIfEl.value : '';

        if (!srcIfName || !tgtIfName) {
            alert('Please select both interfaces.');
            return;
        }

        if (isReservedInterface(linkDraft.srcKind, srcIfName) || isReservedInterface(linkDraft.tgtKind, tgtIfName)) {
            alert('Selected interface is reserved for management and cannot be used for links.');
            return;
        }

        const addedLink = topo.addLink({
            source: linkDraft.srcId,
            target: linkDraft.tgtId,
            srcIfName: srcIfName,
            tgtIfName: tgtIfName
        });

        if (!addedLink) {
            alert('Link creation failed. Check node selection and existing links.');
            cancelLinkInterfaceSelection();
            return;
        }

        closeModal('linkIfModal');
        clearLinkDraft();
        setEditorMode('view');
        queueSaveNodePositions(60);
    }

    function cancelLinkInterfaceSelection() {
        closeModal('linkIfModal');
        clearLinkDraft();
        updateEditorStatus('Add Link: select first node');
    }

    /**
     * Centralized editor mode switch to keep button states consistent
     */
    function setEditorMode(mode) {
        if (mode !== 'addLink') {
            closeModal('linkIfModal');
            clearLinkDraft();
            cleanupLinkPreviewArtifacts();
        }

        if (mode !== 'view') {
            clearSelectedNodeVisuals(false);
        }

        editorMode = mode;
        AppState.interaction.mode = editorMode;
        if (mode === 'view' && topo) {
            if (typeof topo.activateScene === 'function') {
                try { topo.activateScene('default'); } catch (e) {}
            }
            if (typeof topo.blockEvent === 'function') {
                try { topo.blockEvent(false); } catch (e) {}
            }
        }
        setLinkPreviewMouseTracking(mode === 'addLink');
        linkSourceNodeId = null;
        suppressNodeDetails = (mode === 'addLink');
        document.body.classList.toggle('link-mode-active', mode === 'addLink');

        const addBtn = document.getElementById('btn-add-link');
        const delBtn = document.getElementById('btn-delete-mode');
        if (!delBtn) {
            updateEditorStatus();
            return;
        }

        if (addBtn) {
            addBtn.classList.remove('active-mode');
            addBtn.disabled = false;
        }
        delBtn.classList.remove('active-mode');
        delBtn.disabled = false;

        if (mode === 'addLink' && addBtn) {
            addBtn.classList.add('active-mode');
        } else if (mode === 'delete') {
            delBtn.classList.add('active-mode');
        }

        updateEditorStatus();
    }

    /**
     * Handle node click while in addLink mode
     */
    function handleLinkModeNodeClick(node) {
        const nodeId = node.id();
        if (!linkSourceNodeId) {
            linkSourceNodeId = nodeId;
            updateEditorStatus('Add Link: select second node');
            // Visually highlight first selected node
            node.selected(true);
            startLinkPreviewFromNode(nodeId);
        } else {
            if (linkSourceNodeId === nodeId) {
                // Same node clicked — cancel
                clearLinkDraft();
                updateEditorStatus();
                return;
            }
            const srcId  = linkSourceNodeId;
            const tgtId  = nodeId;
            // Deselect first node
            const firstNode = topo.getNode(srcId);
            if (firstNode) firstNode.selected(false);
            linkSourceNodeId = null;
            if (linkDraft) {
                linkDraft.tgtId = tgtId;
            }
            hideLinkPreview();
            openLinkInterfaceModal(srcId, tgtId);
        }
    }

    /**
     * Editor status badge update
     */
    function updateEditorStatus(msg) {
        const badge = document.getElementById('editor-mode-badge');
        if (!badge) return;
        badge.className = '';
        if (editorMode === 'addLink') {
            badge.className = 'mode-addLink';
            badge.textContent = msg || 'Add Link: select first node';
        } else if (editorMode === 'delete') {
            badge.className = 'mode-delete';
            badge.textContent = 'Delete Mode: click node/link to delete';
        } else {
            badge.textContent = '';
        }
    }

    /**
     * ---- TOPOLOGY EDITOR FUNCTIONS ----
     */

    /**
     * Clear canvas and start a new empty topology
     */
    function newTopology() {
        if (!confirm('Clear current topology?')) return;
        topo.clear();
        nodeInterfaceCounters.clear();
        cleanupLinkPreviewArtifacts();
        clearTopologySnapshotLocal();
        updateCurrentLabId(null);
        setEditorMode('view');
        updateStatusPanel();
    }

    /**
     * Get current viewport center in topology model coordinates
     * (Uses topology container's visible area, not browser window)
     */
    function getStageTransform() {
        // Prefer matrixObject when available (has x/y/scale accessors).
        if (topo && typeof topo.matrixObject === 'function') {
            const mObj = topo.matrixObject();
            if (mObj && typeof mObj.scale === 'function' && typeof mObj.x === 'function' && typeof mObj.y === 'function') {
                const s = mObj.scale();
                return {
                    scale: Number.isFinite(s) && s !== 0 ? s : 1,
                    tx: Number.isFinite(mObj.x()) ? mObj.x() : 0,
                    ty: Number.isFinite(mObj.y()) ? mObj.y() : 0
                };
            }
        }

        // Fallback to raw 3x3 matrix: [[s,0,0],[0,s,0],[tx,ty,1]]
        const raw = topo && typeof topo.matrix === 'function' ? topo.matrix() : null;
        if (Array.isArray(raw) && raw.length >= 3 && Array.isArray(raw[0]) && Array.isArray(raw[2])) {
            const s = Number(raw[0][0]);
            return {
                scale: Number.isFinite(s) && s !== 0 ? s : 1,
                tx: Number(raw[2][0]) || 0,
                ty: Number(raw[2][1]) || 0
            };
        }

        return { scale: 1, tx: 0, ty: 0 };
    }

    function getViewportCenterModelPosition() {
        const stageEl = getTopologySurfaceElement();
        if (!stageEl) {
            return { x: 0, y: 0 };
        }

        // Use clientWidth/clientHeight (topology container's visible area)
        const containerWidth = stageEl.clientWidth;
        const containerHeight = stageEl.clientHeight;
        
        if (containerWidth <= 0 || containerHeight <= 0) {
            return { x: 0, y: 0 };
        }

        // Center pixel position within topology container
        const centerPixelX = containerWidth / 2;
        const centerPixelY = containerHeight / 2;

        // Get stage transform for coordinate conversion
        const tf = getStageTransform();

        // Inverse transform: (pixel_coord - translation) / scale = model_coord
        return {
            x: (centerPixelX - tf.tx) / tf.scale,
            y: (centerPixelY - tf.ty) / tf.scale
        };
    }

    /**
     * Re-center viewport to keep a node visible in the current screen.
     */
    function centerNodeInViewport(node) {
        const stageEl = getTopologySurfaceElement();
        if (!stageEl || !node || !node.position) return;

        const rect = stageEl.getBoundingClientRect();
        const viewportCenterAbs = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };

        const nodeAbs = topo.getAbsolutePosition(node.position());
        const dx = viewportCenterAbs.x - nodeAbs.x;
        const dy = viewportCenterAbs.y - nodeAbs.y;

        // Smoothly pan stage so the newly added node is centered on screen.
        topo.move(dx, dy, 0.25);
    }

    /**
     * Check whether a node is currently visible inside the topology viewport.
     */
    function isNodeVisibleInViewport(node, margin = 20) {
        const stageEl = getTopologySurfaceElement();
        if (!stageEl || !node || !node.position || !topo || typeof topo.getAbsolutePosition !== 'function') {
            return false;
        }

        const rect = stageEl.getBoundingClientRect();
        const nodeAbs = topo.getAbsolutePosition(node.position());
        if (!nodeAbs || !Number.isFinite(nodeAbs.x) || !Number.isFinite(nodeAbs.y)) {
            return false;
        }

        return (
            nodeAbs.x >= rect.left + margin &&
            nodeAbs.x <= rect.right - margin &&
            nodeAbs.y >= rect.top + margin &&
            nodeAbs.y <= rect.bottom - margin
        );
    }

    function buildBulkNodeNames(namePattern, count) {
        const pattern = String(namePattern || '').trim();
        if (!pattern) return [];

        const hasBracedToken = pattern.indexOf('{$count}') >= 0;
        const hasPlainToken = pattern.indexOf('$count') >= 0;
        const hasToken = hasBracedToken || hasPlainToken;

        const names = [];
        for (let i = 1; i <= count; i++) {
            const idx = String(i);
            if (hasBracedToken) {
                names.push(pattern.split('{$count}').join(idx));
            } else if (hasPlainToken) {
                names.push(pattern.split('$count').join(idx));
            } else if (count === 1) {
                names.push(pattern);
            } else {
                names.push(`${pattern}-${idx}`);
            }
        }
        return names;
    }

    function getBulkNodeBasePosition(existingNodes) {
        if (!existingNodes || existingNodes.length === 0) {
            return getViewportCenterModelPosition();
        }

        let sumX = 0;
        let sumY = 0;
        existingNodes.forEach(function(node) {
            const pos = node.position ? node.position() : { x: 0, y: 0 };
            sumX += (pos && typeof pos.x === 'number') ? pos.x : 0;
            sumY += (pos && typeof pos.y === 'number') ? pos.y : 0;
        });

        return {
            x: sumX / existingNodes.length,
            y: sumY / existingNodes.length,
        };
    }

    function getBulkLayoutParams(count) {
        const safeCount = Math.max(1, Number(count) || 1);
        const cols = Math.ceil(Math.sqrt(safeCount));
        const rows = Math.ceil(safeCount / cols);

        const stageEl = getTopologySurfaceElement();
        const tf = getStageTransform();
        const scale = Number.isFinite(tf.scale) && tf.scale > 0 ? tf.scale : 1;

        const viewportModelWidth = stageEl ? (stageEl.clientWidth / scale) : 1000;
        const viewportModelHeight = stageEl ? (stageEl.clientHeight / scale) : 700;
        const pad = 70;

        const spacingX = cols > 1 ? (viewportModelWidth - (pad * 2)) / (cols - 1) : 0;
        const spacingY = rows > 1 ? (viewportModelHeight - (pad * 2)) / (rows - 1) : 0;

        const maxSpacing = 90;
        const minSpacing = 18;
        let spacing = maxSpacing;
        if (cols > 1 || rows > 1) {
            const sx = Number.isFinite(spacingX) && spacingX > 0 ? spacingX : maxSpacing;
            const sy = Number.isFinite(spacingY) && spacingY > 0 ? spacingY : maxSpacing;
            spacing = Math.max(minSpacing, Math.min(maxSpacing, sx, sy));
        }

        return { cols, rows, spacing };
    }

    function getBulkNodeOffset(index, count, layoutParams) {
        if (count <= 1) {
            return { x: 0, y: 0 };
        }

        const params = layoutParams || getBulkLayoutParams(count);
        const spacing = params.spacing;
        const cols = params.cols;
        const rows = params.rows;
        const row = Math.floor(index / cols);
        const col = index % cols;
        const jitter = Math.min(8, Math.max(0, spacing * 0.12));

        return {
            x: (col - (cols - 1) / 2) * spacing + (Math.random() * jitter * 2 - jitter),
            y: (row - (rows - 1) / 2) * spacing + (Math.random() * jitter * 2 - jitter),
        };
    }

    /**
     * Open Add Node modal
     */
    function openAddNodeModal() {
        const hasRegisteredKinds = refreshAddNodeKindOptions('linux');
        if (!hasRegisteredKinds) {
            alert('No kind/image mapping is registered.\nPlease add at least one mapping in Develop > Kind -> Image Registry.');
            return;
        }

        document.getElementById('nodeName').value = 'r-{$count}';
        const countEl = document.getElementById('nodeCount');
        if (countEl) countEl.value = '1';
        const selectedKind = document.getElementById('nodeKind').value;
        const defs = KIND_DEFAULTS[selectedKind] || { icon: 'host' };
        document.getElementById('nodeIcon').value = defs.icon;
        document.getElementById('addNodeModal').classList.add('open');
        document.getElementById('nodeName').focus();
    }

    /**
     * Auto-fill image/icon when kind changes in the Add Node modal
     */
    function onKindChange() {
        const kindSelect = document.getElementById('nodeKind');
        const imageSelect = document.getElementById('nodeImage');
        if (!kindSelect || !imageSelect) return;

        const kind = kindSelect.value;
        const mappedImage = getRegisteredImageForKind(kind);
        const defs = KIND_DEFAULTS[kind] || { icon: 'host' };
        imageSelect.innerHTML = '';

        const option = document.createElement('option');
        option.value = mappedImage || '';
        option.textContent = option.value || '(no image registered)';
        imageSelect.appendChild(option);
        imageSelect.value = option.value;

        document.getElementById('nodeIcon').value  = defs.icon;
    }

    /**
     * Add node from the modal form values
     */
    function addNodeFromForm() {
        const namePattern = document.getElementById('nodeName').value.trim();
        if (!namePattern) { alert('Node name is required.'); return; }

        const countRaw = Number((document.getElementById('nodeCount') || {}).value || 1);
        const nodeCount = Number.isFinite(countRaw) ? Math.max(1, Math.min(200, Math.floor(countRaw))) : 1;
        const nodeNames = buildBulkNodeNames(namePattern, nodeCount);
        if (nodeNames.length === 0) {
            alert('Invalid node name pattern.');
            return;
        }

        const kind     = document.getElementById('nodeKind').value;
        const image    = (document.getElementById('nodeImage').value || '').trim();
        const iconType = document.getElementById('nodeIcon').value;
        const registeredImage = getRegisteredImageForKind(kind);

        if (!kind) { alert('Select a registered kind first.'); return; }
        if (!image) { alert('No registered image for selected kind. Register it in Develop tab first.'); return; }
        if (!registeredImage || image !== registeredImage) {
            alert('Selected kind/image is not registered. Re-open Add Node and try again.');
            return;
        }

        // Collect existing nodes using NeXt's iterator API.
        const existingNodes = [];
        topo.eachNode(function(node) {
            existingNodes.push(node);
        });

        const basePos = nodeNames.length > 1
            ? getViewportCenterModelPosition()
            : getBulkNodeBasePosition(existingNodes);
        const bulkLayout = getBulkLayoutParams(nodeNames.length);
        let firstAddedNode = null;
        let createdCount = 0;
        const skippedNames = [];
        const addedNodes = [];

        nodeNames.forEach(function(name, index) {
            const offset = getBulkNodeOffset(index, nodeNames.length, bulkLayout);
            let x = basePos.x + offset.x;
            let y = basePos.y + offset.y;

            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                const center = getViewportCenterModelPosition();
                x = Number.isFinite(center.x) ? center.x : 0;
                y = Number.isFinite(center.y) ? center.y : 0;
            }

            const addedNode = topo.addNode({
                id:       name,
                name:     name,
                label:    name,
                kind:     kind,
                image:    image,
                icon:     iconType,
                iconType: iconType,
                primaryIP: getOrAssignMgmtIp(name),
                x:        x,
                y:        y
            });

            if (!addedNode) {
                skippedNames.push(name);
                return;
            }

            createdCount += 1;
            addedNodes.push(addedNode);
            if (!firstAddedNode) {
                firstAddedNode = addedNode;
            }
        });

        if (createdCount === 0) {
            alert('No nodes were created. Check duplicate names and pattern.');
            return;
        }

        if (addedNodes.length > 1) {
            const centerModel = addedNodes.reduce(function(acc, node) {
                const pos = node.position ? node.position() : { x: 0, y: 0 };
                acc.x += (pos && Number.isFinite(pos.x)) ? pos.x : 0;
                acc.y += (pos && Number.isFinite(pos.y)) ? pos.y : 0;
                return acc;
            }, { x: 0, y: 0 });
            centerModel.x /= addedNodes.length;
            centerModel.y /= addedNodes.length;

            const stageEl = getTopologySurfaceElement();
            if (stageEl && topo && typeof topo.getAbsolutePosition === 'function') {
                const rect = stageEl.getBoundingClientRect();
                const centerAbs = topo.getAbsolutePosition(centerModel);
                if (centerAbs && Number.isFinite(centerAbs.x) && Number.isFinite(centerAbs.y)) {
                    const dx = (rect.left + rect.width / 2) - centerAbs.x;
                    const dy = (rect.top + rect.height / 2) - centerAbs.y;
                    topo.move(dx, dy, 0.25);
                }
            }
        } else if (firstAddedNode && !isNodeVisibleInViewport(firstAddedNode)) {
            centerNodeInViewport(firstAddedNode);
        }

        queueSaveNodePositions(60);

        closeModal('addNodeModal');

        if (skippedNames.length > 0) {
            alert(`Created ${createdCount} node(s). Skipped ${skippedNames.length} duplicate name(s).`);
        }
    }

    /**
     * Toggle Add Link mode
     */
    function toggleAddLinkMode() {
        setEditorMode(editorMode === 'addLink' ? 'view' : 'addLink');
    }

    /**
     * Toggle Delete mode
     */
    function toggleDeleteMode() {
        setEditorMode(editorMode === 'delete' ? 'view' : 'delete');
    }

    /**
     * Collect current topology nodes and links from the diagram
     */
    function getCurrentTopologyData() {
        const labName = (document.getElementById('lab-name-input') || {}).value || 'my-lab';
        const nodes = [];
        const links = [];

        topo.eachNode(function(node) {
            const rawData = (node.model().getData && node.model().getData()) || {};
            nodes.push({
                id:       rawData.id   || node.id(),
                name:     rawData.name || node.id(),
                kind:     rawData.kind  || 'linux',
                image:    rawData.image || 'ubuntu:20.04',
                iconType: rawData.iconType || 'host'
            });
        });

        topo.eachLink(function(link) {
            const m = link.model();
            const rawData = (m.getData && m.getData()) || {};
            links.push({
                source:     m.sourceID ? m.sourceID() : rawData.source,
                target:     m.targetID ? m.targetID() : rawData.target,
                srcIfName:  rawData.srcIfName || 'eth0',
                tgtIfName:  rawData.tgtIfName || 'eth0'
            });
        });

        return { labName, nodes, links };
    }

    function normalizeInterfaceNameForYaml(kind, ifName) {
        return normalizeInterfaceNameByRule(String(kind || '').trim(), ifName, null, null);
    }

    function normalizeInterfaceNameByRule(kindKey, ifName, ruleOverride, reservedOverride) {
        const normalizedKindKey = String(kindKey || '').trim();
        const label = String(ifName || '').trim();
        const rule = ruleOverride || getInterfaceRule(normalizedKindKey);

        function isReservedLabel(ifLabel) {
            if (reservedOverride instanceof Set) {
                return reservedOverride.has(String(ifLabel || '').trim());
            }
            return isReservedInterface(normalizedKindKey, ifLabel);
        }

        function firstNonReservedInterface(offsetHint) {
            const maxCount = Number(rule.max) || 8;
            const begin = Math.max(0, Number(offsetHint) || 0);
            for (let i = begin; i < maxCount; i++) {
                const candidate = formatInterfaceByRule(rule, i);
                if (!isReservedLabel(candidate)) return candidate;
            }
            return formatInterfaceByRule(rule, 0);
        }

        // Fill missing labels with the kind's first available interface.
        let normalized = label;
        if (!normalized) {
            normalized = firstNonReservedInterface(0);
        }

        // Convert legacy ethN labels to the configured naming rule.
        const ethMatch = normalized.match(/^eth(\d+)$/i);
        if (ethMatch) {
            normalized = firstNonReservedInterface(Number(ethMatch[1]));
        }

        // Avoid exporting reserved interfaces as link endpoints.
        if (isReservedLabel(normalized)) {
            normalized = firstNonReservedInterface(0);
        }

        // XRD requires Gi0-0-0-x style in endpoints for reliable parsing.
        if (normalizedKindKey === 'cisco_xrd' || normalizedKindKey === 'xrd') {
            const longMatch = normalized.match(/^GigabitEthernet0\/0\/0\/(\d+)$/i);
            if (longMatch) return `Gi0-0-0-${longMatch[1]}`;

            const shortMatch = normalized.match(/^Gi0-0-0-(\d+)$/i);
            if (shortMatch) return `Gi0-0-0-${shortMatch[1]}`;

            const fallbackEthMatch = normalized.match(/^eth(\d+)$/i);
            if (fallbackEthMatch) return `Gi0-0-0-${fallbackEthMatch[1]}`;
        }

        return normalized || firstNonReservedInterface(0);
    }

    /**
     * Generate containerlab YAML string from current topology
     */
    function generateYAML() {
        const exportData = buildExportTopologyData();
        if (!exportData) return '# No nodes in topology';

        const exportedAt = new Date().toISOString();
        const mgmt = (exportData.mgmt && typeof exportData.mgmt === 'object') ? exportData.mgmt : null;
        const nodesByName = exportData.topology.nodes || {};
        const links = Array.isArray(exportData.topology.links) ? exportData.topology.links : [];

        let yaml = `# exported_at: ${exportedAt}\nname: ${exportData.name}\n`;
        if (mgmt) {
            yaml += `\nmgmt:\n`;
            yaml += `  network: ${mgmt.network}\n`;
            yaml += `  ipv4-subnet: ${mgmt['ipv4-subnet']}\n`;
        }
        yaml += `\ntopology:\n  nodes:\n`;
        Object.keys(nodesByName).forEach(function(nodeName) {
            const node = nodesByName[nodeName] || {};
            yaml += `    ${nodeName}:\n`;
            yaml += `      kind: ${node.kind}\n`;
            if (node.image) yaml += `      image: ${node.image}\n`;
            if (Array.isArray(node.ports) && node.ports.length > 0) {
                yaml += `      ports:\n`;
                node.ports.forEach(function(portMapping) {
                    yaml += `        - "${String(portMapping)}"\n`;
                });
            }
        });

        yaml += `\n  links:\n`;
        if (links.length === 0) {
            yaml += `    []  # no links defined\n`;
        } else {
            links.forEach(function(link) {
                const endpoints = Array.isArray(link.endpoints) ? link.endpoints : [];
                if (endpoints.length < 2) return;
                yaml += `    - endpoints: ["${endpoints[0]}", "${endpoints[1]}"]\n`;
            });
        }

        return yaml;
    }

    function buildExportTopologyData() {
        const { labName, nodes, links } = getCurrentTopologyData();
        if (!Array.isArray(nodes) || nodes.length === 0) return null;
        const mgmtConfig = refreshMgmtNetworkPreview();
        const sshPortRangeConfig = refreshSshPortRangePreview();

        const sortedNodes = nodes.slice().sort(function(a, b) {
            return String(a.name || '').localeCompare(String(b.name || ''));
        });

        const nodesByName = {};
        const nodeKindById = new Map();
        sortedNodes.forEach(function(n, index) {
            const nodeName = String(n.name || '').trim();
            if (!nodeName) return;
            const nodePayload = {
                kind: String(n.kind || 'linux'),
                image: String(n.image || '').trim(),
            };
            if (sshPortRangeConfig.isValid) {
                const hostPort = sshPortRangeConfig.start + index;
                if (hostPort <= sshPortRangeConfig.end) {
                    nodePayload.ports = [`${hostPort}:22`];
                }
            }
            nodesByName[nodeName] = {
                kind: nodePayload.kind,
                image: nodePayload.image,
            };
            if (Array.isArray(nodePayload.ports) && nodePayload.ports.length > 0) {
                nodesByName[nodeName].ports = nodePayload.ports;
            }
            nodeKindById.set(String(n.id || '').trim(), String(n.kind || ''));
            nodeKindById.set(nodeName, String(n.kind || ''));
        });

        const dedupedLinks = [];
        const seenLinkKeys = new Set();
        links.forEach(function(l) {
            const srcNode = String(l.source || '').trim();
            const tgtNode = String(l.target || '').trim();
            if (!srcNode || !tgtNode) return;

            const srcKind = nodeKindById.get(srcNode) || '';
            const tgtKind = nodeKindById.get(tgtNode) || '';
            const srcIfName = normalizeInterfaceNameForYaml(srcKind, l.srcIfName);
            const tgtIfName = normalizeInterfaceNameForYaml(tgtKind, l.tgtIfName);
            const endpointA = `${srcNode}:${srcIfName}`;
            const endpointB = `${tgtNode}:${tgtIfName}`;
            const canonical = [endpointA, endpointB].sort();
            const linkKey = `${canonical[0]}||${canonical[1]}`;
            if (seenLinkKeys.has(linkKey)) return;
            seenLinkKeys.add(linkKey);
            dedupedLinks.push({ endpoints: canonical });
        });

        dedupedLinks.sort(function(a, b) {
            const a0 = String((a.endpoints && a.endpoints[0]) || '');
            const b0 = String((b.endpoints && b.endpoints[0]) || '');
            const first = a0.localeCompare(b0);
            if (first !== 0) return first;
            const a1 = String((a.endpoints && a.endpoints[1]) || '');
            const b1 = String((b.endpoints && b.endpoints[1]) || '');
            return a1.localeCompare(b1);
        });

        return {
            name: String(labName || 'my-lab'),
            mgmt: {
                network: mgmtConfig.name,
                'ipv4-subnet': mgmtConfig.ipv4Subnet,
            },
            topology: {
                nodes: nodesByName,
                links: dedupedLinks,
            },
        };
    }

    function generateJSONExport() {
        const exportData = buildExportTopologyData();
        if (!exportData) return '{\n  "message": "No nodes in topology"\n}';
        return JSON.stringify(exportData, null, 2);
    }

    function setExportFormat(format) {
        exportPreviewFormat = (format === 'json') ? 'json' : 'yaml';
        const yamlTab = document.getElementById('export-tab-yaml');
        const jsonTab = document.getElementById('export-tab-json');
        if (yamlTab) yamlTab.classList.toggle('active', exportPreviewFormat === 'yaml');
        if (jsonTab) jsonTab.classList.toggle('active', exportPreviewFormat === 'json');

        const copyBtn = document.getElementById('export-copy-btn');
        const downloadBtn = document.getElementById('export-download-btn');
        if (copyBtn) copyBtn.textContent = exportPreviewFormat === 'json' ? 'Copy JSON' : 'Copy YAML';
        if (downloadBtn) downloadBtn.textContent = exportPreviewFormat === 'json' ? 'Download JSON' : 'Download YAML';

        refreshExportModalOutput();
    }

    function refreshExportModalOutput() {
        const outputEl = document.getElementById('yaml-output');
        if (!outputEl) return '';
        const content = exportPreviewFormat === 'json' ? generateJSONExport() : generateYAML();
        outputEl.value = content;
        return content;
    }

    function getSyncedYamlForExportAndDeploy() {
        const yaml = generateYAML();
        const outputEl = document.getElementById('yaml-output');
        if (outputEl) {
            outputEl.value = exportPreviewFormat === 'json' ? generateJSONExport() : yaml;
        }
        return yaml;
    }

    /**
     * Open YAML export modal with generated content
     */
    function openExportYAML() {
        // Always regenerate from the current canvas state for each open action.
        setExportFormat(exportPreviewFormat || 'yaml');
        getSyncedYamlForExportAndDeploy();
        document.getElementById('yamlModal').classList.add('open');
    }

    /**
     * Copy YAML to clipboard
     */
    function copyYAML() {
        const ta = document.getElementById('yaml-output');
        if (!ta) return;
        refreshExportModalOutput();
        ta.select();
        document.execCommand('copy');
        alert(exportPreviewFormat === 'json' ? 'JSON copied to clipboard' : 'YAML copied to clipboard');
    }

    /**
     * Download YAML as a file
     */
    function downloadYAML() {
        const content = refreshExportModalOutput();
        const labName = (document.getElementById('lab-name-input') || {}).value || 'topology';
        const blob = new Blob([content], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = exportPreviewFormat === 'json' ? `${labName}.clab.json` : `${labName}.clab.yaml`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Close a modal by id
     */
    function closeModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.classList.remove('open');
    }

    function setDeploymentAccessPanelVisible(visible) {
        const panel = document.getElementById('deployAccessPanel');
        if (!panel) return;
        if (visible && activeMainTab === 'server') {
            panel.classList.remove('open');
            return;
        }
        panel.classList.toggle('open', !!visible);
        if (visible) _initDeployAccessPanelDrag(panel);
    }

    function toggleDeploymentAccessPanel() {
        const panel = document.getElementById('deployAccessPanel');
        if (!panel) return;
        const minimized = panel.classList.toggle('minimized');
        const btn = document.getElementById('deployAccessMinimizeBtn');
        if (btn) btn.innerHTML = minimized ? '&#9633;' : '&#8211;';
    }

    function _initDeployAccessPanelDrag(panel) {
        if (panel._dragInit) return;
        panel._dragInit = true;
        const head = document.getElementById('deployAccessPanelHead');
        const container = document.getElementById('topologyContainer');
        if (!head) return;
        let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
        head.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            const containerRect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
            panel.style.right = 'auto';
            panel.style.left = (rect.left - containerRect.left) + 'px';
            panel.style.top = (rect.top - containerRect.top) + 'px';
            origLeft = rect.left - containerRect.left;
            origTop = rect.top - containerRect.top;
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const maxLeft = container ? Math.max(0, container.clientWidth - panel.offsetWidth) : Math.max(0, window.innerWidth - panel.offsetWidth);
            const maxTop = container ? Math.max(0, container.clientHeight - panel.offsetHeight) : Math.max(0, window.innerHeight - panel.offsetHeight);
            const newLeft = Math.max(0, Math.min(origLeft + dx, maxLeft));
            const newTop = Math.max(0, Math.min(origTop + dy, maxTop));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
        });
        document.addEventListener('mouseup', function() { dragging = false; });
    }

    function setDeploymentAccessStatus(message, isError) {
        const statusEl = document.getElementById('deploy-access-status');
        if (!statusEl) return;
        const nextMessage = String(message || '');
        const nextColor = isError ? '#b91c1c' : '#64748b';
        const nextKey = `${nextColor}::${nextMessage}`;
        if (lastDeploymentAccessStatusKey === nextKey) return;
        statusEl.textContent = nextMessage;
        statusEl.style.color = nextColor;
        lastDeploymentAccessStatusKey = nextKey;
    }

    function renderDeploymentAccessRows(rows) {
        const body = document.getElementById('deploy-access-body');
        if (!body) return;
        const list = Array.isArray(rows) ? rows : [];
        const nextKey = JSON.stringify(list);
        if (lastDeploymentAccessRowsKey === nextKey) return;
        lastDeploymentAccessRowsKey = nextKey;

        if (RenderHelpers && typeof RenderHelpers.buildDeploymentAccessRows === 'function') {
            body.innerHTML = RenderHelpers.buildDeploymentAccessRows(rows, escapeHtml);
            return;
        }

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="2">No deployed instances.</td></tr>';
            return;
        }

        body.innerHTML = list.map(function(row) {
            const hostname = escapeHtml(String(row.hostname || '-'));
            if (row.error) {
                const errText = String(row.error || 'SSH access failed');
                return `<tr><td>${hostname}</td><td><span class="deploy-access-error">${escapeHtml(errText)}</span></td></tr>`;
            }

            const uri = String(row.uri || '');
            const uriEsc = escapeHtml(uri);
            return `<tr><td>${hostname}</td><td><a class="deploy-access-link" href="${uriEsc}" onclick="window.open(this.href); event.preventDefault(); return false;" rel="noopener noreferrer">${uriEsc}</a></td></tr>`;
        }).join('');
    }

    function getNodeKindByNameMap() {
        const kindByName = {};
        if (!topo) return kindByName;

        topo.eachNode(function(node) {
            if (!node || !node.model || typeof node.model !== 'function') return;
            const raw = (node.model().getData && node.model().getData()) || {};
            const nodeName = String(raw.name || raw.id || '').trim();
            const kind = String(raw.kind || '').trim();
            if (nodeName && kind) kindByName[nodeName] = kind;
        });

        return kindByName;
    }

    function shortenRuntimeNodeName(labId, nodeName) {
        const rawLabId = String(labId || '').trim();
        const full = String(nodeName || '').trim();
        if (!rawLabId || !full) return full;
        const prefix = `clab-${rawLabId}-`;
        return full.startsWith(prefix) ? full.slice(prefix.length) : full;
    }

    function expandRuntimeNodeName(labId, nodeName) {
        const rawLabId = String(labId || '').trim();
        const rawNodeName = String(nodeName || '').trim();
        if (!rawLabId || !rawNodeName) return rawNodeName;
        const prefix = `clab-${rawLabId}-`;
        return rawNodeName.startsWith(prefix) ? rawNodeName : `${prefix}${rawNodeName}`;
    }

    async function requestNodeSshAccessWithFallback(labId, fullNodeName, shortNodeName, loginName) {
        const candidates = [];
        const seen = new Set();
        const expandedFullNodeName = expandRuntimeNodeName(labId, shortNodeName || fullNodeName);

        function addCandidate(nodeName, body) {
            const normalizedNodeName = String(nodeName || '').trim();
            if (!normalizedNodeName) return;
            const normalizedBody = (body && typeof body === 'object') ? body : {};
            const key = `${normalizedNodeName}::${JSON.stringify(normalizedBody)}`;
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push({ nodeName: normalizedNodeName, body: normalizedBody });
        }

        if (loginName) {
            addCandidate(fullNodeName, { sshUsername: loginName });
            addCandidate(expandedFullNodeName, { sshUsername: loginName });
            addCandidate(shortNodeName, { sshUsername: loginName });
        }
        addCandidate(fullNodeName, {});
        addCandidate(expandedFullNodeName, {});
        addCandidate(shortNodeName, {});

        let lastError = null;
        for (const candidate of candidates) {
            try {
                const sshResp = await clabFetch(
                    `/labs/${encodeURIComponent(labId)}/nodes/${encodeURIComponent(candidate.nodeName)}/ssh`,
                    {
                        method: 'POST',
                        body: JSON.stringify(candidate.body),
                    }
                );
                const sshPayload = await parseApiResponse(sshResp);
                ensureClabResponseOk(
                    sshResp,
                    sshPayload,
                    `Failed to request SSH for ${candidate.nodeName}`,
                    { affectServerStatus: false }
                );
                return sshPayload;
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error(`Failed to request SSH for ${shortNodeName || fullNodeName}`);
    }

    async function refreshDeploymentAccessPanel(labIdHint, options) {
        const labId = String(labIdHint || currentLabId || getLabIdFromInput() || '').trim();
        const silent = !!(options && options.silent);
        if (!labId) {
            setDeploymentAccessStatus('No lab selected. Deploy first.', true);
            renderDeploymentAccessRows([]);
            return;
        }

        deploymentAccessPanelRequested = true;
        setDeploymentAccessPanelVisible(true);
        if (!silent) {
            setDeploymentAccessStatus(`Loading SSH endpoints for ${labId}...`, false);
        }

        try {
            const response = await clabFetch(`/labs/${encodeURIComponent(labId)}`);
            const payload = await parseApiResponse(response);
            ensureClabResponseOk(response, payload, `Failed to inspect lab ${labId}`);
            const runtime = (payload && typeof payload === 'object') ? payload : {};
            const runtimeNodes = Array.isArray(runtime.nodes_runtime) ? runtime.nodes_runtime : [];
            const portResolution = resolveYamlPortIndexForLab(labId, runtimeNodes);
            const yamlPortIndex = portResolution.portIndex;

            if (runtimeNodes.length === 0) {
                renderDeploymentAccessRows([]);
                setDeploymentAccessStatus(`No runtime nodes were returned for ${labId}.`, true);
                return;
            }

            const kindByName = getNodeKindByNameMap();
            const rows = runtimeNodes.map(function(nodeRuntime) {
                const fullNodeName = String((nodeRuntime && nodeRuntime.name) || '').trim();
                const shortName = shortenRuntimeNodeName(labId, fullNodeName);
                const kind = kindByName[shortName] || kindByName[fullNodeName] || '';
                const loginName = getMappedLoginNameForKind(kind) || String(defaultLoginName || 'admin').trim() || 'admin';

                const sshPort = Number(yamlPortIndex[shortName] || yamlPortIndex[fullNodeName]);
                if (!Number.isFinite(sshPort) || sshPort <= 0) {
                    return {
                        hostname: shortName || fullNodeName,
                        error: 'ports missing in deployed YAML',
                    };
                }

                let host = '';
                if (remoteServerUrl) {
                    try {
                        host = String(new URL(remoteServerUrl).hostname || '').trim();
                    } catch (e) {}
                }
                if (!host) {
                    host = String(window.location.hostname || '').trim();
                }
                if (!host) {
                    return {
                        hostname: shortName || fullNodeName,
                        error: 'server host missing for SSH URI',
                    };
                }

                return {
                    hostname: shortName || fullNodeName,
                    uri: `ssh://${loginName}@${host}:${sshPort}`,
                };
            });

            rows.sort(function(a, b) {
                return String(a.hostname || '').localeCompare(String(b.hostname || ''));
            });
            renderDeploymentAccessRows(rows);
            const hasAnyUri = rows.some(function(item) { return !!item.uri; });
            setDeploymentAccessStatus('', !hasAnyUri);
        } catch (error) {
            renderDeploymentAccessRows([]);
            setDeploymentAccessStatus(`Failed to load instance access info: ${error.message || error}`, true);
        }
    }

    function closeDeploymentAccessPanel() {
        deploymentAccessPanelRequested = false;
        AppState.ui.deploymentAccessPanelRequested = false;
        setDeploymentAccessPanelVisible(false);
    }

    /**
     * Deploy the currently-drawn topology to clab-api-server
     */
    async function deployCurrentTopology() {
        const exportData = buildExportTopologyData();
        const yamlContent = getSyncedYamlForExportAndDeploy();
        if (!yamlContent || yamlContent.startsWith('# No nodes')) {
            alert('No nodes to deploy. Add nodes first.');
            return;
        }

        try {
            const result = await deployTopologyFromYAML(yamlContent);
            const deployedLabId = result.lab_id || result.lab_name || getLabIdFromInput() || 'success';
            if (exportData) {
                persistDeployedExport(deployedLabId, exportData);
            }
            await refreshCurrentLabStatus(deployedLabId);
            RemoteSessionManager.startLabStatusPolling();
            alert(`Lab deployed: ${deployedLabId}`);
            await fetchTopology();
            await refreshDeploymentAccessPanel(deployedLabId);
            updateStatusPanel();
        } catch (err) {
            alert(`Deploy failed: ${err}`);
        }
    }

    /**
     * Node Details (view mode click)
     */
    function showNodeDetails(nodeModel) {
        const raw = (nodeModel.getData && nodeModel.getData()) || {};
        const name  = raw.name  || nodeModel.id();
        const ip    = ensureNodeMgmtIp(nodeModel);
        const kind  = raw.kind  || 'N/A';
        const state = raw.state || 'N/A';

        selectedNodeInfo = { id: raw.id || name, name, ip, kind, state };
        AppState.topology.selectedNodeInfo = selectedNodeInfo;
        updateStatusPanel();
    }

    function runSelectedNodeCommand() {
        if (!selectedNodeInfo) {
            alert('Select a node first.');
            return;
        }

        const cmd = prompt(
            `Node: ${selectedNodeInfo.name}\nEnter command to execute:`,
            'show ip interface brief'
        );
        if (!cmd) return;

        execNodeCommand(selectedNodeInfo.name, cmd)
            .then(output => alert(`Output:\n${output}`))
            .catch(err  => alert(`Error: ${err}`));
    }

    function connectToSelectedNode() {
        if (!selectedNodeInfo) {
            alert('Select a node first.');
            return;
        }
        connectToNode(selectedNodeInfo.name);
    }
    nx.define('Shell', nx.ui.Application, {
        methods: {
            start: function () {
                topo.attach(topologyApp || this);
                ensureTopologyMountedInContainer();
                syncTopologyViewportSize();
                disableDefaultHoverActivation();
                setupNodeClickHandler();
                if (typeof topo.activateScene === 'function') {
                    try { topo.activateScene('default'); } catch (e) {}
                }
                if (typeof topo.blockEvent === 'function') {
                    try { topo.blockEvent(false); } catch (e) {}
                }

                // Try API first, fallback to static topology.js
                fetchTopology().then(topologyData => {
                    const savedViewport = topologyData && topologyData.__viewport ? topologyData.__viewport : null;
                    pendingRestoreCoordMap = buildCoordMapFromNodes((topologyData && topologyData.nodes) || []);
                    topo.setData(topologyData, function() {
                        syncTopologyViewportSize();
                        topo.eachNode(function(node) {
                            ensureNodeMgmtIp(node.model());
                        });
                        applyNodePositionsFromDataWithRetry(0);
                        updateNodeCoordinateDebugLabels();
                        updateStatusPanel();
                        // Auto-show SSH access panel if a lab was already running on startup
                        if (currentLabId && remoteServerUrl && remoteAuthToken) {
                            refreshDeploymentAccessPanel(currentLabId);
                        }
                    }, this);
                }).catch(error => {
                    console.error("Failed to load topology:", error);
                    alert("Failed to load topology. Check console for details.");
                });
            }
        }
    });

    /**
     * Clear node selection from the floating panel close button.
     */
    function clearNodeSelection() {
        clearSelectedNodeVisuals(true);
    }

    /**
     * Status Panel hook retained for node/selection refresh flow.
     * Node info and connectivity are shown in the NeXt tooltip.
     */
    function updateStatusPanel() {
        // Status updates are handled by NeXt tooltip callbacks
    }

    /**
     * Expose global functions for UI buttons
     */
    window.nextUI = {
        // API / lab lifecycle
        deployTopology,
        deployCurrentTopology,
        destroyLab,
        destroyLabAndClean,
        execNodeCommand,
        getNodeLogs,
        connectToNode,
        refreshCurrentLabStatus,
        clearSavedNodePositions,
        runSelectedNodeCommand,
        connectToSelectedNode,
        updateStatusPanel,
        toggleDebugOverlay,
        // Topology editor
        newTopology,
        openAddNodeModal,
        addNodeFromForm,
        onKindChange,
        toggleDeleteMode,
        startAddLinkFromContextMenu,
        deleteNodeFromContextMenu,
        confirmLinkInterfaceSelection,
        cancelLinkInterfaceSelection,
        openExportYAML,
        setExportFormat,
        copyYAML,
        downloadYAML,
        generateYAML,
        closeModal,
        clearNodeSelection,
        switchMainTab,
        connectRemoteServer: function() { return RemoteSessionManager.connect(); },
        disconnectRemoteServer: function() { return RemoteSessionManager.disconnect(); },
        refreshRemoteMetricsNow: function() { return RemoteSessionManager.refreshMetricsNow(); },
        saveKindImageMapping,
        removeKindImageMapping,
        refreshKindYamlInterpretationPreview,
        refreshDeploymentAccessPanel,
        closeDeploymentAccessPanel,
        toggleDeploymentAccessPanel,
    };

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', function() {
        topologyApp = new nx.ui.Application({
            el: document.getElementById('topology')
        });
        initMgmtNetworkSettingsUI();
        initSshPortRangeSettingsUI();
        initKindImageRegistryUI();
        initTopology();
        const shell = new Shell();
        shell.start();
        RemoteSessionManager.restore();
        window.addEventListener('resize', function() {
            ensureTopologyMountedInContainer();
            syncTopologyViewportSize();
            if (editorMode !== 'addLink') {
                cleanupLinkPreviewArtifacts();
            }
        });
    });

})(nx);
