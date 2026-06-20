// Play manifest: drives the picker dropdown (order + default) and decouples the
// display label from <script> load order. Each entry's `slug` must match a
// window.PLAY_DATA[slug] populated by the corresponding data/<slug>.js file.
// The first entry is the default play when no ?play= param or saved choice.
window.PLAY_LIST = [
  { slug: "midsummer", title: "A Midsummer Night's Dream" },
  { slug: "12night",   title: "Twelfth Night" },
];
