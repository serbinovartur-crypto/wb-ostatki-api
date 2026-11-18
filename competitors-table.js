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

  const CATEGORIES = [
    { value: "gloves", label: "Перчатки" },
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
      if (m && /перч/i.test(vc)) {
        out.push({ nmID: Number(c.nmID), vendorCode: vc, label: "_" + m[1], photo: c.photo || null, n: Number(m[1]) });
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

  console.log("competitors-table initialised");
};
