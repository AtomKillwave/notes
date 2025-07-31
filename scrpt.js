// Глобальные переменные
let socket;
let currentUser = null;
let currentChat = null;
let currentChatId = null;
let isLoginMode = true;
let activeChats = new Map();
let isMobile = window.innerWidth < 768;
let isConnected = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 10;
let pingInterval = null;
let statusUpdateInterval = null;
let lastActivity = Date.now();
let reconnectInterval = null;
let isReconnecting = false;

// DOM элементы
const authScreen = document.getElementById('authScreen');
const mainApp = document.getElementById('mainApp');
const authTitle = document.getElementById('authTitle');
const authBtn = document.getElementById('authBtn');
const switchBtn = document.getElementById('switchBtn');
const authError = document.getElementById('authError');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const displayNameInput = document.getElementById('displayName');
const currentUserSpan = document.getElementById('currentUser');
const userSearch = document.getElementById('userSearch');
const chatsList = document.getElementById('chatsList');
const chatArea = document.getElementById('chatArea');
const chatHeader = document.getElementById('chatHeader');
const chatTitle = document.getElementById('chatTitle');
const chatAvatar = document.getElementById('chatAvatar');
const chatAvatarContainer = document.querySelector('.chat-avatar-container');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const profileBtn = document.getElementById('profileBtn');
const chatProfileBtn = document.getElementById('chatProfileBtn');
const settingsBtn = document.getElementById('settingsBtn');
const profileModal = document.getElementById('profileModal');
const profileSettingsModal = document.getElementById('profileSettingsModal');
const closeModal = document.getElementById('closeModal');
const closeProfileSettingsModal = document.getElementById('closeProfileSettingsModal');
const profileInfo = document.getElementById('profileInfo');
const backBtn = document.getElementById('backBtn');
const sidebar = document.getElementById('sidebar');

// Новые элементы для настроек
const settingsArea = document.getElementById('settingsArea');
const settingsBackBtn = document.getElementById('settingsBackBtn');
const logoutBtn = document.getElementById('logoutBtn');

// Элементы настроек профиля
const profileSettingsDisplayName = document.getElementById('profileSettingsDisplayName');
const profileSettingsDescription = document.getElementById('profileSettingsDescription');
const saveProfileSettingsBtn = document.getElementById('saveProfileSettingsBtn');
const profileSettingsError = document.getElementById('profileSettingsError');

// Новые элементы для смены пароля
const passwordChangeModal = document.getElementById('passwordChangeModal');
const closePasswordChangeModal = document.getElementById('closePasswordChangeModal');
const currentPassword = document.getElementById('currentPassword');
const newPassword = document.getElementById('newPassword');
const confirmPassword = document.getElementById('confirmPassword');
const changePasswordBtn = document.getElementById('changePasswordBtn');
const passwordChangeError = document.getElementById('passwordChangeError');

// Элементы для аватарки
const avatarPreview = document.getElementById('avatarPreview');
const avatarOverlay = document.getElementById('avatarOverlay');
const avatarInput = document.getElementById('avatarInput');

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Загрузка приложения...');
    checkExistingSession();
    initializeAvatarUpload();
});

// Функция проверки существующей сессии
async function checkExistingSession() {
    try {
        const response = await fetch('/check-session');
        const data = await response.json();

        if (data.success && data.user) {
            console.log('✅ Найдена активная сессия:', data.user.username);
            currentUser = data.user;
            initializeApp();
        } else {
            console.log('ℹ️ Активная сессия не найдена');
            authScreen.style.display = 'flex';
        }
    } catch (error) {
        console.error('❌ Ошибка проверки сессии:', error);
        authScreen.style.display = 'flex';
    }
}

// Инициализация загрузки аватарки - ИСПРАВЛЕННАЯ ВЕРСИЯ
function initializeAvatarUpload() {
    if (avatarOverlay && avatarInput) {
        // Добавляем поддержку различных событий для кроссплатформенности
        const triggerFileSelect = (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Очищаем предыдущий выбор для возможности выбора того же файла
            avatarInput.value = '';

            // Программно кликаем по input
            avatarInput.click();
        };

        // Обработчики для desktop
        avatarOverlay.addEventListener('click', triggerFileSelect);

        // Обработчики для мобильных устройств
        avatarOverlay.addEventListener('touchstart', (e) => {
            e.preventDefault();
        });

        avatarOverlay.addEventListener('touchend', triggerFileSelect);

        // Добавляем визуальную обратную связь при нажатии
        avatarOverlay.addEventListener('touchstart', () => {
            avatarOverlay.style.opacity = '0.7';
        });

        avatarOverlay.addEventListener('touchend', () => {
            avatarOverlay.style.opacity = '1';
        });

        avatarOverlay.addEventListener('mousedown', () => {
            avatarOverlay.style.opacity = '0.7';
        });

        avatarOverlay.addEventListener('mouseup', () => {
            avatarOverlay.style.opacity = '1';
        });

        // Обработчик изменения файла
        avatarInput.addEventListener('change', handleAvatarUpload);

        // Убеждаемся что input имеет правильные атрибуты
        avatarInput.setAttribute('accept', 'image/*');
        avatarInput.setAttribute('capture', 'environment'); // Для камеры на мобильных
    }
}

// Улучшенная обработка загрузки аватарки
async function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    console.log('📷 Выбран файл:', file.name, 'Размер:', file.size);

    // Проверяем тип файла
    if (!file.type.startsWith('image/')) {
        showError('Пожалуйста, выберите изображение', profileSettingsError);
        return;
    }

    // Проверяем размер файла (максимум 5MB)
    if (file.size > 5 * 1024 * 1024) {
        showError('Размер файла не должен превышать 5MB', profileSettingsError);
        return;
    }

    try {
        // Показываем превью немедленно для лучшего UX
        const reader = new FileReader();
        reader.onload = (e) => {
            avatarPreview.src = e.target.result;
            avatarPreview.classList.remove('default');

            // Добавляем класс для скрытия overlay через CSS
            avatarOverlay.classList.add('has-image');
        };
        reader.readAsDataURL(file);

        // Загружаем на сервер
        const formData = new FormData();
        formData.append('avatar', file);

        const response = await fetch('/upload-avatar', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            console.log('✅ Аватарка загружена:', data.avatarPath);
            currentUser.avatar = data.avatarPath;
            updateAvatarsEverywhere();

            // Добавляем класс для скрытия overlay после успешной загрузки
            avatarOverlay.classList.add('has-image');

            setTimeout(() => {
                hideError(profileSettingsError);
            }, 3000);
        } else {
            showError(data.message || 'Ошибка загрузки аватарки', profileSettingsError);

            // Возвращаем предыдущую аватарку в случае ошибки
            restorePreviousAvatar();
            // Убираем класс при ошибке
            avatarOverlay.classList.remove('has-image');
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки аватарки:', error);
        showError('Ошибка загрузки аватарки', profileSettingsError);

        // Возвращаем предыдущую аватарку в случае ошибки
        restorePreviousAvatar();
        // Убираем класс при ошибке
        avatarOverlay.classList.remove('has-image');
    } finally {
        // Убираем inline стили если они есть
        avatarOverlay.style.opacity = '';
    }
}

// Функция для обновления аватарок везде
function updateAvatarsEverywhere() {
    // Обновляем превью в настройках
    if (currentUser.avatar) {
        avatarPreview.src = currentUser.avatar;
        avatarPreview.classList.remove('default');
    }

    // Обновляем список чатов
    displayChatsList();

    // Если текущий чат открыт, обновляем его заголовок
    if (currentChat === currentUser.username && chatAvatar) {
        updateChatAvatar(currentUser.username, currentUser.avatar);
    }

    // Уведомляем сервер об обновлении аватарки
    if (socket && isConnected) {
        socket.emit('avatar-updated', {
            username: currentUser.username,
            avatar: currentUser.avatar
        });
    }
}

// Функция для получения аватарки пользователя в списке чатов
function getUserAvatar(username, avatar) {
    if (avatar && avatar !== '') {
        return `<img class="chat-item-avatar" src="${avatar}" alt="${username}">`;
    } else {
        const initial = username.charAt(0).toUpperCase();
        return `<div class="chat-item-avatar default">${initial}</div>`;
    }
}

// Функция для получения аватарки в заголовке чата
function getChatAvatar(username, avatar) {
    if (avatar && avatar !== '') {
        return `<img class="chat-avatar" src="${avatar}" alt="${username}">`;
    } else {
        const initial = username.charAt(0).toUpperCase();
        return `<div class="chat-avatar default">${initial}</div>`;
    }
}

// Функция для получения аватарки профиля
function getProfileAvatar(username, avatar) {
    if (avatar && avatar !== '') {
        return `<img class="profile-avatar" src="${avatar}" alt="${username}">`;
    } else {
        const initial = username.charAt(0).toUpperCase();
        return `<div class="profile-avatar default">${initial}</div>`;
    }
}

// Функция для обновления аватарки в заголовке чата
function updateChatAvatar(username, avatar) {
    if (chatAvatar) {
        if (avatar && avatar !== '') {
            chatAvatar.src = avatar;
            chatAvatar.classList.remove('default');
            chatAvatar.alt = username;
        } else {
            chatAvatar.src = '';
            chatAvatar.classList.add('default');
            chatAvatar.innerHTML = username.charAt(0).toUpperCase();
        }
    }
}

// Отслеживание изменения размера экрана
window.addEventListener('resize', () => {
    const wasDesktop = !isMobile;
    isMobile = window.innerWidth < 768;

    if (wasDesktop && !isMobile) {
        chatArea.classList.remove('active');
        settingsArea.classList.remove('active');
    }

    if (!wasDesktop && isMobile && currentChat) {
        chatArea.classList.add('active');
    }
});

// Функция для показа/скрытия ошибок
function showError(message, errorElement = authError) {
    errorElement.textContent = message;
    errorElement.style.display = 'block';
    errorElement.style.color = '#E74C3C';
}

function showSuccess(message, errorElement = authError) {
    errorElement.textContent = message;
    errorElement.style.display = 'block';
    errorElement.style.color = '#27AE60';
}

function hideError(errorElement = authError) {
    errorElement.style.display = 'none';
    errorElement.textContent = '';
}

// Функция для нормализации username
function normalizeUsername(username) {
    return username.startsWith('@') ? username : `@${username}`;
}

// Функция для создания подключения
function createSocketConnection() {
    console.log('🔌 Создаем socket подключение...');

    // Если socket уже существует, закрываем его
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
    }

    socket = io({
        transports: ['websocket', 'polling'],
        upgrade: true,
        rememberUpgrade: true,
        timeout: 10000,
        forceNew: true, // Принудительно создаем новое соединение
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        maxReconnectionAttempts: Infinity
    });

    setupSocketHandlers();
}

// Функция для настройки обработчиков socket
function setupSocketHandlers() {
    socket.on('connect', () => {
        console.log('✅ Socket подключен:', socket.id);
        isConnected = true;
        isReconnecting = false;
        reconnectAttempts = 0;

        // Очищаем таймер переподключения
        if (reconnectInterval) {
            clearTimeout(reconnectInterval);
            reconnectInterval = null;
        }

        if (currentUser) {
            console.log('🔄 Восстанавливаем состояние пользователя...');

            // Уведомляем сервер что мы онлайн
            socket.emit('user-online', currentUser.username);

            // Перезагружаем чаты
            loadUserChats().then(() => {
                console.log('✅ Чаты перезагружены');

                // Подписываемся на статусы пользователей
                setTimeout(() => {
                    subscribeToUserStatuses();
                    updateAllUserStatuses();
                }, 1000);

                // Если был открыт чат, переподключаемся к нему
                if (currentChatId) {
                    console.log('🔄 Переподключаемся к чату:', currentChatId);
                    socket.emit('join-chat', currentChatId);

                    // Обновляем статус собеседника
                    if (currentChat) {
                        updateChatUserStatus(currentChat);
                    }
                }
            });

            startPing();
            startStatusUpdates();
        }

        hideConnectionError();
        showConnectionSuccess('Соединение восстановлено');
    });

    socket.on('disconnect', (reason) => {
        console.log('🔴 Socket отключен:', reason);
        isConnected = false;
        stopPing();
        stopStatusUpdates();

        if (reason === 'io server disconnect') {
            // Сервер принудительно отключил нас
            showConnectionError('Сервер разорвал соединение');
            attemptReconnect();
        } else if (reason === 'transport close' || reason === 'transport error') {
            // Проблемы с сетью
            showConnectionError('Потеряно соединение с сервером. Переподключение...');
            attemptReconnect();
        } else {
            // Другие причины
            showConnectionError('Соединение потеряно. Переподключение...');
            attemptReconnect();
        }
    });

    socket.on('connect_error', (error) => {
        console.log('❌ Ошибка подключения:', error);
        isConnected = false;

        if (!isReconnecting) {
            showConnectionError('Ошибка подключения к серверу');
            attemptReconnect();
        }
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`🔄 Попытка переподключения ${attemptNumber}`);
        showConnectionError(`Переподключение... (попытка ${attemptNumber})`);
    });

    socket.on('reconnect', (attemptNumber) => {
        console.log(`✅ Переподключение успешно после ${attemptNumber} попыток`);
        isReconnecting = false;
    });

    socket.on('reconnect_failed', () => {
        console.log('❌ Не удалось переподключиться');
        showConnectionError('Не удается подключиться к серверу');

        // Продолжаем попытки переподключения
        setTimeout(() => {
            if (!isConnected && currentUser) {
                attemptReconnect();
            }
        }, 5000);
    });

    socket.on('connection-confirmed', (data) => {
        console.log('✅ Подключение подтверждено:', data);
        if (data.connectionType === 'reconnected') {
            console.log('🔄 Переподключение успешно завершено');

            // Полностью восстанавливаем состояние
            restoreApplicationState();
        }
    });

    socket.on('user-status-changed', (data) => {
        console.log('📡 Получено обновление статуса:', data);
        updateUserStatus(data.username, data.isOnline, data.lastSeenText);
    });

    socket.on('users-status-update', (data) => {
        console.log('📡 Получено массовое обновление статусов:', data);
        if (data.users && Array.isArray(data.users)) {
            data.users.forEach(user => {
                updateUserStatus(user.username, user.isOnline, user.lastSeenText);
            });
        }
    });

    socket.on('new-message', (messageData) => {
        if (currentChatId && isMessageForCurrentChat(messageData)) {
            displayMessage(messageData);
        }
        updateChatsList();
    });

    socket.on('new-chat-notification', (data) => {
        const { from, chatId, message } = data;

        if (!activeChats.has(chatId)) {
            const newChat = {
                username: from,
                chatId: chatId,
                lastMessage: {
                    text: message.message,
                    timestamp: message.timestamp,
                    from: message.from
                },
                isOnline: true,
                lastSeenText: 'В сети'
            };
            activeChats.set(chatId, newChat);

            updateChatUserInfo(from, chatId);
            displayChatsList();
            subscribeToUserStatus(from);
        }
    });

    socket.on('chat-history', (messages) => {
        chatMessages.innerHTML = '';
        messages.forEach(message => displayMessage(message));
    });

    // Обработка обновления профиля пользователя
    socket.on('user-profile-updated', (data) => {
        const { username, profile } = data;
        console.log('📝 Получено обновление профиля:', { username, profile });

        // Обновляем информацию о пользователе в чатах
        updateUserProfileInChats(username, profile);
    });

    // Обработка обновления аватарки
    socket.on('user-avatar-updated', (data) => {
        const { username, avatar } = data;
        console.log('🖼️ Получено обновление аватарки:', { username, avatar });

        // Обновляем аватарку в чатах
        updateUserAvatarInChats(username, avatar);
    });

    socket.on('pong', () => {
        lastActivity = Date.now();
    });

    socket.on('error', (error) => {
        console.error('❌ Socket error:', error);
    });
}

// Функция для обновления аватарки пользователя в чатах
function updateUserAvatarInChats(username, avatar) {
    console.log('🔄 Обновляем аватарку пользователя в чатах:', { username, avatar });

    // Обновляем в activeChats
    for (const [chatId, chat] of activeChats) {
        if (chat.username === username) {
            chat.avatar = avatar;
            activeChats.set(chatId, chat);
            break;
        }
    }

    // Обновляем отображение списка чатов
    displayChatsList();

    // Если это текущий чат, обновляем аватарку в заголовке
    if (currentChat === username) {
        updateChatAvatar(username, avatar);
    }
}

// Функция для попытки переподключения
function attemptReconnect() {
    if (isReconnecting || !currentUser) return;

    isReconnecting = true;
    reconnectAttempts++;

    console.log(`🔄 Начинаем переподключение (попытка ${reconnectAttempts})`);

    // Очищаем предыдущий таймер если есть
    if (reconnectInterval) {
        clearTimeout(reconnectInterval);
    }

    // Вычисляем задержку с экспоненциальным увеличением
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), 10000);

    reconnectInterval = setTimeout(() => {
        if (!isConnected && currentUser) {
            console.log(`🔌 Попытка переподключения ${reconnectAttempts}/${maxReconnectAttempts}`);

            // Создаем новое соединение
            createSocketConnection();

            // Если достигли максимума попыток, ждем дольше
            if (reconnectAttempts >= maxReconnectAttempts) {
                reconnectAttempts = 0; // Сбрасываем счетчик
                console.log('🔄 Сброс счетчика попыток переподключения');
            }
        }
        isReconnecting = false;
    }, delay);
}

// Функция для восстановления состояния приложения
async function restoreApplicationState() {
    if (!currentUser) return;

    console.log('🔄 Восстанавливаем состояние приложения...');

    try {
        // Перезагружаем чаты
        await loadUserChats();

        // Подписываемся на статусы
        setTimeout(() => {
            subscribeToUserStatuses();
            updateAllUserStatuses();
        }, 1000);

        // Если был открыт чат, восстанавливаем его
        if (currentChatId && currentChat) {
            console.log('🔄 Восстанавливаем чат:', currentChatId);
            socket.emit('join-chat', currentChatId);

            // Обновляем статус собеседника
            updateChatUserStatus(currentChat);
        }

        console.log('✅ Состояние приложения восстановлено');
    } catch (error) {
        console.error('❌ Ошибка восстановления состояния:', error);
    }
}

// Функция для обновления статуса собеседника в чате
async function updateChatUserStatus(username) {
    if (!username) return;

    try {
        const response = await fetch(`/profile/${username}`);
        const data = await response.json();

        if (data.success && currentChat === username) {
            const statusText = data.profile.lastSeenText;
            const displayName = data.profile.displayName || username;
            const avatar = data.profile.avatar;

            // Обновляем аватарку
            updateChatAvatar(username, avatar);

            // Обновляем индикатор статуса на аватарке
            updateChatAvatarStatus(data.profile.isOnline);

            // Обновляем заголовок
            chatTitle.innerHTML = `
                <div>${displayName}</div>
                <div style="font-size: 12px; color: #95A5A6; font-weight: 400; margin-top: 2px;">${statusText}</div>
            `;

            updateUserStatus(username, data.profile.isOnline, statusText);
        }
    } catch (error) {
        console.error('❌ Ошибка обновления статуса собеседника:', error);
    }
}

// Функция для обновления индикатора статуса на аватарке в заголовке чата
function updateChatAvatarStatus(isOnline) {
    let statusIndicator = chatAvatarContainer.querySelector('.chat-avatar-status');

    if (!statusIndicator) {
        statusIndicator = document.createElement('div');
        statusIndicator.className = 'chat-avatar-status';
        chatAvatarContainer.appendChild(statusIndicator);
    }

    statusIndicator.className = `chat-avatar-status ${isOnline ? 'online' : ''}`;
}

function subscribeToUserStatuses() {
    if (!socket || !isConnected || activeChats.size === 0) return;

    const usernames = Array.from(activeChats.values()).map(chat => chat.username);
    console.log('📡 Подписываемся на статусы пользователей:', usernames);

    socket.emit('subscribe-to-statuses', usernames);
}

function subscribeToUserStatus(username) {
    if (!socket || !isConnected) return;

    console.log('📡 Подписываемся на статус пользователя:', username);
    socket.emit('subscribe-to-status', username);
}

function startPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
    }

    pingInterval = setInterval(() => {
        if (socket && isConnected) {
            socket.emit('ping');
            lastActivity = Date.now();
        }
    }, 25000);
}

function stopPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

function startStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
    }

    statusUpdateInterval = setInterval(() => {
        if (isConnected && activeChats.size > 0) {
            updateAllUserStatuses();
        }
    }, 15000);
}

function stopStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
    }
}

async function updateAllUserStatuses() {
    const usernames = Array.from(activeChats.values()).map(chat => chat.username);

    if (usernames.length === 0) return;

    try {
        const response = await fetch('/users-status', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ usernames })
        });

        const data = await response.json();

        if (data.success) {
            console.log('📊 Обновление статусов с сервера:', data.users);
            data.users.forEach(user => {
                updateUserStatus(user.username, user.isOnline, user.lastSeenText);
            });
        }
    } catch (error) {
        console.error('❌ Ошибка обновления статусов:', error);
    }
}

function showConnectionError(message) {
    let indicator = document.getElementById('connectionIndicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'connectionIndicator';
        indicator.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: #E74C3C;
            color: white;
            text-align: center;
            padding: 8px;
            font-size: 14px;
            z-index: 10000;
            transition: all 0.3s ease;
        `;
        document.body.appendChild(indicator);
    }
    indicator.textContent = message;
    indicator.style.display = 'block';
    indicator.style.backgroundColor = '#E74C3C';
}

function showConnectionSuccess(message) {
    let indicator = document.getElementById('connectionIndicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'connectionIndicator';
        indicator.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            color: white;
            text-align: center;
            padding: 8px;
            font-size: 14px;
            z-index: 10000;
            transition: all 0.3s ease;
        `;
        document.body.appendChild(indicator);
    }
    indicator.textContent = message;
    indicator.style.display = 'block';
    indicator.style.backgroundColor = '#27AE60';

    // Автоматически скрываем через 3 секунды
    setTimeout(() => {
        hideConnectionError();
    }, 3000);
}

function hideConnectionError() {
    const indicator = document.getElementById('connectionIndicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
}

// Переключение между входом и регистрацией
switchBtn.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    if (isLoginMode) {
        authTitle.textContent = 'Вход';
        authBtn.textContent = 'Войти';
        switchBtn.textContent = 'Регистрация';
        displayNameInput.style.display = 'none';
        displayNameInput.required = false;
    } else {
        authTitle.textContent = 'Регистрация';
        authBtn.textContent = 'Зарегистрироваться';
        switchBtn.textContent = 'Вход';
        displayNameInput.style.display = 'block';
        displayNameInput.required = true;
    }
    hideError();
});

// Авторизация
authBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    const displayName = displayNameInput.value.trim();

    if (!username || !password) {
        showError('Заполните все поля');
        return;
    }

    if (!isLoginMode && !displayName) {
        showError('Заполните все поля');
        return;
    }

    const endpoint = isLoginMode ? '/login' : '/register';
    const body = isLoginMode ? 
        { username, password } : 
        { username, password, displayName };

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (data.success) {
            if (isLoginMode) {
                currentUser = data.user;
                console.log('✅ Вход выполнен:', currentUser.username);
                initializeApp();
            } else {
                try {
                    const loginResponse = await fetch('/login', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ username, password })
                    });

                    const loginData = await loginResponse.json();

                    if (loginData.success) {
                        currentUser = loginData.user;
                        console.log('✅ Регистрация и вход выполнены:', currentUser.username);
                        initializeApp();
                    } else {
                        showError('Регистрация прошла успешно, но не удалось войти. Попробуйте войти вручную.');
                    }
                } catch (loginError) {
                    console.error('❌ Ошибка входа после регистрации:', loginError);
                    showError('Регистрация прошла успешно, но не удалось войти. Попробуйте войти вручную.');
                }
            }
        } else {
            showError(data.message);
        }
    } catch (error) {
        showError('Ошибка подключения к серверу');
    }
});

// Инициализация приложения после входа
function initializeApp() {
    authScreen.style.display = 'none';
    mainApp.style.display = 'block';
    currentUserSpan.textContent = currentUser.displayName;

    // Сбрасываем состояние переподключения
    reconnectAttempts = 0;
    isReconnecting = false;

    createSocketConnection();
    loadUserChats();
}

// Загрузка чатов пользователя
async function loadUserChats() {
    try {
        const response = await fetch(`/user-chats/${currentUser.username}`);
        const data = await response.json();

        if (data.success) {
            activeChats.clear();
            data.chats.forEach(chat => {
                activeChats.set(chat.chatId, chat);
            });
            displayChatsList();

            setTimeout(() => {
                subscribeToUserStatuses();
                updateAllUserStatuses();
            }, 500);
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки чатов:', error);
    }
}

async function updateChatsList() {
    await loadUserChats();
}

async function updateChatUserInfo(username, chatId) {
    try {
        const response = await fetch(`/profile/${username}`);
        const data = await response.json();

        if (data.success && activeChats.has(chatId)) {
            const chat = activeChats.get(chatId);
            chat.displayName = data.profile.displayName;
            chat.description = data.profile.description;
            chat.avatar = data.profile.avatar;
            chat.isOnline = data.profile.isOnline;
            chat.lastSeenText = data.profile.lastSeenText;
            activeChats.set(chatId, chat);
            displayChatsList();
        }
    } catch (error) {
        console.error('❌ Ошибка получения информации о пользователе:', error);
    }
}

// Функция для обновления профиля пользователя в чатах
function updateUserProfileInChats(username, profile) {
    console.log('🔄 Обновляем профиль пользователя в чатах:', { username, profile });

    // Обновляем данные профиля в activeChats
    for (const [chatId, chat] of activeChats) {
        if (chat.username === username) {
            chat.displayName = profile.displayName;
            chat.description = profile.description;
            chat.avatar = profile.avatar;
            activeChats.set(chatId, chat);

            // Если это текущий чат, обновляем заголовок
            if (currentChat === username) {
                const statusText = chat.lastSeenText || (chat.isOnline ? 'В сети' : 'Был(а) в сети давно');
                updateChatAvatar(username, profile.avatar);
                updateChatAvatarStatus(chat.isOnline);
                chatTitle.innerHTML = `
                    <div>${profile.displayName}</div>
                    <div style="font-size: 12px; color: #95A5A6; font-weight: 400; margin-top: 2px;">${statusText}</div>
                `;
            }

            break;
        }
    }

    // Обновляем отображение списка чатов
    displayChatsList();
}

function displayChatsList() {
    const chatsContainer = document.createElement('div');
    chatsContainer.innerHTML = '';

    const sortedChats = Array.from(activeChats.values()).sort((a, b) => {
        if (!a.lastMessage && !b.lastMessage) return 0;
        if (!a.lastMessage) return 1;
        if (!b.lastMessage) return -1;
        return new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp);
    });

    sortedChats.forEach(chat => {
        const chatItem = document.createElement('div');
        chatItem.className = 'chat-item';

        if (currentChatId === chat.chatId) {
            chatItem.classList.add('active');
        }

        const displayName = chat.displayName || chat.username;
        const lastMessageText = chat.lastMessage ? 
            `<div class="last-message">
                ${chat.lastMessage.from === currentUser.username ? 'Вы: ' : ''}${chat.lastMessage.text}
            </div>` : '';

        const avatarHtml = getUserAvatar(chat.username, chat.avatar);

        chatItem.innerHTML = `
            <div class="chat-item-avatar-container">
                ${avatarHtml}
                <div class="avatar-status-indicator ${chat.isOnline ? 'online' : ''}"></div>
            </div>
            <div class="chat-info">
                <div class="chat-name">
                    <strong>${displayName}</strong>
                    <span class="username">@${chat.username}</span>
                </div>
                ${lastMessageText}
            </div>
        `;

        chatItem.addEventListener('click', () => {
            openChatById(chat.chatId, chat.username, displayName);
        });

        chatsContainer.appendChild(chatItem);
    });

    const existingChats = chatsList.querySelectorAll('.chat-item');
    existingChats.forEach(item => item.remove());

    Array.from(chatsContainer.children).forEach(child => {
        chatsList.appendChild(child);
    });
}

function isMessageForCurrentChat(messageData) {
    if (!currentChat || !currentChatId) return false;

    const expectedChatId = getChatId(currentUser.username, currentChat);
    return currentChatId === expectedChatId && 
           (messageData.from === currentChat || messageData.from === currentUser.username);
}

let searchTimeout;
userSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = userSearch.value.trim();

    if (query.length === 0) {
        displayChatsList();
        return;
    }

    searchTimeout = setTimeout(async () => {
        try {
            const response = await fetch('/search-users', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ query })
            });

            const users = await response.json();
            displaySearchResults(users);
        } catch (error) {
            console.error('❌ Ошибка поиска:', error);
        }
    }, 300);
});

function displaySearchResults(users) {
    chatsList.innerHTML = '';

    users.forEach(user => {
        if (user.username === currentUser.username) return;

        const chatItem = document.createElement('div');
        chatItem.className = 'chat-item';

        const avatarHtml = getUserAvatar(user.username, user.avatar);

        chatItem.innerHTML = `
            <div class="chat-item-avatar-container">
                ${avatarHtml}
                <div class="avatar-status-indicator ${user.isOnline ? 'online' : ''}"></div>
            </div>
            <div class="chat-info">
                <div class="chat-name">
                    <strong>${user.displayName}</strong>
                    <span class="username">@${user.username}</span>
                </div>
            </div>
        `;

        chatItem.addEventListener('click', () => {
            openChat(user.username, user.displayName);
        });

        chatsList.appendChild(chatItem);
    });
}

function openChat(username, displayName) {
    const chatId = getChatId(currentUser.username, username);
    openChatById(chatId, username, displayName);
}

// Исправленная функция для открытия чата с фиксом фокуса на мобильных
function openChatById(chatId, username, displayName) {
    currentChat = username;
    currentChatId = chatId;

    // Закрываем настройки если они открыты
    hideSettings();

    userSearch.value = '';

    document.querySelectorAll('.chat-item').forEach(item => {
        item.classList.remove('active');
    });

    const chatItems = document.querySelectorAll('.chat-item');
    chatItems.forEach(item => {
        const usernameElement = item.querySelector('.username');
        if (usernameElement && usernameElement.textContent === `@${username}`) {
            item.classList.add('active');
        }
    });

    let statusText = 'Загрузка...';
    let isOnline = false;
    let avatar = null;

    // Проверяем кэш
    for (const [cId, chat] of activeChats) {
        if (chat.username === username) {
            statusText = chat.lastSeenText || (chat.isOnline ? 'В сети' : 'Был(а) в сети давно');
            isOnline = chat.isOnline;
            avatar = chat.avatar;
            break;
        }
    }

    // Обновляем аватарку и заголовок
    updateChatAvatar(username, avatar);
    updateChatAvatarStatus(isOnline);
    chatTitle.innerHTML = `
        <div>${displayName || username}</div>
        <div style="font-size: 12px; color: #95A5A6; font-weight: 400; margin-top: 2px;">${statusText}</div>
    `;

    // Теперь получаем актуальные данные с сервера
    fetch(`/profile/${username}`)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                const newStatusText = data.profile.lastSeenText;
                const newIsOnline = data.profile.isOnline;
                const newAvatar = data.profile.avatar;

                updateChatAvatar(username, newAvatar);
                updateChatAvatarStatus(newIsOnline);
                chatTitle.innerHTML = `
                    <div>${displayName || username}</div>
                    <div style="font-size: 12px; color: #95A5A6; font-weight: 400; margin-top: 2px;">${newStatusText}</div>
                `;

                updateUserStatus(username, newIsOnline, newStatusText);
                subscribeToUserStatus(username);
            }
        })
        .catch(error => {
            console.error('❌ Ошибка получения статуса пользователя:', error);
        });

    chatHeader.style.display = 'flex';
    chatInput.style.display = 'flex';

    if (isMobile) {
        chatArea.classList.add('active');

        // ИСПРАВЛЕНИЕ ПРОБЛЕМЫ С ФОКУСОМ НА МОБИЛЬНЫХ
        // Ждем завершения анимации перехода и затем фокусируемся на input
        setTimeout(() => {
            if (messageInput) {
                messageInput.focus();

                // Дополнительная попытка фокуса через еще немного времени
                setTimeout(() => {
                    messageInput.focus();
                }, 100);
            }
        }, 450); // Ждем немного больше времени анимации (400ms)
    }

    chatMessages.innerHTML = '<div class="no-chat">Загрузка сообщений...</div>';

    if (socket && isConnected) {
        socket.emit('join-chat', chatId);
    }

    displayChatsList();
}

function getChatId(user1, user2) {
    return [user1, user2].sort().join('_');
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function sendMessage() {
    console.log('📤 sendMessage вызвана');
    const message = messageInput.value.trim();

    if (!message || !currentChat || !currentChatId) {
        console.log('⚠️ Условие не выполнено - выходим');
        return;
    }

    if (!socket || !isConnected) {
        console.log('⚠️ Socket не подключен!');
        showConnectionError('Нет соединения с сервером');
        return;
    }

    console.log('📤 Отправляем сообщение через socket');
    socket.emit('send-message', {
        chatId: currentChatId,
        message,
        from: currentUser.username,
        to: currentChat
    });

    messageInput.value = '';
    lastActivity = Date.now();
}

// Функция для форматирования времени в локальном часовом поясе пользователя
function formatLocalTime(timestamp) {
    const date = new Date(timestamp);

    // Проверяем, сегодня ли это сообщение
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        // Если сегодня, показываем только время в 24-часовом формате
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    } else {
        // Если не сегодня, показываем дату и время
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);

        if (date.toDateString() === yesterday.toDateString()) {
            // Если вчера
            return 'вчера ' + date.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } else {
            // Если раньше
            return date.toLocaleDateString([], {
                day: '2-digit',
                month: '2-digit'
            }) + ' ' + date.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }
    }
}

function displayMessage(messageData) {
    const noChat = chatMessages.querySelector('.no-chat');
    if (noChat) {
        noChat.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${messageData.from === currentUser.username ? 'own' : ''}`;

    const formattedTime = formatLocalTime(messageData.timestamp);

    messageDiv.innerHTML = `
        <div class="message-content">
            <div class="message-text">${messageData.message}</div>
            <div class="message-info">${formattedTime}</div>
        </div>
    `;

    chatMessages.appendChild(messageDiv);

    const clearDiv = document.createElement('div');
    clearDiv.style.clear = 'both';
    clearDiv.style.height = '0';
    chatMessages.appendChild(clearDiv);

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

backBtn.addEventListener('click', () => {
    if (isMobile) {
        chatArea.classList.remove('active');
        currentChat = null;
        currentChatId = null;
        chatHeader.style.display = 'none';
        chatInput.style.display = 'none';

        document.querySelectorAll('.chat-item').forEach(item => {
            item.classList.remove('active');
        });

        chatMessages.innerHTML = '<div class="no-chat">Выберите чат для начала общения</div>';
    }
});

// Обработчики для настроек
settingsBtn.addEventListener('click', () => {
    console.log('⚙️ Открываем настройки');
    showSettings();
});

settingsBackBtn.addEventListener('click', () => {
    console.log('⚙️ Закрываем настройки');
    hideSettings();
});

function showSettings() {
    // Закрываем чат если он открыт на мобильном
    if (isMobile) {
        chatArea.classList.remove('active');
        settingsArea.classList.add('active');
    } else {
        // На десктопе просто показываем настройки вместо чата
        chatArea.style.display = 'none';
        settingsArea.style.display = 'flex';
        settingsArea.classList.add('active');
    }
}

function hideSettings() {
    if (isMobile) {
        settingsArea.classList.remove('active');
    } else {
        // На десктопе скрываем настройки и показываем чат
        settingsArea.style.display = 'none';
        settingsArea.classList.remove('active');
        chatArea.style.display = 'flex';
    }
}

// Обработчик клика по категориям настроек
document.addEventListener('click', (e) => {
    const category = e.target.closest('.settings-category');
    if (category) {
        const categoryType = category.getAttribute('data-category');

        if (categoryType === 'profile') {
            showProfileSettings();
        } else if (categoryType === 'password') {
            showPasswordChangeModal();
        } else {
            console.log('🚧 Категория пока недоступна:', categoryType);
        }
    }
});

// Выход из аккаунта
logoutBtn.addEventListener('click', async () => {
    console.log('🚪 Выход из аккаунта');

    try {
        await fetch('/logout', {
            method: 'POST'
        });
    } catch (error) {
        console.error('❌ Ошибка при выходе:', error);
    }

    // Очищаем данные
    currentUser = null;
    currentChat = null;
    currentChatId = null;
    activeChats.clear();

    // Отключаем socket
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }

    // Останавливаем интервалы
    stopPing();
    stopStatusUpdates();

    // Очищаем таймеры переподключения
    if (reconnectInterval) {
        clearTimeout(reconnectInterval);
        reconnectInterval = null;
    }

    // Сбрасываем состояние
    isConnected = false;
    isReconnecting = false;
    reconnectAttempts = 0;

    // Показываем экран авторизации
    mainApp.style.display = 'none';
    authScreen.style.display = 'flex';
    hideSettings();
    hideConnectionError();

    // Очищаем поля
    usernameInput.value = '';
    passwordInput.value = '';
    displayNameInput.value = '';
    hideError();
});

profileBtn.addEventListener('click', () => {
    showProfile(currentUser.username);
});

chatProfileBtn.addEventListener('click', () => {
    if (currentChat) {
        showProfile(currentChat);
    }
});

async function showProfile(username) {
    try {
        const response = await fetch(`/profile/${username}`);
        const data = await response.json();

        if (data.success) {
            const profile = data.profile;
            const registeredDate = new Date(profile.registeredAt).toLocaleDateString();

            const avatarHtml = getProfileAvatar(profile.username, profile.avatar);

            profileInfo.innerHTML = `
                <div class="profile-header">
                    <div class="profile-avatar-container">
                        ${avatarHtml}
                        <div class="profile-avatar-status ${profile.isOnline ? 'online' : ''}"></div>
                    </div>
                    <div class="profile-details">
                        <div class="profile-name-container">
                            <div class="profile-name">${profile.displayName}</div>
                            <div class="profile-username">@${profile.username}</div>
                        </div>
                        <div class="profile-description">${profile.description || ''}</div>
                    </div>
                </div>
                <div class="profile-meta">
                    <div class="profile-registered">Дата регистрации: ${registeredDate}</div>
                </div>
            `;

            profileModal.style.display = 'flex';
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки профиля:', error);
    }
}

// Дополнительная функция для проверки поддержки File API на устройстве
function checkFileAPISupport() {
    if (!window.File || !window.FileReader || !window.FileList || !window.Blob) {
        console.warn('⚠️ File API не полностью поддерживается на этом устройстве');
        return false;
    }
    return true;
}

// Улучшенная функция показа настроек профиля с проверкой поддержки
async function showProfileSettings() {
    console.log('👤 Открываем настройки профиля');

    profileSettingsDisplayName.value = currentUser.displayName;
    profileSettingsDescription.value = currentUser.description || '';

    // Устанавливаем превью аватарки
    if (currentUser.avatar) {
        avatarPreview.src = currentUser.avatar;
        avatarPreview.classList.remove('default');
    } else {
        avatarPreview.src = '';
        avatarPreview.classList.add('default');
        avatarPreview.innerHTML = currentUser.username.charAt(0).toUpperCase();
    }

    // Проверяем поддержку File API
    if (!checkFileAPISupport()) {
        console.warn('⚠️ Загрузка файлов может работать некорректно на этом устройстве');
    }

    hideError(profileSettingsError);
    profileSettingsModal.style.display = 'flex';
}

// Функция для показа модального окна смены пароля
function showPasswordChangeModal() {
    console.log('🔐 Открываем окно смены пароля');

    // Очищаем поля
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';

    hideError(passwordChangeError);
    passwordChangeModal.style.display = 'flex';
}

// Обработчик смены пароля
changePasswordBtn.addEventListener('click', async () => {
    const current = currentPassword.value.trim();
    const newPass = newPassword.value.trim();
    const confirm = confirmPassword.value.trim();

    if (!current || !newPass || !confirm) {
        showError('Заполните все поля', passwordChangeError);
        return;
    }

    if (newPass !== confirm) {
        showError('Новые пароли не совпадают', passwordChangeError);
        return;
    }

    if (newPass.length < 6) {
        showError('Новый пароль должен содержать минимум 6 символов', passwordChangeError);
        return;
    }

    try {
        const response = await fetch('/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                currentPassword: current,
                newPassword: newPass
            })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Пароль успешно изменен!', passwordChangeError);
            setTimeout(() => {
                passwordChangeModal.style.display = 'none';
            }, 2000);
        } else {
            showError(data.message, passwordChangeError);
        }
    } catch (error) {
        showError('Ошибка подключения к серверу', passwordChangeError);
    }
});

saveProfileSettingsBtn.addEventListener('click', async () => {
    const displayName = profileSettingsDisplayName.value.trim();
    const description = profileSettingsDescription.value.trim();

    if (!displayName) {
        showError('Имя обязательно', profileSettingsError);
        return;
    }

    try {
        const response = await fetch('/update-profile', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                displayName,
                description
            })
        });

        const data = await response.json();

        if (data.success) {
            currentUser = data.user;
            currentUserSpan.textContent = currentUser.displayName;

            profileSettingsModal.style.display = 'none';
            hideError(profileSettingsError);

            console.log('✅ Профиль обновлен:', currentUser);

            // Уведомляем сервер об обновлении профиля
            if (socket && isConnected) {
                socket.emit('profile-updated', {
                    username: currentUser.username,
                    profile: currentUser
                });
            }
        } else {
            showError(data.message, profileSettingsError);
        }
    } catch (error) {
        showError('Ошибка подключения к серверу', profileSettingsError);
    }
});

// Закрытие модальных окон
closeModal.addEventListener('click', () => {
    profileModal.style.display = 'none';
});

closeProfileSettingsModal.addEventListener('click', () => {
    profileSettingsModal.style.display = 'none';
});

closePasswordChangeModal.addEventListener('click', () => {
    passwordChangeModal.style.display = 'none';
});

profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) {
        profileModal.style.display = 'none';
    }
});

profileSettingsModal.addEventListener('click', (e) => {
    if (e.target === profileSettingsModal) {
        profileSettingsModal.style.display = 'none';
    }
});

passwordChangeModal.addEventListener('click', (e) => {
    if (e.target === passwordChangeModal) {
        passwordChangeModal.style.display = 'none';
    }
});

// Обработка Enter в полях авторизации
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        if (isLoginMode) {
            passwordInput.focus();
        } else {
            displayNameInput.focus();
        }
    }
});

displayNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        passwordInput.focus();
    }
});

passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        authBtn.click();
    }
});

// Обработка Enter в полях смены пароля
currentPassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        newPassword.focus();
    }
});

newPassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        confirmPassword.focus();
    }
});

confirmPassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        changePasswordBtn.click();
    }
});

// Обработка свайпов для мобильных устройств
let startX = 0;
let startY = 0;
let isSwipeActive = false;

chatArea.addEventListener('touchstart', (e) => {
    if (!isMobile) return;

    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    isSwipeActive = true;
});

chatArea.addEventListener('touchmove', (e) => {
    if (!isMobile || !isSwipeActive) return;

    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - startX;
    const diffY = currentY - startY;

    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
        if (diffX > 0 && chatArea.classList.contains('active')) {
            backBtn.click();
        }
    }
});

chatArea.addEventListener('touchend', () => {
    isSwipeActive = false;
});

// То же самое для настроек
settingsArea.addEventListener('touchstart', (e) => {
    if (!isMobile) return;

    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    isSwipeActive = true;
});

settingsArea.addEventListener('touchmove', (e) => {
    if (!isMobile || !isSwipeActive) return;

    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - startX;
    const diffY = currentY - startY;

    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
        if (diffX > 0 && settingsArea.classList.contains('active')) {
            settingsBackBtn.click();
        }
    }
});

settingsArea.addEventListener('touchend', () => {
    isSwipeActive = false;
});

// Обработка фокуса на input для мобильных - УЛУЧШЕННАЯ ВЕРСИЯ
messageInput.addEventListener('focus', () => {
    if (isMobile) {
        // Небольшая задержка для лучшей работы на iOS
        setTimeout(() => {
            messageInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
    }
});

messageInput.addEventListener('blur', () => {
    if (isMobile) {
        setTimeout(() => {
            window.scrollTo(0, 0);
        }, 100);
    }
});

// Дополнительный обработчик для исправления проблем с фокусом на мобильных
messageInput.addEventListener('touchstart', (e) => {
    if (isMobile) {
        // Принудительно фокусируемся на input при касании
        setTimeout(() => {
            messageInput.focus();
        }, 50);
    }
});

// Автоматическое изменение высоты textarea при вводе
messageInput.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

// Предотвращение зума при фокусе на input на iOS
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
        input.addEventListener('focus', () => {
            input.style.fontSize = '16px';
        });
        input.addEventListener('blur', () => {
            input.style.fontSize = '';
        });
    });
}

// Обработка orientation change для мобильных
window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        isMobile = window.innerWidth < 768;

        if (chatMessages.children.length > 0) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        // Повторно фокусируемся на input если чат открыт
        if (isMobile && currentChat && chatArea.classList.contains('active')) {
            setTimeout(() => {
                messageInput.focus();
            }, 500);
        }
    }, 100);
});

// Инициализация PWA возможностей
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('✅ SW registered: ', registration);
            })
            .catch(registrationError => {
                console.log('❌ SW registration failed: ', registrationError);
            });
    });
}

// Обработка событий видимости страницы
document.addEventListener('visibilitychange', () => {
    if (currentUser && socket) {
        if (document.hidden) {
            console.log('👁️ Страница скрыта');
            // НЕ отключаемся при скрытии страницы  
            if (isConnected) {
                socket.emit('user-inactive');
            }
        } else {
            console.log('👁️ Страница видима');
            lastActivity = Date.now();

            if (isConnected) {
                socket.emit('user-active');
            } else if (!isReconnecting) {
                // Если не подключены и не переподключаемся, пытаемся переподключиться
                attemptReconnect();
            }
        }
    }
});

// Обработка фокуса/расфокуса окна
window.addEventListener('focus', () => {
    if (currentUser) {
        if (!isConnected && !isReconnecting) {
            console.log('🔄 Окно получило фокус, переподключаемся...');
            attemptReconnect();
        }

        if (isConnected) {
            lastActivity = Date.now();
            socket.emit('user-active');
        }
    }
});

window.addEventListener('blur', () => {
    // НЕ отключаемся при потере фокуса окна
    console.log('👁️ Окно потеряло фокус');
});

// Отправляем активность при взаимодействии пользователя
const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
let lastActivityPing = 0;

activityEvents.forEach(event => {
    document.addEventListener(event, () => {
        if (socket && isConnected && currentUser) {
            const now = Date.now();
            lastActivity = now;

            // Отправляем ping только раз в 10 секунд
            if (now - lastActivityPing > 10000) {
                socket.emit('user-active');
                lastActivityPing = now;
            }
        }
    }, { passive: true });
});

// Обработка перед закрытием страницы
window.addEventListener('beforeunload', () => {
    stopPing();
    stopStatusUpdates();

    if (reconnectInterval) {
        clearTimeout(reconnectInterval);
    }

    if (socket && isConnected && currentUser) {
        socket.emit('user-offline');
        socket.disconnect();
    }
});

function updateUserStatus(username, isOnline, lastSeenText) {
    console.log(`📊 Обновляем статус для ${username}: ${isOnline ? 'онлайн' : 'оффлайн'}, ${lastSeenText}`);

    // Обновляем в списке чатов
    for (const [chatId, chat] of activeChats) {
        if (chat.username === username) {
            const oldStatus = chat.isOnline;
            chat.isOnline = isOnline;
            chat.lastSeenText = lastSeenText;
            activeChats.set(chatId, chat);

            if (oldStatus !== isOnline) {
                console.log(`📊 Статус ${username} изменился: ${oldStatus ? 'онлайн' : 'оффлайн'} -> ${isOnline ? 'онлайн' : 'оффлайн'}`);
            }
        }
    }

    // Обновляем отображение в списке чатов
    const chatItems = document.querySelectorAll('.chat-item');
    chatItems.forEach(item => {
        const usernameElement = item.querySelector('.username');
        if (usernameElement && usernameElement.textContent === `@${username}`) {
            const statusElement = item.querySelector('.avatar-status-indicator');

            if (statusElement) {
                statusElement.className = `avatar-status-indicator ${isOnline ? 'online' : ''}`;
            }
        }
    });

    // Обновляем статус в заголовке чата, если это текущий собеседник
    if (currentChat === username) {
        const displayName = chatTitle.querySelector('div') ? chatTitle.querySelector('div').textContent : username;

        chatTitle.innerHTML = `
            <div>${displayName}</div>
            <div style="font-size: 12px; color: #95A5A6; font-weight: 400; margin-top: 2px;">${lastSeenText}</div>
        `;

        // Обновляем индикатор статуса на аватарке в заголовке чата
        updateChatAvatarStatus(isOnline);
    }

    // Обновляем в результатах поиска, если поиск активен
    if (userSearch.value.trim() !== '') {
        const searchItems = document.querySelectorAll('.chat-item');
        searchItems.forEach(item => {
            const usernameElement = item.querySelector('.username');
            if (usernameElement && usernameElement.textContent === `@${username}`) {
                const statusElement = item.querySelector('.avatar-status-indicator');

                if (statusElement) {
                    statusElement.className = `avatar-status-indicator ${isOnline ? 'online' : ''}`;
                }
            }
        });
    }
}

// Дополнительные улучшения для стабильности соединения
window.addEventListener('online', () => {
    console.log('🌐 Сеть восстановлена');
    hideConnectionError();
    if (currentUser && !isConnected && !isReconnecting) {
        attemptReconnect();
    }
});

window.addEventListener('offline', () => {
    console.log('🌐 Сеть потеряна');
    showConnectionError('Нет подключения к интернету');
});

// Функция для проверки состояния соединения и автоматического переподключения
function checkConnectionHealth() {
    if (!currentUser) return;

    if (!isConnected && !isReconnecting) {
        console.log('🔍 Обнаружена потеря соединения, начинаем переподключение...');
        attemptReconnect();
    } else if (isConnected) {
        // Просто отправляем ping если соединение активно
        socket.emit('ping');
        lastActivity = Date.now();
    }
}

// Запускаем проверку здоровья соединения каждые 30 секунд
setInterval(checkConnectionHealth, 30000);

// Обработка потери соединения с автоматическим восстановлением
let connectionLostTime = null;

function handleSocketDisconnect(reason) {
    connectionLostTime = Date.now();
    console.log('🔴 Соединение потеряно в:', new Date(connectionLostTime));
}

function handleSocketConnect() {
    if (connectionLostTime) {
        const reconnectTime = Date.now() - connectionLostTime;
        console.log(`✅ Соединение восстановлено через ${Math.round(reconnectTime / 1000)} секунд`);
        connectionLostTime = null;

        if (currentUser) {
            socket.emit('user-online', currentUser.username);
            subscribeToUserStatuses();

            setTimeout(() => {
                loadUserChats();
                updateAllUserStatuses();

                if (currentChatId) {
                    socket.emit('join-chat', currentChatId);
                }
            }, 1000);
        }
    }
}
