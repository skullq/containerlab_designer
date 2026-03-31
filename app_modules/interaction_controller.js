(function(global) {
    function createInteractionController(deps) {
        return {
            bindGlobalListenersOnce: function(handlers) {
                if (document.body.dataset.linkContextBound) return;

                const menu = document.getElementById('nodeContextMenu');
                if (menu && !menu.dataset.bound) {
                    menu.addEventListener('mousedown', function(evt) { evt.stopPropagation(); });
                    menu.addEventListener('contextmenu', function(evt) { evt.stopPropagation(); });
                    menu.dataset.bound = '1';
                }

                document.addEventListener('contextmenu', handlers.handleDocumentContextMenu, true);
                document.addEventListener('mousedown', handlers.handleDocumentPointerDown, false);
                document.addEventListener('mousemove', handlers.handleDocumentPointerMove, false);
                document.addEventListener('dblclick', handlers.handleDocumentDoubleClick, false);
                document.addEventListener('click', handlers.handleDocumentClick, false);
                document.addEventListener('mouseup', handlers.handleDocumentPointerUp, false);
                document.addEventListener('keydown', handlers.handleDocumentKeyDown, true);

                document.addEventListener('mousedown', function(evt) {
                    if (evt.button !== 0) return;
                    const menuEl = document.getElementById('nodeContextMenu');
                    if (menuEl && menuEl.classList.contains('open') && menuEl.contains(evt.target)) return;
                    handlers.hideNodeContextMenu();
                });

                document.body.dataset.linkContextBound = '1';
            },

            startBackgroundPanTracking: function(handlers) {
                if (global.__nextuiBgPanMoveBound) return;
                window.addEventListener('mousemove', handlers.handleDocumentPointerMove, true);
                window.addEventListener('mouseup', handlers.handleDocumentPointerUp, true);
                global.__nextuiBgPanMoveBound = true;
            },

            stopBackgroundPanTracking: function(handlers) {
                if (!global.__nextuiBgPanMoveBound) return;
                window.removeEventListener('mousemove', handlers.handleDocumentPointerMove, true);
                window.removeEventListener('mouseup', handlers.handleDocumentPointerUp, true);
                global.__nextuiBgPanMoveBound = false;
                handlers.setBackgroundMoveCursor(false);
            },
        };
    }

    global.createInteractionController = createInteractionController;
})(window);
