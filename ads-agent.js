"use strict";
// Основа рекламного агента: сбор статуса, баланса и метрик всех рекламных
// кампаний по своим карточкам + журнал изменений (что и когда поменялось).
// Подключается одной строкой в конце server.js:
//   require("./ads-agent")({ app, wbFetch, requireApiKey, loadJson, saveJson, WB_API_TOKEN });
//
// Данные хранятся в app_state (через loadJson/saveJson):
//   ads_overview_latest — последний снимок (кампании + баланс + метрики)
//   ads_snapshots       — компактная история снимков (последние 300)
//   ads_journal         — журнал изменений (последние 3000 событий)

module.exports = function initAdsAgent(deps) {
  const { app, wbFetch, requireApiKey, loadJson, saveJson, WB_API_TOKEN } = deps;

  const ADV = "https://advert-api.wildberries.ru";
  const COUNT_URL = ADV + "/adv/v1/promotion/count";
  const ADVERTS_URL = ADV + "/api/advert/v2/adverts";
  const BALANCE_URL = ADV + "/adv/v1/balance";
  const BUDGET_URL = ADV + "/adv/v1/budget";
  const FULLSTATS_URL = ADV + "/adv/v3/fullstats";
  const FUNNEL_URL = "https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products";

  const STATUS_NAMES = { 4: "готова к запуску", 7: "завершена", 8: "отменена", 9: "активна", 11: "на паузе" };
  const WATCH_STATUSES = [4, 9, 11]; // завершённые (7) не берём — их сотни
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const headers = function () { return { Authorization: WB_API_TOKEN }; };

  let running = false;
  let lastStatsAt = 0;

  function mskDate(offsetDays) {
    return new Date(Date.now() + 3 * 3600 * 1000 - (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
  }

  async function getJson(url, opts) {
    const r = await wbFetch(url, opts || { headers: headers() });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* не JSON */ }
    return { ok: r.ok, status: r.status, json: j, text: t.slice(0, 400) };
  }

  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  // ---- сбор ---------------------------------------------------------------
  async function collect() {
    if (!WB_API_TOKEN) throw new Error("WB_API_TOKEN не задан");
    const errors = [];

    const cards = await loadJson("wb_cards_cache", { cards: [] });
    const own = {};
    (cards.cards || []).forEach(function (c) { own[Number(c.nmID)] = c.vendorCode || null; });

    // 1) какие кампании есть и в каких статусах
    const count = await getJson(COUNT_URL);
    if (!count.ok) throw new Error("promotion/count " + count.status + ": " + count.text);
    const ids = [];
    (count.json.adverts || []).forEach(function (g) {
      if (WATCH_STATUSES.indexOf(g.status) !== -1) (g.advert_list || []).forEach(function (a) { ids.push(a.advertId); });
    });

    // 2) настройки кампаний, оставляем те, что касаются своих карточек
    const campaigns = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await getJson(ADVERTS_URL + "?ids=" + ids.slice(i, i + 50).join(","));
      if (!r.ok) { errors.push("adverts " + r.status + ": " + r.text); continue; }
      (r.json.adverts || []).forEach(function (a) {
        const bids = [];
        (a.nm_settings || []).forEach(function (ns) {
          const nm = Number(ns.nm_id);
          if (!(nm in own)) return;
          const bk = ns.bids_kopecks || {};
          bids.push({
            nmID: nm,
            vendorCode: own[nm],
            rec: num(bk.recommendations) !== null ? bk.recommendations / 100 : null,
            search: num(bk.search) !== null ? bk.search / 100 : null,
          });
        });
        if (!bids.length) return;
        const pl = (a.settings && a.settings.placements) || {};
        const ts = a.timestamps || {};
        campaigns.push({
          id: a.id,
          name: (a.settings && a.settings.name) || null,
          status: a.status,
          statusName: STATUS_NAMES[a.status] || ("статус " + a.status),
          paymentType: (a.settings && a.settings.payment_type) || null,
          bidType: a.bid_type || null,
          recommendations: !!pl.recommendations,
          search: !!pl.search,
          createdAt: ts.created || null,
          startedAt: ts.started || null,
          updatedAt: ts.updated || null,
          bids: bids,
          budget: null,
          stats: null,
        });
      });
      await sleep(250);
    }

    // Приоритет: активные кампании, затем недавно менявшиеся (за 30 дней).
    // Остальные старые кампании на паузе остаются в снимке, но без бюджета/метрик.
    const monthAgo = Date.now() - 30 * 86400000;
    const isRelevant = function (c) {
      return c.status === 9 || (c.updatedAt && Date.parse(c.updatedAt) >= monthAgo);
    };
    campaigns.sort(function (a, b) {
      if ((a.status === 9) !== (b.status === 9)) return a.status === 9 ? -1 : 1;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });

    // 3) общий баланс кабинета
    let balance = null;
    try {
      const b = await getJson(BALANCE_URL);
      if (b.ok) balance = { balance: num(b.json.balance), net: num(b.json.net), bonus: num(b.json.bonus) };
      else errors.push("balance " + b.status + ": " + b.text);
    } catch (e) { errors.push("balance: " + e.message); }

    // 4) бюджет каждой кампании
    for (const c of campaigns) {
      if (!isRelevant(c)) continue;
      try {
        const b = await getJson(BUDGET_URL + "?id=" + c.id);
        if (b.ok && b.json) c.budget = { cash: num(b.json.cash), netting: num(b.json.netting), total: num(b.json.total) };
        else errors.push("budget " + c.id + " " + b.status);
      } catch (e) { errors.push("budget " + c.id + ": " + e.message); }
      await sleep(300);
    }

    // 5) статистика за последние 3 дня (у WB лимит 1 запрос в минуту)
    let statsRaw = null;
    const statsTargets = campaigns.filter(isRelevant).slice(0, 50);
    if (statsTargets.length && Date.now() - lastStatsAt > 65 * 1000) {
      lastStatsAt = Date.now();
      try {
        const s = await getJson(FULLSTATS_URL + "?ids=" + statsTargets.map(function (c) { return c.id; }).join(",") +
          "&beginDate=" + mskDate(2) + "&endDate=" + mskDate(0));
        if (s.ok && Array.isArray(s.json)) {
          statsRaw = s.json;
          s.json.forEach(function (st) {
            const c = campaigns.find(function (x) { return x.id === st.advertId; });
            if (!c) return;
            const days = (st.days || []).map(function (d) {
              return {
                date: String(d.date || "").slice(0, 10),
                views: d.views || 0, clicks: d.clicks || 0, spend: d.sum || 0,
                atbs: d.atbs || 0, orders: d.orders || 0, shks: d.shks || 0, revenue: d.sum_price || 0,
              };
            });
            c.stats = {
              periodFrom: mskDate(2), periodTo: mskDate(0),
              views: st.views || 0, clicks: st.clicks || 0, ctr: num(st.ctr), cpc: num(st.cpc),
              spend: st.sum || 0, atbs: st.atbs || 0, orders: st.orders || 0, shks: st.shks || 0,
              revenue: st.sum_price || 0, days: days,
            };
          });
        } else {
          errors.push("fullstats " + s.status + ": " + s.text);
        }
      } catch (e) { errors.push("fullstats: " + e.message); }
    } else if (campaigns.length) {
      errors.push("fullstats пропущен (лимит 1 запрос/мин)");
    }

    // 6) воронка по карточкам (переходы → корзина → заказ → выкуп) за 7 дней и за вчера.
    // Лимит WB — 3 запроса в минуту, поэтому всего два запроса за сбор.
    const funnel = {};
    try {
      const nmIds = [];
      campaigns.forEach(function (c) { c.bids.forEach(function (b) { if (nmIds.indexOf(b.nmID) === -1) nmIds.push(b.nmID); }); });
      if (nmIds.length) {
        const periods = [["d7", mskDate(7), mskDate(1)], ["d1", mskDate(1), mskDate(1)]];
        for (const pr of periods) {
          const f = await getJson(FUNNEL_URL, {
            method: "POST",
            headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({
              selectedPeriod: { start: pr[1], end: pr[2] }, nmIds: nmIds.slice(0, 100), skipDeletedNm: true,
              orderBy: { field: "openCard", mode: "desc" }, limit: 100, offset: 0,
            }),
          });
          if (!f.ok || !f.json || !f.json.data) { errors.push("funnel " + pr[0] + " " + f.status + ": " + f.text); continue; }
          (f.json.data.products || []).forEach(function (p) {
            const nm = p.product && p.product.nmId;
            const s = p.statistic && p.statistic.selected;
            if (!nm || !s) return;
            if (!funnel[nm]) funnel[nm] = { vendorCode: p.product.vendorCode || null };
            const cv = s.conversions || {};
            funnel[nm][pr[0]] = {
              from: pr[1], to: pr[2],
              open: s.openCount || 0, cart: s.cartCount || 0, orders: s.orderCount || 0, orderSum: s.orderSum || 0,
              buyout: s.buyoutCount || 0, cancel: s.cancelCount || 0,
              addToCartPct: num(cv.addToCartPercent), cartToOrderPct: num(cv.cartToOrderPercent), buyoutPct: num(cv.buyoutPercent),
            };
          });
          await sleep(21000); // 3 запроса/мин
        }
      }
    } catch (e) { errors.push("funnel: " + e.message); }

    // метрики не пришли — берём из прошлого снимка, чтобы не терять
    const prev = await loadJson("ads_overview_latest", null);
    if (prev && Array.isArray(prev.campaigns)) {
      campaigns.forEach(function (c) {
        if (c.stats) return;
        const p = prev.campaigns.find(function (x) { return x.id === c.id; });
        if (p && p.stats) { c.stats = Object.assign({}, p.stats, { stale: true }); }
      });
    }

    const snapshot = { takenAt: new Date().toISOString(), balance: balance, campaigns: campaigns, funnel: funnel, errors: errors };
    if (statsRaw && statsRaw[0]) snapshot.statsKeysSample = Object.keys(statsRaw[0]);

    // 6) журнал изменений
    const events = diff(prev, snapshot);
    if (events.length) {
      const journal = await loadJson("ads_journal", []);
      events.forEach(function (e) { journal.push(e); });
      await saveJson("ads_journal", journal.slice(-3000));
    }

    await saveJson("ads_overview_latest", snapshot);
    const hist = await loadJson("ads_snapshots", []);
    hist.push({
      takenAt: snapshot.takenAt,
      balance: balance,
      funnel7: Object.keys(funnel).map(function (nm) {
        const d = funnel[nm].d7 || {};
        return [Number(nm), d.open, d.cart, d.orders, d.orderSum];
      }),
      campaigns: campaigns.map(function (c) {
        return {
          id: c.id, status: c.status, paymentType: c.paymentType,
          bids: c.bids.map(function (b) { return [b.nmID, b.rec, b.search]; }),
          budget: c.budget && c.budget.total,
          views: c.stats && c.stats.views, clicks: c.stats && c.stats.clicks,
          spend: c.stats && c.stats.spend, atbs: c.stats && c.stats.atbs, orders: c.stats && c.stats.orders,
        };
      }),
    });
    await saveJson("ads_snapshots", hist.slice(-300));

    // дневной журнал: по каждой кампании и дню — расход и выручка с рекламы (ДРР считается из него).
    // WB отдаёт данные только за последние дни, поэтому копим сами; день перезаписывается свежим значением.
    try {
      const daily = await loadJson("ads_daily", {});
      campaigns.forEach(function (c) {
        if (!c.stats || !c.stats.days) return;
        c.stats.days.forEach(function (d) {
          daily[d.date + "|" + c.id] = {
            date: d.date, id: c.id, pt: c.paymentType,
            nm: c.bids.map(function (b) { return b.nmID; }),
            card: c.bids.map(function (b) { return b.vendorCode; }),
            spend: d.spend, revenue: d.revenue, orders: d.orders, clicks: d.clicks, views: d.views, atbs: d.atbs,
            updated: snapshot.takenAt,
          };
        });
      });
      const keys = Object.keys(daily).sort();
      if (keys.length > 6000) keys.slice(0, keys.length - 6000).forEach(function (k) { delete daily[k]; });
      await saveJson("ads_daily", daily);
    } catch (e) { console.error("ads_daily error:", e.message); }

    // почасовой ряд: накопленные за СЕГОДНЯ (МСК) показатели каждой кампании.
    // WB отдаёт статистику только по дням, поэтому часовую картину получаем разностью соседних снимков.
    try {
      const today = mskDate(0);
      const rows = [];
      campaigns.forEach(function (c) {
        if (!c.stats || c.stats.stale) return;
        const d = (c.stats.days || []).find(function (x) { return x.date === today; }) || { views: 0, clicks: 0, spend: 0, atbs: 0, orders: 0 };
        rows.push([c.id, d.views, d.clicks, d.spend, d.atbs, d.orders, c.budget ? c.budget.total : null, c.status,
          (c.bids[0] ? c.bids[0].rec : null), (c.bids[0] ? c.bids[0].search : null)]);
      });
      if (rows.length) {
        const series = await loadJson("ads_hourly", []);
        series.push({ t: snapshot.takenAt, date: today, rows: rows });
        await saveJson("ads_hourly", series.slice(-3000)); // ~60 суток при сборе раз в 30 мин
      }
    } catch (e) { errors.push("hourly: " + e.message); }

    return { takenAt: snapshot.takenAt, campaigns: campaigns.length, newEvents: events.length, errors: errors };
  }

  // ---- сравнение двух снимков → события журнала ---------------------------
  function diff(prev, next) {
    const at = next.takenAt;
    const ev = [];
    const label = function (c) { return c.name || String(c.id); };
    if (!prev || !Array.isArray(prev.campaigns)) {
      ev.push({ at: at, type: "baseline", text: "Первый снимок: кампаний по своим карточкам — " + next.campaigns.length });
      return ev;
    }
    const prevById = {};
    prev.campaigns.forEach(function (c) { prevById[c.id] = c; });
    const nextById = {};
    next.campaigns.forEach(function (c) { nextById[c.id] = c; });

    next.campaigns.forEach(function (c) {
      const p = prevById[c.id];
      if (!p) {
        ev.push({ at: at, type: "campaign_new", campaignId: c.id, name: c.name, text: "Новая кампания " + label(c) + " (" + c.statusName + ", " + c.paymentType + ")" });
        return;
      }
      if (p.status !== c.status) {
        const e = {
          at: at, type: "status", campaignId: c.id, name: c.name, old: p.statusName, new: c.statusName,
          wbUpdatedAt: c.updatedAt,
          text: label(c) + ": статус «" + p.statusName + "» → «" + c.statusName + "»",
        };
        if (c.status === 11 && c.budget && c.budget.total !== null && c.budget.total <= 0) {
          e.note = "бюджет кампании на нуле — вероятная причина паузы (предположение)";
        }
        ev.push(e);
      }
      if (p.paymentType !== c.paymentType) {
        ev.push({ at: at, type: "payment_type", campaignId: c.id, name: c.name, old: p.paymentType, new: c.paymentType, text: label(c) + ": тип оплаты " + p.paymentType + " → " + c.paymentType });
      }
      if (p.recommendations !== c.recommendations || p.search !== c.search) {
        ev.push({ at: at, type: "placements", campaignId: c.id, name: c.name, text: label(c) + ": размещение изменилось (рекомендации " + p.recommendations + "→" + c.recommendations + ", поиск " + p.search + "→" + c.search + ")" });
      }
      c.bids.forEach(function (b) {
        const pb = (p.bids || []).find(function (x) { return x.nmID === b.nmID; });
        if (!pb) {
          ev.push({ at: at, type: "bid_new", campaignId: c.id, nmID: b.nmID, text: label(c) + ": добавлена карточка " + (b.vendorCode || b.nmID) + " со ставкой " + b.rec + "/" + b.search });
          return;
        }
        if (pb.rec !== b.rec || pb.search !== b.search) {
          ev.push({
            at: at, type: "bid", campaignId: c.id, name: c.name, nmID: b.nmID, vendorCode: b.vendorCode,
            old: pb.rec + "/" + pb.search, new: b.rec + "/" + b.search,
            text: label(c) + " (" + (b.vendorCode || b.nmID) + "): ставка рек/поиск " + pb.rec + "/" + pb.search + " → " + b.rec + "/" + b.search,
          });
        }
      });
      const pt = p.budget && p.budget.total;
      const ct = c.budget && c.budget.total;
      if (typeof pt === "number" && typeof ct === "number") {
        if (pt > 0 && ct <= 0) {
          ev.push({ at: at, type: "budget_zero", campaignId: c.id, name: c.name, old: pt, new: ct, text: label(c) + ": бюджет закончился (было " + pt + " ₽)" });
        } else if (ct - pt >= 1 && ct > pt) {
          ev.push({ at: at, type: "budget_topup", campaignId: c.id, name: c.name, old: pt, new: ct, text: label(c) + ": бюджет пополнен " + pt + " → " + ct + " ₽" });
        }
      }
    });
    prev.campaigns.forEach(function (p) {
      if (!nextById[p.id]) {
        ev.push({ at: at, type: "campaign_gone", campaignId: p.id, name: p.name, text: "Кампания " + (p.name || p.id) + " больше не в списке наблюдения (была: " + p.statusName + ")" });
      }
    });
    return ev;
  }

  // ---- запуск с защитой от параллельных вызовов ---------------------------
  async function safeCollect() {
    if (running) return { skipped: "уже выполняется" };
    running = true;
    try { return await collect(); }
    finally { running = false; }
  }

  // ---- эндпоинты ----------------------------------------------------------
  app.post("/api/ads/collect", requireApiKey, async (req, res) => {
    try { res.json({ ok: true, result: await safeCollect() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/ads/overview", requireApiKey, async (req, res) => {
    try { res.json(await loadJson("ads_overview_latest", null)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/ads/journal", requireApiKey, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 1000);
      const since = req.query.since ? String(req.query.since) : null;
      let j = await loadJson("ads_journal", []);
      if (since) j = j.filter(function (e) { return e.at >= since; });
      res.json({ count: j.length, events: j.slice(-limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Проверка, какие данные реально отдаёт токен (баланс, бюджет, воронка).
  // Эффективность по часам суток (МСК): разность соседних снимков внутри одного дня.
  // ?id=кампания (необязательно) &days=сколько суток назад (по умолчанию 14)
  app.get("/api/ads/hourly", requireApiKey, async (req, res) => {
    try {
      const days = Math.min(Number(req.query.days) || 14, 60);
      const onlyId = req.query.id ? Number(req.query.id) : null;
      const since = Date.now() - days * 86400000;
      const series = (await loadJson("ads_hourly", [])).filter(function (s) { return Date.parse(s.t) >= since; });
      const out = {}; // id -> hour -> {spend, clicks, views, atbs, orders, bidSum, n}
      for (let i = 1; i < series.length; i++) {
        const a = series[i - 1], b = series[i];
        if (a.date !== b.date) continue; // через полночь счётчик сбрасывается
        const hour = new Date(Date.parse(b.t) + 3 * 3600 * 1000).getUTCHours(); // час МСК конца интервала
        const prevRows = {};
        a.rows.forEach(function (r) { prevRows[r[0]] = r; });
        b.rows.forEach(function (r) {
          const p = prevRows[r[0]];
          if (!p || (onlyId && r[0] !== onlyId)) return;
          const dv = r[1] - p[1], dc = r[2] - p[2], ds = r[3] - p[3], da = r[4] - p[4], dord = r[5] - p[5];
          if (dv < 0 || ds < 0) return;
          const o = out[r[0]] = out[r[0]] || {};
          const h = o[hour] = o[hour] || { views: 0, clicks: 0, spend: 0, atbs: 0, orders: 0, intervals: 0, activeIntervals: 0 };
          h.views += dv; h.clicks += dc; h.spend += ds; h.atbs += da; h.orders += dord; h.intervals++;
          if (r[7] === 9) h.activeIntervals++;
        });
      }
      Object.keys(out).forEach(function (id) {
        Object.keys(out[id]).forEach(function (hr) {
          const h = out[id][hr];
          h.spend = Math.round(h.spend * 100) / 100;
          h.ctr = h.views ? Math.round(h.clicks / h.views * 10000) / 100 : null;
          h.cpc = h.clicks ? Math.round(h.spend / h.clicks * 100) / 100 : null;
          h.costPerOrder = h.orders ? Math.round(h.spend / h.orders) : null;
        });
      });
      res.json({ snapshots: series.length, from: series[0] && series[0].t, to: series.length && series[series.length - 1].t, byCampaignHourMsk: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/ads/diag", requireApiKey, async (req, res) => {
    const out = {};
    try {
      const b = await getJson(BALANCE_URL);
      out.balance = { status: b.status, body: b.json || b.text };
      const id = Number(req.query.id) || 41084042;
      const bu = await getJson(BUDGET_URL + "?id=" + id);
      out.budget = { status: bu.status, body: bu.json || bu.text };
      const nm = Number(req.query.nm) || 1852030916;
      const f = await getJson(FUNNEL_URL, {
        method: "POST",
        headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedPeriod: { start: mskDate(7), end: mskDate(1) },
          nmIds: [nm], skipDeletedNm: true,
          orderBy: { field: "openCard", mode: "desc" }, limit: 10, offset: 0,
        }),
      });
      out.funnel = { status: f.status, body: f.json || f.text };
      res.json(out);
    } catch (e) { out.error = e.message; res.status(500).json(out); }
  });

  // Дневная воронка карточек (просмотры, корзины, заказы, выкупы) за период — для разбора «почему карточка выросла».
  // GET /api/ads/funnel-history?nm=1998109943,1852087714&start=2026-11-01&end=2026-11-18  (сырой ответ WB, ничего не пишет)
  app.get("/api/ads/funnel-history", requireApiKey, async (req, res) => {
    try {
      const nmIds = String(req.query.nm || "").split(",").map(Number).filter(Boolean);
      if (!nmIds.length) return res.status(400).json({ error: "nm обязателен" });
      const start = String(req.query.start || mskDate(7));
      const end = String(req.query.end || mskDate(1));
      const r = await getJson(FUNNEL_URL + "/history", {
        method: "POST",
        headers: { Authorization: WB_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ selectedPeriod: { start: start, end: end }, nmIds: nmIds, skipDeletedNm: true, aggregationLevel: "day" }),
      });
      res.status(r.ok ? 200 : 502).json({ status: r.status, body: r.json || r.text });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Что умеет токен WB (без показа самого токена): срок действия и набор прав из его содержимого.
  // Расшифровываем только публичную часть JWT (без проверки подписи). Это справочная информация:
  // «только чтение» определяем по биту 30 (по документации WB; на практике не проверено записью).
  app.get("/api/ads/token-info", requireApiKey, function (req, res) {
    try {
      const parts = String(WB_API_TOKEN || "").split(".");
      if (parts.length < 2) return res.json({ ok: false, error: "токен не похож на JWT" });
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      const s = Number(payload.s);
      const bits = [];
      for (let i = 0; i < 31; i++) { if (Math.floor(s / Math.pow(2, i)) % 2 === 1) bits.push(i); }
      res.json({
        ok: true,
        expires: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
        scopeBits: bits,
        readOnlyBit30: bits.indexOf(30) !== -1,
        test: payload.t === true,
        payloadKeys: Object.keys(payload),
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---- расписание: раз в 30 минут, чтобы журнал ловил изменения между сканами
  setTimeout(function () {
    safeCollect().catch(function (e) { console.error("ads-agent collect error:", e.message); });
    setInterval(function () {
      safeCollect().catch(function (e) { console.error("ads-agent collect error:", e.message); });
    }, 30 * 60 * 1000);
  }, 2 * 60 * 1000);

  // таблица позиций «свои карточки × конкуренты» для сайта (отдельный файл)
  try { require("./competitors-table")({ app: app, loadJson: loadJson, saveJson: saveJson, requireApiKey: requireApiKey }); }
  catch (e) { console.error("competitors-table init failed:", e.message); }

  console.log("ads-agent initialised");
};
