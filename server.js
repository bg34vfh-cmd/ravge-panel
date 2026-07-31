const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Сбор системных переменных баз данных от Vercel
const connectionString = process.env.POSTGRES_URL || process.env.STORAGE_URL || process.env.POSTGRES_URL_NON_POOLING;

// Инициализация пула
const pool = connectionString 
    ? new Pool({ connectionString: connectionString.includes("sslmode") ? connectionString : connectionString + "?sslmode=require" })
    : null;

// Флаг, чтобы не проверять базу данных при каждом запросе
let isDbInitialized = false;

// Безопасная функция инициализации структуры таблиц
const initDB = async () => {
    if (isDbInitialized) return;
    if (!pool) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА: Переменные базы данных не найдены в Vercel!");
        return;
    }

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

        // Проверка миграции ключей покупателей
        const checkKeys = await pool.query('SELECT id FROM licenses LIMIT 1');
        if (checkKeys.rows.length === 0) {
            const backupKeys = [
                "6YZD-5LKM-SW3Y-MSCJ",
                "E000-0000-0000-0000"
            ];

            for (const key of backupKeys) {
                await pool.query(
                    'INSERT INTO licenses (key) VALUES ($1) ON CONFLICT (key) DO NOTHING',
                    [key]
                );
            }
        }
        isDbInitialized = true;
    } catch (err) {
        console.error('Ошибка в процессе работы с базой данных:', err);
    }
};

// Middleware: Инициализируем базу данных при первом запросе к серверу
app.use(async (req, res, next) => {
    try {
        await initDB();
    } catch (e) {
        console.error("Не удалось инициализировать БД:", e);
    }
    next();
});

// Главная страница панели (отдает index.html из папки public)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            res.status(500).send("Файл index.html не найден в папке public");
        }
    });
});

// Базовый эндпоинт для проверки работоспособности
app.get('/api/status', (req, res) => {
    res.json({ 
        status: "online", 
        database_connected: !!pool,
        database_initialized: isDbInitialized
    });
});

// Роут для проверки лицензии
app.post('/api/check-license', async (req, res) => {
    const { key } = req.body;
    if (!pool) return res.status(500).json({ error: "База данных недоступна" });
    if (!key) return res.status(400).json({ error: "Ключ не указан" });

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
        if (result.rows.length === 0) {
            return res.status(404).json({ status: "not_found" });
        }
        res.json({ status: "success", license: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Ошибка сервера при проверке" });
    }
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Локальный сервер запущен на порту ${PORT}`);
    });
}
