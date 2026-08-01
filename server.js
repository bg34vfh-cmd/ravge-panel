const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к Neon PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Функция парсинга времени в миллисекунды (мин, ч, д)
function parseTimeToMs(timeInput) {
    if (!timeInput) return 30 * 24 * 60 * 60 * 1000;
    const value = parseInt(timeInput);
    if (isNaN(value)) return 30 * 24 * 60 * 60 * 1000;
    
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    if (unit === 'm' || unit === 'мин' || unit === 'минут') return value * 60 * 1000;
    if (unit === 'h' || unit === 'ч' || unit === 'час' || unit === 'часов') return value * 60 * 60 * 1000;
    if (unit === 'd' || unit === 'д' || unit === 'дней' || unit === 'день') return value * 24 * 60 * 60 * 1000;
    return value * 24 * 60 * 60 * 1000; // По умолчанию дни
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === 'coco2012coco!') res.json({ success: true });
    else res.json({ success: false });
});

// Проверка лицензии и авторизация игрока
app.get('/api/verify', async (req, res) => {
    let { key, hwid, name, server, action, login, password } = req.query;
    if (!key || !hwid) return res.json({ success: false, error: 'Переданы не все параметры' });

    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    
    let pName = name ? decodeURIComponent(name).trim() : '—';
    if (!pName || pName === '') pName = '—';

    let sIp = server ? decodeURIComponent(server).trim() : '—';
    if (!sIp || sIp === '') sIp = '—';

    try {
        const result = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Ключ не найден в базе данных' });
        }

        // ИСПРАВЛЕНО: Добавлен индекс [0] для выбора первой записи из СУБД
        let row = result.rows[0];

        // 1. Проверка блокировки ключа
        if (row.status !== 'active') {
            await pool.query('UPDATE keys SET player_name = $1, server_ip = $2 WHERE key = $3', ['ЗАБАНЕН', '—', key]);
            return res.json({ success: false, error: 'Данный ключ заблокирован администрацией' });
        }

        // 2. Инициализация времени при самом первом запуске
        let expiresAt = Number(row.expires_at);
        if (expiresAt === 0) {
            expiresAt = Date.now() + Number(row.duration_ms);
            await pool.query('UPDATE keys SET expires_at = $1 WHERE key = $2', [expiresAt, key]);
        }

        // 3. Проверка окончания срока действия подписки
        if (expiresAt !== 0 && Date.now() > expiresAt) {
            return res.json({ success: false, error: 'Срок действия вашей лицензии истёк' });
        }

        // 4. Проверка HWID привязки
        if (row.hwid && row.hwid.toString().trim().toUpperCase() !== hwid) {
            return res.json({ success: false, error: 'Ошибка авторизации: несовпадение HWID' });
        }

        // 5. Обработка регистрации аккаунта (.reg) внутри мода
        if (action === 'register') {
            if (!login || !password) return res.json({ success: false, error: 'Введите корректные логин и пароль' });
            await pool.query(
                'UPDATE keys SET login = $1, password = $2, hwid = $3, player_name = $4, server_ip = $5, last_seen = $6 WHERE key = $7',
                [login.trim(), password.trim(), hwid, pName, sIp, Date.now(), key]
            );
            return res.json({ success: true });
        }

        // 6. Запрос обязательной регистрации, если в БД пустые поля авторизации
        if (!row.login || !row.password) {
            return res.json({ success: true, need_register: true });
        }

        // 7. ЗАЩИТА: Проверяем авторизационные данные
        const dbLogin = row.login ? row.login.toString().trim() : '';
        const dbPassword = row.password ? row.password.toString().trim() : '';
        
        if (!login || !password || login.trim() !== dbLogin || password.trim() !== dbPassword) {
            return res.json({ success: false, error: 'Ошибка авторизации: неверный логин или пароль' });
        }

        // 8. Обработка отображения статусов игрового сервера для админ-панели
        let finalServerField = sIp;
        const lowerServer = sIp.toLowerCase();
        
        if (lowerServer.includes('оффлайн') || lowerServer.includes('offline') || lowerServer.includes('офлайн')) {
            finalServerField = 'Офлайн';
        } else if (lowerServer.includes('меню') || lowerServer.includes('menu') || lowerServer.includes('title')) {
            finalServerField = 'В главном меню';
        } else if (lowerServer.includes('singleplayer') || lowerServer.includes('одиноч')) {
            finalServerField = 'Одиночная игра';
        }

        // 9. Финальное обновление информации о сессии в базе
        await pool.query(
            'UPDATE keys SET hwid = $1, player_name = $2, server_ip = $3, last_seen = $4 WHERE key = $5', 
            [hwid, pName, finalServerField, Date.now(), key]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error('Ошибка верификации:', err);
        return res.json({ success: false, error: 'Внутренняя ошибка сервера базы данных' });
    }
});

// === АДМИН-МАРШРУТЫ УПРАВЛЕНИЯ ===

app.post('/api/admin/generate-license', async (req, res) => {
    const { timeInput } = req.body;
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${genPart()}-${genPart()}-${genPart()}-${genPart()}`;
    const addMs = parseTimeToMs(timeInput);

    try {
        await pool.query(
            'INSERT INTO keys (key, hwid, status, expires_at, duration_ms, type, last_seen, player_name, server_ip, banned_until, login, password) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
            [newKey, null, 'active', 0, addMs, 'license', 0, '—', '—', 0, null, null]
        );
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/admin/extend', async (req, res) => {
    const targetId = parseInt(req.body.id);
    const addMs = parseTimeToMs(req.body.timeInput);

    try {
        const result = await pool.query('SELECT * FROM keys WHERE id = $1', [targetId]);
        if (result.rows.length > 0) {
            // ИСПРАВЛЕНО: Добавлен индекс [0]
            let row = result.rows[0]; 
            let newExpires = 0;
            let newDuration = Number(row.duration_ms);

            if (Number(row.expires_at) === 0) {
                newDuration += addMs;
            } else {
                let baseTime = Number(row.expires_at) < Date.now() ? Date.now() : Number(row.expires_at);
                newExpires = baseTime + addMs;
            }

            await pool.query('UPDATE keys SET duration_ms = $1, expires_at = $2 WHERE id = $3', [newDuration, newExpires, targetId]);
            return res.json({ success: true });
        }
        res.json({ success: false, error: 'Ключ не найден' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/admin/delete', async (req, res) => {
    const targetId = parseInt(req.body.id);
    if (isNaN(targetId)) {
        return res.json({ success: false, error: 'Некорректный ID ключа' });
    }
    
    try {
        const result = await pool.query('DELETE FROM keys WHERE id = $1', [targetId]);
        if (result.rowCount === 0) {
            return res.json({ success: false, error: 'Ключ с таким ID не найден в базе' });
        }
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Сервер успешно запущен на порту ${PORT}`);
});
