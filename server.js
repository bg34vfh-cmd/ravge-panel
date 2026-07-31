const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к твоей постоянной вечной базе данных Postgres на Vercel
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

// Инициализация структуры таблиц в облаке и миграция старых ключей
const initDB = async () => {
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
        console.log('Облачная база Postgres успешно подключена.');

        // ПРОВЕРКА МИГРАЦИИ: Если в облаке пусто, зальем туда дефолтные ключи, чтобы покупатели не слетели
        const checkKeys = await pool.query('SELECT id FROM licenses LIMIT 1');
        if (checkKeys.rows.length === 0) {
            console.log('Облако пустое. Переносим ключи покупателей...');
            
            // Твои основные рабочие ключи покупателей, которые были в keys.db
            const backupKeys = [
                "6YZD-5LKM-SW3Y-MSCJ",
                "EFYB-HJYB-RNJL-0MLD",
                "NPN7-B5WR-CEZT-KID9"
            ];
            
            const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
            for (const k of backupKeys) {
                await pool.query(
                    'INSERT INTO licenses (key, expires_at, duration_ms, type, status) VALUES ($1, 0, $2, \'license\', \'active\') ON CONFLICT (key) DO NOTHING',
                    [k, thirtyDaysMs]
                );
            }
            console.log('Все ключи успешно перенесены в вечное облако!');
        }
    } catch (err) {
        console.error('Ошибка БД:', err.message);
    }
};
initDB();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Верификация лицензии и привязка HWID для чита
app.get('/api/verify', async (req, res) => {
    let { key, hwid, name, server } = req.query;
    if (!key || !hwid) return res.send('{"success":false}');
    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    const pName = name ? decodeURIComponent(name) : '—';
    const sIp = server ? decodeURIComponent(server) : '—';

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
        const row = result.rows[0];

        if (!row) return res.send('{"success":false}');
        if (row.banned_until && Number(row.banned_until) > Date.now()) {
            return res.send(`{"success":false,"banned":true,"until":${row.banned_until}}`);
        }
        if (row.status !== 'active') return res.send('{"success":false}');

        let finalExpiresAt = Number(row.expires_at);

        if (row.type === 'license' && finalExpiresAt === 0) {
            finalExpiresAt = Date.now() + Number(row.duration_ms);
            await pool.query('UPDATE licenses SET expires_at = $1 WHERE key = $2', [finalExpiresAt, key]);
        }

        if (finalExpiresAt !== 0 && Date.now() > finalExpiresAt) return res.send('{"success":false}');
        if (!row.login || !row.password) return res.send('{"success":true,"need_register":true}');

        await pool.query('UPDATE licenses SET last_seen = $1, player_name = $2, server_ip = $3 WHERE key = $4', [Date.now(), pName, sIp, key]);

        if (!row.hwid) {
            await pool.query('UPDATE licenses SET hwid = $1 WHERE key = $2', [hwid, key]);
            return res.send('{"success":true}');
        } else {
            if (row.hwid.trim().toUpperCase() === hwid) return res.send('{"success":true}');
            else return res.send('{"success":false}');
        }
    } catch (err) {
        return res.send('{"success":false}');
    }
});

// Регистрация аккаунта пользователя (логин/пароль)
app.get('/api/register-account', async (req, res) => {
    let { key, login, password } = req.query;
    if (!key || !login || !password) return res.send('{"success":false}');
    key = key.trim().toUpperCase();
    const userLogin = decodeURIComponent(login).trim();
    const userPass = decodeURIComponent(password).trim();

    try {
        const checkUser = await pool.query('SELECT id FROM licenses WHERE login = $1', [userLogin]);
        if (checkUser.rows.length > 0) return res.send('{"success":false,"message":"Username already taken"}');

        await pool.query('UPDATE licenses SET login = $1, password = $2 WHERE key = $3', [userLogin, userPass, key]);
        return res.send('{"success":true}');
    } catch (err) {
        return res.send('{"success":false}');
    }
});

// Генерация новой лицензии администратором в панели
app.post('/api/admin/generate-license', async (req, res) => {
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${genPart()}-${genPart()}-${genPart()}-${genPart()}`;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    try {
        await pool.query('INSERT INTO licenses (key, expires_at, duration_ms, type, status) VALUES ($1, 0, $2, \'license\', \'active\')', [newKey, thirtyDaysMs]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// Удаление лицензии из веб-интерфейса
app.post('/api/admin/delete', async (req, res) => { 
    try {
        await pool.query('DELETE FROM licenses WHERE id = $1', [req.body.id]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// Блокировка / Разблокировка ключа
app.post('/api/admin/toggle-status', async (req, res) => { 
    const { id, currentStatus } = req.body; 
    const nextStatus = currentStatus === 'active' ? 'banned' : 'active'; 
    try {
        await pool.query('UPDATE licenses SET status = $1 WHERE id = $2', [nextStatus, id]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// Получение списка всех ключей для отображения в панели управления
app.get('/api/admin/keys', async (req, res) => { 
    try {
        const result = await pool.query('SELECT * FROM licenses ORDER BY id ASC');
        res.json({ success: true, keys: result.rows || [] });
    } catch (err) {
        res.json({ success: false, keys: [] });
    }
});

module.exports = app;

if (!process.env.VERCEL) {
    app.listen(PORT, () => console.log('Локальный сервер запущен на порту ' + PORT));
}
