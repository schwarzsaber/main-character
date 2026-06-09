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
        icon: 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'512\' height=\'512\'%3E%3Crect width=\'512\' height=\'512\' fill=\'%23667eea\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' font-size=\'300\' dominant-baseline=\'middle\' text-anchor=\'middle\'%3E⚡%3C/text%3E%3C/svg%3E',
        badge: 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'96\' height=\'96\'%3E%3Crect width=\'96\' height=\'96\' fill=\'%23667eea\'/%3E%3C/svg%3E'
    };
    if (data.actions) options.actions = data.actions;
    if (data.vibrate) options.vibrate = data.vibrate;

    e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();

    if (e.action === 'techoff') {
        e.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
                for (let i = 0; i < clientList.length; i++) {
                    const client = clientList[i];
                    client.postMessage({ action: 'techoff' });
                    if ('focus' in client) return client.focus();
                }
                return clients.openWindow('/');
            })
        );
    } else if (e.action === 'dismiss') {
        // just close
    } else {
        e.waitUntil(clients.openWindow('/'));
    }
});
