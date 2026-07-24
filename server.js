// wb-ostatki-api
// Простой backend-фундамент для сайта "Остатки товара".
// Сейчас хранит: порядок строк по вкладкам (общий для всех устройств).
// Задуман как основа, на которую позже можно добавить:
//   - синхронизацию остатков через Wildberries Seller API
//   - ИИ-помощника с рекомендациями по товару
//
// Хранение: одна универсальная таблица key -> value(jsonb).
// Это сознательно простая схема, чтобы не переделывать структуру БД
// при добавлении новых видов данных в будущем.

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined,
});

const API_KEY = process.env.API_KEY || null;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // если ключ не задан в переменных окружения — не требуем (для быстрого старта)
  const provided = req.header("X-Api-Key");
  if (provided !== API_KEY) {
    return res.status(401).json({ error: "invalid or missing X-Api-Key" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Чтение произвольного значения по ключу (без авторизации — только чтение)
app.get("/api/state/:key", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value, updated_at FROM app_state WHERE key = $1",
      [req.params.key]
    );
    if (rows.length === 0) return res.json({ key: req.params.key, value: null });
    res.json({ key: req.params.key, value: rows[0].value, updated_at: rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// Запись значения по ключу (требует X-Api-Key, если задан API_KEY)
app.put("/api/state/:key", requireApiKey, async (req, res) => {
  try {
    const value = req.body;
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log("wb-ostatki-api listening on " + PORT));
  })
  .catch((e) => {
    console.error("Failed to init schema", e);
    process.exit(1);
  });
