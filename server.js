const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./keys.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('База данных SQLite успешно запущена.');
});

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

        // ЛОГИКА АКТИВАЦИИ: Если ключ вводится впервые, запускаем таймер подписки!
        if (row.type === 'license' && row.expires_at === 0) {
            finalExpiresAt = Date.now() + row.duration_ms;
            db.run('UPDATE licenses SET expires_at = ? WHERE key = ?', [finalExpiresAt, key]);
            console.log(`[АКТИВАЦИЯ] Ключ ${key} успешно активирован игроком ${pName}! Таймер запущен.`);
        }

        // Проверка на истечение времени (только если таймер уже запущен)
        if (finalExpiresAt !== 0 && Date.now() > finalExpiresAt) return res.send('{"success":false}');

        if (!row.login || !row.password) {
            return res.send('{"success":true,"need_register":true}');
        }

        db.run('UPDATE licenses SET last_seen = ?, player_name = ?, server_ip = ? WHERE key = ?', [Date.now(), pName, sIp, key]);

        if (!row.hwid) {
            db.run('UPDATE licenses SET hwid = ? WHERE key = ?', [hwid, key], (updErr) => {
                if (updErr) return res.send('{"success":false}');
                return res.send('{"success":true}');
            });
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

        db.run('UPDATE licenses SET login = ?, password = ? WHERE key = ?', [userLogin, userPass, key], (updErr) => {
            if (updErr) return res.send('{"success":false}');
            console.log(`[БАЗА] Успешная регистрация аккаунта: ${userLogin}`);
            return res.send('{"success":true}');
        });
    });
});

app.post('/api/admin/generate-license', (req, res) => {
    const { timeInput } = req.body;
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${genPart()}-${genPart()}-${genPart()}-${genPart()}`;
    
    let addMs = 30 * 24 * 60 * 60 * 1000; 
    
    if (timeInput) {
        const value = parseInt(timeInput) || 30;
        const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
        
        if (unit === 'm' || unit === 'мин') addMs = value * 60 * 1000;
        else if (unit === 'h' || unit === 'ч') addMs = value * 60 * 60 * 1000;
        else if (unit === 'd' || unit === 'д' || unit === 'дней') addMs = value * 24 * 60 * 60 * 1000;
    }

    // Сохраняем длительность в duration_ms, а expires_at оставляем 0 до первой активации!
    db.run('INSERT INTO licenses (key, expires_at, duration_ms, type, status) VALUES (?, 0, ?, "license", "active")', [newKey, addMs], (err) => {
        if (err) return res.json({ success: false });
        return res.json({ success: true });
    });
});

app.post('/api/admin/generate-reset', (req, res) => {
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `RESET-${genPart()}-${genPart()}`;
    db.run('INSERT INTO licenses (key, type, expires_at, duration_ms, status) VALUES (?, "reset", 0, 0, "active")', [newKey], (err) => {
        if (err) return res.json({ success: false });
        return res.json({ success: true });
    });
});

app.post('/api/admin/timeout', (req, res) => {
    const { id, timeInput } = req.body;
    if (!id || !timeInput) return res.json({ success: false });
    const value = parseInt(timeInput);
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    let banMs = value * 24 * 60 * 60 * 1000;
    if (unit === 'm' || unit === 'мин') banMs = value * 60 * 1000;
    else if (unit === 'h' || unit === 'ч') banMs = value * 60 * 60 * 1000;
    db.run('UPDATE licenses SET banned_until = ? WHERE id = ?', [Date.now() + banMs, id], (err) => { res.json({ success: !err }); });
});

app.post('/api/admin/extend', (req, res) => {
    const { id, timeInput } = req.body;
    const value = parseInt(timeInput);
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    let addMs = value * 24 * 60 * 60 * 1000;
    if (unit === 'm' || unit === 'мин') addMs = value * 60 * 1000;
    else if (unit === 'h' || unit === 'ч') addMs = value * 60 * 60 * 1000;
    db.get('SELECT expires_at, duration_ms FROM licenses WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.json({ success: false });
        if (row.expires_at === 0) {
            // Если ключ еще не активирован, просто увеличиваем его заготовленную длительность
            db.run('UPDATE licenses SET duration_ms = ? WHERE id = ?', [row.duration_ms + addMs, id], (updErr) => { res.json({ success: !updErr }); });
        } else {
            let baseTime = row.expires_at < Date.now() ? Date.now() : row.expires_at;
            db.run('UPDATE licenses SET expires_at = ? WHERE id = ?', [baseTime + addMs, id], (updErr) => { res.json({ success: !updErr }); });
        }
    });
});

app.get('/api/logout', (req, res) => {
    let { key } = req.query;
    if (key) db.run('UPDATE licenses SET last_seen = 0, server_ip = "—" WHERE key = ?', [key.trim().toUpperCase()], () => { res.send('{"success":true}'); });
    else res.send('{"success":false}');
});

app.get('/api/reset-hwid', (req, res) => {
    let { resetKey } = req.query;
    if (!resetKey) return res.send('{"success":false}');
    db.get('SELECT * FROM licenses WHERE key = ? AND type = "reset"', [resetKey.trim().toUpperCase()], (err, resetRow) => {
        if (err || !resetRow || resetRow.status !== 'active') return res.send('{"success":false}');
        db.run('UPDATE licenses SET hwid = NULL WHERE type = "license"', (updErr) => {
            if (updErr) return res.send('{"success":false}');
            db.run('DELETE FROM licenses WHERE id = ?', [resetRow.id], () => { res.send('{"success":true}'); });
        });
    });
});

app.post('/api/admin/delete', (req, res) => { db.run('DELETE FROM licenses WHERE id = ?', [req.body.id], (err) => { res.json({ success: !err }); }); });
app.post('/api/admin/toggle-status', (req, res) => { const { id, currentStatus } = req.body; const nextStatus = currentStatus === 'active' ? 'banned' : 'active'; db.run('UPDATE licenses SET status = ? WHERE id = ?', [nextStatus, id], (err) => { res.json({ success: !err }); }); });
app.get('/api/admin/keys', (req, res) => { db.all('SELECT * FROM licenses', [], (err, rows) => { res.json({ success: true, keys: rows || [] }); }); });
app.listen(PORT, () => console.log('Сервер успешно перезапущен на порту ' + PORT));
