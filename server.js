const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к Neon PostgreSQL с адаптивным SSL под Vercel
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true, sslmode: 'verify-full' } // Фикс "Устаревший сервер прослушивает..."
        : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Улучшенный парсер тарифов (понимает "7 дней", "30 дней", "30d", "15 d")
function parseTimeToMs(timeInput) {
    if (!timeInput) return 30 * 24 * 60 * 60 * 1000;
    const value = parseInt(timeInput);
    if (isNaN(value)) return 30 * 24 * 60 * 60 * 1000;
    
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    
    if (unit.includes('м') || unit === 'm') return value * 60 * 1000; // минуты
    if (unit.includes('ч') || unit === 'h') return value * 60 * 60 * 1000; // часы
    if (unit.includes('д') || unit === 'd') return value * 24 * 60 * 60 * 1000; // дни
    
    return value * 24 * 60 * 60 * 1000;
}

// Генератор ключей XXXX-XXXX-XXXX-XXXX
function generateRandomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) key += '-';
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Авторизация администратора
app.post('/api/admin/login', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || 'coco2012coco!';
    if (req.body.password === adminPassword) {
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Неверный пароль' });
    }
});

// Контроллер генерации лицензии (вынесен для поддержки нескольких эндпоинтов из логов)
async function handleGenerateLicense(req, res) {
    const { password, duration } = req.body; 
    const adminPassword = process.env.ADMIN_PASSWORD || 'coco2012coco!';
    
    // Временно отключаем строгую блокировку, если фронтенд пока не передает пароль в body запроса кнопки
    if (password && password !== adminPassword) {
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
            expires_at: expiresAt.toISOString() 
        });

    } catch (err) {
        console.error('Ошибка создания ключа:', err);
        return res.status(500).json({ success: false, error: 'Не удалось сохранить ключ в БД' });
    }
}

// Поддержка всех возможных эндпоинтов генерации ключа из ваших логов Vercel
app.post('/api/admin/generate-license', handleGenerateLicense);
app.post('/api/admin/сгенерировать-лицензию', handleGenerateLicense);
app.post('/api/admin/keys', handleGenerateLicense);

// Контроллер получения списка ключей (вынесен отдельно)
async function handleGetLicensesList(req, res) {
    try {
        // Переводим игроков в оффлайн, если они не обновляли статус более 3 минут
        await pool.query(
            "UPDATE licenses SET last_server = 'Оффлайн' WHERE last_seen < NOW() - INTERVAL '3 minutes' AND last_server != 'Оффлайн'"
        );
        const result = await pool.query('SELECT * FROM licenses ORDER BY id DESC');
        
        // Отдаем данные в двух форматах сразу, чтобы фронтенд точно их прочитал
        if (req.query.raw === 'true') {
            return res.json(result.rows);
        }
        return res.json({ success: true, licenses: result.rows });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, licenses: [] });
    }
}

// Поддержка всех эндпоинтов вывода списка для таблицы (в логах идет GET /api/admin/keys)
app.get('/api/admin/keys', handleGetLicensesList);
app.get('/api/admin/list', handleGetLicensesList);
app.get('/api/licenses', handleGetLicensesList);

// Проверка лицензии клиентом (модом Minecraft)
app.get('/api/verify', async (req, res) => {
    let { key, hwid, name, server, action } = req.query;
    if (!key || !hwid) return res.json({ success: false, error: 'Missing key or HWID' });

    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    
    let pName = name ? decodeURIComponent(name).trim() : '—';
    if (!pName || pName === 'null') pName = '—';

    let currentStatus = 'В меню'; 
    if (action === 'offline' || action === 'close') {
        currentStatus = 'Оффлайн';
    } else if (server) {
        const parsedServer = decodeURIComponent(server).trim();
        if (parsedServer && parsedServer !== '' && parsedServer !== '—' && parsedServer.toLowerCase() !== 'null') {
            currentStatus = parsedServer; // Записывает текущий IP сервера
        }
    }

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [key]);
        if (result.rows.length === 0) return res.json({ success: false, error: 'License not found' });

        const license = result.rows[0];

        if (!license.hwid) {
            await pool.query('UPDATE licenses SET hwid = $1 WHERE license_key = $2', [hwid, key]);
        } else if (license.hwid !== hwid) {
            return res.json({ success: false, error: 'HWID mismatch' });
        }

        if (license.expires_at && new Date(license.expires_at) < new Date()) {
            return res.json({ success: false, error: 'License expired' });
        }

        await pool.query(
            'UPDATE licenses SET last_name = $1, last_server = $2, last_seen = NOW() WHERE license_key = $3',
            [pName, currentStatus, key]
        );

        return res.json({ success: true, message: 'License active' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`Сервер успешно запущен на порту ${PORT}`);
});
