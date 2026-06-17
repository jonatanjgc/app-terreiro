// Ouve o evento de 'push' vindo do servidor
self.addEventListener('push', function(event) {
    let data = {};
    
    // Tenta extrair os dados enviados pelo Node.js
    if (event.data) {
        data = event.data.json();
    }

    const titulo = data.titulo || 'Sete Corações';
    const opcoes = {
        body: data.mensagem || 'Tem um novo aviso no painel.',
        icon: '/logo.png', // O ícone que aparece na notificação
        badge: '/logo.png', // O ícone pequeno na barra de estado (Android)
        vibrate: [200, 100, 200, 100, 200], // Padrão de vibração do telemóvel
        requireInteraction: false // Se true, a notificação não desaparece sozinha
    };

    // Mostra a notificação no ecrã
    event.waitUntil(
        self.registration.showNotification(titulo, opcoes)
    );
});

// Ouve o evento de clique na notificação
self.addEventListener('notificationclick', function(event) {
    event.notification.close(); // Fecha a notificação ao clicar
    
    // Abre a página do aplicativo quando o utilizador clica na notificação
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                let client = clientList[i];
                if (client.url === '/' && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});

// Instalação e ativação imediata do Service Worker
self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(clients.claim());
});