// Таблица позиций «свои карточки × конкуренты» для сайта (вкладка «Конкуренты»).
// Только читает уже сохранённые сканы (competitor_scan_<id>) — ничего не пишет.
// Подключается из ads-agent.js (одной строкой), server.js не меняется.
//
// GET /api/competitors/table  ->  { categories: [ { value, label, cards[], rows[] } ], refreshRequests, now }
//   cards: свои карточки-колонки (nmID, vendorCode, label, photo)
//   rows:  конкуренты (id, nmID, name, photo, scannedAt, totalSeen, pos{nmID:позиция}, prev{nmID:позиция})

module.exports = function initCompetitorsTable(deps) {
  const app = deps.app;
  const loadJson = deps.loadJson;
  // ключ API для эндпоинтов с данными рекламы (если ads-agent его передал)
  const guard = deps.requireApiKey || function (req, res, next) { next(); };

  const CATEGORIES = [
    { value: "gloves", label: "Перчатки" },
    { value: "gloves_women", label: "Женские перчатки" },
    { value: "cardigans", label: "Кардиганы" },
    { value: "hoodies", label: "Худи" },
    { value: "shirts", label: "Рубашки" },
    { value: "other", label: "Прочее" },
  ];

  // Перчатки: свои карточки с номером в конце артикула продавца (_01 … _08).
  function glovesCards(cards) {
    const out = [];
    cards.forEach(function (c) {
      const vc = String(c.vendorCode || "");
      const m = vc.match(/_(\d{2})$/);
      // мужские: без «жен» в артикуле продавца (женские — отдельная категория gloves_women)
      if (m && /перч/i.test(vc) && !/жен/i.test(vc)) {
        out.push({ nmID: Number(c.nmID), vendorCode: vc, label: "_" + m[1], photo: c.photo || null, n: Number(m[1]) });
      }
    });
    out.sort(function (a, b) { return a.n - b.n; });
    return out.map(function (c) { delete c.n; return c; });
  }

  // Женские перчатки: артикул продавца вида ПЕРЧ_ЖЕН_БОРД_01 — колонки «ж_01», «ж_02»…
  function womenGlovesCards(cards) {
    const out = [];
    cards.forEach(function (c) {
      const vc = String(c.vendorCode || "");
      const m = vc.match(/_(\d{2})$/);
      if (m && /перч/i.test(vc) && /жен/i.test(vc)) {
        out.push({ nmID: Number(c.nmID), vendorCode: vc, label: "ж_" + m[1], photo: c.photo || null, n: Number(m[1]) });
      }
    });
    out.sort(function (a, b) { return a.n - b.n; });
    return out.map(function (c) { delete c.n; return c; });
  }

  // Кардиганы: свои карточки «Кардиган_<цвет>_NN» (тестовые «Кардиган тест …» не берём).
  function cardigansCards(cards) {
    const out = [];
    cards.forEach(function (c) {
      const vc = String(c.vendorCode || "");
      const m = vc.match(/^кардиган_.*?(\d{2})$/i);
      if (m) {
        out.push({ nmID: Number(c.nmID), vendorCode: vc, label: vc.replace(/^кардиган_/i, ""), photo: c.photo || null, n: Number(m[1]) });
      }
    });
    out.sort(function (a, b) { return a.n - b.n; });
    return out.map(function (c) { delete c.n; return c; });
  }

  function scansOf(data) {
    const all = [];
    const scans = (data && data.scans) || {};
    Object.keys(scans).forEach(function (d) { (scans[d] || []).forEach(function (s) { all.push(s); }); });
    if (!all.length && data && data.history) {
      Object.keys(data.history).forEach(function (d) { all.push(data.history[d]); });
    }
    all.sort(function (a, b) { return String(a.scannedAt).localeCompare(String(b.scannedAt)); });
    return all;
  }

  function posMap(scan) {
    const m = {};
    if (!scan) return m;
    (scan.matches || []).forEach(function (x) {
      if (x && x.nmID != null && x.position != null) m[String(x.nmID)] = x.position;
    });
    return m;
  }

  // Реклама из снимка, который сервер сохраняет в самом скане (adsSnapshot): только полки.
  function fromScanSnapshot(snap, at) {
    if (!snap || !at) return null;
    const byNm = {};
    (snap.campaigns || []).forEach(function (c) {
      if (!c.recommendations) return;
      const pt = String(c.paymentType || "").toLowerCase();
      if (pt !== "cpm" && pt !== "cpc") return;
      (c.bids || []).forEach(function (b) {
        if (b.rec === null || b.rec === undefined) return;
        const k = String(b.nmID);
        (byNm[k] = byNm[k] || []).push({ t: pt.toUpperCase() + (c.bidType === "unified" ? " авто" : ""), bid: b.rec });
      });
    });
    return { at: at, byNm: byNm };
  }

  // Реклама на полках (рекомендации) у своих карточек в момент замера.
  // Берём последний снимок агента (ads_snapshots, раз в 30 мин) не позже момента замера.
  // Только активные кампании (status 9) с размещением «рекомендации»; поиск игнорируем.
  // Результат кэшируем по времени замера, чтобы история не терялась, когда старые снимки удалятся.
  async function adStateAt(isoTime) {
    if (!isoTime) return null;
    const cache = await loadJson("competitors_ad_state", {});
    if (cache[isoTime]) return cache[isoTime];
    const snaps = await loadJson("ads_snapshots", []);
    const target = Date.parse(isoTime);
    let best = null;
    snaps.forEach(function (s) {
      const t = Date.parse(s.takenAt);
      if (!isNaN(t) && t <= target + 5 * 60 * 1000 && (!best || t > Date.parse(best.takenAt))) best = s;
    });
    if (!best || target - Date.parse(best.takenAt) > 60 * 60 * 1000) return null;
    const byNm = {};
    (best.campaigns || []).forEach(function (c) {
      if (c.status !== 9) return;
      const pt = String(c.paymentType || "").toLowerCase();
      if (pt !== "cpm" && pt !== "cpc") return;
      (c.bids || []).forEach(function (b) {
        if (b[1] === null || b[1] === undefined) return; // нет ставки на рекомендации
        const k = String(b[0]);
        (byNm[k] = byNm[k] || []).push({ t: pt.toUpperCase(), bid: b[1] });
      });
    });
    const out = { at: isoTime, snapshotAt: best.takenAt, byNm: byNm };
    cache[isoTime] = out;
    const keys = Object.keys(cache).sort();
    while (keys.length > 500) delete cache[keys.shift()];
    try { await deps.saveJson("competitors_ad_state", cache); } catch (e) { console.error("ad state save:", e.message); }
    return out;
  }

  app.get("/api/competitors/table", async function (req, res) {
    try {
      const list = await loadJson("competitors_list", []);
      let order = await loadJson("competitors_order", []);
      if (!Array.isArray(order)) order = [];
      const cardsCache = await loadJson("wb_cards_cache", { cards: [] });
      const cards = cardsCache.cards || [];
      const cardByNm = {};
      cards.forEach(function (c) { cardByNm[String(c.nmID)] = c; });
      const flags = await loadJson("competitor_refresh_requests", {});

      // порядок как на сайте (перетаскиванием), остальные — в конце
      const idx = {};
      order.forEach(function (id, i) { idx[id] = i; });
      const sorted = list.slice().sort(function (a, b) {
        const ia = idx[a.id] === undefined ? 1e9 : idx[a.id];
        const ib = idx[b.id] === undefined ? 1e9 : idx[b.id];
        return ia - ib;
      });

      const result = [];
      for (const cat of CATEGORIES) {
        const comps = sorted.filter(function (c) { return (c.category || "shirts") === cat.value; });
        if (!comps.length) continue;
        const rows = [];
        const seenNm = {};
        let snapObj = null, snapAt = null;
        for (const c of comps) {
          const data = await loadJson("competitor_scan_" + c.id, { history: {}, scans: {} });
          const all = scansOf(data);
          const last = all.length ? all[all.length - 1] : null;
          const prev = all.length > 1 ? all[all.length - 2] : null;
          if (last && last.adsSnapshot && (!snapAt || last.scannedAt > snapAt)) { snapAt = last.scannedAt; snapObj = last.adsSnapshot; }
          const pos = posMap(last);
          Object.keys(pos).forEach(function (k) { seenNm[k] = true; });
          rows.push({
            id: c.id, nmID: c.nmID, name: c.wbTitle || c.name, photo: c.photo || null, active: c.active !== false,
            scannedAt: last ? last.scannedAt : null, totalSeen: last ? last.totalSeen : null,
            pos: pos, prev: posMap(prev), refreshRequestedAt: flags[c.id] || null,
          });
        }
        let colCards;
        if (cat.value === "gloves") {
          colCards = glovesCards(cards);
        } else if (cat.value === "gloves_women") {
          colCards = womenGlovesCards(cards);
        } else if (cat.value === "cardigans") {
          colCards = cardigansCards(cards);
        } else {
          // для остальных категорий колонки — свои карточки, найденные в последних сканах
          colCards = Object.keys(seenNm).map(function (k) {
            const c = cardByNm[k] || {};
            return { nmID: Number(k), vendorCode: c.vendorCode || String(k), label: c.vendorCode || String(k), photo: c.photo || null };
          });
        }
        let tmax = null;
        rows.forEach(function (r) { if (r.scannedAt && (!tmax || r.scannedAt > tmax)) tmax = r.scannedAt; });
        // приоритет — снимок рекламы, сохранённый самим сканом (точно на момент замера)
        let ad = fromScanSnapshot(snapObj, snapAt);
        if (!ad) { try { ad = await adStateAt(tmax); } catch (e) { console.error("ad state:", e.message); } }
        result.push({ value: cat.value, label: cat.label, cards: colCards, rows: rows, ad: ad });
      }
      res.json({ categories: result, refreshRequests: flags, now: new Date().toISOString() });
    } catch (e) {
      console.error("competitors table error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Поставить отметки «нужен замер» сразу для многих конкурентов ОДНОЙ записью.
  // (Раньше сайт слал по запросу на каждого параллельно, и записи затирали друг друга — терялись отметки.)
  app.post("/api/competitors-table/request-refresh", async function (req, res) {
    try {
      const ids = (req.body && Array.isArray(req.body.ids)) ? req.body.ids.map(String) : [];
      const flags = await loadJson("competitor_refresh_requests", {});
      const nowIso = new Date().toISOString();
      ids.forEach(function (id) { flags[id] = nowIso; });
      await deps.saveJson("competitor_refresh_requests", flags);
      res.json({ ok: true, count: ids.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // «Память» агента: точки «реклама → позиция». Собирается из сохранённых замеров (ничего нового не пишет).
  // GET /api/ads/learning?days=30&category=gloves
  //   points:  по каждому замеру и своей карточке — тип/ставка рекламы на полках, средняя позиция у конкурентов, сколько конкурентов показали карточку
  //   summary: по каждой карточке и конфигурации рекламы — число замеров, средняя/мин/макс позиция
  app.get("/api/ads/learning", guard, async function (req, res) {
    try {
      const days = Math.max(1, Math.min(120, Number(req.query.days) || 30));
      const category = String(req.query.category || "gloves");
      const since = Date.now() - days * 86400000;
      const list = (await loadJson("competitors_list", [])).filter(function (c) { return (c.category || "shirts") === category && c.active !== false; });
      const cardsCache = await loadJson("wb_cards_cache", { cards: [] });
      const own = category === "gloves" ? glovesCards(cardsCache.cards || []) : [];
      const labelByNm = {};
      own.forEach(function (c) { labelByNm[String(c.nmID)] = c.label; });

      const batches = {}; // key -> {t, byNm:{nm:[pos]}, comps:Set, snap}
      for (const c of list) {
        const data = await loadJson("competitor_scan_" + c.id, { history: {}, scans: {} });
        scansOf(data).forEach(function (s) {
          const t = Date.parse(s.scannedAt);
          if (isNaN(t) || t < since || s.restored) return;
          const key = String(Math.floor(t / (10 * 60 * 1000)));
          const b = batches[key] || (batches[key] = { t: s.scannedAt, byNm: {}, comps: 0, snap: null });
          if (s.scannedAt < b.t) b.t = s.scannedAt;
          b.comps++;
          if (!b.snap && s.adsSnapshot) b.snap = s.adsSnapshot;
          (s.matches || []).forEach(function (m) {
            if (m.position == null) return;
            (b.byNm[String(m.nmID)] = b.byNm[String(m.nmID)] || []).push(m.position);
          });
        });
      }

      const points = [];
      Object.keys(batches).sort().forEach(function (k) {
        const b = batches[k];
        if (!b.snap || b.comps < 3) return; // без снимка рекламы или слишком мало конкурентов — не точка знания
        const ad = fromScanSnapshot(b.snap, b.t);
        own.forEach(function (c) {
          const nm = String(c.nmID);
          const pos = b.byNm[nm] || [];
          const cfg = (ad.byNm[nm] || []).map(function (a) { return a.t + " " + a.bid; });
          points.push({
            t: b.t, nmID: c.nmID, card: c.label,
            ad: cfg.length ? cfg.join(" + ") : "выкл",
            avgPos: pos.length ? Math.round(pos.reduce(function (x, y) { return x + y; }, 0) / pos.length * 10) / 10 : null,
            present: pos.length, of: b.comps,
          });
        });
      });

      const sum = {};
      points.forEach(function (p) {
        const k = p.card + " | " + p.ad;
        const s = sum[k] || (sum[k] = { card: p.card, ad: p.ad, n: 0, withPos: 0, sum: 0, min: null, max: null });
        s.n++;
        if (p.avgPos !== null) { s.withPos++; s.sum += p.avgPos; s.min = s.min === null ? p.avgPos : Math.min(s.min, p.avgPos); s.max = s.max === null ? p.avgPos : Math.max(s.max, p.avgPos); }
      });
      const summary = Object.keys(sum).sort().map(function (k) {
        const s = sum[k];
        return { card: s.card, ad: s.ad, measurements: s.n, avgPos: s.withPos ? Math.round(s.sum / s.withPos * 10) / 10 : null, best: s.min, worst: s.max };
      });
      res.json({ category: category, days: days, points: points, summary: summary });
    } catch (e) {
      console.error("ads learning error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ДРР: расход на рекламу / выручка. Из дневного журнала ads_daily (копится агентом).
  // GET /api/ads/drr?days=7
  //   byCampaign: расход, выручка «с рекламы» (по данным рекламного кабинета), ДРР рекламы, CPC
  //   byCard:     то же по карточке (только кампании с одной карточкой) + «общий ДРР» = расход / ВСЕ заказы карточки (воронка за те же даты)
  app.get("/api/ads/drr", guard, async function (req, res) {
    try {
      const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
      const daily = await loadJson("ads_daily", {});
      const overview = await loadJson("ads_overview_latest", {});
      const funnel = overview.funnel || {};
      const cardsCache = await loadJson("wb_cards_cache", { cards: [] });
      const vc = {};
      (cardsCache.cards || []).forEach(function (c) { vc[String(c.nmID)] = c.vendorCode; });
      const msk = new Date(Date.now() + 3 * 3600 * 1000);
      const today = msk.toISOString().slice(0, 10);
      const fromDate = new Date(msk.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const rows = Object.keys(daily).map(function (k) { return daily[k]; }).filter(function (r) { return r.date >= fromDate && r.date <= today; });
      const pct = function (a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : null; };
      const r2 = function (x) { return Math.round(x * 100) / 100; };

      const camp = {};
      rows.forEach(function (r) {
        const c = camp[r.id] || (camp[r.id] = { id: r.id, type: r.pt, cards: r.card, nm: r.nm, spend: 0, revenue: 0, orders: 0, clicks: 0, views: 0, daysCount: 0 });
        c.spend += r.spend || 0; c.revenue += r.revenue || 0; c.orders += r.orders || 0; c.clicks += r.clicks || 0; c.views += r.views || 0; c.daysCount++;
      });
      const byCampaign = Object.keys(camp).map(function (id) {
        const c = camp[id];
        return { id: c.id, type: c.type, cards: c.cards, spend: r2(c.spend), revenue: r2(c.revenue), orders: c.orders, clicks: c.clicks, cpc: c.clicks ? r2(c.spend / c.clicks) : null, drrAdsPct: pct(c.spend, c.revenue), days: c.daysCount };
      }).filter(function (c) { return c.spend > 0 || c.revenue > 0; }).sort(function (a, b) { return b.spend - a.spend; });

      // по карточкам (только однокарточные кампании); общий ДРР — по окну воронки d7
      const card = {};
      rows.forEach(function (r) {
        if (!r.nm || r.nm.length !== 1) return;
        const nm = String(r.nm[0]);
        const c = card[nm] || (card[nm] = { nmID: Number(nm), card: vc[nm] || (r.card && r.card[0]) || nm, spend: 0, revenue: 0, orders: 0, spendInFunnelWindow: 0 });
        c.spend += r.spend || 0; c.revenue += r.revenue || 0; c.orders += r.orders || 0;
        const f = funnel[nm] && funnel[nm].d7;
        if (f && f.from && f.to && r.date >= f.from && r.date <= f.to) {
          c.spendInFunnelWindow += r.spend || 0;
          (c.winDates || (c.winDates = {}))[r.date] = true;
        }
      });
      const byCard = Object.keys(card).map(function (nm) {
        const c = card[nm];
        const f = funnel[nm] && funnel[nm].d7;
        return {
          nmID: c.nmID, card: c.card, spend: r2(c.spend), adRevenue: r2(c.revenue), adOrders: c.orders,
          drrAdsPct: pct(c.spend, c.revenue),
          funnelWindow: f ? { from: f.from || null, to: f.to || null } : null,
          allOrdersSum: f && f.orderSum != null ? f.orderSum : null,
          // общий ДРР считаем только если журнал покрывает все дни окна воронки (иначе расход занижен и ДРР вводит в заблуждение)
          journalDaysInWindow: Object.keys(c.winDates || {}).length,
          drrTotalPct: f && f.orderSum && f.from && f.to && Object.keys(c.winDates || {}).length >= Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86400000) + 1
            ? pct(c.spendInFunnelWindow, f.orderSum) : null,
        };
      }).sort(function (a, b) { return b.spend - a.spend; });

      const byDay = {};
      rows.forEach(function (r) {
        const d = byDay[r.date] || (byDay[r.date] = { date: r.date, spend: 0, revenue: 0 });
        d.spend += r.spend || 0; d.revenue += r.revenue || 0;
      });
      const dayList = Object.keys(byDay).sort().map(function (k) { const d = byDay[k]; return { date: d.date, spend: r2(d.spend), revenue: r2(d.revenue), drrAdsPct: pct(d.spend, d.revenue) }; });

      res.json({ days: days, from: fromDate, to: today, journalDays: Object.keys(byDay).length, byDay: dayList, byCard: byCard, byCampaign: byCampaign });
    } catch (e) {
      console.error("ads drr error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Показы/клики/расход кампании по времени внутри дня (разность соседних снимков ads_hourly, ~каждые 30 мин, МСК).
  // GET /api/ads/day-series?id=41987099&date=2026-11-18
  app.get("/api/ads/day-series", guard, async function (req, res) {
    try {
      const id = Number(req.query.id);
      const date = String(req.query.date || "");
      const list = await loadJson("ads_hourly", []);
      const snaps = list.filter(function (s) { return s.date === date; }).sort(function (a, b) { return String(a.t).localeCompare(String(b.t)); });
      const out = [];
      let prev = null;
      snaps.forEach(function (s) {
        const row = (s.rows || []).filter(function (r) { return r[0] === id; })[0];
        if (!row) return;
        const cur = { t: s.t, views: row[1] || 0, clicks: row[2] || 0, spend: row[3] || 0, atbs: row[4] || 0, orders: row[5] || 0, status: row[7], rec: row[8], search: row[9] };
        if (prev) {
          const msk = new Date(Date.parse(cur.t) + 3 * 3600 * 1000).toISOString().slice(11, 16);
          out.push({ mskTime: msk, views: cur.views - prev.views, clicks: cur.clicks - prev.clicks, spend: Math.round((cur.spend - prev.spend) * 100) / 100, atbs: cur.atbs - prev.atbs, orders: cur.orders - prev.orders, rec: cur.rec, search: cur.search });
        }
        prev = cur;
      });
      res.json({ id: id, date: date, snapshots: snaps.length, series: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Задать конкуренту фото и название (для таблицы). POST /api/competitors-table/info {id, photo, title}
  app.post("/api/competitors-table/info", guard, async function (req, res) {
    try {
      const b = req.body || {};
      const list = await loadJson("competitors_list", []);
      const idx = list.findIndex(function (c) { return c.id === b.id; });
      if (idx === -1) return res.status(404).json({ error: "конкурент не найден" });
      if (b.photo) list[idx].photo = String(b.photo);
      if (b.title) list[idx].wbTitle = String(b.title);
      await deps.saveJson("competitors_list", list);
      res.json({ ok: true, competitor: list[idx] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log("competitors-table initialised");
};
