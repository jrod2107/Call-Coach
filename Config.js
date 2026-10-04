window.COACH_CONFIG = {
  supabaseUrl: "https://skwgnvxjwfrkgzxrdfhe.supabase.co",
  supabaseAnonKey: "sb_publishable_3N-tsu-oX4DZyDdsYt5gSA_hSDbexOa",

  rcClientId: "4W6MJepbEDpcWqgiF5BSk9",
  rcServer: "https://platform.ringcentral.com",

  // Set to true if you can't hear the customer when answering in the coach.
  playRemoteAudio: false,

  // Ask Claude automatically every few customer sentences. CSRs can toggle it per call.
  autoCoachDefault: false,

  deepgramModel: "nova-3",
  // Words Deepgram should listen for harder: brands, towns, parts.
  keyterms: ["Whirlpool", "Maytag", "KitchenAid", "Frigidaire", "Electrolux", "Samsung", "LG", "Bosch", "Sub-Zero", "Thermador", "Viking", "Miele", "Speed Queen",
             "San Marcos", "Kyle", "Buda", "Wimberley", "Dripping Springs", "New Braunfels", "Lockhart", "Seguin", "Canyon Lake",
             "diagnostic fee", "ice maker", "defrost", "compressor", "igniter", "French door"]
};
