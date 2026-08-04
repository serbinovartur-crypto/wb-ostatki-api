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
const crypto = require("crypto");

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

// ---------------------------------------------------------------------------
// Telegram-уведомления: бэкенд сам шлёт сообщения боту напрямую (не через
// Claude), чтобы это работало независимо от того, открыто ли приложение Claude.
// Правило простое: пишем только когда есть что сказать — либо реальная
// ошибка/проблема, либо факт списания по конкретной поставке/отгрузке.
// Никаких ежедневных "всё в порядке" сообщений специально не делаем.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

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

// Ручная проверка Telegram-уведомлений (например, после смены токена/chat_id). Требует X-Api-Key.
app.get("/api/telegram/test", requireApiKey, async (req, res) => {
  try {
    await sendTelegram("✅ Тестовое сообщение. Если ты это видишь — уведомления по ФБС/ФБО настроены и работают.");
    res.json({ ok: true, sent: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
// "Реальный" остаток по конкретной карточке (проверка/сверка вручную) —
// в отличие от общего кэша (/api/wb/stock), тут остаток разбит по конкретным
// складам и сразу отфильтрован по признаку "склад сейчас активен" (поле
// isActive в /api/v1/warehouses). Нужно из-за того, что часть складов ВБ
// физически сгорела/закрыта, а в обычном кэше остатков их товар всё ещё
// числится — из-за этого сайт показывал больше, чем реально можно купить.
// Метод "Данные по размеру" — тот же токен категории "Аналитика", что и для
// /stocks-report/wb-warehouses (seller-analytics-api.wildberries.ru).
// Важно: это НЕ гарантированно совпадает день-в-день с тем, что видит живой
// покупатель в корзине (тот учитывает ещё и доставку в конкретный регион,
// и обновляется быстрее раза в час) — но исключает склады, которые WB сам
// считает закрытыми, чего наш обычный кэш не делал вообще.
const WB_WAREHOUSES_URL = "https://supplies-api.wildberries.ru/api/v1/warehouses";
const WB_STOCK_SIZES_URL = "https://seller-analytics-api.wildberries.ru/api/v2/stocks-report/products/sizes";

async function fetchWbWarehouses() {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  const res = await fetch(WB_WAREHOUSES_URL, { headers: { Authorization: WB_API_TOKEN } });
  if (!res.ok) throw new Error("supplies-api /warehouses " + res.status + ": " + (await res.text().catch(() => "")));
  return await res.json();
}

async function fetchRealStockForNm(nmID) {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(WB_STOCK_SIZES_URL, {
    method: "POST",
    headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      nmID: Number(nmID),
      currentPeriod: { start: today, end: today },
      stockType: "wb",
      orderBy: { field: "avgOrders", mode: "asc" },
      includeOffice: true,
    }),
  });
  if (!res.ok) throw new Error("seller-analytics-api /stocks-report/products/sizes " + res.status + ": " + (await res.text().catch(() => "")));
  const json = await res.json();
  return (json && json.data) || { offices: [], sizes: [] };
}

// Скрещивает разбивку остатка по складам (per-размер) со списком складов и их
// статусом активности, отдаёт и "сырой" итог (как в обычном API), и
// "реальный" (только активные склады) — чтобы было видно разницу.
async function fetchRealStockFiltered(nmID) {
  const [sizeData, warehouses] = await Promise.all([
    fetchRealStockForNm(nmID),
    fetchWbWarehouses(),
  ]);
  const activeByName = {};
  (warehouses || []).forEach(function (w) {
    activeByName[w.name] = w.isActive !== false;
  });
  const sizes = (sizeData.sizes || []).map(function (sz) {
    let rawTotal = 0;
    let realTotal = 0;
    const byWarehouse = (sz.offices || []).map(function (o) {
      const qty = (o.metrics && o.metrics.stockCount) || 0;
      rawTotal += qty;
      const known = Object.prototype.hasOwnProperty.call(activeByName, o.officeName);
      const isActive = known ? activeByName[o.officeName] : true; // неизвестный склад — не зануляем на всякий случай
      if (isActive) realTotal += qty;
      return { officeName: o.officeName, qty: qty, isActive: isActive, knownWarehouse: known };
    });
    return { techSize: sz.name, chrtID: sz.chrtID, rawTotal: rawTotal, realTotal: realTotal, byWarehouse: byWarehouse };
  });
  return { nmID: Number(nmID), sizes: sizes, fetchedAt: new Date().toISOString() };
}

// Временный отладочный эндпоинт — сырой список складов ВБ с их isActive,
// нужен только чтобы вручную сверить имена складов с тем, что возвращает
// отчёт по остаткам (см. fetchRealStockFiltered). Не выдаёт токен, безопасно
// оставить без авторизации.
app.get("/api/wb/warehouses-raw", async (req, res) => {
  try {
    const data = await fetchWbWarehouses();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Только для ручной проверки конкретного товара — не кэшируется и не
// вызывается по расписанию (у метода жёсткий лимит запросов), поэтому дергать
// его для всех 18 товаров разом нельзя, только по одному nmID за раз.
app.get("/api/wb/real-stock/:nmId", async (req, res) => {
  try {
    const data = await fetchRealStockFiltered(req.params.nmId);
    res.json(data);
  } catch (e) {
    console.error("real-stock error:", e.message);
    res.status(500).json({ error: e.message });
  }
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
      // sizes нужны, чтобы потом сопоставлять chrtID (из заказов FBS) и techSize
      // (из приёмки FBO) с нашими размерами S/M/L/XL/XXL.
      var sizes = Array.isArray(c.sizes) ? c.sizes.map(function (s) {
        return { chrtID: s.chrtID, techSize: s.techSize, wbSize: s.wbSize, skus: s.skus || [] };
      }) : [];
      return { nmID: c.nmID, vendorCode: c.vendorCode, title: c.title, photo: photo, sizes: sizes };
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

// ---------------------------------------------------------------------------
// Заказы (спрос) за период — нужно для расчёта, сколько поставить на неделю.
// Метод старый (Statistics API v1), но, в отличие от /supplier/stocks,
// Wildberries его пока не отключал. Считаем каждый некэнселенный заказ как
// 1 проданную единицу; nmId+techSize берём прямо из ответа (строкой), поэтому
// сопоставление с chrtId/картой размеров тут не нужно.
const WB_ORDERS_STAT_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/orders";

async function fetchWbOrdersStats(dateFromISO) {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  const url = WB_ORDERS_STAT_URL + "?dateFrom=" + encodeURIComponent(dateFromISO) + "&flag=0";
  const res = await fetch(url, { headers: { Authorization: WB_API_TOKEN } });
  if (!res.ok) throw new Error("statistics-api /orders " + res.status + ": " + (await res.text().catch(() => "")));
  return await res.json();
}

// Отдаёт агрегат "сколько штук заказано за период" по каждому nmId+techSize —
// сырые данные, агрегацию по нашим товарам/названиям делает сайт сам
// (у него уже есть sku -> имя товара из своей вёрстки).
app.get("/api/wb/orders-summary", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 30);
    const dateFrom = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const orders = await fetchWbOrdersStats(dateFrom);
    const byKey = {};
    (orders || []).forEach(function (o) {
      if (o.isCancel) return; // отменённые не считаем спросом
      const key = String(o.nmId) + "|" + (o.techSize || "");
      if (!byKey[key]) byKey[key] = { nmId: o.nmId, techSize: o.techSize || null, qty: 0 };
      byKey[key].qty += 1;
    });
    res.json({ days: days, dateFrom: dateFrom, items: Object.values(byKey) });
  } catch (e) {
    console.error("Failed to fetch WB orders stats:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Автоматическое списание остатков при отгрузке (ФБС) и приёмке (ФБО).
//
// Идея: остатки по размерам (Упакованные/Неупакованные) теперь хранятся не в
// статичном HTML, а в этой же БД (ключи "stock_packed" / "stock_unpacked",
// формат { "Название товара": { S,M,L,XL,XXL } }). "Общее" на сайте всегда
// считается как их сумма — отдельно не хранится, чтобы не расходиться.
//
// ФБС: триггер — поставка (marketplace-api) перешла в статус "в доставке"
// (поле done=true, включается методом .../deliver). Как только видим новую
// такую поставку, находим её заказы (метод /api/v3/orders, поле supplyId)
// и списываем по 1 шт. за заказ.
//
// ФБО: триггер — в отчёте по поставке (supplies-api, .../goods) выросло поле
// acceptedQuantity по конкретному штрихкоду ("Принято"). Списываем именно
// дельту (разницу с прошлым разом), а не всё количество поставки сразу.
//
// Сопоставление "какой nmId/chrtId — какой наш товар и размер" — через:
//  - "sku_product_map": { "nmId": "Название товара" } — заполняется вручную
//    (через PUT /api/state/sku_product_map), т.к. это те же данные, что уже
//    введены на сайте (артикулы в колонке "Артикул").
//  - карточки WB (wb_cards_cache) — там же теперь хранятся размеры товара
//    (chrtID/techSize/wbSize), чтобы перевести chrtId/techSize в S/M/L/XL/XXL.
//
// Если товар или размер распознать не удалось — ничего не списываем и пишем
// в журнал запись с unresolved:true, чтобы это было видно и можно было
// поправить sku_product_map, а не тихо портить остатки угадыванием.

const WB_MARKETPLACE_SUPPLIES_URL = "https://marketplace-api.wildberries.ru/api/v3/supplies";
const WB_MARKETPLACE_ORDERS_URL = "https://marketplace-api.wildberries.ru/api/v3/orders";
const WB_SUPPLIES_FBO_URL = "https://supplies-api.wildberries.ru/api/v1/supplies";
const OUR_SIZES = ["S", "M", "L", "XL", "XXL"];

async function loadJson(key, fallback) {
  const { rows } = await pool.query("SELECT value FROM app_state WHERE key = $1", [key]);
  return rows.length ? rows[0].value : fallback;
}

async function saveJson(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

async function appendDeductionLog(entry) {
  const log = await loadJson("deduction_log", []);
  const full = Object.assign({ ts: new Date().toISOString() }, entry);
  log.unshift(full);
  if (log.length > 500) log.length = 500;
  await saveJson("deduction_log", log);
  return full;
}

// Батч-уведомление о позициях, которые не удалось списать за этот прогон
// поллера (товар/размер не распознан и т.п.) — только новые записи с
// момента runStartedAt, чтобы не слать одно и то же повторно.
async function notifyNewUnresolved(sinceIso, pollerLabel) {
  try {
    const log = await loadJson("deduction_log", []);
    // fetchError (не удалось прочитать /goods поставки — сбой на стороне WB,
    // 0 шт списано) обрабатывается отдельно в runFboPoller с дедупликацией,
    // сюда попадают только настоящие "товар/размер не распознан".
    const items = log.filter(function (e) {
      return e.unresolved && !e.fetchError && e.ts && e.ts >= sinceIso;
    });
    if (!items.length) return;
    const lines = items.slice(0, 10).map(function (e) {
      return "• " + (e.source || "") + ", поставка " + (e.supplyId || "?") + ": " + (e.note || "товар/размер не распознан");
    });
    let text = "⚠️ " + pollerLabel + ": не удалось списать " + items.length + " позици" + (items.length === 1 ? "ю" : "й") + ".\n" + lines.join("\n");
    if (items.length > 10) text += "\n…и ещё " + (items.length - 10) + ".";
    await sendTelegram(text);
  } catch (e) {
    console.error("notifyNewUnresolved error:", e.message);
  }
}

// WB иногда кладёт в techSize кириллические буквы, визуально неотличимые от
// латинских (например, кириллическая "М" вместо латинской "M") — из-за этого
// размер не распознавался, хотя выглядел абсолютно нормально на глаз.
const CYRILLIC_LOOKALIKES = { М: "M", Х: "X", А: "A", С: "C", Е: "E", О: "O" };

function normalizeSize(raw) {
  if (!raw) return null;
  let up = String(raw).trim().toUpperCase();
  up = up
    .split("")
    .map(function (ch) {
      return CYRILLIC_LOOKALIKES[ch] || ch;
    })
    .join("");
  if (up === "2XL") up = "XXL"; // WB иногда пишет "2XL" вместо нашего "XXL"
  return OUR_SIZES.indexOf(up) !== -1 ? up : null;
}

function buildChrtIndex(cardsCache) {
  // chrtID -> { nmID, techSize, wbSize } — нужно, чтобы по chrtId из заказа
  // ФБС узнать, какой это размер.
  const idx = {};
  ((cardsCache && cardsCache.cards) || []).forEach(function (c) {
    (c.sizes || []).forEach(function (s) {
      idx[String(s.chrtID)] = { nmID: c.nmID, techSize: s.techSize, wbSize: s.wbSize };
    });
  });
  return idx;
}

// Для этих двух товаров, если и "Упакованные", и "Неупакованные" по нужному
// размеру уже дошли до нуля, разрешено доспиывать остаток из "Брак (волна)" —
// пользователь явно попросил только для зелёной и синей рубашки (не для
// серой, у которой тоже есть брак, но так решили сознательно).
const BRAK_FALLBACK = {
  "Зелёная полоска, кор. рукав": "Зелёная, кор. рукав (брак, волна)",
  "Синяя полоска, кор. рукав": "Синяя, кор. рукав (брак, волна)",
};

// Списывает qty штук указанного размера товара: сначала из "Упакованные",
// остаток (если не хватило) — из "Неупакованные", и если это тоже кончилось —
// для зелёной/синей рубашки последним источником идёт "Брак (волна)"
// (см. BRAK_FALLBACK). Если и брака не хватает — уходим в 0, глубже минуса
// не пишем, и отмечаем insufficient, чтобы это было видно в журнале.
// Возвращает итоговую запись журнала — вызывающий код использует её, чтобы
// понять, сколько реально списалось (для уведомлений в Telegram).
async function deductUnits(productName, size, qty, context) {
  if (!productName || !size) {
    return await appendDeductionLog(
      Object.assign(
        { product: productName || null, size: size || null, qty: qty, unresolved: true, note: "товар или размер не распознаны — сверьте sku_product_map / карточку WB" },
        context
      )
    );
  }
  const packed = await loadJson("stock_packed", {});
  const unpacked = await loadJson("stock_unpacked", {});
  if (!packed[productName]) packed[productName] = { S: 0, M: 0, L: 0, XL: 0, XXL: 0 };
  if (!unpacked[productName]) unpacked[productName] = { S: 0, M: 0, L: 0, XL: 0, XXL: 0 };

  const have = Number(packed[productName][size]) || 0;
  const fromPacked = Math.min(have, qty);
  packed[productName][size] = have - fromPacked;

  let remaining = qty - fromPacked;
  let fromUnpacked = 0;
  if (remaining > 0) {
    const haveU = Number(unpacked[productName][size]) || 0;
    fromUnpacked = Math.min(haveU, remaining);
    unpacked[productName][size] = haveU - fromUnpacked;
    remaining -= fromUnpacked;
  }

  await saveJson("stock_packed", packed);
  await saveJson("stock_unpacked", unpacked);

  let fromBrak = 0;
  const brakName = BRAK_FALLBACK[productName];
  if (remaining > 0 && brakName) {
    const brak = await loadJson("stock_brak", {});
    if (!brak[brakName]) brak[brakName] = { S: 0, M: 0, L: 0, XL: 0, XXL: 0 };
    const haveB = Number(brak[brakName][size]) || 0;
    fromBrak = Math.min(haveB, remaining);
    brak[brakName][size] = haveB - fromBrak;
    remaining -= fromBrak;
    await saveJson("stock_brak", brak);
  }

  return await appendDeductionLog(
    Object.assign(
      {
        product: productName,
        size: size,
        qty: qty,
        fromPacked: fromPacked,
        fromUnpacked: fromUnpacked,
        fromBrak: fromBrak,
        insufficient: remaining > 0,
        shortfall: remaining,
      },
      context
    )
  );
}

async function fetchAllFbsSupplies() {
  let next = 0;
  let all = [];
  for (let page = 0; page < 50; page++) {
    const res = await fetch(WB_MARKETPLACE_SUPPLIES_URL + "?limit=1000&next=" + next, {
      headers: { Authorization: WB_API_TOKEN },
    });
    if (!res.ok) throw new Error("marketplace-api /supplies " + res.status + ": " + (await res.text().catch(() => "")));
    const json = await res.json();
    const supplies = json.supplies || [];
    all = all.concat(supplies);
    if (!supplies.length || json.next === next || json.next == null) break;
    next = json.next;
  }
  return all;
}

async function fetchFbsOrdersInWindow(dateFrom, dateTo) {
  let next = 0;
  let all = [];
  for (let page = 0; page < 50; page++) {
    const url = WB_MARKETPLACE_ORDERS_URL + "?limit=1000&next=" + next + "&dateFrom=" + dateFrom + "&dateTo=" + dateTo;
    const res = await fetch(url, { headers: { Authorization: WB_API_TOKEN } });
    if (!res.ok) throw new Error("marketplace-api /orders " + res.status + ": " + (await res.text().catch(() => "")));
    const json = await res.json();
    const orders = json.orders || [];
    all = all.concat(orders);
    if (!orders.length || json.next === next || json.next == null) break;
    next = json.next;
  }
  return all;
}

// Здоровье поллеров: чтобы про ошибку (упал целиком запрос к ВБ, а не просто
// один товар) можно было узнать не заходя в логи Railway. Шлём в Telegram
// только на ПЕРЕХОДАХ состояния (была ошибка -> появилась, была ошибка ->
// исчезла), а не на каждый прогон — иначе будет спам при повторяющейся ошибке.
async function recordPollerHealth(name, ok, errorMessage) {
  const health = await loadJson("poller_health", {});
  const now = new Date().toISOString();
  const prev = health[name] || { consecutiveErrors: 0 };
  const wasHealthy = !prev.consecutiveErrors || prev.consecutiveErrors === 0;
  if (ok) {
    health[name] = {
      lastRunAt: now,
      lastSuccessAt: now,
      lastError: null,
      lastErrorAt: prev.lastErrorAt || null,
      consecutiveErrors: 0,
    };
    if (!wasHealthy) {
      await sendTelegram("✅ " + name.toUpperCase() + ": ошибка устранена, поллер снова работает нормально.");
    }
  } else {
    health[name] = {
      lastRunAt: now,
      lastSuccessAt: prev.lastSuccessAt || null,
      lastError: errorMessage,
      lastErrorAt: now,
      consecutiveErrors: (Number(prev.consecutiveErrors) || 0) + 1,
    };
    if (wasHealthy) {
      await sendTelegram("⚠️ " + name.toUpperCase() + ": ошибка в работе поллера.\n" + errorMessage);
    }
  }
  await saveJson("poller_health", health);
}

async function runFbsPoller() {
  if (!WB_API_TOKEN) return;
  const runStartedAt = new Date().toISOString();
  try {
    const supplies = await fetchAllFbsSupplies();
    const processed = await loadJson("fbs_processed_supplies", {});
    const newlyDone = supplies.filter(function (s) { return s.done && !processed[s.id]; });
    if (!newlyDone.length) {
      await recordPollerHealth("fbs", true);
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const dateFrom = nowSec - 30 * 24 * 3600; // API отдаёт максимум 30 дней за раз
    const orders = await fetchFbsOrdersInWindow(dateFrom, nowSec);
    const ordersBySupply = {};
    orders.forEach(function (o) {
      if (!o.supplyId) return;
      if (!ordersBySupply[o.supplyId]) ordersBySupply[o.supplyId] = [];
      ordersBySupply[o.supplyId].push(o);
    });

    const cardsCache = await loadJson("wb_cards_cache", { cards: [] });
    const chrtIndex = buildChrtIndex(cardsCache);
    const skuMap = await loadJson("sku_product_map", {});

    const supplySummaries = []; // { supplyId, qty, orders }

    for (const supply of newlyDone) {
      const supplyOrders = ordersBySupply[supply.id] || [];
      if (!supplyOrders.length) {
        // Заказы этой поставки не попали в окно последних 30 дней — такое
        // бывает редко, но лучше явно отметить, чем промолчать.
        await appendDeductionLog({
          source: "fbs",
          supplyId: supply.id,
          unresolved: true,
          note: "не нашли заказы этой поставки за последние 30 дней",
        });
        processed[supply.id] = true;
        continue;
      }
      let qtyDeducted = 0;
      for (const order of supplyOrders) {
        const nm = String(order.nmId);
        const productName = skuMap[nm] || null;
        const sizeInfo = chrtIndex[String(order.chrtId)];
        // techSize у одежды на этом аккаунте — это буквенный размер (S/M/L/XL/XXL),
        // а wbSize — российский числовой размер (46/48/50...), он нам не подходит.
        const size = sizeInfo ? normalizeSize(sizeInfo.techSize || sizeInfo.wbSize) : null;
        const result = await deductUnits(productName, size, 1, {
          source: "fbs",
          supplyId: supply.id,
          orderId: order.id,
          nmId: order.nmId,
          chrtId: order.chrtId,
        });
        if (!result.unresolved) {
          qtyDeducted += (result.fromPacked || 0) + (result.fromUnpacked || 0) + (result.fromBrak || 0);
        }
      }
      processed[supply.id] = true;
      if (qtyDeducted > 0) {
        supplySummaries.push({ supplyId: supply.id, qty: qtyDeducted, orders: supplyOrders.length });
      }
    }
    await saveJson("fbs_processed_supplies", processed);
    await recordPollerHealth("fbs", true);

    if (supplySummaries.length) {
      const lines = supplySummaries.map(function (s) {
        return "• Поставка " + s.supplyId + " (" + s.orders + " зак.): списано " + s.qty + " шт";
      });
      await sendTelegram("📦 ФБС отгружено, остатки списаны:\n" + lines.join("\n"));
    }
    await notifyNewUnresolved(runStartedAt, "ФБС");
  } catch (e) {
    console.error("FBS poller error:", e.message);
    await recordPollerHealth("fbs", false, e.message);
  }
}

async function fetchAllFboSupplies() {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
  // "till" — только дата без времени. Если передать сегодняшнее число, WB,
  // похоже, трактует это как начало дня (00:00) и обрезает всё, что случилось
  // сегодня позже полуночи — из-за этого свежепринятые сегодня поставки не
  // попадали в список вообще. Берём "завтра", чтобы гарантированно захватить
  // весь сегодняшний день.
  const till = new Date(now.getTime() + 24 * 3600 * 1000);
  let offset = 0;
  const limit = 1000;
  let all = [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch(WB_SUPPLIES_FBO_URL + "?limit=" + limit + "&offset=" + offset, {
      method: "POST",
      headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        dates: [
          {
            from: from.toISOString().slice(0, 10),
            till: till.toISOString().slice(0, 10),
            type: "factDate",
          },
        ],
      }),
    });
    if (!res.ok) throw new Error("supplies-api /supplies " + res.status + ": " + (await res.text().catch(() => "")));
    const json = await res.json();
    const supplies = Array.isArray(json) ? json : json.supplies || json.data || [];
    all = all.concat(supplies);
    if (supplies.length < limit) break;
    offset += limit;
  }
  return all;
}

async function fetchFboSupplyGoods(supplyId) {
  let res;
  try {
    res = await fetch(WB_SUPPLIES_FBO_URL + "/" + supplyId + "/goods?limit=1000&offset=0", {
      headers: { Authorization: WB_API_TOKEN },
    });
  } catch (e) {
    // Сетевая ошибка (таймаут, разрыв соединения и т.п.) — тут нет res.status,
    // но код причины (ECONNRESET/ETIMEDOUT/...) обычно есть у cause.
    e.code = (e.cause && e.cause.code) || e.code || "network";
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error("supplies-api /goods " + res.status + ": " + text);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function runFboPoller() {
  if (!WB_API_TOKEN) return;
  const runStartedAt = new Date().toISOString();
  try {
    const supplies = await fetchAllFboSupplies();
    const acceptedState = await loadJson("fbo_accepted_state", {});
    const skuMap = await loadJson("sku_product_map", {});
    // Дедупликация уведомлений об ошибках чтения /goods по конкретной поставке:
    // WB иногда на несколько часов роняет этот метод (500/503) для одних и тех
    // же старых поставок при каждом прогоне (раз в 10 минут) — без этого была
    // бы серия из десятка одинаковых по сути алертов подряд. Помним последнюю
        // "версию" ошибки (код статуса) на поставку; шлём заново только если
    // поставка успешно прочиталась (ошибка ушла), а потом снова не читается,
    // или если код ошибки поменялся.
    const fetchAlertState = await loadJson("fbo_fetch_alert_state", {});
    const newFetchErrors = []; // [{supplyId, status}]

    const supplySummaries = {}; // supplyId -> qty списано

    // Поставки, которые уже подтверждённо "устоялись" (два прогона подряд без
    // изменений после того, как мы их хоть раз успешно прочитали) — больше не
    // трогаем их вообще, ни чтением /goods, ни тем более алертами. Это и есть
    // ответ на просьбу "не перепроверяй старые поставки, они уже сделаны".
    const settledState = await loadJson("fbo_settled_supplies", {});
    const seenState = await loadJson("fbo_seen_supplies", {});
    let skippedSettledCount = 0;

    for (const supply of supplies) {
      // Название поля с ID поставки в этом методе не проверено вживую на
      // 100% по документации — подстраховываемся под разные варианты.
      const supplyId = supply.id || supply.ID || supply.supplyID || supply.incomeID;
      if (!supplyId) continue;
      if (settledState[String(supplyId)]) {
        skippedSettledCount++;
        continue;
      }
      let goods;
      try {
        goods = await fetchFboSupplyGoods(supplyId);
        if (fetchAlertState[String(supplyId)]) delete fetchAlertState[String(supplyId)];
      } catch (e) {
        const marker = "status:" + (e.status || e.code || "unknown");
        await appendDeductionLog({
          source: "fbo",
          supplyId: supplyId,
          unresolved: true,
          fetchError: true,
          httpStatus: e.status || null,
          note: "не удалось получить товары поставки (/goods): " + e.message,
        });
        if (fetchAlertState[String(supplyId)] !== marker) {
          newFetchErrors.push({ supplyId: supplyId, status: e.status || e.code || "сетевая ошибка" });
          fetchAlertState[String(supplyId)] = marker;
        }
        continue;
      }
      const list = Array.isArray(goods) ? goods : goods.goods || [];
      let supplyDeltaTotal = 0;
      for (const g of list) {
        const key = supplyId + ":" + g.barcode;
        const prevAccepted = Number(acceptedState[key]) || 0;
        const nowAccepted = Number(g.acceptedQuantity) || 0;
        const delta = nowAccepted - prevAccepted;
        if (delta > 0) {
          supplyDeltaTotal += delta;
          const productName = skuMap[String(g.nmID)] || null;
          const size = normalizeSize(g.techSize);
          const result = await deductUnits(productName, size, delta, {
            source: "fbo",
            supplyId: supplyId,
            barcode: g.barcode,
            nmId: g.nmID,
          });
          if (!result.unresolved) {
            const deducted = (result.fromPacked || 0) + (result.fromUnpacked || 0) + (result.fromBrak || 0);
            supplySummaries[supplyId] = (supplySummaries[supplyId] || 0) + deducted;
          }
        }
        acceptedState[key] = nowAccepted;
      }
      // Если поставку уже видели раньше (это не первый успешный прогон по ней)
      // и в этот раз изменений ноль — считаем её устоявшейся и больше не трогаем.
      if (seenState[String(supplyId)] && supplyDeltaTotal === 0) {
        settledState[String(supplyId)] = new Date().toISOString();
      }
      seenState[String(supplyId)] = true;
    }
    await saveJson("fbo_accepted_state", acceptedState);
    await saveJson("fbo_fetch_alert_state", fetchAlertState);
    await saveJson("fbo_settled_supplies", settledState);
    await saveJson("fbo_seen_supplies", seenState);
    await recordPollerHealth("fbo", true);

    const supplyIds = Object.keys(supplySummaries);
    if (supplyIds.length) {
      const lines = supplyIds.map(function (id) {
        return "• Поставка " + id + ": списано " + supplySummaries[id] + " шт";
      });
      await sendTelegram("✅ ФБО принято на складе ВБ, остатки списаны:\n" + lines.join("\n"));
    }

    if (newFetchErrors.length) {
      const lines = newFetchErrors.slice(0, 10).map(function (f) {
        return "• Поставка " + f.supplyId + " (ошибка " + f.status + ")";
      });
      let text =
        "ℹ️ ФБО: не смог проверить " + newFetchErrors.length +
        " поставк" + (newFetchErrors.length === 1 ? "у" : "и") +
        " из-за временного сбоя на стороне Wildberries. Списано 0 шт, на остатки это не повлияло — повторю проверку в следующий раз.\n" +
        lines.join("\n");
      if (newFetchErrors.length > 10) text += "\n…и ещё " + (newFetchErrors.length - 10) + ".";
      await sendTelegram(text);
    }

    await notifyNewUnresolved(runStartedAt, "ФБО");
  } catch (e) {
    console.error("FBO poller error:", e.message);
    await recordPollerHealth("fbo", false, e.message);
  }
}

// Алерты по здоровью поллеров: отдаёт только то, что появилось нового с
// прошлой проверки (сам двигает чекпоинт), чтобы можно было дёргать эндпоинт
// периодически и получать "тишину", если всё в порядке.
app.get("/api/health/alerts", async (req, res) => {
  try {
    const health = await loadJson("poller_health", {});
    const checkpoint = await loadJson("alerts_checkpoint", { since: null });
    const sinceMs = checkpoint.since ? new Date(checkpoint.since).getTime() : 0;

    const errors = [];
    for (const name of ["fbs", "fbo"]) {
      const h = health[name];
      if (h && h.lastError && h.lastErrorAt && new Date(h.lastErrorAt).getTime() > sinceMs) {
        errors.push({
          poller: name,
          error: h.lastError,
          at: h.lastErrorAt,
          consecutiveErrors: h.consecutiveErrors,
          lastSuccessAt: h.lastSuccessAt,
        });
      }
    }

    const log = await loadJson("deduction_log", []);
    const newUnresolved = log.filter((e) => e.unresolved && e.ts && new Date(e.ts).getTime() > sinceMs);

    const now = new Date().toISOString();
    await saveJson("alerts_checkpoint", { since: now });

    res.json({
      checkedFrom: checkpoint.since,
      checkedTo: now,
      hasAlerts: errors.length > 0 || newUnresolved.length > 0,
      pollerErrors: errors,
      newUnresolved: newUnresolved,
      health: health,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Журнал списаний — что и когда списалось, чтобы можно было проверить.
app.get("/api/deductions", async (req, res) => {
  const log = await loadJson("deduction_log", []);
  let entries = log;
  if (req.query.source) {
    entries = entries.filter((e) => e.source === req.query.source);
  }
  const limit = Number(req.query.limit) || entries.length;
  res.json({ total: entries.length, entries: entries.slice(-limit) });
});

// Отдельный путь-алиас на случай, если query-параметры где-то по пути обрезаются.
app.get("/api/deductions/fbo/:limit", async (req, res) => {
  const log = await loadJson("deduction_log", []);
  const entries = log.filter((e) => e.source === "fbo");
  const limit = Number(req.params.limit) || entries.length;
  res.json({ total: entries.length, entries: entries.slice(-limit) });
});

// Временный эндпоинт: сбросить наш внутренний счётчик "уже видели" для
// конкретных штрихкодов конкретной поставки. Нужен после починки нормализации
// размера — те позиции, что раньше не распознались, уже "запомнены" как
// увиденные (даже без реального списания), и поллер сам их не переберёт
// повторно. Сброс заставляет поллер в следующий прогон снова посчитать их как
// новые и списать по уже исправленной логике.
app.get("/api/wb/reset-accepted/:supplyId", async (req, res) => {
  try {
    const barcodes = String(req.query.barcodes || "").split(",").map((s) => s.trim()).filter(Boolean);
    const acceptedState = await loadJson("fbo_accepted_state", {});
    const removed = [];
    for (const bc of barcodes) {
      const key = req.params.supplyId + ":" + bc;
      if (acceptedState[key] !== undefined) {
        delete acceptedState[key];
        removed.push(key);
      }
    }
    await saveJson("fbo_accepted_state", acceptedState);
    // На всякий случай снимаем и с "устоявшихся" — вдруг успела settled-логика
    // пометить эту поставку раньше времени.
    const settledState = await loadJson("fbo_settled_supplies", {});
    if (settledState[req.params.supplyId]) {
      delete settledState[req.params.supplyId];
      await saveJson("fbo_settled_supplies", settledState);
    }
    res.json({ ok: true, removed: removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Временный диагностический эндпоинт: прямой запрос деталей конкретной
// поставки у WB (в обход нашего списка/фильтра по датам) — чтобы понять,
// почему поставка не попадает в обычный список /api/v1/supplies.
app.get("/api/wb/supply-debug/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const detailRes = await fetch(WB_SUPPLIES_FBO_URL + "/" + id, {
      headers: { Authorization: WB_API_TOKEN },
    });
    const detail = await detailRes.json().catch(() => null);
    let goods = null;
    try {
      goods = await fetchFboSupplyGoods(id);
    } catch (e) {
      goods = { error: e.message };
    }
    res.json({ detailStatus: detailRes.status, detail: detail, goods: goods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Временный диагностический эндпоинт: проверяет, попадает ли конкретный ID
// поставки в общий список fetchAllFboSupplies() (тот самый, который
// использует поллер) — чтобы понять, видит ли поллер поставку вообще.
app.get("/api/wb/supply-in-list/:id", async (req, res) => {
  try {
    const supplies = await fetchAllFboSupplies();
    const id = String(req.params.id);
    const found = supplies.find(function (s) {
      const sid = s.id || s.ID || s.supplyID || s.incomeID;
      return String(sid) === id;
    });
    res.json({ totalSupplies: supplies.length, found: !!found, entry: found || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ручной запуск (для проверки), требует X-Api-Key
app.post("/api/deductions/run", requireApiKey, async (req, res) => {
  await runFbsPoller();
  await runFboPoller();
  res.json({ ok: true });
});

// Ручной запуск FBO-поллера через GET (без API-ключа) — для быстрой
// диагностики без возможности делать POST-запросы из песочницы.
app.get("/api/wb/run-fbo-now", requireApiKey, async (req, res) => {
  try {
    await runFboPoller();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ---------------------------------------------------------------------------
// Конкуренты: отслеживание позиций наших карточек в блоке "Смотрите также"
// (в обиходе — "Похожие товары") на карточках конкурентов на WB.
//
// Важно про источник данных: сам сервер НИКОГДА не ходит на wildberries.ru
// за этим блоком — это нарушало бы условия WB и упиралось бы в антибот-защиту.
// Данные сюда присылает Claude, который открывает карточку конкурента в
// обычном браузере пользователя (как реальный человек — без спецмаскировки)
// и построчно читает, что показано в "Смотрите также". Сервер только хранит
// присланный результат и сам сопоставляет его с нашими товарами (по nmID из
// wb_cards_cache), чтобы не полагаться на ручное ведение списка своих nmID.

// ---------------------------------------------------------------------------
// Wildberries: реклама (Advertising API) — нужно, чтобы отличать позицию
// карточки в "Смотрите также", которая выросла органически (от "прогрева"),
// от позиции, которая держится за счёт активной сейчас платной рекламной
// кампании с размещением "рекомендации". Кампания в WB может быть нацелена
// отдельно на поиск и отдельно на рекомендации (см. settings.placements) —
// нас интересуют только те, что бьют по рекомендательным полкам.
const WB_ADV_COUNT_URL = "https://advert-api.wildberries.ru/adv/v1/promotion/count";
const WB_ADV_ADVERTS_URL = "https://advert-api.wildberries.ru/api/advert/v2/adverts";
const WB_ADV_ACTIVE_STATUS = 9; // по документации WB API: 9 = кампания активна прямо сейчас

async function fetchActiveRecommendationNmIds() {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");

  const countRes = await fetch(WB_ADV_COUNT_URL, {
    headers: { Authorization: WB_API_TOKEN },
  });
  if (!countRes.ok) {
    const text = await countRes.text().catch(() => "");
    throw new Error("WB Adv API (count) ответил " + countRes.status + ": " + text);
  }
  const countJson = await countRes.json();
  const activeAdvertIds = [];
  (countJson.adverts || []).forEach(function (group) {
    if (group.status === WB_ADV_ACTIVE_STATUS) {
      (group.advert_list || []).forEach(function (a) { activeAdvertIds.push(a.advertId); });
    }
  });
  if (!activeAdvertIds.length) return [];

  const nmIds = new Set();
  for (let i = 0; i < activeAdvertIds.length; i += 50) {
    const batch = activeAdvertIds.slice(i, i + 50);
    const url = WB_ADV_ADVERTS_URL + "?ids=" + batch.join(",");
    const res = await fetch(url, { headers: { Authorization: WB_API_TOKEN } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("WB Adv API (adverts) ответил " + res.status + ": " + text);
    }
    const json = await res.json();
    (json.adverts || []).forEach(function (advert) {
      const recomEnabled = advert.settings && advert.settings.placements && advert.settings.placements.recommendations;
      if (!recomEnabled) return;
      (advert.nm_settings || []).forEach(function (ns) { nmIds.add(Number(ns.nm_id)); });
    });
  }
  return Array.from(nmIds);
}

// Диагностический эндпоинт — только чтобы проверить, что у токена есть права
// на раздел "Продвижение". После проверки можно убрать.
app.get("/api/ads/test", async (req, res) => {
  try {
    const nmIds = await fetchActiveRecommendationNmIds();
    res.json({ ok: true, activeRecommendationNmIdsCount: nmIds.length, nmIds: nmIds });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function extractNmIdFromUrl(url) {
  const m = String(url || "").match(/catalog\/(\d+)\/detail/);
  return m ? Number(m[1]) : null;
}

// Список отслеживаемых конкурентов — сразу с краткой сводкой по последнему
// обходу (дата, сколько карточек увидели, сколько из них наши), чтобы фронту
// не нужно было отдельно дёргать историю по каждому конкуренту ради превью-плитки.
app.get("/api/competitors", async (req, res) => {
  try {
    const list = await loadJson("competitors_list", []);
    const enriched = await Promise.all(
      list.map(async function (c) {
        const data = await loadJson("competitor_scan_" + c.id, { history: {} });
        const days = Object.keys(data.history).sort();
        const lastDay = days.length ? days[days.length - 1] : null;
        const prevDay = days.length > 1 ? days[days.length - 2] : null;
        const lastScan = lastDay
          ? {
              day: lastDay,
              scannedAt: data.history[lastDay].scannedAt,
              totalSeen: data.history[lastDay].totalSeen,
              matchesCount: (data.history[lastDay].matches || []).length,
              prevMatchesCount: prevDay ? (data.history[prevDay].matches || []).length : null,
              delta: prevDay ? (data.history[lastDay].matches || []).length - (data.history[prevDay].matches || []).length : null,
            }
          : null;
        return Object.assign({}, c, { lastScan: lastScan, active: c.active !== false });
      })
    );
    res.json({ competitors: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Добавить конкурента вручную (по ссылке на его карточку товара на WB)
app.post("/api/competitors", requireApiKey, async (req, res) => {
  try {
    const { url, name } = req.body || {};
    const nmID = extractNmIdFromUrl(url);
    if (!nmID) {
      return res.status(400).json({
        error: "Не нашли артикул в ссылке. Нужна ссылка вида https://www.wildberries.ru/catalog/123456/detail.aspx",
      });
    }
    const list = await loadJson("competitors_list", []);
    const item = {
      id: crypto.randomUUID(),
      nmID: nmID,
      url: "https://www.wildberries.ru/catalog/" + nmID + "/detail.aspx",
      name: (name || "").trim() || ("Конкурент " + nmID),
      addedAt: new Date().toISOString(),
      active: true,
    };
    list.push(item);
    await saveJson("competitors_list", list);
    res.json({ ok: true, competitor: item });
  } catch (e) {
    console.error("add competitor error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Удалить конкурента и всю накопленную по нему историю
app.delete("/api/competitors/:id", requireApiKey, async (req, res) => {
  try {
    const list = await loadJson("competitors_list", []);
    const next = list.filter(function (c) { return c.id !== req.params.id; });
    await saveJson("competitors_list", next);
    await pool.query("DELETE FROM app_state WHERE key = $1", ["competitor_scan_" + req.params.id]);
    const flags = await loadJson("competitor_refresh_requests", {});
    if (flags[req.params.id]) {
      delete flags[req.params.id];
      await saveJson("competitor_refresh_requests", flags);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Включить/выключить конкурента без удаления — неактивные пропускаются при массовом обновлении
app.post("/api/competitors/:id/active", requireApiKey, async (req, res) => {
  try {
    const { active } = req.body || {};
    const list = await loadJson("competitors_list", []);
    const idx = list.findIndex(function (c) { return c.id === req.params.id; });
    if (idx === -1) {
      return res.status(404).json({ error: "конкурент с таким id не найден" });
    }
    list[idx].active = active !== false;
    await saveJson("competitors_list", list);
    res.json({ ok: true, competitor: list[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Кнопка "Обновить" на сайте не может сама завести браузер и обойти
// конкурента (это делает только Claude в чате) — она лишь ставит отметку
// "проверить как можно скорее", чтобы запрос было видно и он не потерялся.
app.post("/api/competitors/:id/request-refresh", async (req, res) => {
  try {
    const flags = await loadJson("competitor_refresh_requests", {});
    flags[req.params.id] = new Date().toISOString();
    await saveJson("competitor_refresh_requests", flags);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/competitors/refresh-requests", async (req, res) => {
  try {
    const flags = await loadJson("competitor_refresh_requests", {});
    res.json({ requests: flags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Приём результата обхода одного конкурента. items — сырой список товаров,
// увиденных в блоке "Смотрите также", в порядке появления (position 1, 2, 3…).
// Сервер сам оставляет только те, что совпадают с нашими товарами (по nmID
// из wb_cards_cache), остальное отбрасывает — хранить чужие товары незачем.
app.post("/api/competitors/:id/scan", requireApiKey, async (req, res) => {
  try {
    const { items, date, competitorPhoto, competitorTitle } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items должен быть массивом [{nmID, name, position}]" });
    }

    const list = await loadJson("competitors_list", []);
    const competitorIdx = list.findIndex(function (c) { return c.id === req.params.id; });
    if (competitorIdx === -1) {
      return res.status(404).json({ error: "конкурент с таким id не найден" });
    }

    // Фото/название карточки конкурента узнаём только во время обхода (сам
    // сервер на WB не ходит) — если прислали, сохраняем в карточку конкурента,
    // чтобы показывать на сайте без повторного похода в браузер.
    let listChanged = false;
    if (competitorPhoto && list[competitorIdx].photo !== competitorPhoto) {
      list[competitorIdx].photo = competitorPhoto;
      listChanged = true;
    }
    if (competitorTitle && list[competitorIdx].wbTitle !== competitorTitle) {
      list[competitorIdx].wbTitle = competitorTitle;
      listChanged = true;
    }
    if (listChanged) await saveJson("competitors_list", list);

    const cardsCache = await loadJson("wb_cards_cache", { cards: [] });
    const myCardsByNm = {};
    (cardsCache.cards || []).forEach(function (c) { myCardsByNm[String(c.nmID)] = c; });

    // Помечаем, есть ли у карточки СЕЙЧАС активная (статус 9) рекламная
    // кампания с размещением на рекомендации — чтобы отличать позицию,
    // которая держится за счёт платной рекламы, от органической (от
    // "прогрева"). Если запрос к рекламному API не удался (нет доступа,
    // сбой сети) — не роняем сохранение скана, просто помечаем adActive
    // как null ("неизвестно"), а не false ("точно нет рекламы").
    let activeRecomNmIds = null;
    try {
      activeRecomNmIds = await fetchActiveRecommendationNmIds();
    } catch (e) {
      console.error("не удалось получить активные рекламные кампании:", e.message);
    }
    const activeRecomSet = activeRecomNmIds ? new Set(activeRecomNmIds) : null;

    const matches = items
      .filter(function (it) { return it && myCardsByNm[String(it.nmID)]; })
      .map(function (it) {
        const mine = myCardsByNm[String(it.nmID)];
        return {
          nmID: Number(it.nmID),
          myName: mine.title,
          myVendorCode: mine.vendorCode,
          myPhoto: mine.photo || null,
          position: Number(it.position) || null,
          adActive: activeRecomSet ? activeRecomSet.has(Number(it.nmID)) : null,
        };
      });

    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const key = "competitor_scan_" + req.params.id;
    const data = await loadJson(key, { history: {} });
    data.history[day] = {
      scannedAt: new Date().toISOString(),
      totalSeen: items.length,
      matches: matches,
    };
    // Не храним больше 90 дней истории по одному конкуренту, чтобы база не росла бесконечно
    const days = Object.keys(data.history).sort();
    if (days.length > 90) {
      days.slice(0, days.length - 90).forEach(function (d) { delete data.history[d]; });
    }
    await saveJson(key, data);

    const flags = await loadJson("competitor_refresh_requests", {});
    if (flags[req.params.id]) {
      delete flags[req.params.id];
      await saveJson("competitor_refresh_requests", flags);
    }

    res.json({ ok: true, day: day, matchesFound: matches.length, totalSeen: items.length });
  } catch (e) {
    console.error("competitor scan error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// История по конкретному конкуренту — для таблицы на сайте
app.get("/api/competitors/:id/history", async (req, res) => {
  try {
    const key = "competitor_scan_" + req.params.id;
    const data = await loadJson(key, { history: {} });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Одноразовая (но безвредно повторяемая) подчистка: несколько старых ФБО-поставок
// уже полностью разобраны вручную ещё в начале августа (см. откат лишних
// списаний), но их /goods иногда отвечает ошибкой у WB — из-за этого они не
// могли "устояться" сами (см. логику settled в runFboPoller) и продолжали
// давать шумные алерты. Явно помечаем их устоявшимися один раз при старте,
// дальше поллер их больше не трогает.
async function bootstrapSettledFboSupplies() {
  try {
    const KNOWN_OLD_SUPPLIES = ["40151910", "40298885", "40755615", "39927994", "40868998", "41153512"];
    const settledState = await loadJson("fbo_settled_supplies", {});
    let changed = false;
    for (const id of KNOWN_OLD_SUPPLIES) {
      if (!settledState[id]) {
        settledState[id] = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await saveJson("fbo_settled_supplies", settledState);
  } catch (e) {
    console.error("bootstrapSettledFboSupplies error:", e.message);
  }
}

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log("wb-ostatki-api listening on " + PORT));
    if (WB_API_TOKEN) {
      bootstrapSettledFboSupplies();
      refreshWbStockCache(); // сразу при старте сервиса
      refreshWbCardsCache();
      setInterval(refreshWbStockCache, 20 * 60 * 1000); // и затем каждые 20 минут
      setInterval(refreshWbCardsCache, 20 * 60 * 1000);
      // Списания по ФБС/ФБО — через 2 минуты после старта (дать кэшу карточек
      // успеть заполниться) и затем каждые 10 минут.
      setTimeout(function () {
        runFbsPoller();
        runFboPoller();
      }, 2 * 60 * 1000);
      setInterval(function () {
        runFbsPoller();
        runFboPoller();
      }, 10 * 60 * 1000);
    } else {
      console.log("WB_API_TOKEN не задан — синхронизация остатков ВБ отключена");
    }
  })
  .catch((e) => {
    console.error("Failed to init schema", e);
    process.exit(1);
  });
