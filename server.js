// wb-ostatki-api
// Простой backend-фундамент для сайта "Остатки товара".
// Хранит: порядок строк по вкладкам, остатки ВБ (кэш), карточки ВБ (кэш),
// журнал списаний по ФБС/ФБО, и теперь — финансовую статистику ВБ (кэш).
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
// его для всех товаров разом нельзя, только по одному nmID за раз.
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
// ФИНАНСОВАЯ СТАТИСТИКА (Реализация, Комиссия, Логистика, Хранение, Штрафы,
// Доплаты, Удержания, Платная приёмка, СПП) — добавлено при разборе того,
// откуда MPpulse берёт проценты на дашборде (ДРР/Комиссия/Логистика/
// Себестоимость считаются от "Реализации", налог = ставка УСН + НДС и т.д.)
//
// Источник — официальный "Отчёт о реализации" (детализация), тот же файл,
// который можно вручную скачать в личном кабинете WB (Финансы → Отчёты).
// У метода такой же жёсткий лимит запросов, как у остатков, поэтому кэшируем
// точно по той же схеме: раз в 20 минут сами обновляем, сайт всегда читает
// готовый кэш.
//
// ВАЖНО про поля отчёта (официальные имена от WB, ничего не придумано):
// - retail_amount     — Реализация (сумма продаж по цене продавца), ₽
// - ppvz_for_pay       — сумма к перечислению продавцу, ₽ (ближе всего к
//                        "живым деньгам", но это не то же самое, что
//                        "Сумма продаж" на дашборде MPpulse — это отдельная
//                        метрика, тут беру как есть, без досочинения)
// - ppvz_vw            — вознаграждение (комиссия) WB, ₽
// - delivery_rub       — логистика, ₽
// - storage_fee        — хранение, ₽
// - penalty            — штрафы, ₽
// - additional_payment — доплаты, ₽
// - deduction          — удержания, ₽
// - acceptance         — платная приёмка, ₽
// - ppvz_spp_prc       — процент СПП по конкретной строке (для справки)
//
// ДРР (реклама) сюда не входит — это данные из отдельного API продвижения
// WB (advert-api, нужен токен категории "Продвижение"), в этом модуле не
// реализовано. Себестоимость — те цифры, что вы вручную вносите на сайте.
const WB_FINANCE_REPORT_URL = "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod";
const WB_SALES_STAT_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/sales";

// Формат даты, который требует часть методов WB (например supplies-api):
// YYYY-MM-DD, без времени. Вынесено отдельной функцией, т.к. раньше именно
// из-за пропуска этого шага падал FBO-поллер (см. фикс ниже по файлу).
function toWbDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchWbFinanceReport(dateFrom, dateTo) {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  let rrdid = 0;
  let all = [];
  for (let page = 0; page < 50; page++) { // защита от бесконечного цикла
    const url = WB_FINANCE_REPORT_URL
      + "?dateFrom=" + encodeURIComponent(dateFrom)
      + "&dateTo=" + encodeURIComponent(dateTo)
      + "&rrdid=" + rrdid
      + "&limit=100000";
    const res = await fetch(url, { headers: { Authorization: WB_API_TOKEN } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("statistics-api /reportDetailByPeriod " + res.status + ": " + text);
    }
    const rows = await res.json();
    if (!rows || !rows.length) break;
    all = all.concat(rows);
    rrdid = rows[rows.length - 1].rrd_id;
    if (rows.length < 100000) break; // последняя страница
  }
  return all;
}

async function fetchWbSalesStats(dateFromISO) {
  if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан в переменных окружения");
  const url = WB_SALES_STAT_URL + "?dateFrom=" + encodeURIComponent(dateFromISO) + "&flag=0";
  const res = await fetch(url, { headers: { Authorization: WB_API_TOKEN } });
  if (!res.ok) throw new Error("statistics-api /sales " + res.status + ": " + (await res.text().catch(() => "")));
  return await res.json();
}

// Складывает построчный отчёт в те же агрегаты, что мы вручную сверяли
// с карточками MPpulse (ДРР% и Себестоимость% туда не входят — см. комментарий выше).
function aggregateFinanceRows(rows) {
  function sum(field) {
    return rows.reduce(function (acc, r) { return acc + (Number(r[field]) || 0); }, 0);
  }
  const realizacia = sum("retail_amount");
  const komissiya = sum("ppvz_vw");
  const logistika = sum("delivery_rub");
  const hranenie = sum("storage_fee");
  const shtrafy = sum("penalty");
  const doplaty = sum("additional_payment");
  const uderzhaniya = sum("deduction");
  const platPriemka = sum("acceptance");
  const kPerechisleniu = sum("ppvz_for_pay");

  const sppRows = rows.filter(function (r) { return r.ppvz_spp_prc !== undefined && r.ppvz_spp_prc !== null; });
  const avgSppPercent = sppRows.length
    ? sppRows.reduce(function (a, r) { return a + Number(r.ppvz_spp_prc); }, 0) / sppRows.length
    : null;

  return {
    realizacia: realizacia,
    komissiya: komissiya,
    logistika: logistika,
    hranenie: hranenie,
    shtrafy: shtrafy,
    doplaty: doplaty,
    uderzhaniya: uderzhaniya,
    platPriemka: platPriemka,
    kPerechisleniu: kPerechisleniu,
    avgSppPercent: avgSppPercent,
    rowsCount: rows.length,
  };
}

// Кэшируем сырые строки отчёта за скользящее окно в 35 дней — этого хватает,
// чтобы сайт мог сам агрегировать за любой период до месяца без повторных
// обращений к WB (у метода жёсткий лимит запросов, как и у остатков).
async function refreshWbFinanceCache() {
  try {
    const dateTo = toWbDate(new Date());
    const dateFrom = toWbDate(new Date(Date.now() - 35 * 24 * 3600 * 1000));
    const rows = await fetchWbFinanceReport(dateFrom, dateTo);
    const snapshot = { fetchedAt: new Date().toISOString(), dateFrom: dateFrom, dateTo: dateTo, rows: rows, error: null };
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ('wb_finance_cache', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(snapshot)]
    );
    console.log("WB finance cache refreshed:", rows.length, "rows");
  } catch (e) {
    console.error("Failed to refresh WB finance cache:", e.message);
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ('wb_finance_cache', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = app_state.value || $1::jsonb, updated_at = now()`,
      [JSON.stringify({ error: e.message, checkedAt: new Date().toISOString() })]
    ).catch(() => {});
  }
}

// Отдаёт агрегаты за последние N дней (по умолчанию 7, максимум 35 — размер
// кэшируемого окна), считая по уже сохранённым сырым строкам, без обращения
// к WB на каждый запрос сайта.
app.get("/api/wb/finance", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 35);
    const { rows } = await pool.query("SELECT value FROM app_state WHERE key = 'wb_finance_cache'");
    if (rows.length === 0 || !rows[0].value || !rows[0].value.rows) {
      return res.json({ fetchedAt: null, days: days, error: "кэш ещё не наполнен, подождите первое обновление" });
    }
    const cache = rows[0].value;
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const filtered = cache.rows.filter(function (r) {
      const d = r.rr_dt || r.sale_dt || r.order_dt;
      return d && new Date(d).getTime() >= cutoff;
    });
    const agg = aggregateFinanceRows(filtered);
    res.json({ fetchedAt: cache.fetchedAt, days: days, error: cache.error || null, ...agg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// Заказы + продажи за период — та же логика, что уже есть в orders-summary,
// но с денежными суммами (для карточек "Сумма заказов" / "Сумма продаж").
app.get("/api/wb/orders-sales-summary", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);
    const dateFrom = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const [orders, sales] = await Promise.all([
      fetchWbOrdersStats(dateFrom),
      fetchWbSalesStats(dateFrom),
    ]);
    const ordersNotCancelled = (orders || []).filter(function (o) { return !o.isCancel; });
    const sumZakazov = ordersNotCancelled.reduce(function (a, o) { return a + (Number(o.priceWithDisc) || 0); }, 0);
    const realSales = (sales || []).filter(function (s) { return s.saleID && String(s.saleID).charAt(0) === "S"; });
    const sumProdazh = realSales.reduce(function (a, s) { return a + (Number(s.forPay) || 0); }, 0);
    res.json({
      days: days,
      dateFrom: dateFrom,
      kolZakazov: ordersNotCancelled.length,
      sumZakazov: sumZakazov,
      kolProdazh: realSales.length,
      sumProdazh: sumProdazh,
    });
  } catch (e) {
    console.error("Failed to fetch WB orders/sales summary:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/wb/finance/refresh", requireApiKey, async (req, res) => {
  await refreshWbFinanceCache();
  res.json({ ok: true });
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
// - "sku_product_map": { "nmId": "Название товара" } — заполняется вручную
// (через PUT /api/state/sku_product_map), т.к. это те же данные, что уже
// введены на сайте (артикулы в колонке "Артикул").
// - карточки WB (wb_cards_cache) — там же теперь хранятся размеры товара
// (chrtID/techSize/wbSize), чтобы перевести chrtId/techSize в S/M/L/XL/XXL.
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
  log.unshift(Object.assign({ ts: new Date().toISOString() }, entry));
  if (log.length > 500) log.length = 500;
  await saveJson("deduction_log", log);
}

function normalizeSize(raw) {
  if (!raw) return null;
  const up = String(raw).trim().toUpperCase();
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
async function deductUnits(productName, size, qty, context) {
  if (!productName || !size) {
    await appendDeductionLog(
      Object.assign(
        { product: productName || null, size: size || null, qty: qty, unresolved: true, note: "товар или размер не распознаны — сверьте sku_product_map / карточку WB" },
        context
      )
    );
    return;
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

  await appendDeductionLog(
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

async function runFbsPoller() {
  if (!WB_API_TOKEN) return;
  try {
    const supplies = await fetchAllFbsSupplies();
    const processed = await loadJson("fbs_processed_supplies", {});
    const newlyDone = supplies.filter(function (s) { return s.done && !processed[s.id]; });
    if (!newlyDone.length) return;

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
      for (const order of supplyOrders) {
        const nm = String(order.nmId);
        const productName = skuMap[nm] || null;
        const sizeInfo = chrtIndex[String(order.chrtId)];
        // techSize у одежды на этом аккаунте — это буквенный размер (S/M/L/XL/XXL),
        // а wbSize — российский числовой размер (46/48/50...), он нам не подходит.
        const size = sizeInfo ? normalizeSize(sizeInfo.techSize || sizeInfo.wbSize) : null;
        await deductUnits(productName, size, 1, {
          source: "fbs",
          supplyId: supply.id,
          orderId: order.id,
          nmId: order.nmId,
          chrtId: order.chrtId,
        });
      }
      processed[supply.id] = true;
    }
    await saveJson("fbs_processed_supplies", processed);
  } catch (e) {
    console.error("FBS poller error:", e.message);
  }
}

async function fetchAllFboSupplies() {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
  let offset = 0;
  const limit = 1000;
  let all = [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch(WB_SUPPLIES_FBO_URL + "?limit=" + limit + "&offset=" + offset, {
      method: "POST",
      headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
      // ФИКС: WB требует дату в формате YYYY-MM-DD (ISO Date), а не полный
      // ISO-timestamp с временем — раньше здесь стояло from.toISOString()
      // без обрезки, из-за чего WB отвечал 400 "ошибка при считывании даты"
      // на каждом цикле поллера (см. логи Railway). toWbDate() обрезает
      // время и оставляет только дату.
      body: JSON.stringify({ dates: [{ from: toWbDate(from), to: toWbDate(now) }] }),
    });
    if (!res.ok) throw new Error("supplies-api /supplies " + res.status + ": " + (await res.text().catch(() => "")));
    const json = await res.json();
    const supplies = json.supplies || json.data || [];
    all = all.concat(supplies);
    if (supplies.length < limit) break;
    offset += limit;
  }
  return all;
}

async function fetchFboSupplyGoods(supplyId) {
  const res = await fetch(WB_SUPPLIES_FBO_URL + "/" + supplyId + "/goods?limit=1000&offset=0", {
    headers: { Authorization: WB_API_TOKEN },
  });
  if (!res.ok) throw new Error("supplies-api /goods " + res.status + ": " + (await res.text().catch(() => "")));
  return await res.json();
}

async function runFboPoller() {
  if (!WB_API_TOKEN) return;
  try {
    const supplies = await fetchAllFboSupplies();
    const acceptedState = await loadJson("fbo_accepted_state", {});
    const skuMap = await loadJson("sku_product_map", {});

    for (const supply of supplies) {
      // Название поля с ID поставки в этом методе не проверено вживую на
      // 100% по документации — подстраховываемся под разные варианты.
      const supplyId = supply.id || supply.ID || supply.supplyID || supply.incomeID;
      if (!supplyId) continue;
      let goods;
      try {
        goods = await fetchFboSupplyGoods(supplyId);
      } catch (e) {
        continue;
      }
      const list = Array.isArray(goods) ? goods : goods.goods || [];
      for (const g of list) {
        const key = supplyId + ":" + g.barcode;
        const prevAccepted = Number(acceptedState[key]) || 0;
        const nowAccepted = Number(g.acceptedQuantity) || 0;
        const delta = nowAccepted - prevAccepted;
        if (delta > 0) {
          const productName = skuMap[String(g.nmID)] || null;
          const size = normalizeSize(g.techSize);
          await deductUnits(productName, size, delta, {
            source: "fbo",
            supplyId: supplyId,
            barcode: g.barcode,
            nmId: g.nmID,
          });
        }
        acceptedState[key] = nowAccepted;
      }
    }
    await saveJson("fbo_accepted_state", acceptedState);
  } catch (e) {
    console.error("FBO poller error:", e.message);
  }
}

// Журнал списаний — что и когда списалось, чтобы можно было проверить.
app.get("/api/deductions", async (req, res) => {
  const log = await loadJson("deduction_log", []);
  res.json({ entries: log });
});

// Ручной запуск (для проверки), требует X-Api-Key
app.post("/api/deductions/run", requireApiKey, async (req, res) => {
  await runFbsPoller();
  await runFboPoller();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log("wb-ostatki-api listening on " + PORT));
    if (WB_API_TOKEN) {
      refreshWbStockCache(); // сразу при старте сервиса
      refreshWbCardsCache();
      refreshWbFinanceCache();
      setInterval(refreshWbStockCache, 20 * 60 * 1000); // и затем каждые 20 минут
      setInterval(refreshWbCardsCache, 20 * 60 * 1000);
      setInterval(refreshWbFinanceCache, 20 * 60 * 1000);
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
