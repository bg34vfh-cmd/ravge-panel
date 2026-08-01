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
    } catch (err) { console.error('Ошибка инициализации БД:', err); }
};

app.use(async (req, res, next) => { await initDB(); next(); });

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

app.get('/api/admin/keys', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    try {
        const result = await pool.query('SELECT * FROM licenses ORDER BY id DESC');
        res.json({ success: true, keys: result.rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/generate-license', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    const { timeInput } = req.body;
    const duration = parseTimeInput(timeInput || "30d");
    const key = generateRandomKey();
    const expiresAt = Date.now() + duration;
    try {
        await pool.query(
            `INSERT INTO licenses (key, expires_at, duration_ms, type) VALUES ($1, $2, $3, 'license')`,
            [key, expiresAt, duration]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/generate-reset', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    const key = "RESET-" + generateRandomKey();
    try {
        await pool.query(`INSERT INTO licenses (key, type, status) VALUES ($1, 'reset', 'active')`, [key]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/action', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false });
    const { action, id } = req.body;
    try {
        if (action === 'reset') await pool.query("UPDATE licenses SET hwid = NULL WHERE id = $1", [id]);
        else if (action === 'ban') await pool.query("UPDATE licenses SET status = 'banned' WHERE id = $1", [id]);
        else if (action === 'unban') await pool.query("UPDATE licenses SET status = 'active' WHERE id = $1", [id]);
        else if (action === 'delete') await pool.query("DELETE FROM licenses WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ГЕЙТВЕЙ ДЛЯ МОДА: ДВУХЭТАПНАЯ АВТОРИЗАЦИЯ
app.get('/api/check-license', async (req, res) => {
    let key = req.query.key;
    let playerName = req.query.name;
    let serverIp = req.query.server;
    let hwid = req.query.hwid;
    let action = req.query.action || 'check'; 
    let inputLogin = req.query.login;
    let inputPassword = req.query.password;

    if (!pool) return res.status(200).json({ success: false, status: "error", error: "База недоступна" });
    if (!key) return res.status(200).json({ success: false, status: "error", error: "Ключ пуст" });

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key.trim().toUpperCase()]);
        if (result.rows.length === 0) return res.status(200).json({ success: false, status: "error", error: "Ключ не найден" });

        // ФИКС: Берем именно первый элемент [0] из полученных строк БД, а не весь массив целиком
        const license = result.rows[0]; 

        if (license.status === 'banned') return res.status(200).json({ success: false, status: "error", error: "Лицензия заблокирована" });
        
        if (license.type !== 'reset' && license.expires_at && parseInt(license.expires_at) < Date.now()) {
            return res.status(200).json({ success: false, status: "error", error: "Срок действия истек" });
        }

        // 1. Проверка и привязка HWID устройства
        if (!license.hwid) {
            await pool.query('UPDATE licenses SET hwid = $1 WHERE key = $2', [hwid, key.trim().toUpperCase()]);
        } else if (license.hwid !== hwid) {
            return res.status(200).json({ success: false, status: "error", error: "Ошибка HWID (Ключ привязан к другому ПК)" });
        }

        // 2. Обработка команды регистрации покупателя (.reg)
        if (action === 'register') {
            if (!inputLogin || !inputPassword) {
                return res.status(200).json({ success: false, status: "error", error: "Логин или пароль пусты" });
            }
            await pool.query(
                'UPDATE licenses SET login = $1, password = $2 WHERE key = $3',
                [inputLogin.trim(), inputPassword.trim(), key.trim().toUpperCase()]
            );
            return res.status(200).json({ success: true, status: "success" });
        }

        // 3. Сценарий обычной проверки (.code или повторный заход в игру)
        if (!license.login || !license.password) {
            return res.status(200).json({ success: true, status: "need_registration" });
        }

        await pool.query(
            'UPDATE licenses SET last_seen = $1, player_name = $2, server_ip = $3 WHERE key = $4',
            [Date.now(), playerName || '—', serverIp || '—', key.trim().toUpperCase()]
        );

        res.status(200).json({ success: true, status: "success" });
    } catch (err) { 
        console.error(err);
        res.status(200).json({ success: false, status: "error", error: "Внутренняя ошибка сервера" }); 
    }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Локальный запуск: порт ${PORT}`));
}
