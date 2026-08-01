const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let licenses = [
    { id: 1, key: "6YZD-5LKM-SW3Y-MSCJ", hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000, type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null },
    { id: 2, key: "EFYB-HJYB-RNJL-0MLD", hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000, type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null },
    { id: 3, key: "NPN7-B5WR-CEZT-KID9", hwid: null, status: "active", expires_at: 0, duration_ms: 30 * 24 * 60 * 60 * 1000, type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null }
];

function parseTimeToMs(timeInput) {
    if (!timeInput) return 30 * 24 * 60 * 60 * 1000;
    const value = parseInt(timeInput) || 30;
    const unit = timeInput.toString().toLowerCase().replace(/[0-9]/g, '').trim();
    
    if (unit === 'm' || unit === 'мин') return value * 60 * 1000;
    if (unit === 'h' || unit === 'ч') return value * 60 * 60 * 1000;
    if (unit === 'd' || unit === 'д' || unit === 'дней') return value * 24 * 60 * 60 * 1000;
    return value * 24 * 60 * 60 * 1000;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ПРОВЕРКА ПАРОЛЯ АДМИНКИ СЕРВЕРОМ
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === 'coco2012coco!') {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

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

app.post('/api/admin/generate-license', (req, res) => {
    const { timeInput } = req.body;
    const genPart = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    const newKey = `${genPart()}-${genPart()}-${genPart()}-${genPart()}`;
    const newId = licenses.length > 0 ? licenses[licenses.length - 1].id + 1 : 1;
    
    const addMs = parseTimeToMs(timeInput);

    licenses.push({
        id: newId, key: newKey, hwid: null, status: "active", expires_at: 0, duration_ms: addMs,
        type: "license", last_seen: 0, player_name: "—", server_ip: "—", banned_until: 0, login: null, password: null
    });
    res.json({ success: true });
});

app.post('/api/admin/extend', (req, res) => {
    const targetId = parseInt(req.body.id);
    const addMs = parseTimeToMs(req.body.timeInput);

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

app.post('/api/admin/delete', (req, res) => {
    licenses = licenses.filter(l => l.id !== parseInt(req.body.id));
    res.json({ success: true });
});

app.post('/api/admin/toggle-status', (req, res) => {
    const targetId = parseInt(req.body.id);
    let row = licenses.find(l => l.id === targetId);
    if (row) {
        row.status = row.status === 'active' ? 'banned' : 'active';
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.get('/api/admin/keys', (req, res) => {
    res.json({ success: true, keys: licenses });
});

module.exports = app;
app.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
