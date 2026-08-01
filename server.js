const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к Neon PostgreSQL с правильной настройкой SSL под Vercel
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true, sslmode: 'verify-full' } // Фикс ошибки SSL из логов Vercel
        : { rejectUnauthorized: false } // Для локальных тестов
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Универсальный парсер тарифов (обрабатывает "30d", "15d", "7d", "2h")
function parseTimeToMs(timeInput) {
    if (!timeInput) return 30 * 24 * 60 * 60 * 1000; // По умолчанию 30 дней
    const value = parseInt(timeInput);
    if (isNaN(value)) return 30 * 24 * 60 * 60 * 1000;
    
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    if (unit === 'm' || unit === 'мин' || unit === 'минут') return value * 60 * 1000;
    if (unit === 'h' || unit === 'ч' || unit === 'час' || unit === 'часов') return value * 60 * 60 * 1000;
    if (unit === 'd' || unit === 'д' || unit === 'дней' || unit === 'день') return value * 24 * 60 * 60 * 1000;
    return value * 24 * 60 * 60 * 1000;
}

// Генератор уникальных лицензионных ключей формата XXXX-XXXX-XXXX-XXXX
function generateRandomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) key += '-';
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

// Главная страница админ-панели
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Вход в админ-панель
app.post('/api/admin/login', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || 'coco2012coco!';
    if (req.body.password === adminPassword) {
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Неверный пароль' });
    }
});

// Эндпоинт для динамической генерации тарифов администратором (30d, 15d, 7d и т.д.)
app.post('/api/admin/сгенерировать-лицензию', async (req, res) => {
    const { password, duration } = req.body; 
    const adminPassword = process.env.ADMIN_PASSWORD || 'coco2012coco!';
    
    if (password !== adminPassword) {
        return res.status(401).json({ success: false, error: 'Доступ запрещен' });
    }

    try {
        const newKey = generateRandomKey();
        const ms = parseTimeToMs(duration);
        const expiresAt = new Date(Date.now() + ms);

        await pool.query(
            'INSERT INTO licenses (license_key, expires_at) VALUES ($1, $2)',
            [newKey, expiresAt]
        );

        return res.json({ 
            success: true, 
            key: newKey, 
            duration_requested: duration,
            expires_at: expiresAt.toISOString() 
        });

    } catch (err) {
        console.error('Ошибка создания ключа:', err);
        return res.status(500).json({ success: false, error: 'Не удалось сохранить ключ в БД' });
    }
});

// Проверка лицензии и определение местоположения (В меню / IP сервера / Оффлайн)
app.get('/api/verify', async (req, res) => {
    let { key, hwid, name, server, action } = req.query;
    if (!key || !hwid) return res.json({ success: false, error: 'Missing key or HWID' });

    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    
    let pName = name ? decodeURIComponent(name).trim() : '—';
    if (!pName || pName === 'null') pName = '—';

    // Парсим положение игрока из запроса вашего мода
    let currentStatus = 'В меню'; 
    
    if (action === 'offline' || action === 'close') {
        currentStatus = 'Оффлайн';
    } else if (server) {
        const parsedServer = decodeURIComponent(server).trim();
        if (parsedServer && parsedServer !== '' && parsedServer !== '—' && parsedServer.toLowerCase() !== 'null') {
            currentStatus = parsedServer; // Запишет реальный IP сервера (например, play.hypixel.net)
        }
    }

    try {
        // Поиск ключа в базе данных
        const result = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [key]);
        
        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'License not found' });
        }

        const license = result.rows;

        // 1. Проверка и жесткая привязка HWID при первом запуске
        if (!license.hwid) {
            await pool.query('UPDATE licenses SET hwid = $1 WHERE license_key = $2', [hwid, key]);
        } else if (license.hwid !== hwid) {
            return res.json({ success: false, error: 'HWID mismatch' });
        }

        // 2. Проверка даты окончания тарифного плана
        const now = new Date();
        if (license.expires_at && new Date(license.expires_at) < now) {
            return res.json({ success: false, error: 'License expired' });
        }

        // 3. Сохраняем ник, IP майнкрафт-сервера и обновляем время активности NOW()
        await pool.query(
            'UPDATE licenses SET last_name = $1, last_server = $2, last_seen = NOW() WHERE license_key = $3',
            [pName, currentStatus, key]
        );

        return res.json({ success: true, message: 'License active' });

    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Эндпоинт для вашей админ-панели (чтобы выводить список ключей на сайт)
app.get('/api/admin/list', async (req, res) => {
    try {
        // Автоматически переводим в статус "Оффлайн" тех, от кого не было верификации больше 3 минут (вылет игры)
        await pool.query(
            "UPDATE licenses SET last_server = 'Оффлайн' WHERE last_seen < NOW() - INTERVAL '3 minutes' AND last_server != 'Оффлайн'"
        );

        const result = await pool.query('SELECT * FROM licenses ORDER BY id DESC');
        return res.json({ success: true, licenses: result.rows });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
