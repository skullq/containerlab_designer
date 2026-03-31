(function(global) {
    function buildKindImageRegistryRows(kindImageRegistry, defaultLoginName, escapeHtml) {
        const keys = Object.keys(kindImageRegistry || {}).sort();
        if (keys.length === 0) {
            return '<tr><td colspan="5">No mappings registered.</td></tr>';
        }

        return keys.map(function(kind) {
            const item = kindImageRegistry[kind] || {};
            const image = String(item.image || '').trim();
            const loginName = String(item.login_name || defaultLoginName || 'admin').trim() || 'admin';
            const rule = item.interface_rule && typeof item.interface_rule === 'object' ? item.interface_rule : {};
            const prefix = String(rule.prefix || '').trim();
            const start = Number(rule.start);
            const max = Number(rule.max);
            const style = String(rule.style || '').trim();
            const ruleText = (prefix && Number.isFinite(start) && Number.isFinite(max))
                ? (style ? (style + ' | ') : '') + prefix + '[' + String(start) + '..' + String(start + max - 1) + ']'
                : '-';

            const reserved = Array.isArray(item.reserved_interfaces)
                ? item.reserved_interfaces.map(function(v) { return String(v || '').trim(); }).filter(Boolean)
                : [];
            const reservedText = reserved.length > 0 ? reserved.join(', ') : '-';

            return '<tr>' +
                '<td>' + escapeHtml(kind) + '</td>' +
                '<td>' + escapeHtml(image) + '</td>' +
                '<td>' + escapeHtml(loginName) + '</td>' +
                '<td>' + escapeHtml(ruleText) + '</td>' +
                '<td>' + escapeHtml(reservedText) + '</td>' +
                '</tr>';
        }).join('');
    }

    function buildDeploymentAccessRows(rows, escapeHtml) {
        const list = Array.isArray(rows) ? rows : [];
        if (list.length === 0) {
            return '<tr><td colspan="2">No deployed instances.</td></tr>';
        }

        return list.map(function(row) {
            const hostname = escapeHtml(String(row.hostname || '-'));
            if (row.error) {
                const errText = String(row.error || 'SSH access failed');
                return '<tr><td>' + hostname + '</td><td><span class="deploy-access-error">' + escapeHtml(errText) + '</span></td></tr>';
            }

            const uri = String(row.uri || '');
            const uriEsc = escapeHtml(uri);
            return '<tr><td>' + hostname + '</td><td><a class="deploy-access-link" href="' + uriEsc + '" onclick="window.open(this.href); event.preventDefault(); return false;" rel="noopener noreferrer">' + uriEsc + '</a></td></tr>';
        }).join('');
    }

    global.NextUIRenderHelpers = {
        buildKindImageRegistryRows: buildKindImageRegistryRows,
        buildDeploymentAccessRows: buildDeploymentAccessRows,
    };
})(window);
