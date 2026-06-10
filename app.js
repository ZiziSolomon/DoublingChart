"use strict";

// ---- State ---------------------------------------------------------------
let DATA = null;          // loaded timeline JSON (immutable, as parsed)
let EFF = null;           // effective model after DECISIONS+EDITS applied
let NAMES = [];           // castable character names (from EFF)
let BREAK_CREDIT = 9999;   // lines/words of rest a scene break is worth (UI-set)
let LAST_ACTORS = [];      // current assignment, exposed for script generation

// User decisions/edits, all expressed against the ORIGINAL parsed data so they
// stay stable and composable. See buildEFF for how they fold into EFF.
let DECISIONS = { cutChars: [], merges: [], locks: {} };
let EDITS = { lineReassign: {}, lineEdits: {}, lineCuts: [], lineJoins: [] };

// ---- Effective model (EFF) ----------------------------------------------
// buildEFF replays the parsed script under the current decisions/edits to
// produce the effective character set the rest of the app reasons over. With
// empty decisions/edits it reproduces DATA.characters exactly.
//
// Merge semantics: merging A and B yields ONE identity (canonical name) whose
// presence is the union of both and whose lines are the union — so a merge
// reduces headcount even where both were on stage. cutChars drops a character
// entirely. Line ops (cut/edit/reassign/join) act per global line index (gli).

// Resolve a character name to its canonical merged identity (e.g. A or B -> AB).
function mergeRoot(name, mergeMap) {
  let n = name;
  while (mergeMap[n] && mergeMap[n] !== n) n = mergeMap[n];
  return n;
}

function buildEFF() {
  const cut = new Set(DECISIONS.cutChars);
  // Union-find-ish: map each merged member to a canonical name (joined label).
  const mergeMap = {};
  for (const [a, b] of DECISIONS.merges) {
    const ra = mergeRoot(a, mergeMap), rb = mergeRoot(b, mergeMap);
    if (ra === rb) continue;
    const label = [ra, rb].join("/");          // e.g. "COBWEB/MOTH"
    mergeMap[ra] = label; mergeMap[rb] = label; mergeMap[label] = label;
  }
  // Castable identities: those the parser recorded (excludes group/chorus
  // speakers like ALL and FAIRY, which appear in the script but were never
  // counted as characters). A merge label counts if any member is castable.
  const orig = new Set(Object.keys(DATA.characters));
  const isCastable = name => {
    if (orig.has(name)) return true;
    return name.split("/").some(m => orig.has(m));  // merge label
  };
  const canon = name => {
    if (cut.has(name) || !isCastable(name)) return null;
    return mergeRoot(name, mergeMap);
  };

  const cuts = new Set(EDITS.lineCuts);
  const joins = new Set(EDITS.lineJoins);

  // Fresh character records keyed by canonical name.
  const chars = {};
  const ensure = name => (chars[name] ||= {
    lines: {}, words: {}, total_lines: 0, total_words: 0, segments: [],
  });

  // 1) Rebuild per-scene line/word counts + an effective script by walking the
  //    original script, applying line ops and speaker remapping.
  const effScript = [];
  for (const e of DATA.script) {
    if (e.t !== "speech") { effScript.push(e); continue; }
    const sp = canon(e.speaker);
    const outLines = [];
    for (const l of e.lines) {
      if (cuts.has(l.gli)) continue;                 // deleted line
      const text = (l.gli in EDITS.lineEdits) ? EDITS.lineEdits[l.gli] : l.text;
      const reassigned = EDITS.lineReassign[l.gli];
      const lineSpeaker = reassigned ? canon(reassigned) : sp;
      outLines.push({ gli: l.gli, text, speaker: lineSpeaker,
                      join: joins.has(l.gli) });
      if (lineSpeaker) {
        const d = ensure(lineSpeaker);
        d.lines[e.scene] = (d.lines[e.scene] || 0) + 1;
        const w = (text.match(/[A-Za-z']+/g) || []).length;
        d.words[e.scene] = (d.words[e.scene] || 0) + w;
        d.total_lines++; d.total_words += w;
      }
    }
    if (outLines.length) effScript.push({ ...e, speaker: sp, lines: outLines });
  }

  // 2) Rebuild presence/segments by remapping the original segments through
  //    canon() and merging overlapping/adjacent ones per canonical character.
  const segsByName = {};
  for (const [name, rec] of Object.entries(DATA.characters)) {
    const c = canon(name);
    if (!c) continue;
    (segsByName[c] ||= []).push(...rec.segments.map(s => s.slice()));
  }
  for (const [name, segs] of Object.entries(segsByName)) {
    segs.sort((p, q) => p[1] - q[1]);
    // Coalesce overlapping line-ranges (merged identities may now overlap).
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s[1] <= last[3]) {
        last[3] = Math.max(last[3], s[3]);
        last[4] = Math.max(last[4], s[4]);
      } else merged.push(s);
    }
    ensure(name).segments = merged;
  }

  // Drop characters left with no presence (e.g. fully line-cut).
  for (const name of Object.keys(chars))
    if (!chars[name].segments.length && chars[name].total_lines === 0)
      delete chars[name];

  const groups = new Set(DATA.groups || []);
  EFF = {
    characters: chars,
    script: effScript,
    names: Object.keys(chars).filter(n => !groups.has(n)).sort(),
    groups: DATA.groups || [],
    scenes: DATA.scenes,
  };
  return EFF;
}

// ---- Conflict models -----------------------------------------------------
// A "segment" is [scene, lineStart, wordStart, lineEnd, wordEnd]: a continuous
// stretch a character is on stage. Two characters CONFLICT (cannot share an
// actor) when, under the chosen mode, they come too close.

function segmentsOf(name) { return EFF.characters[name].segments; }

// Minimum gap between two characters in a given unit, where the unit index in
// a segment is: line -> [1,3], word -> [2,4]. Returns the smallest REST (in
// that unit) between any exit of one and the next entrance of the other.
// Negative/zero means genuine on-stage overlap (a hard conflict).
//
// Rest spanning a scene break is credited: each break crossed adds
// `breakCredit` units of rest. With credit 0 a hand-off across a break gives
// only the literal spoken lines between (so closing one scene and opening the
// next — the "law of re-entry" — is a conflict). With a large credit, scene
// breaks are effectively unlimited rest (the classic mode). The credit makes a
// one-line scene correctly count as almost no rest.
function minGap(a, b, startIdx, endIdx, breakCredit) {
  let best = Infinity;
  for (const sa of segmentsOf(a)) {
    for (const sb of segmentsOf(b)) {
      if (sa[startIdx] < sb[endIdx] && sb[startIdx] < sa[endIdx]) return -1;
      const [first, second] = sa[endIdx] <= sb[startIdx] ? [sa, sb] : [sb, sa];
      const raw = second[startIdx] - first[endIdx];     // literal lines/words
      const breaks = Math.abs(second[0] - first[0]);    // scene boundaries crossed
      const rest = raw + breaks * breakCredit;
      if (rest < best) best = rest;
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
// BREAK_CREDIT (a module global, set from the UI) values a scene break in
// lines/words modes: how many units of rest one break is worth.
function conflicts(a, b, mode, n) {
  switch (mode) {
    case "instant":  return minGap(a, b, 1, 3, 0) <= 0;   // share any stage instant
    case "scene":    return sharesScene(a, b);
    case "lines":    return minGap(a, b, 1, 3, BREAK_CREDIT) < n;
    case "words":    return minGap(a, b, 2, 4, BREAK_CREDIT) < n;
    case "scenes":   return minSceneGap(a, b) < n;        // need >= n scene breaks apart
    default:         return sharesScene(a, b);
  }
}

// ---- Assignment (greedy graph colouring + load balancing) ----------------
function assign(mode, n, nActors) {
  const total = name => EFF.characters[name].total_lines;
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
  return EFF.characters[name].lines[String(sc)] || 0;
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

// The "pinch": the scene(s) that force the minimum cast size. For each scene,
// count how many characters present there mutually conflict (under the mode) —
// that local clique is a lower bound on actors needed. The scenes hitting the
// global max are where thinning gives the most relief: cut a role or a line
// there and the whole floor can drop. Returns [{scene, headcount, chars}], the
// busiest first.
function pinchScenes(mode, n) {
  const perScene = DATA.scenes.map((_, sc) => {
    const present = NAMES.filter(c => scenesOf(c).has(sc));
    // Largest mutually-conflicting group in this scene (greedy clique estimate).
    const ordered = [...present].sort((a, b) =>
      EFF.characters[b].total_lines - EFF.characters[a].total_lines);
    const clique = [];
    for (const c of ordered) {
      if (clique.every(o => conflicts(c, o, mode, n))) clique.push(c);
    }
    return { scene: sc, headcount: clique.length, chars: clique, present };
  });
  const max = Math.max(...perScene.map(s => s.headcount));
  return {
    floorSceneCount: max,
    pinch: perScene.filter(s => s.headcount === max)
      .sort((a, b) => b.present.length - a.present.length),
    all: perScene,
  };
}

// Lightest roles in a scene — the cheapest candidates to cut/merge to relieve
// the pinch (line count is the proxy for how much you'd lose).
function thinnestIn(scene, present) {
  return [...present]
    .map(c => ({ name: c, lines: linesInScene(c, scene),
                 total: EFF.characters[c].total_lines }))
    .sort((a, b) => a.total - b.total);
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
  buildEFF();            // re-derive effective model from current decisions/edits
  NAMES = EFF.names;
  const mode = document.getElementById("mode").value;
  const n = parseInt(document.getElementById("threshold").value, 10) || 0;
  const nActors = parseInt(document.getElementById("actors").value, 10) || 1;
  const creditRaw = document.getElementById("breakcredit").value;
  BREAK_CREDIT = creditRaw === "" ? 9999 : (parseInt(creditRaw, 10) || 0);

  const floor = chromatic(mode, n);
  const actors = assign(mode, n, nActors);
  LAST_ACTORS = actors;          // expose current cast for script generation
  const loads = actors.map(a => a.load);
  const totalLines = loads.reduce((s, x) => s + x, 0);

  // Summary line.
  const summary = document.getElementById("summary");
  // The best achievable max-load is bounded below by the heaviest single role
  // (it can't be split) and by the even share — whichever is larger. Reporting
  // the even share alone would be a target no casting can reach.
  const heaviest = Math.max(...NAMES.map(c => EFF.characters[c].total_lines));
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

  renderPinch(mode, n, floor, nActors);

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

// "Where to cut": name the scene(s) that set the floor and the lightest roles
// in them — the highest-leverage place to thin lines or conflate roles. This
// is the structural half of the under-cast problem; which cut actually
// preserves the play is left to the director.
function renderPinch(mode, n, floor, nActors) {
  const el = document.getElementById("pinch");
  const { pinch } = pinchScenes(mode, n);
  const sceneNames = pinch.map(p => DATA.scenes[p.scene].split(" — ")[0]);
  const relief = nActors < floor ? floor - nActors : 1;

  // From the busiest pinch scene, the lightest roles to target. Rank by total
  // lines (what you'd lose play-wide), not lines-in-scene — a near-silent lead
  // is still a bad cut. Show enough to cover the relief needed, plus a couple.
  const main = pinch[0];
  const light = thinnestIn(main.scene, main.chars).slice(0, Math.max(relief + 2, 4));
  const lightHtml = light.map(r =>
    `<span class="cand">${r.name} `
    + `<span class="lc">${r.total} lines play-wide</span></span>`).join("");

  el.innerHTML =
    `<h2>Where to cut</h2>`
    + `<p>The cast floor of <b>${floor}</b> is forced by `
    + `<b>${sceneNames.join(", ")}</b> — ${main.headcount} characters who can't `
    + `share an actor are all on stage there at once. To get below ${floor} actors `
    + `you must thin or merge roles <em>in that scene</em>; cutting elsewhere won't help.</p>`
    + `<p class="muted">Lightest roles in ${sceneNames[0]} (cheapest to cut or `
    + `conflate — but check what each one provides before removing it):</p>`
    + `<div class="cands">${lightHtml}</div>`;
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
  // Break-credit only applies to the line/word gap modes.
  const usesCredit = mode === "lines" || mode === "words";
  document.getElementById("breakcredit").disabled = !usesCredit;
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
  buildEFF();                 // empty decisions -> mirrors DATA.characters
  NAMES = EFF.names;

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
  if (q.has("credit")) document.getElementById("breakcredit").value = q.get("credit");

  ["mode", "threshold", "actors", "breakcredit"].forEach(id =>
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
