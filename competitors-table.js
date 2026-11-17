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
        for (const c of comps) {
          const data = await loadJson("competitor_scan_" + c.id, { history: {}, scans: {} });
          const all = scansOf(data);
          const last = all.length ? all[all.length - 1] : null;
          const prev = all.length > 1 ? all[all.length - 2] : null;
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
        result.push({ value: cat.value, label: cat.label, cards: colCards, rows: rows });
      }
      res.json({ categories: result, refreshRequests: flags, now: new Date().toISOString() });
    } catch (e) {
      console.error("competitors table error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log("competitors-table initialised");
};
