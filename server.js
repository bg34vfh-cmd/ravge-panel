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

// Функция парсинга времени в миллисекунды (поддерживает мин, ч, д, дней)
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

// Проверка лицензии и динамическое обновление статусов игрока
app.get('/api/verify', async (req, res) => {
    let { key, hwid, name, server, action, login, password } = req.query;
    if (!key || !hwid) return res.json({ success: false });

    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    
    // Получаем чистый ник игрока
    let pName = name ? decodeURIComponent(name).trim() : '—';
    if (!pName || pName === '') pName = '—';

    // Получаем то, что мод передал в качестве сервера
    let sIp = server ? decodeURIComponent(server).trim() : '—';
    if (!sIp || sIp === '') sIp = '—';

    try {
        const result = await pool.query('SELECT * FROM keys WHERE key = $1', [key]);
        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Ключ не найден' });
        }

        let row = result.rows[0];

        // Проверка бана ключа
        if (row.status !== 'active') {
            await pool.query('UPDATE keys SET player_name = $1, server_ip = $2 WHERE key = $3', ['ЗАБАНЕН', '—', key]);
            return res.json({ success: false, error: 'Ключ заблокирован' });
        }

        // Активация времени при самом первом запуске чита с этим ключом
        let expiresAt = Number(row.expires_at);
        if (expiresAt === 0) {
            expiresAt = Date.now() + Number(row.duration_ms);
            await pool.query('UPDATE keys SET expires_at = $1 WHERE key = $2', [expiresAt, key]);
        }

        // Проверка окончания подписки
        if (expiresAt !== 0 && Date.now() > expiresAt) {
            return res.json({ success: false, error: 'Срок действия лицензии истёк' });
        }

        // Обработка регистрации (.reg)
        if (action === 'register') {
            if (!login || !password) return res.json({ success: false, error: 'Укажите логин и пароль' });
            await pool.query(
                'UPDATE keys SET login = $1, password = $2, hwid = $3, player_name = $4, server_ip = $5, last_seen = $6 WHERE key = $7',
                [login.trim(), password.trim(), hwid, pName, sIp, Date.now(), key]
            );
            return res.json({ success: true });
        }

        // Если логина/пароля еще нет в базе — отправляем запрос на регистрацию
        if (!row.login || !row.password) {
            return res.json({ success: true, need_register: true });
        }

        // --- УМНАЯ ЛОГИКА СТАТУСОВ ДЛЯ ТАБЛИЦЫ АДМИНКИ ---
        let finalPlayerField = row.login ? `${row.login} (${pName})` : pName; 
        let finalServerField = sIp;
        let finalStatusField = 'active'; // По умолчанию в админке горит зеленый ACTIVE

        // Проверяем, что именно прислал клиент
        const lowerServer = sIp.toLowerCase();
        
        if (lowerServer.includes('оффлайн') || lowerServer.includes('offline') || lowerServer.includes('офлайн')) {
            // Если игрок полностью закрыл Майнкрафт (сработал твой ShutdownHook)
            finalServerField = '—'; 
            finalPlayerField = row.login ? `${row.login} [Офлайн]` : '—';
        } else if (lowerServer.includes('меню') || lowerServer.includes('menu') || lowerServer.includes('title')) {
            // Если игрок вышел в главное меню игры
            finalServerField = 'В меню';
        } else if (lowerServer.includes('singleplayer') || lowerServer.includes('одиноч')) {
            // Если играет в одиночном мире (как у игрока Player123 на твоем скриншоте)
            finalServerField = 'Одиночная игра';
        } else {
            // Во всех остальных случаях считаем, что это IP-адрес сервера (например, mc.hypixel.net)
            finalServerField = sIp;
        }

        // Проверка привязки по железу (HWID) и обновление строки в БД
        if (!row.hwid) {
            await pool.query(
                'UPDATE keys SET hwid = $1, player_name = $2, server_ip = $3, last_seen = $4, status = $5 WHERE key = $6', 
                [hwid, finalPlayerField, finalServerField, Date.now(), finalStatusField, key]
            );
            return res.json({ success: true });
        } else {
            if (row.hwid.trim().toUpperCase() === hwid) {
                await pool.query(
                    'UPDATE keys SET player_name = $1, server_ip = $2, last_seen = $3, status = $4 WHERE key = $5', 
                    [finalPlayerField, finalServerField, Date.now(), finalStatusField, key]
                );
                return res.json({ success: true });
            } else {
                return res.json({ success: false, error: 'Ошибка HWID привязки' });
            }
        }
    } catch (err) {
        return res.json({ success: false, error: err.message });
    }
});

// === ОСТАЛЬНЫЕ АДМИН-МАРШРУТЫ БЕЗ ИЗМЕНЕНИЙ СТРУКТУРЫ ===

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
    try {
        await pool.query('DELETE FROM keys WHERE id = $1', [parseInt(req.body.id)]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/admin/toggle-status', async (req, res) => {
    const targetId = parseInt(req.body.id);
    try {
        const result = await pool.query('SELECT status FROM keys WHERE id = $1', [targetId]);
        if (result.rows.length > 0) {
            const currentStatus = result.rows[0].status;
            const newStatus = currentStatus === 'active' ? 'banned' : 'active';
            
            if (newStatus === 'banned') {
                await pool.query('UPDATE keys SET status = $1, player_name = $2, server_ip = $3, hwid = $4 WHERE id = $5', ['banned', 'БАН-ОФЛАЙН', '—', null, targetId]);
            } else {
                await pool.query('UPDATE keys SET status = $1, player_name = $2 WHERE id = $3', ['active', '—', targetId]);
            }
            return res.json({ success: true });
        }
        res.json({ success: false, error: 'Ключ не найден' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/admin/keys', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM keys ORDER BY id ASC');
        res.json({ success: true, keys: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

module.exports = app;
app.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
