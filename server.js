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
    // Важно: библиотека pg передаёт JS-массивы/объекты в свой формат Postgres-массива,
    // а не в JSON, поэтому для колонки jsonb значение нужно явно сериализовать в текст
    // и привести типом ::jsonb — иначе INSERT падает с ошибкой "invalid input syntax for type json".
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// ---------------------------------------------------------------------------
// Wildberries: остатки на складах ВБ (Statistics API).
// У этого метода жёсткий лимит — 1 запрос в минуту, поэтому мы не дёргаем его
// на каждое открытие сайта, а раз в 20 минут сами тянем данные и кладём
// последний снимок в ту же таблицу app_state (ключ "wb_stock_cache").
// Сайт всегда читает уже готовый кэш через GET /api/wb/stock.
const WB_API_TOKEN = process.env.WB_API_TOKEN || null;
// Старый метод statistics-api.wildberries.ru/api/v1/supplier/stocks Wildberries отключил 20.07.2026.
// Актуальный метод — Stocks Report (категория токена "Аналитика"), домен seller-analytics-api.wildberries.ru.
const WB_STOCKS_URL = "https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses";

async function fetchWbStocksFromWildberries() {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  let offset = 0;
  const limit = 100000;
  let allItems = [];
  for (let page = 0; page < 10; page++) { // защита от бесконечного цикла
    const res = await fetch(WB_STOCKS_URL, {
      method: "POST",
      headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ limit, offset }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("WB API ответил " + res.status + ": " + text);
    }
    const json = await res.json();
    const items = (json && json.data && json.data.items) || [];
    allItems = allItems.concat(items);
    if (items.length < limit) break;
    offset += limit;
  }
  return allItems;
}

async function refreshWbStockCache() {
  try {
    const data = await fetchWbStocksFromWildberries();
    const snapshot = { fetchedAt: new Date().toISOString(), rows: data, error: null };
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ('wb_stock_cache', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
    console.log("WB stock cache refreshed:", Array.isArray(data) ? data.length : 0, "rows");
  } catch (e) {
    console.error("Failed to refresh WB stock cache:", e.message);
    // Сохраняем ошибку в кэш, чтобы сайт мог её показать вместо молчаливого "пусто"
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ('wb_stock_cache', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = app_state.value || $1::jsonb, updated_at = now()`,
      [JSON.stringify({ error: e.message, checkedAt: new Date().toISOString() })]
    ).catch(() => {});
  }
}

// Отдаёт последний сохранённый снимок остатков ВБ (без обращения к самому WB на каждый запрос)
app.get("/api/wb/stock", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_state WHERE key = 'wb_stock_cache'");
    if (rows.length === 0) return res.json({ fetchedAt: null, rows: [], error: null });
    res.json(rows[0].value);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// Принудительное обновление кэша прямо сейчас (для ручной проверки), требует X-Api-Key
app.post("/api/wb/stock/refresh", requireApiKey, async (req, res) => {
  await refreshWbStockCache();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Wildberries: карточки товаров (Content API) — нужны для артикула продавца
// (vendorCode) и фото по товарам, которых нет в нашем собственном списке.
const WB_CARDS_URL = "https://content-api.wildberries.ru/content/v2/get/cards/list";

async function fetchWbCardsFromWildberries() {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  let cursor = { limit: 100 };
  let allCards = [];
  for (let page = 0; page < 50; page++) { // защита от бесконечного цикла
    const res = await fetch(WB_CARDS_URL, {
      method: "POST",
      headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: { sort: { ascending: true }, cursor: cursor, filter: { withPhoto: -1 } },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("WB Content API ответил " + res.status + ": " + text);
    }
    const json = await res.json();
    const cards = json.cards || [];
    allCards = allCards.concat(cards);
    const nextCursor = json.cursor || {};
    if (!cards.length || cards.length < cursor.limit) break;
    cursor = { updatedAt: nextCursor.updatedAt, nmID: nextCursor.nmID, limit: 100 };
  }
  return allCards;
}

async function refreshWbCardsCache() {
  try {
    const cards = await fetchWbCardsFromWildberries();
    // Оставляем только то, что реально нужно сайту, чтобы не раздувать базу
    const slim = cards.map(function (c) {
      var photo = null;
      if (Array.isArray(c.photos) && c.photos.length) {
        var p = c.photos[0];
        // square/c246x328 — небольшие превью, удобные для таблицы; big — на случай, если их нет
        photo = p.square || p.c246x328 || p.tm || p.big || null;
      }
      return { nmID: c.nmID, vendorCode: c.vendorCode, title: c.title, photo: photo };
    });
    const snapshot = { fetchedAt: new Date().toISOString(), cards: slim, error: null };
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ('wb_cards_cache', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
    console.log("WB cards cache refreshed:", slim.length, "cards");
  } catch (e) {
    console.error("Failed to refresh WB cards cache:", e.message);
  }
}

app.get("/api/wb/cards", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_state WHERE key = 'wb_cards_cache'");
    if (rows.length === 0) return res.json({ fetchedAt: null, cards: [], error: null });
    res.json(rows[0].value);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

app.post("/api/wb/cards/refresh", requireApiKey, async (req, res) => {
  await refreshWbCardsCache();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log("wb-ostatki-api listening on " + PORT));
    if (WB_API_TOKEN) {
      refreshWbStockCache(); // сразу при старте сервиса
      refreshWbCardsCache();
      setInterval(refreshWbStockCache, 20 * 60 * 1000); // и затем каждые 20 минут
      setInterval(refreshWbCardsCache, 20 * 60 * 1000);
    } else {
      console.log("WB_API_TOKEN не задан — синхронизация остатков ВБ отключена");
    }
  })
  .catch((e) => {
    console.error("Failed to init schema", e);
    process.exit(1);
  });
