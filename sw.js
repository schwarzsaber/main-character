self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

// Receive push messages from the backend and display them
self.addEventListener('push', (e) => {
    let data = {};
    try {
        data = e.data ? e.data.json() : {};
    } catch (err) {
        data = { title: 'Main Character Energy', body: e.data ? e.data.text() : '' };
    }

    const title = data.title || 'Main Character Energy';
    const options = {
        body: data.body || '',
        tag: data.tag || 'mce',
        requireInteraction: !!data.requireInteraction,
        // Large in-tray icon: full-colour lightning bolt emoji, close-cropped.
        icon: 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'192\' height=\'192\'%3E%3Ctext x=\'50%25\' y=\'52%25\' font-size=\'176\' dominant-baseline=\'central\' text-anchor=\'middle\'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E',
        // Small status-bar badge: the crown EMOJI on a transparent background.
        // Android derives the silhouette from the glyph's opaque pixels.
        badge: 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'96\' height=\'96\'%3E%3Ctext x=\'50%25\' y=\'52%25\' font-size=\'88\' dominant-baseline=\'central\' text-anchor=\'middle\'%3E%F0%9F%91%91%3C/text%3E%3C/svg%3E'
    };
    if (data.actions) options.actions = data.actions;
    if (data.vibrate) options.vibrate = data.vibrate;

    e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();

    // Use the service worker's scope so taps open the app at its actual hosted
    // path (handles GitHub Pages project subpaths, not just the domain root).
    const appUrl = self.registration.scope;

    if (e.action === 'techoff') {
        e.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
                for (let i = 0; i < clientList.length; i++) {
                    const client = clientList[i];
                    client.postMessage({ action: 'techoff' });
                    if ('focus' in client) return client.focus();
                }
                // No open window: open the app with a flag so it logs tech-off on load
                const sep = appUrl.indexOf('?') === -1 ? '?' : '&';
                return clients.openWindow(appUrl + sep + 'techoff=1');
            })
        );
    } else if (e.action === 'dismiss') {
        // just close
    } else {
        e.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
                // Focus an existing app window if one is open
                for (let i = 0; i < clientList.length; i++) {
                    const client = clientList[i];
                    if ('focus' in client) return client.focus();
                }
                return clients.openWindow(appUrl);
            })
        );
    }
});
