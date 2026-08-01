const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// БАЗА ДАННЫХ В ВИДЕ ОБЫЧНОГО JS-МАССИВА
let licenses = [
    { id: 1, key: "6YZD-5LKM-SW3Y-MSCJ", hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000, type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null },
    { id: 2, key: "EFYB-HJYB-RNJL-0MLD", hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000, type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null },
    { id: 3, key: "NPN7-B5WR-CEZT-KID9", hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000, type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null }
];

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Проверка лицензии из чита
app.get('/api/verify', (req, res) => {
    let { key, hwid, name, server } = req.query;
    if (!key || !hwid) return res.send('{"success":false}');
    key = key.trim().toUpperCase();
    hwid = hwid.trim().toUpperCase();
    const pName = name ? decodeURIComponent(name) : '—';
    const sIp = server ? decodeURIComponent(server) : '—';

    let row = licenses.find(l => l.key === key);
    if (!row) return res.send('{"success":false}');
    if (row.banned_until && row.banned_until > Date.now()) return res.send(`{"success":false,"banned":true,"until":${row.banned_until}}`);
    if (row.status !== 'active') return res.send('{"success":false}');

    if (row.type === 'license' && row.expires_at === 0) {
        row.expires_at = Date.now() + row.duration_ms;
    }

    if (row.expires_at !== 0 && Date.now() > row.expires_at) return res.send('{"success":false}');
    if (!row.login || !row.password) return res.send('{"success":true,"need_register":true}');

    row.last_seen = Date.now();
    row.player_name = pName;
    row.server_ip = sIp;

    if (!row.hwid) {
        row.hwid = hwid;
        return res.send('{"success":true}');
    } else {
        if (row.hwid.trim().toUpperCase() === hwid) return res.send('{"success":true}');
        else return res.send('{"success":false}');
    }
});

// Регистрация аккаунта из чита
app.get('/api/register-account', (req, res) => {
    let { key, login, password } = req.query;
    if (!key || !login || !password) return res.send('{"success":false}');
    key = key.trim().toUpperCase();
    const userLogin = decodeURIComponent(login).trim();
    const userPass = decodeURIComponent(password).trim();

    let checkLogin = licenses.find(l => l.login === userLogin);
    if (checkLogin) return res.send('{"success":false,"message":"Username already taken"}');

    let row = licenses.find(l => l.key === key);
    if (row) {
        row.login = userLogin;
        row.password = userPass;
        return res.send('{"success":true}');
    }
    return res.send('{"success":false}');
});

// Генерация нового ключа из админки
app.post('/api/admin/generate-license', (req, res) => {
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${genPart()}-${genPart()}-${genPart()}-${genPart()}`;
    const newId = licenses.length > 0 ? licenses[licenses.length - 1].id + 1 : 1;
    
    licenses.push({
        id: newId, key: newKey, hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000,
        type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null
    });
    res.json({ success: true });
});

// Продление подписки (ВОЗВРАЩЕНО!)
app.post('/api/admin/extend', (req, res) => {
    const targetId = parseInt(req.body.id);
    const value = parseInt(req.body.timeInput) || 30; // По умолчанию продлеваем на 30 дней
    const addMs = value * 24 * 60 * 60 * 1000;

    let row = licenses.find(l => l.id === targetId);
    if (row) {
        if (row.expires_at === 0) {
            row.duration_ms += addMs;
        } else {
            let baseTime = row.expires_at < Date.now() ? Date.now() : row.expires_at;
            row.expires_at = baseTime + addMs;
        }
        return res.json({ success: true });
    }
    res.json({ success: false });
});

// Удаление ключа
app.post('/api/admin/delete', (req, res) => {
    licenses = licenses.filter(l => l.id !== parseInt(req.body.id));
    res.json({ success: true });
});

// ИСПРАВЛЕНО: Рабочий роут изменения статуса бана
app.post('/api/admin/toggle-status', (req, res) => {
    const targetId = parseInt(req.body.id);
    let row = licenses.find(l => l.id === targetId);
    if (row) {
        row.status = row.status === 'active' ? 'banned' : 'active';
        return res.json({ success: true });
    }
    res.json({ success: false });
});

// Вывод ключей на страницу сайта
app.get('/api/admin/keys', (req, res) => {
    res.json({ success: true, keys: licenses });
});

module.exports = app;
app.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
