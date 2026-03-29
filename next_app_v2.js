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

    // Global state
    let currentTopology = null;
    let currentLabId = null;
    let apiMode = true;  // true = use API, false = use static topology.js
    let topo = null;
    let selectedNodeInfo = null;
    let linkDraft = null;
    let linkPreviewLayer = null;
    let linkPreviewLine = null;
    let previewRafId = null;
    let lastMousePoint = null;
    let lastNodeClickTs = 0;
    let lastImmediateFocusTs = 0;
    let lastLinkPick = { nodeId: null, ts: 0 };
    let activeSelectedNodeId = null;
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
    let mgmtHostCounter = 10;
    let topologyApp = null;
    const INTERACTION = {
        contextPickRadius: 80,
        linkPickRadius: 68,
        focusPickRadius: 56,
        dedupeMs: 120,
        suppressClickNodeMs: 200,  // Increased from 140ms for slower systems
        menuMargin: 8,
    };

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
        'vr-xrv':         { image: 'vrnetlab/vr-xrv:7.8.1',           icon: 'router' },
        'ceos':           { image: 'ceos:4.31.0F',                    icon: 'switch' },
        'bridge':         { image: '',                                 icon: 'switch' },
    };

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

    function peekNextInterface(nodeId, kind) {
        const count = nodeInterfaceCounters.get(nodeId) || 0;
        switch (kind) {
            case 'nokia_srlinux': return `ethernet-1/${count + 1}`;
            case 'vr-xrv':        return `GigabitEthernet0/0/0/${count}`;
            case 'ceos':          return `Ethernet${count + 1}`;
            default:              return `eth${count}`;
        }
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
        if (suggested) candidates.push(suggested);

        if (kind === 'nokia_srlinux') {
            for (let i = 1; i <= 8; i++) candidates.push(`ethernet-1/${i}`);
        } else if (kind === 'vr-xrv') {
            for (let i = 0; i <= 7; i++) candidates.push(`GigabitEthernet0/0/0/${i}`);
        } else if (kind === 'ceos') {
            for (let i = 1; i <= 8; i++) candidates.push(`Ethernet${i}`);
        } else {
            for (let i = 0; i <= 7; i++) candidates.push(`eth${i}`);
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
    async function fetchTopology() {
        try {
            const response = await fetch(CLAB_API + "/labs");
            const data = await response.json();
            
            if (data.labs && data.labs.length > 0) {
                currentLabId = data.labs[0].id;
                updateLabStatusIndicators();
                // Fetch graph for first lab
                const graphResponse = await fetch(CLAB_API + `/labs/${currentLabId}/graph`);
                const graph = await graphResponse.json();
                return await applySavedNodePositionsToGraph(graph, currentLabId);
            }
            
            return { nodes: [], links: [] };
        } catch (error) {
            console.warn("API fetch failed, falling back to static topology:", error);
            apiMode = false;
            return topologyData || { nodes: [], links: [] };
        }
    }

    async function deployTopology(topologySpec) {
        try {
            const response = await fetch(CLAB_API + "/labs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(topologySpec)
            });
            const result = await response.json();
            currentLabId = result.lab_id;
            updateLabStatusIndicators();
            return result;
        } catch (error) {
            console.error("Deploy failed:", error);
            throw error;
        }
    }

    async function destroyLab() {
        if (!currentLabId) return;
        try {
            const removedLabId = currentLabId;
            await fetch(CLAB_API + `/labs/${currentLabId}`, { method: "DELETE" });
            currentLabId = null;
            updateLabStatusIndicators();
            await clearSavedNodePositions(removedLabId);
        } catch (error) {
            console.error("Destroy failed:", error);
        }
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

    async function fetchServerLayoutPositions(labId) {
        if (!labId) return null;
        try {
            const res = await fetch(CLAB_API + `/labs/${encodeURIComponent(labId)}/layout`);
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
            const res = await fetch(CLAB_API + `/labs/${encodeURIComponent(labId)}/layout`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
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
            const res = await fetch(CLAB_API + `/labs/${encodeURIComponent(labId)}/layout`, {
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
            if (!node || !node.position) return;
            const pos = node.position();
            if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
            const raw = (node.model && node.model().getData && node.model().getData()) || {};
            const nodeId = String(raw.id || raw.name || node.id());
            if (!nodeId) return;
            positions[nodeId] = { x: pos.x, y: pos.y };
        });

        return positions;
    }

    async function saveNodePositionsNow() {
        if (!currentLabId) return;
        const positions = collectNodePositions();

        // Keep local fallback for offline / API failure.
        writeSavedNodePositionsLocal(currentLabId, positions);
        const ok = await saveServerLayoutPositions(currentLabId, positions);
        if (!ok) {
            console.warn('Server layout save failed, local fallback kept.');
        }
    }

    function queueSaveNodePositions(delayMs) {
        if (!currentLabId) return;
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
            const response = await fetch(CLAB_API + `/labs/${currentLabId}/nodes/${nodeName}/exec`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command: command })
            });
            const result = await response.json();
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
            const response = await fetch(CLAB_API + `/labs/${currentLabId}/nodes/${nodeName}/logs?lines=${lines}`);
            const result = await response.json();
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
            const response = await fetch(CLAB_API + `/labs/${currentLabId}`);
            const labState = await response.json();
            
            const node = labState.nodes_runtime.find(n => n.name === nodeName);
            if (node && node.ssh_port) {
                const sshUrl = `ssh://admin@127.0.0.1:${node.ssh_port}`;
                console.log("SSH URL:", sshUrl);
                alert(`SSH connection info:\n${node.name}\nIP: ${node.mgmt_ip}\nPort: ${node.ssh_port}\n\nSSH URL: ${sshUrl}`);
                // In real browser, could open: window.location.href = sshUrl;
            }
        } catch (error) {
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

    /**
     * NeXt UI Topology Configuration
     */
    function initTopology() {
        const size = getTopologyContainerSize();
        topo = new nx.graphic.Topology({
            width: size.width,
            height: size.height,
            dataProcessor: 'force',
            identityKey: 'id',
            
            nodeConfig: {
                label: 'model.name',
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
                    console.log('[Tooltip] tooltip_content DOM not ready after retries');
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
                var entries = getNodeConnectivityEntries(nodeId);

                // Connectivity rows
                var connRows = '';
                if (entries.length === 0) {
                    connRows = '<div style="color:#666; font-style:italic; font-size:11px; padding:4px 0;">No links connected.</div>';
                } else {
                    connRows = entries.map(function(e) {
                        return '<div style="display:flex; align-items:center; flex-wrap:wrap; padding:3px 0; border-bottom:1px solid #eee; font-size:11px; gap:1px 2px; color:#000;">'
                            + '<span style="font-weight:600; color:#000;">' + escapeHtml(e.localIf) + '</span>'
                            + '<span style="color:#999; margin:0 1px;"> ↔ </span>'
                            + '<span style="color:#0066cc; font-weight:600;">' + escapeHtml(e.peerName) + '</span>'
                            + '<span style="color:#666; font-size:10px;"> (' + escapeHtml(e.peerIf) + ')</span>'
                            + '</div>';
                    }).join('');
                }

                // Build final HTML
                var html = '<div style="font-size:13px; font-weight:700; color:#000; margin-bottom:6px;">' + escapeHtml(name) + '</div>';
                
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
                    console.log('[Tooltip] Error setting innerHTML:', e);
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
        if (!document.body.dataset.linkContextBound) {
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
            document.addEventListener('mousedown', handleDocumentPointerDown, true);
            document.addEventListener('mouseup', handleDocumentPointerUp, true);
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
            const now = Date.now();
            lastNodeClickTs = now;
            if (editorMode === 'addLink') {
                processLinkNodeSelection(node);
            } else if (editorMode === 'delete') {
                topo.deleteNode(node.id());
                // One-shot delete: return to view mode after deletion.
                setEditorMode('view');
                queueSaveNodePositions(60);
            } else if (!suppressNodeDetails) {
                if (now - lastImmediateFocusTs < INTERACTION.suppressClickNodeMs) {
                    return;
                }
                // NOTE: mousedown already called focusNodeImmediately which calls updateStatusPanel.
                // This is a backup in case mousedown didn't fire for some reason.
                // focusNodeImmediately always calls updateStatusPanel now, so no need to duplicate.
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
        // Close any open NeXt tooltip before showing context menu
        if (topo && typeof topo.tooltipManager === 'function') {
            try { topo.tooltipManager().closeAll(); } catch(e) {}
        }
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
            // Handle node focus on mousedown to avoid delayed click transitions.
            const stageScale = Math.max(0.6, getStageTransform().scale || 1);
            const dynamicFocusRadius = Math.max(INTERACTION.focusPickRadius, 32 * stageScale + 18);
            const nearest = findNearestNodeByClientPoint(evt.clientX, evt.clientY, dynamicFocusRadius);
            if (nearest) {
                focusNodeImmediately(nearest, true);
                lastNodeClickTs = Date.now();
                lastImmediateFocusTs = lastNodeClickTs;
            } else {
                const clickedNodeElement = evt.target && evt.target.closest
                    ? evt.target.closest('.node, .nodeSet, .n-topology-icon')
                    : null;
                if (!clickedNodeElement) {
                    clearSelectedNodeVisuals(true);
                }
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

    function handleDocumentPointerUp(evt) {
        if (evt.button !== 0) return;
        if (!currentLabId) return;

        const surface = getTopologySurfaceElement();
        if (!surface || !surface.contains(evt.target)) return;

        // Capture final node position after drag/release.
        queueSaveNodePositions(140);
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
        contextMenuNodeId = nodeId;

        // Ensure status panel is updated BEFORE menu displays
        if (nodeId) {
            const node = topo.getNode(nodeId);
            if (node) {
                showNodeDetails(node.model());
                updateStatusPanel();  // CRITICAL: Force panel update
            }
        }

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

        const connectBtn = document.getElementById('ctxConnectBtn');
        if (connectBtn) {
            const labRunning = !!currentLabId;
            connectBtn.disabled = !nodeId || !labRunning;
            if (!nodeId) {
                connectBtn.textContent = 'SSH Connect (Select node first)';
                connectBtn.title = '';
            } else if (!labRunning) {
                connectBtn.textContent = 'SSH Connect (Lab not running)';
                connectBtn.title = 'Deploy the lab first to connect.';
            } else {
                connectBtn.textContent = `SSH Connect (${nodeId})`;
                connectBtn.title = '';
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
        menu.classList.remove('open');
    }

    function handleTopologyContextMenu(evt) {
        // Own the right-click interaction in topology area.
        evt.preventDefault();
        evt.stopPropagation();

        // Be tolerant for right-click hit-testing; user intent is usually nearby.
        showDebugHitCircle(evt.clientX, evt.clientY, INTERACTION.contextPickRadius);
        let nearest = findNearestNodeByClientPoint(evt.clientX, evt.clientY, INTERACTION.contextPickRadius);
        if (!nearest && selectedNodeInfo && selectedNodeInfo.id) {
            nearest = topo.getNode(selectedNodeInfo.id) || null;
        }
        showNodeContextMenu(nearest ? nearest.id() : null, evt.clientX, evt.clientY);
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

    function connectFromContextMenu() {
        const nodeId = contextMenuNodeId;
        hideNodeContextMenu();
        if (!nodeId) return;
        connectToNode(nodeId);
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
            document.getElementById('yaml-output').value = generateYAML();
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

        if (!linkPreviewLayer) {
            const svgNS = 'http://www.w3.org/2000/svg';
            linkPreviewLayer = document.createElementNS(svgNS, 'svg');
            linkPreviewLayer.setAttribute('viewBox', `0 0 ${topologyEl.clientWidth || 1} ${topologyEl.clientHeight || 1}`);
            linkPreviewLayer.style.position = 'absolute';
            linkPreviewLayer.style.left = '0';
            linkPreviewLayer.style.top = '0';
            linkPreviewLayer.style.width = '100%';
            linkPreviewLayer.style.height = '100%';
            linkPreviewLayer.style.pointerEvents = 'none';
            linkPreviewLayer.style.zIndex = '500';

            linkPreviewLine = document.createElementNS(svgNS, 'line');
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
        }

        if (mode !== 'view') {
            clearSelectedNodeVisuals(false);
        }

        editorMode = mode;
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
        currentLabId = null;
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

    function getBulkNodeOffset(index, count) {
        if (count <= 1) {
            return { x: 0, y: 0 };
        }

        const spacing = 90;
        const cols = Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);
        const row = Math.floor(index / cols);
        const col = index % cols;
        const jitter = 12;

        return {
            x: (col - (cols - 1) / 2) * spacing + (Math.random() * jitter * 2 - jitter),
            y: (row - (rows - 1) / 2) * spacing + (Math.random() * jitter * 2 - jitter),
        };
    }

    /**
     * Open Add Node modal
     */
    function openAddNodeModal() {
        document.getElementById('nodeName').value = 'r-{$count}';
        const countEl = document.getElementById('nodeCount');
        if (countEl) countEl.value = '1';
        document.getElementById('nodeKind').value = 'linux';
        document.getElementById('nodeImage').value = KIND_DEFAULTS.linux.image;
        document.getElementById('nodeIcon').value  = KIND_DEFAULTS.linux.icon;
        document.getElementById('addNodeModal').classList.add('open');
        document.getElementById('nodeName').focus();
    }

    /**
     * Auto-fill image/icon when kind changes in the Add Node modal
     */
    function onKindChange() {
        const kind = document.getElementById('nodeKind').value;
        const defs = KIND_DEFAULTS[kind] || { image: '', icon: 'host' };
        document.getElementById('nodeImage').value = defs.image;
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
        const image    = document.getElementById('nodeImage').value.trim();
        const iconType = document.getElementById('nodeIcon').value;

        // Collect existing nodes using NeXt's iterator API.
        const existingNodes = [];
        topo.eachNode(function(node) {
            existingNodes.push(node);
        });

        const basePos = getBulkNodeBasePosition(existingNodes);
        let firstAddedNode = null;
        let createdCount = 0;
        const skippedNames = [];

        nodeNames.forEach(function(name, index) {
            const offset = getBulkNodeOffset(index, nodeNames.length);
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
            if (!firstAddedNode) {
                firstAddedNode = addedNode;
            }
        });

        if (createdCount === 0) {
            alert('No nodes were created. Check duplicate names and pattern.');
            return;
        }

        if (firstAddedNode && !isNodeVisibleInViewport(firstAddedNode)) {
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

    /**
     * Generate containerlab YAML string from current topology
     */
    function generateYAML() {
        const { labName, nodes, links } = getCurrentTopologyData();

        if (nodes.length === 0) return '# No nodes in topology';

        let yaml = `name: ${labName}\n\ntopology:\n  nodes:\n`;
        for (const n of nodes) {
            yaml += `    ${n.name}:\n`;
            yaml += `      kind: ${n.kind}\n`;
            if (n.image) yaml += `      image: ${n.image}\n`;
        }

        yaml += `\n  links:\n`;
        if (links.length === 0) {
            yaml += `    []  # no links defined\n`;
        } else {
            yaml += `    endpoints:\n`;
            for (const l of links) {
                yaml += `      - ["${l.source}:${l.srcIfName}", "${l.target}:${l.tgtIfName}"]\n`;
            }
        }

        return yaml;
    }

    /**
     * Open YAML export modal with generated content
     */
    function openExportYAML() {
        document.getElementById('yaml-output').value = generateYAML();
        document.getElementById('yamlModal').classList.add('open');
    }

    /**
     * Copy YAML to clipboard
     */
    function copyYAML() {
        const ta = document.getElementById('yaml-output');
        ta.select();
        document.execCommand('copy');
        alert('YAML copied to clipboard');
    }

    /**
     * Download YAML as a file
     */
    function downloadYAML() {
        const content = document.getElementById('yaml-output').value;
        const labName = (document.getElementById('lab-name-input') || {}).value || 'topology';
        const blob = new Blob([content], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${labName}.clab.yaml`;
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

    /**
     * Deploy the currently-drawn topology to clab-api-server
     */
    async function deployCurrentTopology() {
        const { labName, nodes, links } = getCurrentTopologyData();

        // Convert to TopologySpec format expected by the backend
        const topologySpec = {
            lab_name: labName,
            nodes: nodes.map(n => ({
                id:    n.id,
                name:  n.name,
                kind:  n.kind,
                image: n.image,
                role:  'undefined'
            })),
            links: links.map((l, i) => ({
                id:    `link-${i}`,
                a_node: l.source,
                a_if:   l.srcIfName,
                b_node: l.target,
                b_if:   l.tgtIfName
            }))
        };

        try {
            const result = await deployTopology(topologySpec);
            alert(`Lab deployed: ${result.lab_id || result.lab_name || 'success'}`);
            await fetchTopology();
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
                // Try API first, fallback to static topology.js
                fetchTopology().then(topologyData => {
                    console.log("Topology data loaded:", topologyData);
                    topo.data(topologyData);
                    syncTopologyViewportSize();
                    topo.eachNode(function(node) {
                        ensureNodeMgmtIp(node.model());
                    });
                    topo.attach(topologyApp || this);
                    ensureTopologyMountedInContainer();
                    setupNodeClickHandler();
                    updateStatusPanel();
                    queueSaveNodePositions(300);
                }).catch(error => {
                    console.error("Failed to load topology:", error);
                    alert("Failed to load topology. Check console for details.");
                });
            }
        }
    });

    /**
     * Update the compact lab status indicators in the header.
     */
    function updateLabStatusIndicators() {
        const labDot = document.getElementById('lab-deployed-dot');
        const apiDot = document.getElementById('api-on-dot');
        if (labDot) {
            labDot.className = currentLabId ? 'lab-dot dot-green' : 'lab-dot dot-red';
            labDot.title = currentLabId ? `Active: ${currentLabId}` : 'Not deployed';
        }
        if (apiDot) {
            apiDot.className = apiMode ? 'lab-dot dot-green' : 'lab-dot dot-red';
            apiDot.title = apiMode ? 'API connected' : 'Static mode';
        }
    }

    /**
     * Clear node selection from the floating panel close button.
     */
    function clearNodeSelection() {
        clearSelectedNodeVisuals(true);
    }

    /**
     * Status Panel — now only updates header lab status dots.
     * Node info and connectivity are shown in the NeXt tooltip.
     */
    function updateStatusPanel() {
        updateLabStatusIndicators();
    }

    /**
     * Expose global functions for UI buttons
     */
    window.nextUI = {
        // API / lab lifecycle
        fetchTopology,
        deployTopology,
        deployCurrentTopology,
        destroyLab,
        execNodeCommand,
        getNodeLogs,
        connectToNode,
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
        connectFromContextMenu,
        confirmLinkInterfaceSelection,
        cancelLinkInterfaceSelection,
        openExportYAML,
        copyYAML,
        downloadYAML,
        generateYAML,
        closeModal,
        clearNodeSelection,
        updateLabStatusIndicators,
    };

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', function() {
        topologyApp = new nx.ui.Application({
            el: document.getElementById('topology')
        });
        initTopology();
        const shell = new Shell();
        shell.start();
        window.addEventListener('resize', function() {
            ensureTopologyMountedInContainer();
            syncTopologyViewportSize();
        });
    });

})(nx);
