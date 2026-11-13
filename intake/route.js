/* ============ Drive-time ranking (beta) ============
   Pure functions, no page access: used by schedule.js, and testable on their own.
   Ranks each day and AM/PM block by how much driving a new stop adds to that
   day's route, following the Scheduling Playbook:
   - every day starts at the shop; the crew leaves at the start hour
   - stops run in booked order; the new stop is tried between each pair
   - days already at their point cap, and blocks held by a calendar block, are skipped
   - a caller more than farMinutes from the shop gets no automatic slots
   Drive time is an estimate from straight-line distance (no outside service). */
(function (root) {
  const R_MI = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;

  function miles(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Road miles ~ 1.3x straight line. Short hops run on town streets (~24 mph),
  // longer ones on I-35 and ranch roads (up to ~48 mph), plus 2 minutes to park.
  function driveMinutes(a, b, cfg) {
    const d = cfg.drive || {};
    const mi = miles(a, b) * (d.roadFactor ?? 1.3);
    if (mi < 0.05) return 0;
    const mph = Math.min(d.maxMph ?? 48, Math.max(d.minMph ?? 24, (d.minMph ?? 24) + mi * (d.mphPerMile ?? 1.8)));
    return (mi / mph) * 60 + (d.parkMinutes ?? 2);
  }

  const hasPt = (p) => !!p && typeof p.lat === "number" && typeof p.lng === "number" && isFinite(p.lat) && isFinite(p.lng);

  /* day: { key, label, jobs:[{start, lat, lng, city, points}], events:[{start,end,all_day}],
            load:{points, cap, extra} }  (jobs already filtered to the crew or tech)
     opts: { newPoints, blocks:{AM:[startHour,endHour], PM:[...]}, blockCaps:{AM,PM},
             hourOf(iso)->local hour, cutoff? }
     Returns candidate spots for this day (zero, one per block). */
  function daySpots(day, caller, cfg, opts) {
    const shop = cfg.shop;
    const out = [];
    const jobs = day.jobs.filter((j) => hasPt(j)).slice().sort((a, b) => (a.start < b.start ? -1 : 1));
    const unplaced = day.jobs.length - jobs.length;
    if (day.load.points + opts.newPoints > day.load.cap) return out; // full: the extra point is for same-day only

    for (const block of ["AM", "PM"]) {
      const [h0, h1] = opts.blocks[block];
      // A calendar block (time off, meeting, "no jobs Thursday mornings") over most of the block holds it.
      const held = (day.events || []).some((e) => {
        if (e.all_day) return true;
        const s = Math.max(opts.hourOf(e.start), h0), t = Math.min(opts.hourOf(e.end) || h1, h1);
        return t - s >= (h1 - h0) / 2;
      });
      if (held) continue;
      const blockPts = jobs.filter((j) => { const h = opts.hourOf(j.start); return h >= h0 && h < h1; })
        .reduce((a, j) => a + (j.points || 1), 0);
      if (blockPts + opts.newPoints > opts.blockCaps[block]) continue;

      // Try the new stop between each pair of stops that touches this block.
      const route = [{ ...shop, label: "Shop", isShop: true }].concat(jobs.map((j) => ({ ...j, label: j.city || "Stop" })));
      let best = null;
      for (let i = 0; i < route.length; i++) {
        const prev = route[i], next = route[i + 1] || null;
        const prevH = prev.isShop ? h0 : opts.hourOf(prev.start);
        const nextH = next ? opts.hourOf(next.start) : h1;
        // The new stop must land inside this block: after prev starts, before next starts.
        if (prevH >= h1 || nextH < h0) continue;
        const toNew = driveMinutes(prev, caller, cfg);
        const fromNew = next ? driveMinutes(caller, next, cfg) : 0;
        const skipped = next ? driveMinutes(prev, next, cfg) : 0;
        const added = toNew + fromNew - skipped;
        if (!best || added < best.added) best = { added, prev, next, toNew, fromNew, skipped };
      }
      if (!best) continue;
      out.push({
        day: day.key, label: day.label, block,
        added: Math.max(0, Math.round(best.added)),
        after: best.prev.isShop ? "the shop (first stop)" : best.prev.label,
        before: best.next ? best.next.label : null,
        legs: { toNew: Math.round(best.toNew), fromNew: Math.round(best.fromNew), skipped: Math.round(best.skipped) },
        pointsAfter: day.load.points + opts.newPoints, cap: day.load.cap,
        blockPointsAfter: blockPts + opts.newPoints, blockCap: opts.blockCaps[block],
        unplaced,
        emptyDay: jobs.length === 0,
      });
    }
    // Nothing booked yet: AM and PM cost the same, so offer the day once.
    if (jobs.length === 0 && out.length === 2) return [{ ...out[0], block: "AM or PM" }];
    return out;
  }

  /* days: array of day objects (see daySpots). Returns { far, fromShop, spots } with
     spots sorted by added drive time, then by date. */
  function rank(days, caller, cfg, opts) {
    if (!hasPt(caller) || !hasPt(cfg.shop)) return { far: false, fromShop: null, spots: [] };
    const fromShop = Math.round(driveMinutes(cfg.shop, caller, cfg));
    if (fromShop > (cfg.farMinutes ?? 45)) return { far: true, fromShop, spots: [] };
    const spots = days.flatMap((d) => daySpots(d, caller, cfg, opts));
    spots.sort((a, b) => a.added - b.added || (a.day < b.day ? -1 : a.day > b.day ? 1 : a.block < b.block ? -1 : 1));
    return { far: false, fromShop, spots };
  }

  const api = { miles, driveMinutes, daySpots, rank };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SchedRoute = api;
})(typeof window !== "undefined" ? window : globalThis);
