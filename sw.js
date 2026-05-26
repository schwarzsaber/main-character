self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    
    if (e.action === 'techoff') {
        e.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
                for (let i = 0; i < clientList.length; i++) {
                    const client = clientList[i];
                    client.postMessage({ action: 'techoff' });
                    if ('focus' in client) client.focus();
                    return;
                }
                return clients.openWindow('/');
            })
        );
    } else {
        e.waitUntil(clients.openWindow('/'));
    }
});

