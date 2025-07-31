console.log(`🚀 Запускаем основной сервер...`);

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ==================== SUPABASE CONFIGURATION ====================

const supabaseUrl = process.env.Cloud_Url;
const supabaseKey = process.env.Cloud_Key;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Отсутствуют секреты Supabase: Cloud_Url и Cloud_Key');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Настройка multer для обработки загрузки файлов
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB максимум
    },
    fileFilter: (req, file, cb) => {
        // Проверяем тип файла
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Только изображения разрешены!'), false);
        }
    }
});

// ==================== КРИПТОГРАФИЧЕСКИЕ ФУНКЦИИ ====================

// Генерация соли для хеширования паролей
function generateSalt() {
    return crypto.randomBytes(32).toString('hex');
}

// Хеширование пароля с солью
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// Проверка пароля
function verifyPassword(password, hash, salt) {
    const hashToVerify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return hashToVerify === hash;
}

// Генерация ключа шифрования для чата (32 байта для AES-256)
function generateChatKey() {
    return crypto.randomBytes(32).toString('hex');
}

// Генерация IV для AES
function generateIV() {
    return crypto.randomBytes(16);
}

// Шифрование сообщения
function encryptMessage(message, key) {
    try {
        const iv = generateIV();
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
        let encrypted = cipher.update(message, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
        console.error('❌ Ошибка шифрования сообщения:', error);
        return message; // Возвращаем исходное сообщение при ошибке
    }
}

// Расшифровка сообщения
function decryptMessage(encryptedMessage, key) {
    try {
        if (!encryptedMessage.includes(':')) {
            // Сообщение не зашифровано (для совместимости)
            return encryptedMessage;
        }

        const parts = encryptedMessage.split(':');
        if (parts.length !== 2) {
            return encryptedMessage;
        }

        const iv = Buffer.from(parts[0], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
        let decrypted = decipher.update(parts[1], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('❌ Ошибка расшифровки сообщения:', error);
        return encryptedMessage; // Возвращаем зашифрованное сообщение при ошибке
    }
}

// Создание ID чата (теперь используем user_id)
function createChatId(userId1, userId2) {
    const users = [userId1, userId2].sort((a, b) => a - b);
    return users.join('_');
}

// ==================== ФУНКЦИИ ДЛЯ РАБОТЫ С АВАТАРКАМИ ====================

// Функция для генерации уникального имени файла
function generateAvatarFileName(userId, originalExtension) {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(6).toString('hex');
    return `avatars/user_${userId}_${timestamp}_${randomString}.${originalExtension}`;
}

// Функция для загрузки аватарки в Supabase Storage
async function uploadAvatarToSupabase(fileBuffer, fileName, mimeType) {
    try {
        console.log(`📤 Загружаем аватарку в Supabase: ${fileName}`);

        const { data, error } = await supabase.storage
            .from('avatars')
            .upload(fileName, fileBuffer, {
                contentType: mimeType,
                upsert: true
            });

        if (error) {
            console.error('❌ Ошибка загрузки в Supabase Storage:', error);
            return null;
        }

        // Получаем публичный URL файла
        const { data: publicData } = supabase.storage
            .from('avatars')
            .getPublicUrl(fileName);

        console.log(`✅ Аватарка загружена: ${publicData.publicUrl}`);
        return publicData.publicUrl;
    } catch (error) {
        console.error('❌ Ошибка при загрузке аватарки:', error);
        return null;
    }
}

// Функция для удаления старой аватарки из Supabase Storage
async function deleteOldAvatarFromSupabase(avatarUrl) {
    if (!avatarUrl) return;

    try {
        // Извлекаем имя файла из URL
        const urlParts = avatarUrl.split('/');
        const fileName = urlParts[urlParts.length - 1];

        if (fileName && fileName.includes('_')) {
            const fullPath = `avatars/${fileName}`;

            const { error } = await supabase.storage
                .from('avatars')
                .remove([fullPath]);

            if (error) {
                console.error('❌ Ошибка удаления старой аватарки:', error);
            } else {
                console.log(`🗑️ Старая аватарка удалена: ${fullPath}`);
            }
        }
    } catch (error) {
        console.error('❌ Ошибка при удалении старой аватарки:', error);
    }
}

// ==================== ПОДКЛЮЧЕНИЕ К БД ====================

const pool = new Pool({
    connectionString: process.env.DataStoreKey,
    ssl: {
        rejectUnauthorized: false
    }
});

// Инициализация таблиц в базе данных
async function initDatabase() {
    try {
        console.log('🔄 Инициализация базы данных...');

        // Таблица пользователей с user_id как PRIMARY KEY
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                password_salt VARCHAR(64) NOT NULL,
                display_name VARCHAR(100) NOT NULL,
                description TEXT DEFAULT '',
                avatar_url TEXT DEFAULT '',
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Добавляем user_id если его нет (для миграции)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'users' AND column_name = 'user_id'
                ) THEN
                    ALTER TABLE users ADD COLUMN user_id SERIAL PRIMARY KEY;
                END IF;
            END $$
        `);

        // Таблица сессий (теперь с user_id)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                ip VARCHAR(45) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                session_token VARCHAR(100) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
        `);

        // Таблица чатов с user_id
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                chat_id VARCHAR(100) PRIMARY KEY,
                user1_id INTEGER NOT NULL,
                user2_id INTEGER NOT NULL,
                encryption_key VARCHAR(64) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user1_id) REFERENCES users(user_id) ON DELETE CASCADE,
                FOREIGN KEY (user2_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
        `);

        // Таблица сообщений с user_id
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chat_id VARCHAR(100) NOT NULL,
                from_user_id INTEGER NOT NULL,
                encrypted_message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
                FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
        `);

        // Индексы для оптимизации
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);

        // Миграция существующих данных
        await migrateToUserIdSystem();

        console.log('✅ База данных успешно инициализирована с системой user_id');
    } catch (error) {
        console.error('❌ Ошибка инициализации базы данных:', error);
        process.exit(1);
    }
}

// Миграция к системе user_id
async function migrateToUserIdSystem() {
    try {
        console.log('🔄 Выполняем миграцию к системе user_id...');

        // Проверяем, нужна ли миграция user_sessions
        const sessionColumns = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'user_sessions' AND column_name = 'username'
        `);

        if (sessionColumns.rows.length > 0) {
            console.log('🔄 Мигрируем user_sessions...');

            // Добавляем новый столбец user_id
            await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS user_id INTEGER`);

            // Заполняем user_id на основе username
            await pool.query(`
                UPDATE user_sessions 
                SET user_id = (SELECT user_id FROM users WHERE users.username = user_sessions.username)
                WHERE user_id IS NULL
            `);

            // Удаляем старые записи без соответствующих пользователей
            await pool.query(`DELETE FROM user_sessions WHERE user_id IS NULL`);

            // Добавляем NOT NULL constraint
            await pool.query(`ALTER TABLE user_sessions ALTER COLUMN user_id SET NOT NULL`);

            // Добавляем внешний ключ
            await pool.query(`
                ALTER TABLE user_sessions 
                ADD CONSTRAINT fk_user_sessions_user_id 
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            `);

            // Удаляем старый столбец username
            await pool.query(`ALTER TABLE user_sessions DROP COLUMN IF EXISTS username`);

            console.log('✅ Миграция user_sessions завершена');
        }

        // Проверяем, нужна ли миграция chats
        const chatColumns = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'chats' AND column_name = 'user1'
        `);

        if (chatColumns.rows.length > 0) {
            console.log('🔄 Мигрируем chats...');

            // Добавляем новые столбцы
            await pool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS user1_id INTEGER`);
            await pool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS user2_id INTEGER`);

            // Заполняем user_id на основе username
            await pool.query(`
                UPDATE chats 
                SET user1_id = (SELECT user_id FROM users WHERE users.username = chats.user1),
                    user2_id = (SELECT user_id FROM users WHERE users.username = chats.user2)
                WHERE user1_id IS NULL OR user2_id IS NULL
            `);

            // Обновляем chat_id на основе user_id
            await pool.query(`
                UPDATE chats 
                SET chat_id = LEAST(user1_id, user2_id)::text || '_' || GREATEST(user1_id, user2_id)::text
                WHERE user1_id IS NOT NULL AND user2_id IS NOT NULL
            `);

            // Удаляем записи без соответствующих пользователей
            await pool.query(`DELETE FROM chats WHERE user1_id IS NULL OR user2_id IS NULL`);

            // Добавляем NOT NULL constraints и внешние ключи
            await pool.query(`ALTER TABLE chats ALTER COLUMN user1_id SET NOT NULL`);
            await pool.query(`ALTER TABLE chats ALTER COLUMN user2_id SET NOT NULL`);

            await pool.query(`
                ALTER TABLE chats 
                ADD CONSTRAINT fk_chats_user1_id 
                FOREIGN KEY (user1_id) REFERENCES users(user_id) ON DELETE CASCADE
            `);
            await pool.query(`
                ALTER TABLE chats 
                ADD CONSTRAINT fk_chats_user2_id 
                FOREIGN KEY (user2_id) REFERENCES users(user_id) ON DELETE CASCADE
            `);

            // Удаляем старые столбцы
            await pool.query(`ALTER TABLE chats DROP COLUMN IF EXISTS user1`);
            await pool.query(`ALTER TABLE chats DROP COLUMN IF EXISTS user2`);

            console.log('✅ Миграция chats завершена');
        }

        // Проверяем, нужна ли миграция messages
        const messageColumns = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'messages' AND column_name = 'from_user'
        `);

        if (messageColumns.rows.length > 0) {
            console.log('🔄 Мигрируем messages...');

            // Добавляем новый столбец
            await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_user_id INTEGER`);

            // Заполняем user_id на основе username
            await pool.query(`
                UPDATE messages 
                SET from_user_id = (SELECT user_id FROM users WHERE users.username = messages.from_user)
                WHERE from_user_id IS NULL
            `);

            // Удаляем записи без соответствующих пользователей
            await pool.query(`DELETE FROM messages WHERE from_user_id IS NULL`);

            // Добавляем NOT NULL constraint и внешний ключ
            await pool.query(`ALTER TABLE messages ALTER COLUMN from_user_id SET NOT NULL`);

            await pool.query(`
                ALTER TABLE messages 
                ADD CONSTRAINT fk_messages_from_user_id 
                FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE CASCADE
            `);

            // Удаляем старый столбец
            await pool.query(`ALTER TABLE messages DROP COLUMN IF EXISTS from_user`);

            console.log('✅ Миграция messages завершена');
        }

        console.log('✅ Миграция к системе user_id завершена успешно');
    } catch (error) {
        console.error('❌ Ошибка миграции к системе user_id:', error);
        // Не останавливаем сервер, продолжаем работу
    }
}

// Временное хранилище для онлайн пользователей (теперь по user_id)
const onlineUsersByIP = new Map();
const userSockets = new Map(); // теперь ключ - user_id
const connectedSockets = new Map();
const chatKeys = new Map(); // Кеш ключей шифрования чатов

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Функция для нормализации username
function normalizeUsername(username) {
    return username.startsWith('@') ? username.substring(1) : username;
}

// Функция для получения IP адреса клиента
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

// Функция для генерации токена сессии
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Функция для создания сессии (теперь с user_id)
async function createSession(ip, userId) {
    try {
        const sessionToken = generateSessionToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 дней

        await pool.query(
            'INSERT INTO user_sessions (ip, user_id, session_token, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (ip) DO UPDATE SET user_id = $2, session_token = $3, expires_at = $4, created_at = CURRENT_TIMESTAMP',
            [ip, userId, sessionToken, expiresAt]
        );

        console.log(`🔐 Создана сессия для user_id ${userId} (IP: ${ip}), истекает: ${expiresAt.toLocaleString('ru-RU')}`);
        return sessionToken;
    } catch (error) {
        console.error('❌ Ошибка создания сессии:', error);
        return null;
    }
}

// Функция для проверки сессии (теперь возвращает user_id)
async function checkSession(ip) {
    try {
        const result = await pool.query(
            'SELECT us.user_id, us.expires_at, u.username, u.display_name, u.description, u.registered_at, u.avatar_url FROM user_sessions us JOIN users u ON us.user_id = u.user_id WHERE us.ip = $1',
            [ip]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const session = result.rows[0];

        if (new Date() > new Date(session.expires_at)) {
            console.log(`⏰ Сессия истекла для IP: ${ip}`);
            await pool.query('DELETE FROM user_sessions WHERE ip = $1', [ip]);
            return null;
        }

        console.log(`✅ Валидная сессия найдена для user_id ${session.user_id} (IP: ${ip})`);
        return {
            userId: session.user_id,
            username: session.username,
            displayName: session.display_name,
            description: session.description,
            registeredAt: session.registered_at,
            avatar: session.avatar_url
        };
    } catch (error) {
        console.error('❌ Ошибка проверки сессии:', error);
        return null;
    }
}

// Функция для удаления сессии
async function removeSession(ip) {
    try {
        const result = await pool.query('DELETE FROM user_sessions WHERE ip = $1 RETURNING user_id', [ip]);
        if (result.rows.length > 0) {
            console.log(`🗑️ Удаляем сессию для user_id ${result.rows[0].user_id} (IP: ${ip})`);
        }
    } catch (error) {
        console.error('❌ Ошибка удаления сессии:', error);
    }
}

// ИСПРАВЛЕННАЯ функция для получения ключа шифрования чата
async function getChatEncryptionKey(chatId) {
    // Проверяем кеш
    if (chatKeys.has(chatId)) {
        console.log(`🔑 Ключ шифрования найден в кеше для чата: ${chatId}`);
        return chatKeys.get(chatId);
    }

    try {
        const result = await pool.query('SELECT encryption_key FROM chats WHERE chat_id = $1', [chatId]);

        if (result.rows.length > 0 && result.rows[0].encryption_key) {
            const key = result.rows[0].encryption_key;
            chatKeys.set(chatId, key); // Кешируем ключ
            console.log(`🔑 Ключ шифрования найден в БД для чата: ${chatId}`);
            return key;
        }

        console.log(`⚠️ Ключ шифрования не найден для чата: ${chatId}`);
        return null;
    } catch (error) {
        console.error('❌ Ошибка получения ключа шифрования чата:', error);
        return null;
    }
}

// Функция для форматирования времени "был в сети" с учетом UTC
function formatLastSeen(lastSeenTime) {
    if (!lastSeenTime) return 'Давно не был(а) в сети';

    const now = new Date();
    const lastSeen = new Date(lastSeenTime);
    const diffMs = now - lastSeen;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffMinutes < 1) {
        return 'Только что был(а) в сети';
    }

    if (diffMinutes < 60) {
        return `Был(а) в сети ${diffMinutes} мин. назад`;
    }

    if (diffHours < 24) {
        return `Был(а) в сети сегодня`;
    }

    if (diffDays === 1) {
        return `Был(а) в сети вчера`;
    }

    if (diffDays < 7) {
        return `Был(а) в сети ${diffDays} дн. назад`;
    }

    if (diffWeeks < 4) {
        return diffWeeks === 1 ? 'Был(а) в сети неделю назад' : `Был(а) в сети ${diffWeeks} нед. назад`;
    }

    if (diffMonths < 12) {
        return diffMonths === 1 ? 'Был(а) в сети месяц назад' : `Был(а) в сети ${diffMonths} мес. назад`;
    }

    if (diffYears >= 1) {
        return diffYears === 1 ? 'Был(а) в сети год назад' : `Был(а) в сети ${diffYears} лет назад`;
    }

    return `Был(а) в сети давно`;
}

// Функция для проверки онлайн статуса пользователя (теперь по user_id)
function isUserOnline(userId) {
    for (const [ip, data] of onlineUsersByIP) {
        if (data.userId === userId) {
            const timeSinceLastActivity = Date.now() - data.lastActivity;
            return timeSinceLastActivity < 120000; // 2 минуты
        }
    }
    return false;
}

// Функция для получения статуса пользователя (теперь по user_id)
async function getUserStatus(userId) {
    const isOnline = isUserOnline(userId);
    if (isOnline) {
        return { isOnline: true, lastSeenText: 'В сети' };
    }

    try {
        const result = await pool.query('SELECT last_seen FROM users WHERE user_id = $1', [userId]);
        const lastSeen = result.rows.length > 0 ? result.rows[0].last_seen : null;
        const lastSeenText = formatLastSeen(lastSeen);
        return { isOnline: false, lastSeenText };
    } catch (error) {
        console.error('❌ Ошибка получения статуса пользователя:', error);
        return { isOnline: false, lastSeenText: 'Давно не был(а) в сети' };
    }
}

// Функция для обновления активности пользователя
function updateUserActivity(userId, socketId, ip) {
    if (onlineUsersByIP.has(ip)) {
        onlineUsersByIP.get(ip).lastActivity = Date.now();
    }

    if (connectedSockets.has(socketId)) {
        connectedSockets.get(socketId).lastPing = Date.now();
    }
}

// ==================== API ЭНДПОИНТЫ ====================

// Health check endpoint
app.get('/health', async (req, res) => {
    const uptime = Math.floor(process.uptime());
    const memoryUsage = process.memoryUsage();
    const activeConnections = connectedSockets.size;
    const onlineUsers = onlineUsersByIP.size;

    res.json({
        status: 'OK',
        uptime: uptime,
        timestamp: new Date().toISOString(),
        memory: {
            used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
        },
        connections: {
            sockets: activeConnections,
            users: onlineUsers
        }
    });
});

// Статистика сервера
app.get('/stats', async (req, res) => {
    try {
        const userCount = await pool.query('SELECT COUNT(*) as count FROM users');
        const messageCount = await pool.query('SELECT COUNT(*) as count FROM messages');
        const chatCount = await pool.query('SELECT COUNT(*) as count FROM chats');
        const activeSessionsCount = await pool.query('SELECT COUNT(*) as count FROM user_sessions WHERE expires_at > CURRENT_TIMESTAMP');

        res.json({
            server: {
                uptime: Math.floor(process.uptime()),
                active_connections: connectedSockets.size,
                online_users: onlineUsersByIP.size
            },
            database: {
                total_users: parseInt(userCount.rows[0].count),
                total_messages: parseInt(messageCount.rows[0].count),
                total_chats: parseInt(chatCount.rows[0].count),
                active_sessions: parseInt(activeSessionsCount.rows[0].count)
            },
            memory: process.memoryUsage()
        });
    } catch (error) {
        console.error('❌ Ошибка получения статистики:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/check-session', async (req, res) => {
    const clientIP = getClientIP(req);
    const user = await checkSession(clientIP);

    if (user) {
        res.json({ success: true, user });
    } else {
        res.json({ success: false });
    }
});

// Эндпоинт для загрузки аватарки
app.post('/upload-avatar', upload.single('avatar'), async (req, res) => {
    const clientIP = getClientIP(req);

    try {
        // Проверяем сессию пользователя
        const result = await pool.query('SELECT user_id FROM user_sessions WHERE ip = $1 AND expires_at > CURRENT_TIMESTAMP', [clientIP]);
        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Сессия истекла' });
        }

        const userId = result.rows[0].user_id;

        if (!req.file) {
            return res.json({ success: false, message: 'Файл не выбран' });
        }

        // Получаем расширение файла
        const originalName = req.file.originalname;
        const extension = originalName.split('.').pop().toLowerCase();

        // Проверяем поддерживаемые форматы
        const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        if (!allowedExtensions.includes(extension)) {
            return res.json({ success: false, message: 'Неподдерживаемый формат файла' });
        }

        // Получаем текущую аватарку пользователя для удаления
        const currentAvatarResult = await pool.query('SELECT avatar_url FROM users WHERE user_id = $1', [userId]);
        const currentAvatarUrl = currentAvatarResult.rows.length > 0 ? currentAvatarResult.rows[0].avatar_url : null;

        // Генерируем уникальное имя файла
        const fileName = generateAvatarFileName(userId, extension);

        // Загружаем новую аватарку в Supabase
        const avatarUrl = await uploadAvatarToSupabase(req.file.buffer, fileName, req.file.mimetype);

        if (!avatarUrl) {
            return res.json({ success: false, message: 'Ошибка загрузки файла в облако' });
        }

        // Обновляем URL аватарки в базе данных
        await pool.query('UPDATE users SET avatar_url = $1 WHERE user_id = $2', [avatarUrl, userId]);

        // Удаляем старую аватарку из Supabase (если была)
        if (currentAvatarUrl && currentAvatarUrl !== avatarUrl) {
            await deleteOldAvatarFromSupabase(currentAvatarUrl);
        }

        console.log(`🖼️ Аватарка обновлена для пользователя: user_id ${userId}`);

        res.json({ 
            success: true, 
            avatarPath: avatarUrl,
            message: 'Аватарка успешно загружена'
        });

    } catch (error) {
        console.error('❌ Ошибка загрузки аватарки:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

app.post('/logout', async (req, res) => {
    const clientIP = getClientIP(req);

    try {
        const result = await pool.query('SELECT us.user_id, u.username FROM user_sessions us JOIN users u ON us.user_id = u.user_id WHERE us.ip = $1', [clientIP]);

        if (result.rows.length > 0) {
            const { user_id: userId, username } = result.rows[0];

            await removeSession(clientIP);
            await pool.query('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE user_id = $1', [userId]);

            onlineUsersByIP.delete(clientIP);
            userSockets.delete(userId);

            const socketData = userSockets.get(userId);
            if (socketData) {
                const socket = io.sockets.sockets.get(socketData.socketId);
                if (socket) {
                    socket.disconnect(true);
                }
                connectedSockets.delete(socketData.socketId);
            }

            console.log(`🚪 Пользователь вышел: ${username} (user_id: ${userId}, IP: ${clientIP})`);

            const status = await getUserStatus(userId);
            io.emit('user-status-changed', { 
                userId,
                username, 
                isOnline: false,
                lastSeenText: status.lastSeenText 
            });
        }
    } catch (error) {
        console.error('❌ Ошибка выхода пользователя:', error);
    }

    res.json({ success: true });
});

app.post('/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const clientIP = getClientIP(req);

    if (!currentPassword || !newPassword) {
        return res.json({ success: false, message: 'Заполните все поля' });
    }

    if (newPassword.length < 6) {
        return res.json({ success: false, message: 'Новый пароль должен содержать минимум 6 символов' });
    }

    try {
        const result = await pool.query('SELECT user_id FROM user_sessions WHERE ip = $1 AND expires_at > CURRENT_TIMESTAMP', [clientIP]);
        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Сессия истекла' });
        }

        const userId = result.rows[0].user_id;

        const userResult = await pool.query('SELECT password_hash, password_salt FROM users WHERE user_id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: 'Пользователь не найден' });
        }

        const { password_hash, password_salt } = userResult.rows[0];

        // Проверяем текущий пароль
        if (!verifyPassword(currentPassword, password_hash, password_salt)) {
            return res.json({ success: false, message: 'Неверный текущий пароль' });
        }

        // Создаем новый хеш пароля
        const newSalt = generateSalt();
        const newHashedPassword = hashPassword(newPassword, newSalt);

        await pool.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE user_id = $3', [newHashedPassword, newSalt, userId]);

        console.log(`🔐 Пароль изменен для пользователя: user_id ${userId} (IP: ${clientIP})`);
        res.json({ success: true, message: 'Пароль успешно изменен' });
    } catch (error) {
        console.error('❌ Ошибка смены пароля:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

app.post('/register', async (req, res) => {
    let { username, password, displayName } = req.body;

    if (!username || !password || !displayName) {
        return res.json({ success: false, message: 'Заполните все поля' });
    }

    username = normalizeUsername(username);

    try {
        const existingUser = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
        if (existingUser.rows.length > 0) {
            return res.json({ success: false, message: 'Пользователь уже существует' });
        }

        // Создаем зашифрованный пароль
        const salt = generateSalt();
        const hashedPassword = hashPassword(password, salt);

        // Получаем следующий user_id
        const nextIdResult = await pool.query('SELECT COALESCE(MAX(user_id), 0) + 1 as next_id FROM users');
        const nextId = nextIdResult.rows[0].next_id;

        // Загружаем дефолтную аватарку в Supabase
        let defaultAvatarUrl = '';
        try {
            const fs = require('fs');
            const path = require('path');

            const defaultAvatarPath = path.join(__dirname, 'user-icon.png');

            if (fs.existsSync(defaultAvatarPath)) {
                const fileBuffer = fs.readFileSync(defaultAvatarPath);
                const fileName = `avatars/default_user_${nextId}_${Date.now()}.png`;

                console.log(`📤 Загружаем дефолтную аватарку для user_id ${nextId}`);

                const { data, error } = await supabase.storage
                    .from('avatars')
                    .upload(fileName, fileBuffer, {
                        contentType: 'image/png',
                        upsert: false
                    });

                if (!error) {
                    const { data: publicData } = supabase.storage
                        .from('avatars')
                        .getPublicUrl(fileName);

                    defaultAvatarUrl = publicData.publicUrl;
                    console.log(`✅ Дефолтная аватарка загружена: ${defaultAvatarUrl}`);
                } else {
                    console.error('❌ Ошибка загрузки дефолтной аватарки:', error);
                }
            } else {
                console.warn(`⚠️ Файл user-icon.png не найден в корне проекта`);
            }
        } catch (avatarError) {
            console.error('❌ Ошибка при загрузке дефолтной аватарки:', avatarError);
        }

        // Регистрируем пользователя с дефолтной аватаркой
        const insertResult = await pool.query(
            'INSERT INTO users (username, password_hash, password_salt, display_name, avatar_url) VALUES ($1, $2, $3, $4, $5) RETURNING user_id',
            [username, hashedPassword, salt, displayName, defaultAvatarUrl]
        );

        const userId = insertResult.rows[0].user_id;

        console.log(`✅ Новый пользователь зарегистрирован: ${username} (user_id: ${userId}, IP: ${getClientIP(req)}) с дефолтной аватаркой`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

app.post('/login', async (req, res) => {
    let { username, password } = req.body;
    const clientIP = getClientIP(req);

    username = normalizeUsername(username);

    try {
        const result = await pool.query(
            'SELECT user_id, username, password_hash, password_salt, display_name, description, registered_at, avatar_url FROM users WHERE username = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Пользователь не найден' });
        }

        const user = result.rows[0];

        // Проверяем пароль с использованием хеширования
        if (!verifyPassword(password, user.password_hash, user.password_salt)) {
            return res.json({ success: false, message: 'Неверный пароль' });
        }

        await pool.query('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE user_id = $1', [user.user_id]);
        await createSession(clientIP, user.user_id);

        console.log(`✅ Пользователь вошел: ${username} (user_id: ${user.user_id}, IP: ${clientIP})`);
        res.json({ 
            success: true, 
            user: {
                userId: user.user_id,
                username: user.username,
                displayName: user.display_name,
                description: user.description,
                registeredAt: user.registered_at,
                avatar: user.avatar_url
            }
        });
    } catch (error) {
        console.error('❌ Ошибка входа:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

app.post('/search-users', async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.json([]);
    }

    try {
        const searchQuery = `%${query.toLowerCase()}%`;
        const result = await pool.query(
            'SELECT user_id, username, display_name, description, last_seen, avatar_url FROM users WHERE LOWER(username) LIKE $1 OR LOWER(display_name) LIKE $1 ORDER BY username',
            [searchQuery]
        );

        const results = [];
        for (const user of result.rows) {
            const status = await getUserStatus(user.user_id);
            results.push({
                userId: user.user_id,
                username: user.username,
                displayName: user.display_name,
                description: user.description,
                isOnline: status.isOnline,
                lastSeen: status.isOnline ? null : user.last_seen,
                lastSeenText: status.lastSeenText,
                avatar: user.avatar_url
            });
        }

        res.json(results);
    } catch (error) {
        console.error('❌ Ошибка поиска пользователей:', error);
        res.json([]);
    }
});

app.post('/users-status', async (req, res) => {
    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds)) {
        return res.json({ success: false, message: 'Некорректный запрос' });
    }

    try {
        const results = [];
        for (const userId of userIds) {
            const userResult = await pool.query('SELECT username, last_seen FROM users WHERE user_id = $1', [userId]);
            if (userResult.rows.length > 0) {
                const status = await getUserStatus(userId);
                results.push({
                    userId: userId,
                    username: userResult.rows[0].username,
                    isOnline: status.isOnline,
                    lastSeenText: status.lastSeenText,
                    lastSeen: status.isOnline ? null : userResult.rows[0].last_seen
                });
            }
        }

        res.json({ success: true, users: results });
    } catch (error) {
        console.error('❌ Ошибка получения статусов пользователей:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

app.get('/user-chats/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const userCheck = await pool.query('SELECT user_id FROM users WHERE user_id = $1', [userId]);
        if (userCheck.rows.length === 0) {
            return res.json({ success: false, message: 'Пользователь не найден' });
        }

        // Получаем все чаты пользователя с зашифрованными сообщениями
        const result = await pool.query(`
            SELECT 
                c.chat_id,
                c.encryption_key,
                CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END as other_user_id,
                u.username as other_username,
                u.display_name,
                u.description,
                u.last_seen,
                u.avatar_url,
                (
                    SELECT json_build_object(
                        'text', m.encrypted_message,
                        'timestamp', m.timestamp,
                        'from_user_id', m.from_user_id
                    )
                    FROM messages m 
                    WHERE m.chat_id = c.chat_id 
                    ORDER BY m.timestamp DESC 
                    LIMIT 1
                ) as last_message,
                (
                    SELECT m.timestamp 
                    FROM messages m 
                    WHERE m.chat_id = c.chat_id 
                    ORDER BY m.timestamp DESC 
                    LIMIT 1
                ) as last_message_time
            FROM chats c
            JOIN users u ON (CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END) = u.user_id
            WHERE c.user1_id = $1 OR c.user2_id = $1
            ORDER BY last_message_time DESC NULLS LAST
        `, [userId]);

        const chats = [];
        for (const row of result.rows) {
            const status = await getUserStatus(row.other_user_id);

            // Расшифровываем последнее сообщение если оно есть
            let lastMessage = row.last_message;
            if (lastMessage && lastMessage.text && row.encryption_key) {
                const decryptedText = decryptMessage(lastMessage.text, row.encryption_key);
                lastMessage = {
                    ...lastMessage,
                    text: decryptedText
                };
            }

            chats.push({
                userId: row.other_user_id,
                username: row.other_username,
                displayName: row.display_name,
                description: row.description,
                isOnline: status.isOnline,
                lastSeen: status.isOnline ? null : row.last_seen,
                lastSeenText: status.lastSeenText,
                lastMessage: lastMessage,
                chatId: row.chat_id,
                avatar: row.avatar_url
            });
        }

        res.json({ success: true, chats });
    } catch (error) {
        console.error('❌ Ошибка получения чатов:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

app.get('/profile/:identifier', async (req, res) => {
    const { identifier } = req.params;

    try {
        let result;

        // Проверяем, является ли identifier числом (user_id) или строкой (username)
        if (/^\d+$/.test(identifier)) {
            // Это user_id
            result = await pool.query(
                'SELECT user_id, username, display_name, description, registered_at, last_seen, avatar_url FROM users WHERE user_id = $1',
                [parseInt(identifier)]
            );
        } else {
            // Это username
            const normalizedUsername = normalizeUsername(identifier);
            result = await pool.query(
                'SELECT user_id, username, display_name, description, registered_at, last_seen, avatar_url FROM users WHERE username = $1',
                [normalizedUsername]
            );
        }

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Пользователь не найден' });
        }

        const user = result.rows[0];
        const status = await getUserStatus(user.user_id);

        res.json({
            success: true,
            profile: {
                userId: user.user_id,
                username: user.username,
                displayName: user.display_name,
                description: user.description,
                registeredAt: user.registered_at,
                isOnline: status.isOnline,
                lastSeen: status.isOnline ? null : user.last_seen,
                lastSeenText: status.lastSeenText,
                avatar: user.avatar_url
            }
        });
    } catch (error) {
        console.error('❌ Ошибка получения профиля:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

// Обновленная функция обновления профиля с возможностью изменения username
app.post('/update-profile', async (req, res) => {
    const { username, displayName, description } = req.body;
    const clientIP = getClientIP(req);

    if (!displayName) {
        return res.json({ success: false, message: 'Отображаемое имя не может быть пустым' });
    }

    try {
        // Получаем user_id из сессии
        const sessionResult = await pool.query('SELECT user_id FROM user_sessions WHERE ip = $1 AND expires_at > CURRENT_TIMESTAMP', [clientIP]);
        if (sessionResult.rows.length === 0) {
            return res.json({ success: false, message: 'Сессия истекла' });
        }

        const userId = sessionResult.rows[0].user_id;

        // Получаем текущие данные пользователя
        const userResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: 'Пользователь не найден' });
        }

        const oldUsername = userResult.rows[0].username;
        let newUsername = oldUsername;

        // Если передан новый username, проверяем его доступность
        if (username && normalizeUsername(username) !== oldUsername) {
            newUsername = normalizeUsername(username);

            // Проверяем, не занят ли новый username
            const existingUser = await pool.query('SELECT user_id FROM users WHERE username = $1 AND user_id != $2', [newUsername, userId]);
            if (existingUser.rows.length > 0) {
                return res.json({ success: false, message: 'Это имя пользователя уже занято' });
            }
        }

        // Обновляем профиль
        await pool.query(
            'UPDATE users SET username = $1, display_name = $2, description = $3 WHERE user_id = $4', 
            [newUsername, displayName, description || '', userId]
        );

        console.log(`✏️ Пользователь обновил профиль: user_id ${userId} (${oldUsername} -> ${newUsername}) (IP: ${clientIP})`);

        // Получаем обновленные данные
        const result = await pool.query(
            'SELECT user_id, username, display_name, description, registered_at, avatar_url FROM users WHERE user_id = $1', 
            [userId]
        );
        const updatedUser = result.rows[0];

        // Уведомляем всех клиентов об изменении профиля
        io.emit('user-profile-updated', {
            userId: userId,
            username: newUsername,
            oldUsername: oldUsername !== newUsername ? oldUsername : null,
            profile: {
                userId: updatedUser.user_id,
                username: updatedUser.username,
                displayName: updatedUser.display_name,
                description: updatedUser.description,
                registeredAt: updatedUser.registered_at,
                avatar: updatedUser.avatar_url
            }
        });

        // Возвращаем успешный результат
        res.json({ 
            success: true, 
            user: {
                userId: updatedUser.user_id,
                username: updatedUser.username,
                displayName: updatedUser.display_name,
                description: updatedUser.description,
                registeredAt: updatedUser.registered_at,
                avatar: updatedUser.avatar_url
            }
        });

    } catch (error) {
        console.error('❌ Ошибка обновления профиля:', error);
        res.json({ success: false, message: 'Внутренняя ошибка сервера' });
    }
});

// ИСПРАВЛЕННАЯ функция создания защищенного чата с использованием user_id
async function ensureChatExists(userId1, userId2) {
    const chatId = createChatId(userId1, userId2);

    try {
        // Проверяем, существует ли чат с правильным ID
        const existingChat = await pool.query(
            'SELECT chat_id, encryption_key FROM chats WHERE chat_id = $1', 
            [chatId]
        );

        if (existingChat.rows.length > 0 && existingChat.rows[0].encryption_key) {
            // Кешируем ключ шифрования
            chatKeys.set(chatId, existingChat.rows[0].encryption_key);
            console.log(`✅ Найден существующий чат: ${chatId} с ключом шифрования`);
            return chatId;
        }

        // Проверяем, не существует ли чат между этими пользователями с другим ID
        const possibleChats = await pool.query(
            'SELECT chat_id, encryption_key FROM chats WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)', 
            [userId1, userId2]
        );

        if (possibleChats.rows.length > 0) {
            const existingChat = possibleChats.rows[0];

            // Если нашли чат с неправильным ID, обновляем его
            if (existingChat.chat_id !== chatId) {
                console.log(`🔄 Обновляем ID чата: ${existingChat.chat_id} -> ${chatId}`);

                await pool.query('BEGIN');
                try {
                    // Обновляем chat_id в таблице chats
                    await pool.query(
                        'UPDATE chats SET chat_id = $1 WHERE chat_id = $2', 
                        [chatId, existingChat.chat_id]
                    );

                    // Обновляем chat_id во всех сообщениях
                    await pool.query(
                        'UPDATE messages SET chat_id = $1 WHERE chat_id = $2', 
                        [chatId, existingChat.chat_id]
                    );

                    await pool.query('COMMIT');

                    // Обновляем кеш
                    if (chatKeys.has(existingChat.chat_id)) {
                        const key = chatKeys.get(existingChat.chat_id);
                        chatKeys.delete(existingChat.chat_id);
                        chatKeys.set(chatId, key);
                    } else {
                        chatKeys.set(chatId, existingChat.encryption_key);
                    }

                    console.log(`✅ ID чата обновлен: ${existingChat.chat_id} -> ${chatId} с ключом шифрования`);
                } catch (error) {
                    await pool.query('ROLLBACK');
                    console.error('❌ Ошибка обновления ID чата:', error);
                }
            } else {
                // Чат уже существует с правильным ID, кешируем ключ
                chatKeys.set(chatId, existingChat.encryption_key);
                console.log(`✅ Чат ${chatId} уже существует с ключом шифрования`);
            }

            return chatId;
        }

        // Создаем новый чат с уникальным ключом шифрования
        const encryptionKey = generateChatKey();

        await pool.query(
            'INSERT INTO chats (chat_id, user1_id, user2_id, encryption_key) VALUES ($1, $2, $3, $4)',
            [chatId, userId1, userId2, encryptionKey]
        );

        console.log(`🔐 Создан новый чат: ${chatId} между user_id ${userId1} и ${userId2} с ключом шифрования`);

        // Кешируем ключ шифрования
        chatKeys.set(chatId, encryptionKey);

        return chatId;
    } catch (error) {
        console.error('❌ Ошибка создания/проверки чата:', error);
        return chatId;
    }
}

// Функция для отключения пользователя по IP
async function disconnectUserByIP(ip, reason = 'disconnect') {
    const userData = onlineUsersByIP.get(ip);
    if (userData) {
        const { userId, socketId } = userData;

        try {
            await pool.query('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE user_id = $1', [userId]);
        } catch (error) {
            console.error('❌ Ошибка обновления времени последнего посещения:', error);
        }

        onlineUsersByIP.delete(ip);
        userSockets.delete(userId);
        connectedSockets.delete(socketId);

        console.log(`🔴 Пользователь отключился по IP: user_id ${userId} (${ip}) - ${reason}`);
        return userId;
    }
    return null;
}

// Функция для очистки неактивных соединений
async function cleanupInactiveConnections() {
    const now = Date.now();
    const inactiveUsers = [];
    const timeoutDuration = 300000; // 5 минут

    for (const [ip, data] of onlineUsersByIP) {
        if (now - data.lastActivity > timeoutDuration) {
            inactiveUsers.push({ ip, userId: data.userId, reason: 'activity_timeout' });
        }
    }

    for (const [socketId, data] of connectedSockets) {
        if (now - data.lastPing > timeoutDuration) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                const ip = getClientIP(socket.handshake);
                if (!inactiveUsers.find(user => user.ip === ip)) {
                    inactiveUsers.push({ ip, userId: data.userId, reason: 'ping_timeout' });
                }
            } else {
                connectedSockets.delete(socketId);
            }
        }
    }

    for (const { ip, userId, reason } of inactiveUsers) {
        const disconnectedUserId = await disconnectUserByIP(ip, reason);
        if (disconnectedUserId) {
            const status = await getUserStatus(disconnectedUserId);
            // Получаем username для уведомления
            const userResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [disconnectedUserId]);
            const username = userResult.rows.length > 0 ? userResult.rows[0].username : null;

            io.emit('user-status-changed', { 
                userId: disconnectedUserId,
                username,
                isOnline: false,
                lastSeenText: status.lastSeenText 
            });
        }
    }

    if (inactiveUsers.length > 0) {
        console.log(`🧹 Очищено ${inactiveUsers.length} неактивных соединений`);
    }
}

setInterval(cleanupInactiveConnections, 60000);

setInterval(async () => {
   try {
       const result = await pool.query('DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP RETURNING user_id, ip');

       if (result.rows.length > 0) {
           console.log(`🧹 Очищено ${result.rows.length} истекших сессий`);
           result.rows.forEach(session => {
               console.log(`🗑️ Удалена истекшая сессия для user_id ${session.user_id} (IP: ${session.ip})`);
           });
       }
   } catch (error) {
       console.error('❌ Ошибка очистки истекших сессий:', error);
   }
}, 60 * 60 * 1000);

// ==================== SOCKET.IO ОБРАБОТЧИКИ ====================

io.on('connection', (socket) => {
   const clientIP = getClientIP(socket.handshake);
   console.log(`🟢 Подключение: ${socket.id} (IP: ${clientIP})`);

   socket.emit('connection-confirmed', { 
       connectionType: 'new',
       socketId: socket.id 
   });

   socket.on('user-online', async (userData) => {
       const { userId, username } = userData;

       const existingSocket = userSockets.get(userId);
       if (existingSocket && existingSocket.socketId !== socket.id) {
           const oldSocket = io.sockets.sockets.get(existingSocket.socketId);
           if (oldSocket) {
               console.log(`🔄 Отключаем старое соединение для user_id ${userId}: ${existingSocket.socketId}`);
               oldSocket.disconnect(true);
           }
           connectedSockets.delete(existingSocket.socketId);
       }

       const existingData = onlineUsersByIP.get(clientIP);
       if (existingData) {
           existingData.userId = userId;
           existingData.username = username;
           existingData.socketId = socket.id;
           existingData.lastActivity = Date.now();
       } else {
           onlineUsersByIP.set(clientIP, {
               userId,
               username,
               socketId: socket.id,
               lastActivity: Date.now()
           });
       }

       userSockets.set(userId, { socketId: socket.id, ip: clientIP });
       connectedSockets.set(socket.id, { 
           userId,
           username, 
           ip: clientIP, 
           lastPing: Date.now() 
       });

       console.log(`✅ Пользователь ${username} (user_id: ${userId}) онлайн с соединением (${socket.id}, IP: ${clientIP})`);

       if (existingSocket) {
           socket.emit('connection-confirmed', { 
               connectionType: 'reconnected',
               socketId: socket.id 
           });
       }

       io.emit('user-status-changed', { 
           userId,
           username, 
           isOnline: true,
           lastSeenText: 'В сети'
       });
   });

   socket.on('user-active', async () => {
       const userData = onlineUsersByIP.get(clientIP);
       if (userData) {
           userData.lastActivity = Date.now();

           const socketData = connectedSockets.get(socket.id);
           if (socketData) {
               socketData.lastPing = Date.now();
           }

           io.emit('user-status-changed', { 
               userId: userData.userId,
               username: userData.username, 
               isOnline: true,
               lastSeenText: 'В сети'
           });
       }
   });

   socket.on('user-inactive', () => {
       const userData = onlineUsersByIP.get(clientIP);
       if (userData) {
           console.log(`😴 Пользователь неактивен: ${userData.username} (user_id: ${userData.userId}, ${clientIP})`);
       }
   });

   socket.on('user-offline', async () => {
       const userId = await disconnectUserByIP(clientIP, 'user_request');
       if (userId) {
           const status = await getUserStatus(userId);
           // Получаем username для уведомления
           const userResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
           const username = userResult.rows.length > 0 ? userResult.rows[0].username : null;

           io.emit('user-status-changed', { 
               userId,
               username,
               isOnline: false,
               lastSeenText: status.lastSeenText 
           });
       }
   });

   socket.on('subscribe-to-statuses', async (userIds) => {
       console.log(`📡 Подписка на статусы: ${userIds.join(', ')}`);

       const statuses = [];
       for (const userId of userIds) {
           const status = await getUserStatus(userId);
           const userResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
           const username = userResult.rows.length > 0 ? userResult.rows[0].username : null;

           statuses.push({
               userId: userId,
               username: username,
               isOnline: status.isOnline,
               lastSeenText: status.lastSeenText
           });
       }

       socket.emit('users-status-update', { users: statuses });
   });

   socket.on('subscribe-to-status', async (userId) => {
       console.log(`📡 Подписка на статус: user_id ${userId}`);

       const status = await getUserStatus(userId);
       const userResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
       const username = userResult.rows.length > 0 ? userResult.rows[0].username : null;

       socket.emit('user-status-changed', {
           userId: userId,
           username: username,
           isOnline: status.isOnline,
           lastSeenText: status.lastSeenText
       });
   });

   socket.on('profile-updated', (data) => {
       const { userId, username, oldUsername, profile } = data;
       console.log(`📝 Получено уведомление об обновлении профиля от user_id ${userId} (${username}):`, profile);

       socket.broadcast.emit('user-profile-updated', {
           userId,
           username,
           oldUsername,
           profile
       });
   });

   socket.on('avatar-updated', (data) => {
       const { userId, username, avatar } = data;
       console.log(`🖼️ Получено уведомление об обновлении аватарки от user_id ${userId} (${username}):`, avatar);

       socket.broadcast.emit('user-avatar-updated', {
           userId,
           username,
           avatar
       });
   });

   socket.on('join-chat', async (chatId) => {
       socket.join(chatId);

       const userData = onlineUsersByIP.get(clientIP);
       if (userData) {
           userData.lastActivity = Date.now();
       }

       const socketData = connectedSockets.get(socket.id);
       if (socketData) {
           socketData.lastPing = Date.now();
       }

       console.log(`💬 Пользователь присоединился к чату: ${chatId}`);

       try {
           // Получаем ключ шифрования для чата
           let encryptionKey = await getChatEncryptionKey(chatId);

           if (!encryptionKey) {
               console.error(`❌ Не найден ключ шифрования для чата: ${chatId}`);

               // ИСПРАВЛЕНИЕ: Пытаемся создать чат если ключ не найден
               const chatParts = chatId.split('_');
               if (chatParts.length === 2) {
                   const userId1 = parseInt(chatParts[0]);
                   const userId2 = parseInt(chatParts[1]);

                   if (!isNaN(userId1) && !isNaN(userId2)) {
                       console.log(`🔧 Попытка создать отсутствующий чат: ${chatId}`);
                       await ensureChatExists(userId1, userId2);

                       // Повторно пытаемся получить ключ
                       encryptionKey = await getChatEncryptionKey(chatId);
                       if (encryptionKey) {
                           console.log(`✅ Ключ шифрования создан для чата: ${chatId}`);
                       }
                   }
               }

               if (!encryptionKey) {
                   socket.emit('chat-history', []);
                   return;
               }
           }

           // Получаем зашифрованную историю сообщений с информацией о пользователях
           const result = await pool.query(`
               SELECT m.from_user_id, m.encrypted_message, m.timestamp, u.username 
               FROM messages m
               JOIN users u ON m.from_user_id = u.user_id
               WHERE m.chat_id = $1 
               ORDER BY m.timestamp ASC
           `, [chatId]);

           // Расшифровываем сообщения перед отправкой клиенту
           const chatMessages = result.rows.map(row => {
               const decryptedMessage = decryptMessage(row.encrypted_message, encryptionKey);
               return {
                   fromUserId: row.from_user_id,
                   from: row.username,
                   message: decryptedMessage,
                   timestamp: row.timestamp
               };
           });

           socket.emit('chat-history', chatMessages);
           console.log(`🔓 Отправлена расшифрованная история чата ${chatId} (${chatMessages.length} сообщений)`);
       } catch (error) {
           console.error('❌ Ошибка получения защищенной истории чата:', error);
           socket.emit('chat-history', []);
       }
   });

   socket.on('send-message', async (data) => {
       const { chatId, message, fromUserId, toUserId } = data;

       updateUserActivity(fromUserId, socket.id, clientIP);

       // Получаем username отправителя для уведомлений
       const fromUserResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [fromUserId]);
       const fromUsername = fromUserResult.rows.length > 0 ? fromUserResult.rows[0].username : null;

       io.emit('user-status-changed', { 
           userId: fromUserId,
           username: fromUsername, 
           isOnline: true,
           lastSeenText: 'В сети'
       });

       const messageData = {
           fromUserId,
           from: fromUsername,
           message,
           timestamp: new Date().toISOString()
       };

       try {
           // Убеждаемся, что защищенный чат существует
           await ensureChatExists(fromUserId, toUserId);

           const existingChatForRecipient = await pool.query(
               'SELECT COUNT(*) as count FROM messages WHERE chat_id = $1 AND from_user_id = $2',
               [chatId, toUserId]
           );

           const isNewChatForRecipient = parseInt(existingChatForRecipient.rows[0].count) === 0;

           // Получаем ключ шифрования для чата
           const encryptionKey = await getChatEncryptionKey(chatId);

           if (!encryptionKey) {
               console.error(`❌ Не найден ключ шифрования для чата: ${chatId}`);
               socket.emit('message-error', { error: 'Ошибка шифрования сообщения' });
               return;
           }

           // Шифруем сообщение перед сохранением
           const encryptedMessage = encryptMessage(message, encryptionKey);

           // Сохраняем зашифрованное сообщение в базу данных
           await pool.query(
               'INSERT INTO messages (chat_id, from_user_id, encrypted_message) VALUES ($1, $2, $3)',
               [chatId, fromUserId, encryptedMessage]
           );

           console.log(`🔐 Сообщение сохранено: user_id ${fromUserId} -> ${toUserId} в чате ${chatId}`);

           // Отправляем расшифрованное сообщение всем в чате
           io.to(chatId).emit('new-message', messageData);

           if (isNewChatForRecipient) {
               const recipientSocket = userSockets.get(toUserId);
               if (recipientSocket) {
                   const recipientSocketObj = io.sockets.sockets.get(recipientSocket.socketId);
                   if (recipientSocketObj) {
                       recipientSocketObj.emit('new-chat-notification', {
                           fromUserId,
                           from: fromUsername,
                           chatId,
                           message: messageData
                       });
                   }
               }
           }
       } catch (error) {
           console.error('❌ Ошибка отправки зашифрованного сообщения:', error);
           socket.emit('message-error', { error: 'Не удалось отправить сообщение' });
       }
   });

   socket.on('ping', async () => {
       const userData = onlineUsersByIP.get(clientIP);
       if (userData) {
           userData.lastActivity = Date.now();
       }

       const socketData = connectedSockets.get(socket.id);
       if (socketData) {
           socketData.lastPing = Date.now();
       }

       socket.emit('pong');
   });

   socket.on('disconnect', async (reason) => {
       console.log(`🔴 Отключение соединения: ${socket.id} (IP: ${clientIP}) - ${reason}`);

       connectedSockets.delete(socket.id);

       setTimeout(async () => {
           const userData = onlineUsersByIP.get(clientIP);

           if (userData && userData.socketId === socket.id) {
               const userId = await disconnectUserByIP(clientIP, `socket_${reason}`);
               if (userId) {
                   const status = await getUserStatus(userId);
                   // Получаем username для уведомления
                   const userResult = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
                   const username = userResult.rows.length > 0 ? userResult.rows[0].username : null;

                   io.emit('user-status-changed', { 
                       userId,
                       username,
                       isOnline: false,
                       lastSeenText: status.lastSeenText 
                   });
               }
           }
       }, 5000);
   });

   socket.on('error', (error) => {
       console.log(`❌ Ошибка защищенного соединения ${socket.id}:`, error);
   });
});

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGTERM', async () => {
   console.log('🛑 Получен сигнал SIGTERM, начинаем graceful shutdown...');

   for (const [ip, userData] of onlineUsersByIP) {
       try {
           await pool.query('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE user_id = $1', [userData.userId]);
       } catch (error) {
           console.error('❌ Ошибка обновления last_seen при shutdown:', error);
       }
   }

   io.close(() => {
       console.log('✅ Сокет сервер закрыт');

       server.close(() => {
           console.log('✅ HTTP сервер закрыт');

           pool.end(() => {
               console.log('✅ Подключение к базе-данных закрыто');
               process.exit(0);
           });
       });
   });
});

process.on('SIGINT', async () => {
   console.log('🛑 Получен сигнал SIGINT (Ctrl+C)');
   process.emit('SIGTERM');
});

// Обработка ошибок без завершения процесса
process.on('uncaughtException', (error) => {
   console.error('❌ Необработанное исключение:', error);
   // НЕ завершаем процесс для устойчивости
});

process.on('unhandledRejection', (reason, promise) => {
   console.error('❌ Необработанное отклонение промиса:', reason);
   // НЕ завершаем процесс для устойчивости
});

// ==================== ЗАПУСК СЕРВЕРА ====================

initDatabase().then(() => {
   const PORT = process.env.Port || 3000;

   // Настройка keep-alive для HTTP сервера
   server.keepAliveTimeout = 120000; // 2 минуты
   server.headersTimeout = 120000;   // 2 минуты

   server.listen(PORT, () => {
       console.log(`✅ Основной сервер запущен на порту: ${PORT}`);
       console.log(`🚀 Сервер готов к работе!`);
   });
}).catch((error) => {
   console.error('❌ Ошибка запуска сервера:', error);
   process.exit(1);
});
