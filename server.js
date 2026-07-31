const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const connectionString = process.env.POSTGRES_URL || process.env.STORAGE_URL || process.env.POSTGRES_URL_NON_POOLING;
const pool = connectionString 
    ? new Pool({ connectionString: connectionString.includes("sslmode") ? connectionString : connectionString + "?sslmode=require" })
    : null;

let isDbInitialized = false;

const initDB = async () => {
    if (isDbInitialized || !pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id SERIAL PRIMARY KEY,
                key TEXT UNIQUE,
                hwid TEXT DEFAULT NULL,
                status TEXT DEFAULT 'active',
                expires_at BIGINT DEFAULT 0,
                duration_ms BIGINT DEFAULT 0,
                type TEXT DEFAULT 'license',
                last_seen BIGINT DEFAULT 0,
                player_name TEXT DEFAULT '—',
                server_ip TEXT DEFAULT '—',
                banned_until BIGINT DEFAULT 0,
                login TEXT DEFAULT NULL,
                password TEXT DEFAULT NULL
            )
        `);
        isDbInitialized = true;
    } catch (err) {
        console.error('Ошибка инициализации БД:', err);
    }
};

app.use(async (req, res, next) => {
    await initDB();
    next();
});

function parseTimeInput(input) {
    const match = input.match(/^(\d+)([dmh])$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'm') return value * 60 * 1000;
    return 0;
}

function generateRandomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const gen = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${gen()}-${gen()}-${gen()}-${gen()}`;
}

// API: Получить все ключи
app.get('/api/admin/keys', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    try {
        const result = await pool.query('SELECT * FROM licenses ORDER BY id DESC');
        res.json({ success: true, keys: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Создать обычную лицензию
app.post('/api/admin/generate-license', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    const { timeInput } = req.body;
    const duration = parseTimeInput(timeInput || "30d");
    const key = generateRandomKey();
    const expiresAt = Date.now() + duration;

    try {
        await pool.query(
            `INSERT INTO licenses (key, expires_at, duration_ms, type, login) VALUES ($1, $2, $3, 'license', $4)`,
            [key, expiresAt, duration, 'User_' + Math.floor(1000 + Math.random() * 9000)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Создать ключ сброса HWID
app.post('/api/admin/generate-reset', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    const key = "RESET-" + generateRandomKey();
    try {
        await pool.query(`INSERT INTO licenses (key, type, status) VALUES ($1, 'reset', 'active')`, [key]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Действия над ключами
app.post('/api/admin/action', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    const { action, id } = req.body;
    try {
        if (action === 'reset') {
            await pool.query("UPDATE licenses SET hwid = NULL WHERE id = $1", [id]);
        } else if (action === 'ban') {
            await pool.query("UPDATE licenses SET status = 'banned' WHERE id = $1", [id]);
        } else if (action === 'unban') {
            await pool.query("UPDATE licenses SET status = 'active', banned_until = 0 WHERE id = $1", [id]);
        } else if (action === 'delete') {
            await pool.query("DELETE FROM licenses WHERE id = $1", [id]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
}
