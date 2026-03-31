(function(global) {
    function createRemoteSessionManager(deps) {
        // Use explicit self-reference (mgr) to avoid any `this` binding issues
        // when methods are called via wrappers, callbacks, or detached references.
        var mgr = {
            _stopTokenRefreshScheduler: function() {
                var timer = deps.getTokenRefreshTimer();
                if (timer) {
                    clearTimeout(timer);
                    deps.setTokenRefreshTimer(null);
                }
            },

            _loginRemoteServerAndGetToken: async function(serverUrl, username, password) {
                const response = await fetch('/api/tester/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ serverUrl: serverUrl, username: username, password: password }),
                });
                const data = await response.json();
                if (!response.ok) {
                    const detail = data && data.detail ? data.detail : 'Login failed';
                    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
                }
                if (!data.token) throw new Error('Login succeeded but token is missing.');
                return String(data.token);
            },

            _scheduleTokenAutoRefresh: function() {
                mgr._stopTokenRefreshScheduler();
                if (!deps.getRemoteServerUrl() || !deps.getRemoteAuthToken()) return;
                const expiresInSec = deps.getTokenExpiresInSeconds(deps.getRemoteAuthToken());
                if (!Number.isFinite(expiresInSec)) return;
                const refreshInSec = Math.max(5, Number(expiresInSec) - 60);
                const timer = setTimeout(function() {
                    mgr.refreshTokenSilently('scheduled');
                }, refreshInSec * 1000);
                deps.setTokenRefreshTimer(timer);
            },

            refreshTokenSilently: async function(reason) {
                const inFlight = deps.getTokenRefreshInFlight();
                if (inFlight) return inFlight;

                const urlEl = document.getElementById('remote-server-url');
                const userEl = document.getElementById('remote-username');
                const stored = deps.readStoredRemoteSession();
                const serverUrl = String((urlEl && urlEl.value) || stored.serverUrl || deps.getRemoteServerUrl() || '').trim();
                const username = String((userEl && userEl.value) || stored.username || '').trim();
                const password = String(deps.getRemotePasswordCache() || stored.password || '');

                const promise = (async () => {
                    try {
                        if (!serverUrl || !username || !password) {
                            throw new Error('Cannot auto-refresh token: cached credentials are missing. Reconnect once to enable auto-refresh.');
                        }
                        const newToken = await mgr._loginRemoteServerAndGetToken(serverUrl, username, password);
                        deps.updateRemoteSessionState({ serverUrl: serverUrl, token: newToken });
                        deps.persistRemoteSession({ serverUrl: serverUrl, username: username, token: newToken });
                        mgr._scheduleTokenAutoRefresh();
                        return true;
                    } catch (e) {
                        deps.logWarn('Token auto-refresh failed (' + String(reason || 'n/a') + '):', e);
                        deps.setServerAuthStatus('Token auto-refresh failed: ' + (e.message || e), true);
                        return false;
                    } finally {
                        deps.setTokenRefreshInFlight(null);
                    }
                })();

                deps.setTokenRefreshInFlight(promise);
                return promise;
            },

            _summarizeRemoteErrorData: function(data) {
                if (data == null) return '';
                if (typeof data === 'string') return data;
                if (typeof data !== 'object') return String(data);
                if (data.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
                if (data.message) return String(data.message);
                return JSON.stringify(data);
            },

            _proxyRemoteRequest: async function(method, endpoint, body) {
                const response = await fetch('/api/tester/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        serverUrl: deps.getRemoteServerUrl(),
                        method: method,
                        endpoint: endpoint,
                        token: deps.getRemoteAuthToken(),
                        body: body || null,
                    }),
                });
                const payload = await response.json();
                if (!response.ok) {
                    const detail = payload && payload.detail ? payload.detail : 'Proxy request failed';
                    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
                }
                return payload;
            },

            refreshMetricsNow: async function() {
                if (!deps.getRemoteServerUrl() || !deps.getRemoteAuthToken()) {
                    deps.setRemoteApiIndicator(false, 'Disconnected');
                    deps.setRemoteMetrics(NaN, NaN);
                    return;
                }

                const token = deps.getRemoteAuthToken();
                if (deps.isTokenExpired(token)) {
                    const refreshed = await mgr.refreshTokenSilently('expired-check');
                    if (!refreshed && deps.isTokenExpired(deps.getRemoteAuthToken())) {
                        mgr.disconnect();
                        deps.setServerAuthStatus('Saved token expired. Please reconnect with username/password.', true);
                        return;
                    }
                }

                try {
                    const result = await mgr._proxyRemoteRequest('GET', '/api/v1/health/metrics');
                    const status = Number(result && result.status);
                    const data = result ? result.data : null;
                    const metrics = data && data.metrics ? data.metrics : null;
                    const cpu = metrics && metrics.cpu ? Number(metrics.cpu.usagePercent) : NaN;
                    const mem = metrics && metrics.mem ? Number(metrics.mem.usagePercent) : NaN;

                    if (status >= 200 && status < 300) {
                        deps.setRemoteApiIndicator(true, 'Connected (' + status + ')');
                        deps.setRemoteMetrics(cpu, mem);
                        deps.setServerAuthStatus('Connected. Polling metrics every 5 seconds.', false);
                    } else if (status === 401 || status === 403) {
                        const errorText = mgr._summarizeRemoteErrorData(data);
                        mgr.disconnect();
                        deps.setServerAuthStatus('Remote auth failed (' + status + ')' + (errorText ? ': ' + errorText : '') + '. Please reconnect.', true);
                    } else {
                        const errorText = mgr._summarizeRemoteErrorData(data);
                        deps.setRemoteApiIndicator(false, 'Error (' + status + ')');
                        deps.setRemoteMetrics(NaN, NaN);
                        deps.setServerAuthStatus('Metrics request failed (' + status + ')' + (errorText ? ': ' + errorText : '') + '.', true);
                    }
                } catch (e) {
                    deps.setRemoteApiIndicator(false, 'Disconnected');
                    deps.setRemoteMetrics(NaN, NaN);
                    deps.setServerAuthStatus('Metrics error: ' + e.message, true);
                }
            },

            startRemoteMetricsPolling: function() {
                const timer = deps.getRemoteMetricsTimer();
                if (timer) clearInterval(timer);
                mgr.refreshMetricsNow();
                deps.setRemoteMetricsTimer(setInterval(function() { mgr.refreshMetricsNow(); }, 5000));
            },

            stopRemoteMetricsPolling: function() {
                const timer = deps.getRemoteMetricsTimer();
                if (timer) {
                    clearInterval(timer);
                    deps.setRemoteMetricsTimer(null);
                }
            },

            startLabStatusPolling: function(onFirstComplete) {
                const timer = deps.getLabStatusTimer();
                if (timer) clearInterval(timer);
                const firstPoll = deps.refreshLabStatusNow();
                if (typeof onFirstComplete === 'function') firstPoll.then(onFirstComplete).catch(function() {});
                deps.setLabStatusTimer(setInterval(deps.refreshLabStatusNow, 5000));
            },

            stopLabStatusPolling: function() {
                const timer = deps.getLabStatusTimer();
                if (timer) {
                    clearInterval(timer);
                    deps.setLabStatusTimer(null);
                }
            },

            connect: async function() {
                const urlEl = document.getElementById('remote-server-url');
                const userEl = document.getElementById('remote-username');
                const passEl = document.getElementById('remote-password');
                const serverUrl = urlEl ? String(urlEl.value || '').trim() : '';
                const username = userEl ? String(userEl.value || '').trim() : '';
                const password = passEl ? String(passEl.value || '') : '';

                if (!serverUrl || !username || !password) {
                    deps.setServerAuthStatus('Server URL, username, password are required.', true);
                    return;
                }

                deps.setServerAuthStatus('Connecting to remote server...', false);
                try {
                    const token = await mgr._loginRemoteServerAndGetToken(serverUrl, username, password);
                    deps.updateRemoteSessionState({ serverUrl: serverUrl, token: token, password: password });
                    deps.persistRemoteSession({ serverUrl: serverUrl, username: username, token: token, password: password });
                    if (passEl) passEl.value = '';
                    deps.setRemoteApiIndicator(true, 'Connected');
                    mgr.startRemoteMetricsPolling();
                    mgr.startLabStatusPolling();
                    mgr._scheduleTokenAutoRefresh();
                } catch (e) {
                    deps.updateRemoteSessionState({ token: '' });
                    deps.setRemoteApiIndicator(false, 'Disconnected');
                    deps.setRemoteMetrics(NaN, NaN);
                    deps.setServerAuthStatus('Login failed: ' + e.message, true);
                }
            },

            disconnect: function() {
                deps.updateRemoteSessionState({ token: '', password: '' });
                mgr.stopRemoteMetricsPolling();
                mgr.stopLabStatusPolling();
                mgr._stopTokenRefreshScheduler();
                deps.persistRemoteSession({ token: '', password: '' });
                deps.setRemoteApiIndicator(false, 'Disconnected');
                deps.setRemoteMetrics(NaN, NaN);
                deps.setLabRuntimeIndicator('idle', 'Connect to a remote server');
                deps.setServerAuthStatus('Disconnected from remote server.', false);
            },

            restore: function() {
                const stored = deps.readStoredRemoteSession();
                const savedUrl = stored.serverUrl;
                const savedUser = stored.username;
                const savedToken = stored.token;
                const savedPassword = stored.password;

                const urlEl = document.getElementById('remote-server-url');
                const userEl = document.getElementById('remote-username');
                if (urlEl && savedUrl) urlEl.value = savedUrl;
                if (userEl && savedUser) userEl.value = savedUser;

                deps.updateRemoteSessionState({ serverUrl: savedUrl, token: savedToken, password: savedPassword });

                if (deps.getRemoteAuthToken() && deps.isTokenExpired(deps.getRemoteAuthToken())) {
                    deps.updateRemoteSessionState({ token: '' });
                    deps.persistRemoteSession({ token: '' });
                    deps.setServerAuthStatus('Saved token expired. Please reconnect with username/password.', true);
                }

                if (deps.hasRemoteSession()) {
                    deps.setRemoteApiIndicator(true, 'Connected');
                    mgr.startRemoteMetricsPolling();
                    mgr.startLabStatusPolling(function() {
                        if (deps.getCurrentLabId()) deps.refreshDeploymentAccessPanel(deps.getCurrentLabId());
                    });
                    mgr._scheduleTokenAutoRefresh();
                } else {
                    deps.setRemoteApiIndicator(false, 'Disconnected');
                    deps.setRemoteMetrics(NaN, NaN);
                    deps.setLabRuntimeIndicator('idle', 'Connect to a remote server');
                }
            },

            stopTokenRefreshScheduler: function() { mgr._stopTokenRefreshScheduler(); },
            scheduleTokenAutoRefresh: function() { mgr._scheduleTokenAutoRefresh(); },
        };
        return mgr;
    }

    global.createRemoteSessionManager = createRemoteSessionManager;
})(window);
