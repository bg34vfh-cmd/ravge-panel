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
                duration_ms BIGINT DEFAULT 0,
                expires_at TIMESTAMP DEFAULT NULL,
                is_banned BOOLEAN DEFAULT FALSE,
                last_name VARCHAR(255) DEFAULT '—',
                last_server VARCHAR(255) DEFAULT 'Оффлайн',
                last_seen TIMESTAMP DEFAULT NOW()
            );
        `);

        // 2. Миграция: добавляем колонку duration_ms для заморозки времени, если её нет
        const checkDuration = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='licenses' AND column_name='duration_ms';
        `);
        if (checkDuration.rows.length === 0) {
            await pool.query(`ALTER TABLE licenses ADD COLUMN duration_ms BIGINT DEFAULT 0;`);
        }

        // 3. Миграция: проверяем и добавляем колонку web_login, если её нет
        const checkLogin = await pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='licenses' AND column_name='web_login';
        `);
        if (checkLogin.rows.length === 0) {
            await pool.query(`ALTER TABLE licenses ADD COLUMN web_login VARCHAR(255) DEFAULT '—';`);
        }

        isDbInitialized = true;
        console.log("База данных успешно инициализирована и проверена.");
    } catch (err) {
        console.error("Ошибка инициализации базы данных:", err);
    }
}

// Middleware для парсинга JSON и URL-encoded данных
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware автоматического контроля готовности БД при каждом запросе
app.use(async (req, res, next) => {
    await ensureDatabaseReady();
    next();
});

/* ==========================================================================
   API ДЛЯ КЛИЕНТСКОГО СОФТА (АВТОРИЗАЦИЯ И ПРОВЕРКА HWID)
   ========================================================================== */

app.post('/api/auth', async (req, res) => {
    const { license_key, hwid, server_name } = req.body;

    if (!license_key) {
        return res.status(400).json({ success: false, message: "Отсутствует ключ лицензии." });
    }

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [license_key]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Лицензия не найдена." });
        }

        const license = result.rows[0]; // Исправлено: берем первый элемент массива строк

        if (license.is_banned) {
            return res.status(403).json({ success: false, message: "Данная лицензия заблокирована." });
        }

        // Если привязка HWID уже существует, проверяем на совпадение
        if (license.hwid && hwid && license.hwid !== hwid) {
            return res.status(403).json({ success: false, message: "Ошибка авторизации: неверный HWID." });
        }

        // ПРОВЕРКА НА ПЕРВЫЙ ВХОД: Если логин не задан (дефолтное значение '—')
        if (!license.web_login || license.web_login === '—') {
            return res.json({ 
                success: true, 
                need_registration: true, 
                message: "Введите .reg логин пароль" 
            });
        }

        const now = new Date();

        // Проверка на заморозку ключа (expires_at равен null, но есть оставшееся время)
        if (!license.expires_at && license.duration_ms > 0) {
            return res.status(403).json({ success: false, message: "Лицензия сейчас заморожена." });
        }

        // Проверка истечения срока действия активного ключа
        if (license.expires_at && new Date(license.expires_at) < now) {
            return res.status(403).json({ success: false, message: "Срок действия лицензии истек." });
        }

        // Обновляем данные сессии софта (HWID привязывается при первом входе)
        const updated = await pool.query(
            `UPDATE licenses 
             SET hwid = COALESCE(hwid, $1), 
                 last_server = $2, 
                 last_seen = NOW() 
             WHERE id = $3 RETURNING *`,
            [hwid, server_name || 'Активен', license.id]
        );

        res.json({ 
            success: true, 
            need_registration: false,
            message: "Авторизация успешна.", 
            expires_at: updated.rows[0].expires_at 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Внутренняя ошибка сервера." });
    }
});

// Эндпоинт для обработки команды .reg из чата игры
app.post('/api/auth/register_command', async (req, res) => {
    const { license_key, web_login } = req.body;

    if (!license_key || !web_login || web_login === '—') {
        return res.status(400).json({ success: false, message: "Некорректные регистрационные данные." });
    }

    try {
        const result = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [license_key]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Лицензия не найдена." });
        }

        const license = result.rows[0];

        if (license.is_banned) {
            return res.status(403).json({ success: false, message: "Данная лицензия заблокирована." });
        }

        // Если дата окончания еще не установлена (ключ ни разу не активировался через веб)
        let expiresAt = license.expires_at;
        if (!expiresAt) {
            const duration = license.duration_ms > 0 ? parseInt(license.duration_ms) : 30 * 24 * 60 * 60 * 1000;
            expiresAt = new Date(Date.now() + duration);
        }

        // Сохраняем введенный .reg логин/пароль и активируем временные рамки
        await pool.query(
            `UPDATE licenses 
             SET web_login = $1, 
                 expires_at = $2, 
                 duration_ms = 0,
                 last_seen = NOW() 
             WHERE id = $3`,
            [web_login, expiresAt, license.id]
        );

        res.json({ 
            success: true, 
            message: "Регистрация успешна! Функционал чита открыт.",
            expires_at: expiresAt
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Ошибка при регистрации аккаунта." });
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Сервер запущен и ожидает запросов на порту: ${PORT}`);
});
