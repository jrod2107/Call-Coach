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

  // Appliance tags the intake guide adds to jobs (one per appliance type).
  applianceTags: ["Washer", "Dryer", "Refrigerator", "Freezer", "Dishwasher", "Oven/Range", "Wall Oven",
    "Cooktop/Stovetop", "Microwave", "Wine Fridge", "Ice Maker", "Garbage Disposal"],
};
