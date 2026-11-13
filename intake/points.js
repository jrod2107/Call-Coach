/* ============ Job points and daily load (beta) ============
   Pure functions, no page access: used by schedule.js, and testable on their own.
   Settings come from schedule-settings.js (window.SCHED_SETTINGS). */
(function (root) {
  const norm = (s) => String(s || "").toLowerCase().trim();
  const firstName = (t) => String(t || "").trim().split(/\s+/)[0] || "";

  function isCommercial(job, cfg) {
    const want = (cfg.commercialTags || []).map(norm);
    const tags = (job.tags || []).concat(job.customer_tags || []).map(norm);
    if (tags.some((t) => want.includes(t))) return true;
    return /\bcommercial\b/i.test(String(job.desc || ""));
  }

  // Distinct appliance types tagged on the job; at least 1.
  function applianceCount(job, cfg) {
    const known = (cfg.applianceTags || []).map(norm);
    const seen = new Set((job.tags || []).map(norm).filter((t) => known.includes(t)));
    return Math.max(1, seen.size);
  }

  function jobPoints(job, cfg) {
    const p = cfg.points || {};
    const n = applianceCount(job, cfg);
    const commercial = isCommercial(job, cfg);
    const points = commercial
      ? (p.commercial ?? 2) + (n - 1) * (p.commercialExtra ?? 1)
      : (p.standard ?? 1) + (n - 1) * (p.residentialExtra ?? 1);
    return { points, commercial, appliances: n };
  }

  // Load for one day. Crew mode: every job counts once against the crew cap.
  // Otherwise each tech gets the points of the jobs they are assigned to.
  function dayLoad(jobs, cfg) {
    const extra = cfg.sameDayExtra ?? 0;
    const scored = jobs.map((j) => ({ job: j, ...jobPoints(j, cfg) }));
    if (cfg.crewTogether) {
      const pts = scored.reduce((a, s) => a + s.points, 0);
      return { mode: "crew", rows: [{ who: "Crew", points: pts, cap: cfg.crewCap ?? 7, extra }], scored };
    }
    const caps = cfg.techs || {};
    const per = {};
    Object.keys(caps).forEach((name) => { per[name] = 0; });
    scored.forEach((s) => {
      (s.job.techs || []).map(firstName).forEach((t) => { if (t) per[t] = (per[t] || 0) + s.points; });
    });
    const rows = Object.keys(per).map((who) => ({ who, points: per[who], cap: caps[who] ? caps[who].cap : null, extra }));
    return { mode: "tech", rows, scored };
  }

  // "open" | "near" (one point from the cap) | "full" (at the cap, same-day room may remain) | "over"
  function status(row) {
    if (row.cap == null) return "open";
    if (row.points > row.cap + (row.extra || 0)) return "over";
    if (row.points >= row.cap) return "full";
    if (row.points >= row.cap - 1) return "near";
    return "open";
  }

  const api = { isCommercial, applianceCount, jobPoints, dayLoad, status };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SchedPoints = api;
})(typeof window !== "undefined" ? window : globalThis);
