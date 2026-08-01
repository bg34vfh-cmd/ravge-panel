const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к Neon PostgreSQL с адаптивным SSL под Vercel
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true, sslmode: 'verify-full' }
        : { rejectUnauthorized: false }
});

// Функция автоматического создания и проверки таблицы базы данных
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255) UNIQUE NOT NULL,
                hwid VARCHAR(255),
                expires_at TIMESTAMP,
                last_name VARCHAR(255) DEFAULT '—',
                last_server VARCHAR(255) DEFAULT 'Оффлайн',
                last_seen TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log("База данных успешно проверена и готова к работе.");
    } catch (err) {
        console.error("Критическая ошибка инициализации базы данных:", err);
    }
}

initDatabase();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Улучшенный парсер тарифов (понимает "7 дней", "30 дней", "30d", "15 d")
function parseTimeToMs(timeInput) {
    if (!timeInput) return 30 * 24 * 60 * 60 * 1000;
    const value = parseInt(timeInput);
    if (isNaN(value)) return 30 * 24 * 60 * 60 * 1000;
    
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    
    if (unit.includes('м') || unit === 'm') return value * 60 * 1000; 
    if (unit.includes('ч') || unit === 'h') return value * 60 * 60 * 1000; 
    if (unit.includes('д') || unit === 'd') return value * 24 * 60 * 60 * 1000; 
    
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

// Контроллер генерации лицензии
async function handleGenerateLicense(req, res) {
    const { password, duration } = req.body; 
    const adminPassword = process.env.ADMIN_PASSWORD || 'coco2012coco!';
    
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

app.post('/api/admin/generate-license', handleGenerateLicense);
app.post('/api/admin/сгенерировать-лицензию', handleGenerateLicense);
app.post('/api/admin/keys', handleGenerateLicense);

// Контроллер получения списка ключей
async function handleGetLicensesList(req, res) {
    try {
        // ИСПРАВЛЕНО: Безопасное и точное приведение типов для вычисления оффлайн-игроков
        await pool.query(`
            UPDATE licenses 
            SET last_server = 'Оффлайн' 
            WHERE last_seen < NOW() - CAST('3 minutes' AS INTERVAL) 
              AND last_server != 'Оффлайн'
        `);
        
        const result = await pool.query('SELECT * FROM licenses ORDER BY id DESC');
        
        if (req.query.raw === 'true') {
            return res.json(result.rows);
        }
        return res.json({ success: true, licenses: result.rows });
    } catch (err) {
        console.error('Ошибка получения списка ключей:', err);
        return res.status(500).json({ success: false, licenses: [] });
    }
}

app.get('/api/admin/keys', handleGetLicensesList);
app.get('/api/admin/list', handleGetLicensesList);
app.get('/api/licenses', handleGetLicensesList);

// Проверка лицензии модом
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
            currentStatus = parsedServer;
        }
    }

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [key]);
        if (result.rows.length === 0) return res.json({ success: false, error: 'License not found' });

        // ИСПРАВЛЕНО: берем первую строку rows[0], а не весь массив строк
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
