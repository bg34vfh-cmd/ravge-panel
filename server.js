const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'coco2012coco!';

// Подключение к Neon PostgreSQL с адаптивным SSL под продакшн Vercel
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' 
        ? { rejectUnauthorized: true, sslmode: 'verify-full' } 
        : { rejectUnauthorized: false }
});

let isDbInitialized = false;

// Гарантированная функция инициализации и мягкой миграции таблицы
async function ensureDatabaseReady() {
    if (isDbInitialized) return;
    try {
        // 1. Создаем таблицу, если её вообще не существовало
        await pool.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(255) UNIQUE NOT NULL,
                web_login VARCHAR(255) DEFAULT '—',
                hwid VARCHAR(255),
                expires_at TIMESTAMP,
                is_banned BOOLEAN DEFAULT FALSE,
                last_name VARCHAR(255) DEFAULT '—',
                last_server VARCHAR(255) DEFAULT 'Оффлайн',
                last_seen TIMESTAMP DEFAULT NOW()
            );
        `);

        // 2. Мягкая миграция: проверяем и добавляем колонку web_login, если её нет
        const checkLogin = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='licenses' AND column_name='web_login';
        `);
        if (checkLogin.rows.length === 0) {
            await pool.query(`ALTER TABLE licenses ADD COLUMN web_login VARCHAR(255) DEFAULT '—';`);
        }

        // 3. Мягкая миграция: проверяем и добавляем колонку is_banned, если её нет
        const checkBanned = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='licenses' AND column_name='is_banned';
        `);
        if (checkBanned.rows.length === 0) {
            await pool.query(`ALTER TABLE licenses ADD COLUMN is_banned BOOLEAN DEFAULT FALSE;`);
        }

        // 4. Фикс старого названия колонки (если ключ раньше хранился в колонке "key")
        const checkLicenseKey = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='licenses' AND column_name='license_key';
        `);
        if (checkLicenseKey.rows.length === 0) {
            const oldKeyCheck = await pool.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='licenses' AND column_name='key';
            `);
            if (oldKeyCheck.rows.length > 0) {
                await pool.query(`ALTER TABLE licenses RENAME COLUMN "key" TO license_key;`);
            } else {
                await pool.query(`ALTER TABLE licenses ADD COLUMN license_key VARCHAR(255) UNIQUE;`);
            }
        }

        isDbInitialized = true;
        console.log("База данных успешно проверена, миграции применены.");
    } catch (err) { 
        console.error("Ошибка инициализации БД:", err); 
        throw err; 
    }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Универсальный парсер времени (поддерживает 7d, 15d, 30d)
function parseTimeToMs(timeInput) {
    const value = parseInt(timeInput);
    if (isNaN(value)) return 30 * 24 * 60 * 60 * 1000;
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    if (unit.includes('м') || unit === 'm') return value * 60 * 1000;
    if (unit.includes('ч') || unit === 'h') return value * 60 * 60 * 1000;
    if (unit.includes('д') || unit === 'd') return value * 24 * 60 * 60 * 1000;
    return value * 24 * 60 * 60 * 1000;
}

// Генератор уникальных ключей формата XXXX-XXXX-XXXX-XXXX
function generateRandomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) key += '-';
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

app.get('/', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) {}
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// АВТОРИЗАЦИЯ АДМИНИСТРАТОРА НА ВЕБ-ПАНЕЛИ
app.post('/api/admin/login', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false, error: 'Database error' }); }
    
    if (req.body.password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Неверный пароль' });
    }
});

// ГЕНЕРАЦИЯ ЧИСТОГО КЛЮЧА
app.post('/api/admin/generate-license', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false, error: 'Database not ready' }); }
    const { password, duration, login } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Запрещено' });

    try {
        const newKey = generateRandomKey();
        const expiresAt = new Date(Date.now() + parseTimeToMs(duration));
        await pool.query('INSERT INTO licenses (license_key, web_login, expires_at) VALUES ($1, $2, $3)', [newKey, login || '—', expiresAt]);
        return res.json({ success: true, key: newKey });
    } catch (err) { 
        console.error(err);
        return res.status(500).json({ success: false, error: 'Internal error' }); 
    }
});

// ПОЛУЧЕНИЕ СПИСКА КЛЮЧЕЙ ДЛЯ ВЕБ-ТАБЛИЦЫ
app.get('/api/admin/keys', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false }); }
    try {
        // Автоматом переводим в оффлайн тех, от кого не было верификации более 3 минут
        const threshold = new Date(Date.now() - 3 * 60 * 1000);
        await pool.query("UPDATE licenses SET last_server = 'Оффлайн' WHERE last_seen < $1 AND last_server != 'Оффлайн'", [threshold]);
        
        const result = await pool.query('SELECT * FROM licenses ORDER BY id DESC');
        return res.json({ success: true, licenses: result.rows });
    } catch (err) { return res.status(500).json({ success: false }); }
});

// ЭНДПОИНТ БАНА / РАЗБАНА ПО КНОПКЕ
app.post('/api/admin/ban', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false }); }
    const { password, key, ban } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Invalid password' });

    try {
        await pool.query('UPDATE licenses SET is_banned = $1 WHERE license_key = $2', [ban, key]);
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false }); }
});

// ЭНДПОИНТ ПРОДЛЕНИЯ СРОКА ЛИЦЕНЗИИ
app.post('/api/admin/extend', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false }); }
    const { password, key, duration } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Invalid password' });

    try {
        const licCheck = await pool.query('SELECT expires_at FROM licenses WHERE license_key = $1', [key]);
        if (licCheck.rows.length === 0) return res.json({ success: false, error: 'Key not found' });
        
        let currentExpire = new Date(licCheck.rows[0].expires_at);
        if (currentExpire < new Date()) currentExpire = new Date(); // Продлеваем от сегодняшнего дня, если уже просрочен

        const newExpire = new Date(currentExpire.getTime() + parseTimeToMs(duration));
        await pool.query('UPDATE licenses SET expires_at = $1 WHERE license_key = $2', [newExpire, key]);
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false }); }
});

// ЭНДПОИНТ ДЛЯ ПОЛНОГО УДАЛЕНИЯ КЛЮЧА ИЗ БАЗЫ
app.post('/api/admin/delete', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false }); }
    const { password, key } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Invalid password' });

    try {
        await pool.query('DELETE FROM licenses WHERE license_key = $1', [key]);
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false }); }
});

// ВЕРИФИКАЦИЯ КЛИЕНТОМ (ВАШИМ МОДОМ/ЧИТОМ ИЗ MINECRAFT)
app.get('/api/verify', async (req, res) => {
    try { await ensureDatabaseReady(); } catch(e) { return res.status(500).json({ success: false }); }
    let { key, hwid, name, server, action } = req.query;
    if (!key || !hwid) return res.json({ success: false, error: 'Missing parameters' });

    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    let pName = name ? decodeURIComponent(name).trim() : '—';
    
    let currentStatus = 'В меню';
    if (action === 'offline' || action === 'close') currentStatus = 'Оффлайн';
    else if (server) {
        const parsed = decodeURIComponent(server).trim();
        if (parsed && parsed !== 'null') currentStatus = parsed;
    }

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [key]);
        if (result.rows.length === 0) return res.json({ success: false, error: 'License not found' });

        // Жесткий фикс: берём именно объект строки из возвращаемого массива rows
        const license = result.rows[0];

        // 1. Проверка на бан
        if (license.is_banned) {
            return res.json({ success: false, error: 'You are banned from this cheat' });
        }
        
        // 2. Проверка на соответствие HWID
        if (license.hwid && license.hwid !== hwid) {
            return res.json({ success: false, error: 'HWID mismatch' });
        }
        
        // 3. Проверка срока окончания подписки
        if (license.expires_at && new Date(license.expires_at) < new Date()) {
            return res.json({ success: false, error: 'License expired' });
        }

        // 4. Запись сетевой активности и автоматическая привязка логина/ника при первом входе
        if (!license.hwid || license.hwid === '') {
            await pool.query('UPDATE licenses SET hwid = $1, last_name = $2, last_server = $3, last_seen = NOW() WHERE license_key = $4', [hwid, pName, currentStatus, key]);
        } else {
            await pool.query('UPDATE licenses SET last_name = $1, last_server = $2, last_seen = NOW() WHERE license_key = $3', [pName, currentStatus, key]);
        }

        return res.json({ success: true, message: 'Active' });
    } catch (err) { 
        console.error(err);
        return res.status(500).json({ success: false }); 
    }
});

app.listen(PORT, () => console.log(`Бэкенд успешно запущен на порту ${PORT}`));
