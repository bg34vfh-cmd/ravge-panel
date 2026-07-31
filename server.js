const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Настройка middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Автоматический сбор системных переменных баз данных от Vercel
const connectionString = process.env.POSTGRES_URL || process.env.STORAGE_URL || process.env.POSTGRES_URL_NON_POOLING;

// Инициализация пула только при наличии строки подключения, чтобы избежать фатального сбоя
const pool = connectionString 
    ? new Pool({ connectionString: connectionString.includes("sslmode") ? connectionString : connectionString + "?sslmode=require" })
    : null;

// Инициализация структуры таблиц в облаке Neon
const initDB = async () => {
    if (!pool) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА: Переменные базы данных не найдены в Vercel! Проверьте Environment Variables.");
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
        console.log('Облачная база Postgres успешно подключена и структура проверена.');

        // Проверка миграции: если в облаке пусто, заливаем ключи покупателей
        const checkKeys = await pool.query('SELECT id FROM licenses LIMIT 1');
        if (checkKeys.rows.length === 0) {
            console.log('Облако пустое. Переносим ключи покупателей...');
            
            // Список ваших ключей (добавьте сюда все нужные ключи)
            const backupKeys = [
                "6YZD-5LKM-SW3Y-MSCJ",
                "E000-0000-0000-0000" // Исправлен оборванный ключ из вашего примера
            ];

            // Безопасный импорт через цикл, предотвращающий дублирование (ON CONFLICT)
            for (const key of backupKeys) {
                await pool.query(
                    'INSERT INTO licenses (key) VALUES ($1) ON CONFLICT (key) DO NOTHING',
                    [key]
                );
            }
            console.log('Миграция резервных ключей успешно завершена.');
        }
    } catch (err) {
        console.error('Ошибка в процессе работы с базой данных:', err);
    }
};

// Запуск инициализации БД
initDB();

// Базовые эндпоинты для проверки работоспособности панели
app.get('/api/status', (req, res) => {
    res.json({ 
        status: "online", 
        database_connected: !!pool 
    });
});

// Пример роута для проверки лицензии (для теста)
app.post('/api/check-license', async (req, res) => {
    const { key } = req.body;
    if (!pool) return res.status(500).json({ error: "База данных недоступна" });
    if (!key) return res.status(400).json({ error: "Ключ не указан" });

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
        if (result.rows.length === 0) {
            return res.status(404).json({ status: "not_found" });
        }
        res.json({ status: "success", license: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "Ошибка сервера при проверке" });
    }
});

// Экспорт для Vercel Serverless environment
module.exports = app;

// Локальный запуск (если скрипт запускается не в Vercel, а через node index.js)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Локальный сервер запущен на порту ${PORT}`);
    });
}
