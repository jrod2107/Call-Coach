/* ============ Scheduling settings (beta) ============
   Change these numbers here; nothing else needs editing.
   Rules come from the City Appliance Scheduling Playbook. */
window.SCHED_SETTINGS = {
  // While Jules is training, Jacob and Jules ride together: every job counts
  // once against one crew cap. Set to false once Jules runs his own route.
  crewTogether: true,
  crewCap: 7,

  // Daily caps per tech (used when crewTogether is false). Matched by first name.
  techs: {
    Jacob: { cap: 7 },
    Jules: { cap: 4 },
  },

  // Room kept above the cap for a same-day job when it fits.
  sameDayExtra: 1,

  // Points per job.
  points: {
    standard: 1,             // one residential appliance
    residentialExtra: 1,     // each extra appliance on a residential job (2 appliances = 2 points)
    commercial: 2,           // one commercial appliance
    commercialExtra: 1,      // each extra appliance on a commercial job (2 appliances = 3 points)
  },

  // A job is commercial when its job or customer tags include one of these,
  // or its description says "commercial".
  commercialTags: ["Business", "Commercial"],

  // ----- Drive-time ranking -----
  // Every day starts at the shop, 118 Lockwood St, San Marcos.
  // APPROXIMATE position (downtown San Marcos): replace with the shop's exact lat/lng.
  shop: { lat: 29.8833, lng: -97.9414 },
  // Customer-facing blocks (local hours) and the most points each block takes per tech.
  blocks: { AM: [9, 13], PM: [13, 17] },
  blockCaps: { AM: 4, PM: 3 },
  // More than this many minutes from the shop: no automatic slots, check with the tech.
  farMinutes: 45,
  // At least this many minutes from the shop: far out, so only offer the first stop of a morning.
  farOutMinutes: 25,
  // Fill the day: days already at `from` points or more rank as if the drive were
  // `bonusMinutes` shorter, so they fill toward 6-7 before an empty day is started.
  fill: { from: 4, bonusMinutes: 10 },
  // How many days ahead to rank (today is left out: same-day is offered separately).
  rankDays: 14,
  // Days that take bookings (0 = Sunday ... 6 = Saturday). Other days only show if a job is already on them.
  workDays: [1, 2, 3, 4, 5],
  // Drive estimate from straight-line distance (no outside map service).
  drive: { roadFactor: 1.3, minMph: 24, maxMph: 48, mphPerMile: 1.8, parkMinutes: 2 },
  // Where a new caller is placed until they're a returning customer with an exact
  // Housecall Pro address: the center of their city (approximate).
  cityCenters: {
    "San Marcos": { lat: 29.8833, lng: -97.9414 },
    "Kyle": { lat: 29.9891, lng: -97.8772 },
    "Buda": { lat: 30.0852, lng: -97.8403 },
    "New Braunfels": { lat: 29.7030, lng: -98.1245 },
    "Lockhart": { lat: 29.8849, lng: -97.6700 },
    "Kingsbury": { lat: 29.6449, lng: -97.8314 },
    "Wimberley": { lat: 29.9974, lng: -98.0986 },
    "Canyon Lake": { lat: 29.8752, lng: -98.2625 },
    "Driftwood": { lat: 30.1238, lng: -98.0089 },
    "Dripping Springs": { lat: 30.1902, lng: -98.0867 },
  },

  // Appliance tags the intake guide adds to jobs (one per appliance type).
  applianceTags: ["Washer", "Dryer", "Refrigerator", "Freezer", "Dishwasher", "Oven/Range", "Wall Oven",
    "Cooktop/Stovetop", "Microwave", "Wine Fridge", "Ice Maker", "Garbage Disposal"],
};
