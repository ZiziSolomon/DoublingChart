"use strict";

// ---- State ---------------------------------------------------------------
let DATA = null;          // loaded timeline JSON
let NAMES = [];           // castable character names

// ---- Conflict models -----------------------------------------------------
// A "segment" is [scene, lineStart, wordStart, lineEnd, wordEnd]: a continuous
// stretch a character is on stage. Two characters CONFLICT (cannot share an
// actor) when, under the chosen mode, they come too close.

function segmentsOf(name) { return DATA.characters[name].segments; }

// Minimum gap between two characters in a given unit, where the unit index in
// a segment is: line -> [1,3], word -> [2,4]. Returns the smallest rest (in
// that unit) between any exit of one and the next entrance of the other.
// Negative/zero means genuine on-stage overlap. A scene break between them is
// treated as unlimited rest (handled by caller via sameScene check).
function minGap(a, b, startIdx, endIdx) {
  let best = Infinity;
  for (const sa of segmentsOf(a)) {
    for (const sb of segmentsOf(b)) {
      // Overlap on stage at the same instant -> gap 0 (a hard conflict).
      if (sa[startIdx] < sb[endIdx] && sb[startIdx] < sa[endIdx]) return -1;
      // Otherwise the gap is gap between whichever ends first and the other's start.
      const gap = sa[endIdx] <= sb[startIdx]
        ? sb[startIdx] - sa[endIdx]
        : sa[startIdx] - sb[endIdx];
      if (gap < best) best = gap;
    }
  }
  return best;
}

function sharesScene(a, b) {
  const sa = new Set(segmentsOf(a).map(s => s[0]));
  for (const s of segmentsOf(b)) if (sa.has(s[0])) return true;
  return false;
}

// Minimum number of scene breaks between any appearance of a and b. 0 means
// they appear in the same scene.
function minSceneGap(a, b) {
  const sa = segmentsOf(a).map(s => s[0]);
  const sb = segmentsOf(b).map(s => s[0]);
  let best = Infinity;
  for (const x of sa) for (const y of sb) best = Math.min(best, Math.abs(x - y));
  return best;
}

// Returns true if a and b conflict under the chosen mode + threshold.
function conflicts(a, b, mode, n) {
  switch (mode) {
    case "instant":  return minGap(a, b, 1, 3) <= 0;   // share any stage instant
    case "scene":    return sharesScene(a, b);
    case "lines":    // need >= n lines of rest, unless a scene break separates them
      return sharesScene(a, b) && minGap(a, b, 1, 3) < n;
    case "words":
      return sharesScene(a, b) && minGap(a, b, 2, 4) < n;
    case "scenes":   return minSceneGap(a, b) < n;     // need >= n scene breaks apart
    default:         return sharesScene(a, b);
  }
}

// ---- Assignment (greedy graph colouring + load balancing) ----------------
function assign(mode, n, nActors) {
  const total = name => DATA.characters[name].total_lines;
  const footprintSize = name => segmentsOf(name).length;
  // Most-constrained-first so hard-to-place roles claim actors before fillers.
  const order = [...NAMES].sort((x, y) =>
    footprintSize(y) - footprintSize(x) || total(y) - total(x));

  const actors = Array.from({ length: nActors }, () => ({ roles: [], load: 0 }));

  const eligibleActors = (c, pool) =>
    pool.filter(a => a.roles.every(r => !conflicts(c, r.name, mode, n)));

  for (const c of order) {
    const eligible = eligibleActors(c, actors);
    let target, clash;
    if (eligible.length) {
      // Pack onto an actor that already has roles (graph-colouring behaviour)
      // before opening a fresh one; break ties by lighter load. This finds a
      // clash-free assignment at the true minimum cast size.
      target = eligible.reduce((m, a) => {
        const aKey = [a.roles.length === 0 ? 1 : 0, a.load];
        const mKey = [m.roles.length === 0 ? 1 : 0, m.load];
        return (aKey[0] - mKey[0] || aKey[1] - mKey[1]) < 0 ? a : m;
      });
      clash = false;
    } else {
      target = actors.reduce((m, a) => a.load < m.load ? a : m);
      clash = true;  // below the feasible floor: flag the forced clash
    }
    target.roles.push({ name: c, lines: total(c), clash });
    target.load += total(c);
  }

  // Repair pass: load-balancing can bunch two compatible-elsewhere roles onto
  // one actor and force a clash even when a conflict-free actor exists. Move
  // any clashing role to an actor that can take it cleanly, if one exists.
  for (const a of actors) {
    for (const r of a.roles.filter(r => r.clash)) {
      const dest = eligibleActors(r.name, actors.filter(x => x !== a))
        .sort((x, y) => x.load - y.load)[0];
      if (dest) {
        a.roles = a.roles.filter(x => x !== r);
        a.load -= r.lines;
        r.clash = false;
        dest.roles.push(r);
        dest.load += r.lines;
      }
    }
  }
  return actors;
}

// Scenes a character speaks/appears in, and lines spoken there.
function scenesOf(name) { return new Set(segmentsOf(name).map(s => s[0])); }
function linesInScene(name, sc) {
  return DATA.characters[name].lines[String(sc)] || 0;
}

// Given an assignment, find the real cost of any forced clashes, expressed the
// way the user asked: which SCENES break, and how many spoken LINES are caught
// in those clashes. A clash "hits" a scene when two roles on the same actor
// are both present in that scene (i.e. the actor would have to be in two places
// at once there). The lines at stake = the lines those clashing roles speak in
// the affected scenes.
function clashImpact(actors, mode, n) {
  const brokenScenes = new Set();
  let brokenLines = 0;
  const counted = new Set();   // (role|scene) pairs already tallied
  for (const a of actors) {
    const roles = a.roles.map(r => r.name);
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        if (!conflicts(roles[i], roles[j], mode, n)) continue;
        // Scenes where both are present = the collisions.
        const shared = [...scenesOf(roles[i])].filter(s => scenesOf(roles[j]).has(s));
        for (const sc of shared) {
          brokenScenes.add(sc);
          for (const r of [roles[i], roles[j]]) {
            const key = r + "|" + sc;
            if (!counted.has(key)) {
              counted.add(key);
              brokenLines += linesInScene(r, sc);
            }
          }
        }
      }
    }
  }
  return { scenes: [...brokenScenes].sort((x, y) => x - y), lines: brokenLines };
}

// Minimum feasible actors = greedy chromatic number under the chosen mode.
function chromatic(mode, n) {
  const order = [...NAMES].sort((x, y) =>
    segmentsOf(y).length - segmentsOf(x).length);
  const colour = {};
  for (const c of order) {
    const used = new Set();
    for (const o in colour) if (conflicts(c, o, mode, n)) used.add(colour[o]);
    let k = 0; while (used.has(k)) k++;
    colour[c] = k;
  }
  return Math.max(...Object.values(colour)) + 1;
}

// ---- Rendering -----------------------------------------------------------
function render() {
  const mode = document.getElementById("mode").value;
  const n = parseInt(document.getElementById("threshold").value, 10) || 0;
  const nActors = parseInt(document.getElementById("actors").value, 10) || 1;

  const floor = chromatic(mode, n);
  const actors = assign(mode, n, nActors);
  const loads = actors.map(a => a.load);
  const totalLines = loads.reduce((s, x) => s + x, 0);

  // Summary line.
  const summary = document.getElementById("summary");
  // The best achievable max-load is bounded below by the heaviest single role
  // (it can't be split) and by the even share — whichever is larger. Reporting
  // the even share alone would be a target no casting can reach.
  const heaviest = Math.max(...NAMES.map(c => DATA.characters[c].total_lines));
  const evenShare = Math.round(totalLines / nActors);
  const bestMax = Math.max(heaviest, evenShare);
  let msg = `Mode: <b>${labelFor(mode, n)}</b>. `
    + `Minimum feasible cast: <b>${floor}</b> actor${floor === 1 ? "" : "s"}. `;
  if (nActors < floor) {
    const imp = clashImpact(actors, mode, n);
    const sceneList = imp.scenes.map(s => DATA.scenes[s].split(" — ")[0]).join(", ");
    msg += `<span class="warn">You picked <b>${nActors}</b> — below the floor of `
      + `${floor}. This causes clashes in <b>${imp.scenes.length} `
      + `scene${imp.scenes.length === 1 ? "" : "s"}</b> `
      + `(${sceneList}) affecting <b>${imp.lines} spoken lines</b> that would need `
      + `one actor in two places at once. Cut or merge those roles, or add actors.`
      + `</span>`;
  } else {
    msg += `Heaviest single role is ${heaviest} lines, so no split beats a `
      + `max load of ~${bestMax}. This cast: busiest actor ${Math.max(...loads)} lines, `
      + `lightest ${Math.min(...loads)} (spread ${Math.max(...loads) - Math.min(...loads)}).`;
  }
  summary.innerHTML = msg;

  // Actor cards.
  const out = document.getElementById("assignment");
  out.innerHTML = "";
  actors.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "actor";
    const roles = [...a.roles].sort((x, y) => y.lines - x.lines);
    const roleHtml = roles.length
      ? roles.map(r =>
          `<span class="role${r.clash ? " clash" : ""}">${r.name} `
          + `<span class="lc">${r.lines}</span>`
          + `${r.clash ? " ⚠" : ""}</span>`).join("")
      : '<span class="muted">(no role)</span>';
    card.innerHTML =
      `<div class="actor-head">Actor ${i + 1}`
      + `<span class="load">${a.load} lines</span></div>`
      + `<div class="roles">${roleHtml}</div>`;
    out.appendChild(card);
  });

  renderReductionTable(mode, n, floor);
}

function renderReductionTable(mode, n, floor) {
  // For cast sizes from floor down to 1, how many lines become "broken" (must
  // clash). Shows the cost of a smaller cast.
  const rows = [];
  for (let k = floor; k >= 1; k--) {
    const actors = assign(mode, n, k);
    const imp = clashImpact(actors, mode, n);
    rows.push({ k, nScenes: imp.scenes.length, nLines: imp.lines });
  }
  const tbl = document.getElementById("reduction");
  const body = rows.filter(r => r.nScenes > 0)
    .map(r => `<tr><td>${r.k}</td><td>${r.nScenes}</td><td>${r.nLines}</td></tr>`)
    .join("");
  tbl.innerHTML = body
    ? `<caption>Cost of a smaller cast (below the floor of ${floor})</caption>`
      + `<thead><tr><th>actors</th><th>scenes with clashes</th>`
      + `<th>spoken lines affected</th></tr></thead>`
      + `<tbody>${body}</tbody>`
    : `<caption>At ${floor}+ actors, every role is cleanly coverable in this mode.</caption>`;
}

function labelFor(mode, n) {
  switch (mode) {
    case "instant": return "never on stage at the same instant";
    case "scene":   return "never in the same scene";
    case "lines":   return `≥ ${n} lines apart (or a scene break between)`;
    case "words":   return `≥ ${n} words apart (or a scene break between)`;
    case "scenes":  return `≥ ${n} scene breaks apart`;
    default:        return mode;
  }
}

// ---- Threshold widget enable/disable depending on mode -------------------
function syncThreshold() {
  const mode = document.getElementById("mode").value;
  const usesN = mode === "lines" || mode === "words" || mode === "scenes";
  const t = document.getElementById("threshold");
  t.disabled = !usesN;
  const labels = { lines: "lines of rest", words: "words of rest", scenes: "scene breaks" };
  document.getElementById("threshold-unit").textContent =
    usesN ? labels[mode] : "(n/a for this mode)";
  // Sensible defaults per unit.
  if (usesN && (mode === "scenes") && t.value > 5) t.value = 1;
  if (usesN && (mode === "words") && t.value < 20) t.value = 50;
}

// ---- Boot ----------------------------------------------------------------
function boot() {
  // Data is inlined in data.js (window.PLAY_DATA) so the page works both from
  // a web server and when opened directly as a local file (file://), where
  // fetch() would be blocked by the browser.
  DATA = window.PLAY_DATA;
  if (!DATA) {
    document.getElementById("summary").innerHTML =
      '<span class="warn">Could not load play data (data.js missing).</span>';
    return;
  }
  const groups = new Set(DATA.groups || []);
  NAMES = Object.keys(DATA.characters).filter(n => !groups.has(n)).sort();

  document.getElementById("play-title").textContent = DATA.title;
  document.getElementById("stats").textContent =
    `${NAMES.length} castable characters · ${DATA.scenes.length} scenes · `
    + `${DATA.play_lines} lines`;

  // Default actor count to the scene-mode floor for a sensible first view.
  const a = document.getElementById("actors");
  a.value = chromatic("scene", 0);

  // Optional URL params let you link/share a specific configuration and make
  // the view testable, e.g. ?mode=lines&n=30&actors=12
  const q = new URLSearchParams(location.search);
  if (q.has("mode")) document.getElementById("mode").value = q.get("mode");
  if (q.has("n")) document.getElementById("threshold").value = q.get("n");
  if (q.has("actors")) a.value = q.get("actors");

  ["mode", "threshold", "actors"].forEach(id =>
    document.getElementById(id).addEventListener("input", () => {
      if (id === "mode") syncThreshold();
      render();
    }));
  syncThreshold();
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
