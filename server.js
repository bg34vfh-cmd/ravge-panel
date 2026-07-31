const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ХАК ДЛЯ VERCEL: Запускаем базу данных прямо в оперативной памяти (:memory:)
const db = new sqlite3.Database(':memory:', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('База данных в памяти Vercel успешно запущена.');
});

// Инициализация структуры таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE,
        hwid TEXT DEFAULT NULL,
        status TEXT DEFAULT 'active',
        expires_at INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        type TEXT DEFAULT 'license',
        last_seen INTEGER DEFAULT 0,
        player_name TEXT DEFAULT '—',
        server_ip TEXT DEFAULT '—',
        banned_until INTEGER DEFAULT 0,
        login TEXT DEFAULT NULL,
        password TEXT DEFAULT NULL
    )`);

    // ЗАШИВАЕМ КЛЮЧИ: При каждом старте Vercel эти ключи будут автоматически создаваться в базе!
    const defaultKeys = [
        "6YZD-5LKM-SW3Y-MSCJ",
        "EFYB-HJYB-RNJL-0MLD",
        "NPN7-B5WR-CEZT-KID9" // Ключ твоего первого покупателя!
    ];
    
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    defaultKeys.forEach(k => {
        db.run('INSERT OR IGNORE INTO licenses (key, expires_at, duration_ms, type, status) VALUES (?, 0, ?, "license", "active")', [k, thirtyDaysMs]);
    });
});

// Роут для Vercel: чтобы главная страница не выдавала ошибку, отдаём index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/verify', (req, res) => {
    let { key, hwid, name, server } = req.query;
    if (!key || !hwid) return res.send('{"success":false}');
    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    const pName = name ? decodeURIComponent(name) : '—';
    const sIp = server ? decodeURIComponent(server) : '—';

    db.get('SELECT * FROM licenses WHERE key = ?', [key], (err, row) => {
        if (err || !row) return res.send('{"success":false}');
        if (row.banned_until && row.banned_until > Date.now()) return res.send(`{"success":false,"banned":true,"until":${row.banned_until}}`);
        if (row.status !== 'active') return res.send('{"success":false}');

        let finalExpiresAt = row.expires_at;

        if (row.type === 'license' && row.expires_at === 0) {
            finalExpiresAt = Date.now() + row.duration_ms;
            db.run('UPDATE licenses SET expires_at = ? WHERE key = ?', [finalExpiresAt, key]);
        }

        if (finalExpiresAt !== 0 && Date.now() > finalExpiresAt) return res.send('{"success":false}');
        if (!row.login || !row.password) return res.send('{"success":true,"need_register":true}');

        db.run('UPDATE licenses SET last_seen = ?, player_name = ?, server_ip = ? WHERE key = ?', [Date.now(), pName, sIp, key]);

        if (!row.hwid) {
            db.run('UPDATE licenses SET hwid = ? WHERE key = ?', [hwid, key], () => { return res.send('{"success":true}'); });
        } else {
            if (row.hwid.trim().toUpperCase() === hwid) return res.send('{"success":true}');
            else return res.send('{"success":false}');
        }
    });
});

app.get('/api/register-account', (req, res) => {
    let { key, login, password } = req.query;
    if (!key || !login || !password) return res.send('{"success":false}');
    key = key.trim().toUpperCase();
    const userLogin = decodeURIComponent(login).trim();
    const userPass = decodeURIComponent(password).trim();

    db.get('SELECT id FROM licenses WHERE login = ?', [userLogin], (err, row) => {
        if (row) return res.send('{"success":false,"message":"Username already taken"}');
        db.run('UPDATE licenses SET login = ?, password = ? WHERE key = ?', [userLogin, userPass, key], () => {
            return res.send('{"success":true}');
        });
    });
});

app.post('/api/admin/generate-license', (req, res) => {
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${genPart()}-${genPart()}-${genPart()}-${genPart()}`;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    db.run('INSERT INTO licenses (key, expires_at, duration_ms, type, status) VALUES (?, 0, ?, "license", "active")', [newKey, thirtyDaysMs], (err) => {
        res.json({ success: !err });
    });
});

app.post('/api/admin/delete', (req, res) => { db.run('DELETE FROM licenses WHERE id = ?', [req.body.id], (err) => { res.json({ success: !err }); }); });
app.post('/api/admin/toggle-status', (req, res) => { const { id, currentStatus } = req.body; const nextStatus = currentStatus === 'active' ? 'banned' : 'active'; db.run('UPDATE licenses SET status = ? WHERE id = ?', [nextStatus, id], (err) => { res.json({ success: !err }); }); });
app.get('/api/admin/keys', (req, res) => { db.all('SELECT * FROM licenses', [], (err, rows) => { res.json({ success: true, keys: rows || [] }); }); });

// Экспортируем приложение для бессерверных функций Vercel
module.exports = app;

app.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
