"use strict";

// ---- State ---------------------------------------------------------------
let DATA = null;          // loaded timeline JSON (immutable, as parsed)
let EFF = null;           // effective model after DECISIONS+EDITS applied
let NAMES = [];           // castable character names (from EFF)
let BREAK_CREDIT = 9999;   // lines/words of rest a scene break is worth (UI-set)
let LAST_ACTORS = [];      // current assignment, exposed for script generation
let LAST_NACTORS = 0;      // actor count of the current assignment
let SPREAD = false;        // spread roles across surplus actors vs. compress

// User decisions/edits, all expressed against the ORIGINAL parsed data so they
// stay stable and composable. See buildEFF for how they fold into EFF.
// splits maps a character to ascending scene cutpoints: PUCK:[4] splits PUCK
// into a sub-role for scenes <4 and one for scenes >=4. Sub-roles are named
// "PUCK#0", "PUCK#1", … and behave as independent assignable characters.
let DECISIONS = { cutChars: [], merges: [], locks: {}, splits: {} };
let EDITS = { lineReassign: {}, lineEdits: {}, lineCuts: [], lineJoins: [] };

// ---- Persistence: decisions + edits --------------------------------------
// Per-play key, set in boot() from the active slug, so each play keeps its own
// saved edits. The midsummer key equals the old global constant
// ("doublingchart.midsummer"), so pre-multi-play saves migrate for free.
let STORE_KEY = "doublingchart.midsummer";
let SLUG = "midsummer";   // active play slug, set in boot()

function saveState() {
  const blob = JSON.stringify({ DECISIONS, EDITS });
  try { localStorage.setItem(STORE_KEY, blob); } catch (e) { /* private mode */ }
  // Mirror to URL hash (base64) so a configuration can be shared/bookmarked.
  // Stamp the play slug (&p=) so a link can't mis-apply one play's edits — which
  // are keyed by character name — to another play on load.
  try {
    location.hash = "s=" + btoa(unescape(encodeURIComponent(blob)))
      + "&p=" + encodeURIComponent(SLUG);
  } catch (e) { /* ignore */ }
}

function loadState() {
  // Hash beats localStorage (lets a shared link override local work), but only
  // if the hash is for THIS play (or carries no slug — legacy MSND-only links).
  let blob = null;
  const m = location.hash.match(/s=([^&]+)/);
  const hp = location.hash.match(/[#&]p=([^&]+)/);
  const hashSlug = hp ? decodeURIComponent(hp[1]) : null;
  if (m && (!hashSlug || hashSlug === SLUG)) {
    try { blob = decodeURIComponent(escape(atob(m[1]))); } catch (e) {}
  }
  if (!blob) { try { blob = localStorage.getItem(STORE_KEY); } catch (e) {} }
  if (!blob) return;
  try {
    const o = JSON.parse(blob);
    if (o.DECISIONS) DECISIONS = { cutChars: [], merges: [], locks: {}, splits: {}, ...o.DECISIONS };
    if (o.EDITS) EDITS = { lineReassign: {}, lineEdits: {}, lineCuts: [], lineJoins: [], ...o.EDITS };
  } catch (e) { /* corrupt; ignore */ }
}

// Apply a mutation to decisions/edits, persist, and re-render everything.
function mutate(fn) {
  fn();
  saveState();
  render();
}

function clearAllEdits() {
  DECISIONS = { cutChars: [], merges: [], locks: {}, splits: {} };
  EDITS = { lineReassign: {}, lineEdits: {}, lineCuts: [], lineJoins: [] };
  saveState();
  render();
}

function decisionCount() {
  return DECISIONS.cutChars.length + DECISIONS.merges.length
    + Object.keys(DECISIONS.locks).length + Object.keys(DECISIONS.splits).length;
}
function editCount() {
  return Object.keys(EDITS.lineReassign).length + Object.keys(EDITS.lineEdits).length
    + EDITS.lineCuts.length + EDITS.lineJoins.length;
}

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
  // Split: map (original name, scene) -> sub-role name "NAME#k" where k is the
  // index of the scene-range the scene falls into. No split -> name unchanged.
  const splitName = (name, scene) => {
    const pts = DECISIONS.splits[name];
    if (!pts || !pts.length) return name;
    let k = 0;
    for (const p of pts) if (scene >= p) k++;
    return `${name}#${k}`;
  };
  // canon resolves a (name, scene) to its effective castable identity, applying
  // cut -> split -> merge in order. scene may be omitted for whole-char checks.
  const canon = (name, scene) => {
    if (cut.has(name) || !isCastable(name)) return null;
    const s = (scene === undefined) ? name : splitName(name, scene);
    return mergeRoot(s, mergeMap);
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
    const sp = canon(e.speaker, e.scene);
    const outLines = [];
    for (const l of e.lines) {
      if (cuts.has(l.gli)) continue;                 // deleted line
      const text = (l.gli in EDITS.lineEdits) ? EDITS.lineEdits[l.gli] : l.text;
      const reassigned = EDITS.lineReassign[l.gli];
      const lineSpeaker = reassigned ? canon(reassigned, e.scene) : sp;
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
    for (const s of rec.segments) {
      const c = canon(name, s[0]);     // split/merge by the segment's scene
      if (!c) continue;
      (segsByName[c] ||= []).push(s.slice());
    }
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

  // Honour locks first: a character pinned to an actor slot is placed there
  // before the greedy runs. (After merges, a lock on any merged member applies
  // to the merged identity.) Locks can force clashes; that's the user's call.
  const locked = new Set();
  for (const [rawName, idx] of Object.entries(DECISIONS.locks || {})) {
    const c = NAMES.includes(rawName) ? rawName
      : NAMES.find(nm => nm.split("/").includes(rawName));
    if (c && idx >= 0 && idx < nActors && !locked.has(c)) {
      const a = actors[idx];
      const clash = a.roles.some(r => conflicts(c, r.name, mode, n));
      a.roles.push({ name: c, lines: total(c), clash, locked: true });
      a.load += total(c);
      locked.add(c);
    }
  }

  for (const c of order) {
    if (locked.has(c)) continue;
    const eligible = eligibleActors(c, actors);
    let target, clash;
    if (eligible.length) {
      if (SPREAD) {
        // Spread: put each role on the least-loaded eligible actor (empty ones
        // welcome), so all actors get used and spoken-line load evens out.
        target = eligible.reduce((m, a) => a.load < m.load ? a : m);
      } else {
        // Compress: pack onto an actor that already has roles (graph-colouring
        // behaviour) before opening a fresh one; ties by lighter load. Finds a
        // clash-free assignment at the true minimum cast size.
        target = eligible.reduce((m, a) => {
          const aKey = [a.roles.length === 0 ? 1 : 0, a.load];
          const mKey = [m.roles.length === 0 ? 1 : 0, m.load];
          return (aKey[0] - mKey[0] || aKey[1] - mKey[1]) < 0 ? a : m;
        });
      }
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

// ---- Cut-meter: propose cuts/merges to reach a target cast size ----------
// Greedy over the pinch scene(s): the floor is set by the most-mutually-
// conflicting characters on stage together, so to lower it we cut or merge the
// lightest of those. Each step simulates the op (on a scratch DECISIONS),
// rebuilds EFF, and keeps it if the floor dropped. Pure: restores state after.
function suggestCuts(target, mode, n) {
  const savedDec = JSON.parse(JSON.stringify(DECISIONS));
  const savedEff = EFF, savedNames = NAMES;
  const suggestions = [];
  let guard = 0;
  try {
    let floor = chromatic(mode, n);
    while (floor > target && guard++ < 60) {
      const { pinch } = pinchScenes(mode, n);
      if (!pinch.length) break;
      // Candidates: characters in the pinch clique, lightest play-wide first.
      const clique = pinch[0].chars;
      const cands = [...clique].sort((a, b) =>
        EFF.characters[a].total_lines - EFF.characters[b].total_lines);
      // Try: merge the two lightest clique members (cheaper — keeps lines),
      // else cut the lightest. Pick whichever lowers the floor.
      let applied = null;
      // Option A: merge two lightest.
      if (cands.length >= 2) {
        const [a, b] = cands;
        DECISIONS.merges.push([a, b]);
        buildEFF(); NAMES = EFF.names;
        if (chromatic(mode, n) < floor) {
          applied = { op: "merge", chars: [a, b],
            cost: 0, note: `play one actor (lines kept)` };
        } else DECISIONS.merges.pop();
      }
      // Option B: cut the lightest (if merge didn't help).
      if (!applied) {
        const c = cands[0];
        DECISIONS.cutChars.push(c);
        buildEFF(); NAMES = EFF.names;
        if (chromatic(mode, n) < floor) {
          applied = { op: "cut", chars: [c],
            cost: savedEffLines(c, savedEff), note: `lines lost` };
        } else { DECISIONS.cutChars.pop(); break; } // can't progress
      }
      buildEFF(); NAMES = EFF.names;
      floor = chromatic(mode, n);
      applied.floorAfter = floor;
      suggestions.push(applied);
    }
  } finally {
    DECISIONS = savedDec; EFF = savedEff; NAMES = savedNames;
  }
  return suggestions;
}
function savedEffLines(name, eff) {
  return (eff.characters[name] && eff.characters[name].total_lines) || 0;
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
  SPREAD = document.getElementById("spread").value === "spread";

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

  // Actor cards — each role chip is clickable (cut / lock / move / merge).
  const out = document.getElementById("assignment");
  out.innerHTML = "";
  actors.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "actor";
    const roles = [...a.roles].sort((x, y) => y.lines - x.lines);
    const roleHtml = roles.length
      ? roles.map(r =>
          `<span class="role${r.clash ? " clash" : ""}${r.locked ? " locked" : ""}" `
          + `data-role="${r.name}" data-actor="${i}" tabindex="0">`
          + `${r.locked ? "📌 " : ""}${r.name} `
          + `<span class="lc">${r.lines}</span>`
          + `${r.clash ? " ⚠" : ""}</span>`).join("")
      : '<span class="muted">(no role)</span>';
    card.innerHTML =
      `<div class="actor-head">Actor ${i + 1}`
      + `<span class="load">${a.load} lines</span></div>`
      + `<div class="roles">${roleHtml}</div>`;
    out.appendChild(card);
  });
  LAST_NACTORS = nActors;

  renderReductionTable(mode, n, floor);
  renderLinePanel();

  // Edit badge.
  const badge = document.getElementById("edit-badge");
  if (badge) {
    const dc = decisionCount(), ec = editCount();
    badge.textContent = (dc + ec === 0) ? "no edits"
      : `${dc} casting decision${dc === 1 ? "" : "s"}, ${ec} line edit${ec === 1 ? "" : "s"}`;
    badge.classList.toggle("active", dc + ec > 0);
  }
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
    + `<div class="cands">${lightHtml}</div>`
    + (nActors < floor
        ? `<p style="margin-top:.6rem"><button id="suggest-cuts" class="small">`
          + `Suggest cuts/merges to reach ${nActors} actors</button></p>`
          + `<div id="suggestions"></div>`
        : "");

  const btn = document.getElementById("suggest-cuts");
  if (btn) btn.addEventListener("click", () => renderSuggestions(mode, n, nActors));
}

// Show a proposed sequence of cuts/merges that reaches the target cast size,
// with an Apply button. Merges are preferred (they keep the lines).
function renderSuggestions(mode, n, target) {
  const out = document.getElementById("suggestions");
  const sugg = suggestCuts(target, mode, n);
  if (!sugg.length) {
    out.innerHTML = `<p class="muted">Couldn't find cuts to reach ${target} `
      + `automatically — the remaining roles are all leads. Try merging by hand.</p>`;
    return;
  }
  const totalLost = sugg.filter(s => s.op === "cut").reduce((t, s) => t + s.cost, 0);
  const list = sugg.map(s => s.op === "merge"
    ? `<li><b>Merge</b> ${s.chars.join(" + ")} into one actor `
      + `<span class="muted">(lines kept) → floor ${s.floorAfter}</span></li>`
    : `<li><b>Cut</b> ${s.chars[0]} `
      + `<span class="muted">(${s.cost} lines lost) → floor ${s.floorAfter}</span></li>`
  ).join("");
  out.innerHTML = `<p>To reach <b>${target}</b> actors:</p><ol class="sugg">${list}</ol>`
    + `<p class="muted">${totalLost} spoken lines lost to cuts (merges keep theirs). `
    + `<button id="apply-sugg" class="small">Apply all</button></p>`;
  document.getElementById("apply-sugg").addEventListener("click", () => mutate(() => {
    for (const s of sugg) {
      if (s.op === "merge") DECISIONS.merges.push(s.chars);
      else if (!DECISIONS.cutChars.includes(s.chars[0]))
        DECISIONS.cutChars.push(s.chars[0]);
    }
  }));
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
  // For gap modes, describe how scene breaks are valued (the break-credit knob).
  const breakNote = BREAK_CREDIT >= 9999 ? "a scene break counts as unlimited rest"
    : BREAK_CREDIT === 0 ? "scene breaks give no rest"
    : `a scene break = ${BREAK_CREDIT}`;
  switch (mode) {
    case "instant": return "never on stage at the same instant";
    case "scene":   return "never in the same scene";
    case "lines":   return `≥ ${n} lines apart (${breakNote})`;
    case "words":   return `≥ ${n} words apart (${breakNote})`;
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

// ---- Auto-spread & split -------------------------------------------------
// Fill surplus actors by splitting the heaviest multi-scene roles at a
// load-balancing scene seam, then assigning in spread mode. Greedy: repeatedly
// split whichever current role would best relieve the busiest actor, until no
// empty actors remain or nothing more can be split.
function autoSpreadSplit() {
  const nActors = LAST_NACTORS || parseInt(document.getElementById("actors").value, 10);
  document.getElementById("spread").value = "spread";
  SPREAD = true;

  for (let guard = 0; guard < 40; guard++) {
    buildEFF(); NAMES = EFF.names;
    const mode = document.getElementById("mode").value;
    const n = parseInt(document.getElementById("threshold").value, 10) || 0;
    const actors = assign(mode, n, nActors);
    const empties = actors.filter(a => a.load === 0).length;
    if (empties === 0) break;

    // Pick the heaviest splittable base character not already split.
    const cand = NAMES
      .map(nm => nm.replace(/#\d+$/, ""))
      .filter((b, i, arr) => arr.indexOf(b) === i)        // unique bases
      .filter(b => DATA.characters[b] && !DECISIONS.splits[b]
        && new Set(DATA.characters[b].segments.map(s => s[0])).size > 1)
      .sort((a, b) => DATA.characters[b].total_lines - DATA.characters[a].total_lines)[0];
    if (!cand) break;            // nothing left to split

    // Seam = the scene boundary that most evenly halves the role's lines.
    const scs = [...new Set(DATA.characters[cand].segments.map(s => s[0]))]
      .sort((a, b) => a - b);
    const linesBefore = sc => scs.filter(x => x < sc)
      .reduce((t, x) => t + (DATA.characters[cand].lines[x] || 0), 0);
    const half = DATA.characters[cand].total_lines / 2;
    let seam = scs[1], bestDiff = Infinity;
    for (const sc of scs.slice(1)) {
      const diff = Math.abs(linesBefore(sc) - half);
      if (diff < bestDiff) { bestDiff = diff; seam = sc; }
    }
    DECISIONS.splits[cand] = [seam];
  }
  saveState();
  render();
}

// ---- Role chip menu (cut / lock / move / merge) --------------------------
// A single floating menu reused for whichever role chip was clicked.
function openRoleMenu(roleName, actorIdx, anchorEl) {
  closeRoleMenu();
  const menu = document.createElement("div");
  menu.className = "rolemenu";
  menu.id = "rolemenu";

  const isLocked = DECISIONS.locks[roleName] !== undefined
    || NAMES.some(nm => nm === roleName && Object.entries(DECISIONS.locks)
        .some(([k, v]) => nm.split("/").includes(k)));

  const items = [];
  items.push([`Cut ${roleName} entirely`, () =>
    mutate(() => { if (!DECISIONS.cutChars.includes(roleName))
      DECISIONS.cutChars.push(roleName); })]);

  // Lock / unlock to this actor slot.
  if (DECISIONS.locks[roleName] === actorIdx) {
    items.push([`Unpin from this actor`, () =>
      mutate(() => { delete DECISIONS.locks[roleName]; })]);
  } else {
    items.push([`Pin to Actor ${actorIdx + 1}`, () =>
      mutate(() => { DECISIONS.locks[roleName] = actorIdx; })]);
  }

  // Move to another actor (pin to a chosen slot).
  items.push([`Move to actor…`, () => {
    const opts = Array.from({ length: LAST_NACTORS }, (_, i) =>
      ({ label: `Actor ${i + 1}`, value: i }));
    pickOption(`Move ${roleName} to:`, anchorEl, opts,
      v => mutate(() => { DECISIONS.locks[roleName] = parseInt(v, 10); }));
  }]);

  // Split a multi-scene role at a scene boundary into independent sub-roles
  // (e.g. PUCK I–III on one actor, PUCK IV–V on another). Operates on the base
  // character; offers the scenes where the role appears (after its first) as
  // possible seam points. Already-split roles get an "un-split" option.
  const base = roleName.replace(/#\d+$/, "");
  if (DECISIONS.splits[base]) {
    items.push([`Un-split ${base}`, () =>
      mutate(() => { delete DECISIONS.splits[base]; })]);
  } else if (DATA.characters[base]) {
    const scs = [...new Set(DATA.characters[base].segments.map(s => s[0]))]
      .sort((a, b) => a - b);
    if (scs.length > 1) {
      items.push([`Split ${base} by scene…`, () => {
        // Seam = "starts at scene X"; offer each scene after the first.
        const opts = scs.slice(1).map(sc =>
          ({ label: `before ${DATA.scenes[sc].split(" — ")[0]}`, value: sc }));
        pickOption(`Split ${base} into two actors, second starts:`, anchorEl, opts,
          v => mutate(() => { DECISIONS.splits[base] = [parseInt(v, 10)]; }));
      }]);
    }
  }

  // Merge with another character (collapse to one body).
  items.push([`Merge ${roleName} with…`, () => {
    pickCharacter(`Merge ${roleName} with:`, anchorEl, other => {
      // Warn if they share scenes (merging hides those overlaps).
      const shared = [...scenesOf(roleName)].filter(s => scenesOf(other).has(s));
      if (shared.length) {
        const names = shared.map(s => DATA.scenes[s].split(" — ")[0]).join(", ");
        if (!confirm(`${roleName} and ${other} are both on stage in ${names}. `
          + `Merging makes them one actor there (hiding those overlaps). Proceed?`))
          return;
      }
      mutate(() => { DECISIONS.merges.push([roleName, other]); });
    }, roleName);
  }]);

  for (const [label, action] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { closeRoleMenu(); action(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = (window.scrollX + r.left) + "px";
  menu.style.top = (window.scrollY + r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("click", closeRoleMenuOnce), 0);
}
function closeRoleMenu() {
  const m = document.getElementById("rolemenu");
  if (m) m.remove();
}
function closeRoleMenuOnce(e) {
  if (!e.target.closest("#rolemenu")) {
    closeRoleMenu();
    document.removeEventListener("click", closeRoleMenuOnce);
  }
}

// ---- Conflict surfacing (relative to current assignment) -----------------
// A spoken line "conflicts" when its effective speaker shares an actor with
// another character who is on stage at the same instant — i.e. that actor
// would need to be in two places at once. Returns a Set of conflicting glis
// and a per-actor count, computed from LAST_ACTORS over EFF.
function computeConflicts() {
  const charToActor = {};
  LAST_ACTORS.forEach((a, i) => a.roles.forEach(r => charToActor[r.name] = i));

  const conflictGlis = new Set();
  const perActor = LAST_ACTORS.map(() => 0);

  // For each speech line, check whether any *other* character sharing the
  // speaker's actor is on stage at that line's moment.
  for (const e of EFF.script) {
    if (e.t !== "speech") continue;
    for (const l of e.lines) {
      const sp = l.speaker;
      if (!sp || !(sp in charToActor)) continue;
      const actor = charToActor[sp];
      // Other characters on this actor present at this scene & overlapping time.
      const mates = LAST_ACTORS[actor].roles
        .map(r => r.name).filter(nm => nm !== sp);
      for (const mate of mates) {
        if (onStageAt(mate, e.scene, l.gli)) {
          conflictGlis.add(l.gli);
          perActor[actor]++;
          break;
        }
      }
    }
  }
  return { glis: conflictGlis, perActor, charToActor };
}

// Is `name` on stage during the line at global index gli (in scene sc)?
function onStageAt(name, sc, gli) {
  for (const s of segmentsOf(name)) {
    if (s[0] === sc && s[1] <= gli && gli < s[3]) return true;
  }
  return false;
}

// ---- Line editor panel ---------------------------------------------------
let EDITOR_SCENE = 0;
let LAST_CONFLICTS = { glis: new Set(), perActor: [], charToActor: {} };

function renderLinePanel() {
  LAST_CONFLICTS = computeConflicts();
  const sceneSel = document.getElementById("line-scene");
  // (Re)populate scene dropdown once.
  if (sceneSel.options.length !== EFF.scenes.length) {
    sceneSel.innerHTML = EFF.scenes.map((t, i) =>
      `<option value="${i}">${t.split(" — ")[0]}</option>`).join("");
  }
  if (EDITOR_SCENE >= EFF.scenes.length) EDITOR_SCENE = 0;
  sceneSel.value = EDITOR_SCENE;

  // Jump-by-character dropdown.
  const charSel = document.getElementById("jump-char");
  charSel.innerHTML = `<option value="">Jump to next line by…</option>`
    + NAMES.map(c => `<option value="${c}">${c}</option>`).join("");

  document.getElementById("conflict-count").textContent =
    LAST_CONFLICTS.glis.size
      ? `${LAST_CONFLICTS.glis.size} conflicting line(s) under this cast`
      : "no conflicts under this cast";

  // Annotate actor cards with their conflict count (an offer to resolve).
  const cards = document.querySelectorAll("#assignment .actor");
  LAST_CONFLICTS.perActor.forEach((cnt, i) => {
    const card = cards[i];
    if (!card) return;
    const head = card.querySelector(".actor-head");
    const old = head.querySelector(".aclash");
    if (old) old.remove();
    if (cnt > 0) {
      const tag = document.createElement("span");
      tag.className = "aclash";
      tag.textContent = `⚠ ${cnt}`;
      tag.title = "Conflicting lines — click to jump to the first";
      tag.style.cursor = "pointer";
      tag.onclick = ev => { ev.stopPropagation(); jumpFirstConflictForActor(i); };
      head.appendChild(tag);
    }
  });

  renderLineList();
}

function renderLineList() {
  const wrap = document.getElementById("line-list");
  const rows = [];
  for (const e of EFF.script) {
    if (e.t === "dir" && e.scene === EDITOR_SCENE)
      rows.push(`<div class="dir" style="opacity:.6">[${escapeHTML(e.text)}]</div>`);
    if (e.t !== "speech" || e.scene !== EDITOR_SCENE) continue;
    for (const l of e.lines) {
      const conflict = LAST_CONFLICTS.glis.has(l.gli);
      const reassigned = (l.gli in EDITS.lineReassign);
      const cut = EDITS.lineCuts.includes(l.gli);
      const joined = l.join;
      rows.push(
        `<div class="linerow${conflict ? " conflict" : ""}`
        + `${reassigned ? " reassigned" : ""}${cut ? " cut" : ""}" `
        + `data-gli="${l.gli}" id="gli-${l.gli}">`
        + `<span class="lr-who">${joined ? "↳" : (l.speaker || "—")}</span>`
        + `<span class="lr-text">${joined ? "<em>(joined) </em>" : ""}`
        + `${escapeHTML(l.text)}</span></div>`);
    }
  }
  wrap.innerHTML = rows.join("") || "<p class='muted'>No lines in this scene.</p>";
}

// Show a character-picker submenu (a <select> + confirm) anchored at anchorEl,
// instead of a typed prompt. `exclude` omits a name; calls cb(name) on pick.
function pickCharacter(title, anchorEl, cb, exclude) {
  closeRoleMenu();
  const menu = document.createElement("div");
  menu.className = "rolemenu"; menu.id = "rolemenu";
  const label = document.createElement("div");
  label.textContent = title;
  label.style.cssText = "padding:.3rem .55rem;font-size:.8rem;color:#9b8f82";
  menu.appendChild(label);
  const sel = document.createElement("select");
  sel.innerHTML = NAMES.filter(c => c !== exclude)
    .map(c => `<option value="${c}">${c}</option>`).join("");
  sel.style.cssText = "margin:.2rem .4rem";
  menu.appendChild(sel);
  const go = document.createElement("button");
  go.textContent = "Confirm";
  go.onclick = () => { const v = sel.value; closeRoleMenu(); if (v) cb(v); };
  menu.appendChild(go);
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = (window.scrollX + r.left) + "px";
  menu.style.top = (window.scrollY + r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("click", closeRoleMenuOnce), 0);
}

// Generic option-picker submenu: opts is [{label, value}], calls cb(value).
function pickOption(title, anchorEl, opts, cb) {
  closeRoleMenu();
  const menu = document.createElement("div");
  menu.className = "rolemenu"; menu.id = "rolemenu";
  const label = document.createElement("div");
  label.textContent = title;
  label.style.cssText = "padding:.3rem .55rem;font-size:.8rem;color:#9b8f82";
  menu.appendChild(label);
  const sel = document.createElement("select");
  sel.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join("");
  sel.style.cssText = "margin:.2rem .4rem";
  menu.appendChild(sel);
  const go = document.createElement("button");
  go.textContent = "Confirm";
  go.onclick = () => { const v = sel.value; closeRoleMenu(); cb(v); };
  menu.appendChild(go);
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = (window.scrollX + r.left) + "px";
  menu.style.top = (window.scrollY + r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("click", closeRoleMenuOnce), 0);
}

// Open the per-line op menu (reassign / edit / delete / join).
function openLineMenu(gli, anchorEl) {
  closeRoleMenu();
  const menu = document.createElement("div");
  menu.className = "rolemenu"; menu.id = "rolemenu";
  const add = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label; b.onclick = () => { closeRoleMenu(); fn(); };
    menu.appendChild(b);
  };

  add("Reassign to…", () => {
    pickCharacter("Reassign this line to:", anchorEl,
      nm => mutate(() => { EDITS.lineReassign[gli] = nm; }));
  });
  add("Edit text…", () => {
    const cur = effLineText(gli);
    const next = prompt("Edit line text:", cur);
    if (next !== null) mutate(() => { EDITS.lineEdits[gli] = next; });
  });
  add(EDITS.lineCuts.includes(gli) ? "Un-delete line" : "Delete line", () => {
    mutate(() => {
      const i = EDITS.lineCuts.indexOf(gli);
      if (i >= 0) EDITS.lineCuts.splice(i, 1); else EDITS.lineCuts.push(gli);
    });
  });
  // Join to previous line — only when the preceding effective line shares this
  // line's effective speaker (you can't fold a line into a different speaker's).
  const prev = prevEffLine(gli);
  if (EDITS.lineJoins.includes(gli)) {
    add("Un-join from previous", () => mutate(() => {
      EDITS.lineJoins.splice(EDITS.lineJoins.indexOf(gli), 1);
    }));
  } else if (prev && prev.speaker === effSpeakerOf(gli)) {
    add("Join to previous line", () =>
      mutate(() => { EDITS.lineJoins.push(gli); }));
  }
  if (EDITS.lineReassign[gli] !== undefined)
    add("Clear reassignment", () =>
      mutate(() => { delete EDITS.lineReassign[gli]; }));
  if (EDITS.lineEdits[gli] !== undefined)
    add("Revert text edit", () =>
      mutate(() => { delete EDITS.lineEdits[gli]; }));

  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = (window.scrollX + r.left) + "px";
  menu.style.top = (window.scrollY + r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("click", closeRoleMenuOnce), 0);
}

// Current effective text of a line (for the edit prompt default).
function effLineText(gli) {
  if (gli in EDITS.lineEdits) return EDITS.lineEdits[gli];
  for (const e of DATA.script)
    if (e.t === "speech")
      for (const l of e.lines) if (l.gli === gli) return l.text;
  return "";
}

// Effective speaker of a line, and the immediately preceding effective line —
// used to decide whether a "join to previous" is legal.
function effSpeakerOf(gli) {
  for (const e of EFF.script)
    if (e.t === "speech")
      for (const l of e.lines) if (l.gli === gli) return l.speaker;
  return null;
}
function prevEffLine(gli) {
  let last = null;
  for (const e of EFF.script)
    if (e.t === "speech")
      for (const l of e.lines) {
        if (l.gli === gli) return last;
        last = l;
      }
  return null;
}

function jumpToGli(gli) {
  // Find the scene of this gli and switch to it, then scroll/flash the row.
  for (const e of EFF.script)
    if (e.t === "speech")
      for (const l of e.lines)
        if (l.gli === gli) { EDITOR_SCENE = e.scene; break; }
  document.getElementById("line-scene").value = EDITOR_SCENE;
  renderLineList();
  const row = document.getElementById("gli-" + gli);
  if (row) { row.scrollIntoView({ block: "center" }); row.style.background = "#3a2a10"; }
}

// Jump to the first conflicting line involving any character on a given actor.
function jumpFirstConflictForActor(actorIdx) {
  const mine = new Set(LAST_ACTORS[actorIdx].roles.map(r => r.name));
  for (const e of EFF.script)
    if (e.t === "speech")
      for (const l of e.lines)
        if (LAST_CONFLICTS.glis.has(l.gli) && mine.has(l.speaker)) {
          jumpToGli(l.gli);
          document.getElementById("linepanel").scrollIntoView({ block: "nearest" });
          return;
        }
}

function jumpNextConflict() {
  const sorted = [...LAST_CONFLICTS.glis].sort((a, b) => a - b);
  if (!sorted.length) return;
  // Next conflict after the current scene's first line, wrapping around.
  const firstOfScene = sceneFirstGli(EDITOR_SCENE);
  const next = sorted.find(g => g > firstOfScene) ?? sorted[0];
  jumpToGli(next);
}

function jumpNextByChar(name) {
  if (!name) return;
  const glis = [];
  for (const e of EFF.script)
    if (e.t === "speech")
      for (const l of e.lines) if (l.speaker === name) glis.push(l.gli);
  if (!glis.length) return;
  const firstOfScene = sceneFirstGli(EDITOR_SCENE);
  jumpToGli(glis.find(g => g > firstOfScene) ?? glis[0]);
}

function sceneFirstGli(sc) {
  for (const e of EFF.script)
    if (e.t === "speech" && e.scene === sc && e.lines.length) return e.lines[0].gli;
  return -1;
}

// ---- Per-actor script generation -----------------------------------------
// Build one rehearsal script per actor from the current assignment over EFF:
// a roster (which role they play in each scene) then the full play text with
// their lines highlighted. Edits (cuts/merges/line ops) are already baked into
// EFF.script, so the scripts reflect them.
// Distinct highlight colours for the combined colour-coded script.
const ACTOR_COLOURS = ["#ffe9a8", "#bfe3c0", "#bcd6f5", "#f3c4d8", "#e6c9a8",
  "#cdbdf0", "#a8e6e0", "#f5d0a8", "#d6e8a8", "#f0b8b8", "#b8e0f0", "#e0c0e8"];

// Per-scene roster for an actor: which of their characters appear in each scene.
function actorRoster(myChars) {
  const r = [];
  EFF.scenes.forEach((title, sc) => {
    const here = [...myChars].filter(c => scenesOf(c).has(sc));
    if (here.length) r.push(`${title.split(" — ")[0]}: <b>${here.join(" / ")}</b>`);
  });
  return r;
}
function actorLabel(myChars) {
  return [...myChars].sort((a, b) =>
    EFF.characters[b].total_lines - EFF.characters[a].total_lines).join(", ");
}

// Render the play body; markFn(speaker) -> {cls, style} decides per-line styling.
// onlyScenes (a Set) limits which scenes are emitted (null = all).
function renderPlayBody(markFn, onlyScenes) {
  let body = "", skip = false;
  for (const e of EFF.script) {
    if (e.t === "scene") {
      skip = onlyScenes && !onlyScenes.has(e.scene);
      if (!skip) body += `<div class="scene-h" id="sc-${e.scene}">${EFF.scenes[e.scene]}</div>`;
    } else if (skip) {
      continue;
    } else if (e.t === "dir") {
      body += `<div class="dir">[${escapeHTML(e.text)}]</div>`;
    } else if (e.t === "speech") {
      for (const l of e.lines) {
        if (l.join && body.endsWith("</span></div>")) {
          body = body.slice(0, -"</span></div>".length)
            + " " + escapeHTML(l.text) + "</span></div>";
          continue;
        }
        const m = markFn(l.speaker);
        const who = l.speaker || "—";
        body += `<div class="sp ${m.cls}">`
          + `<span class="who">${who}.</span> `
          + `<span class="ln"${m.style ? ` style="${m.style}"` : ""}>`
          + `${escapeHTML(l.text)}</span></div>`;
      }
    }
  }
  return body;
}

function buildScriptsHTML(opts = {}) {
  if (!LAST_ACTORS.length) return "";
  const mode = opts.mode || "per-actor";

  if (mode === "combined") {
    // One script; each actor's lines get a distinct highlight colour.
    const colourOf = {};
    LAST_ACTORS.forEach((a, i) =>
      a.roles.forEach(r => colourOf[r.name] = ACTOR_COLOURS[i % ACTOR_COLOURS.length]));
    const key = LAST_ACTORS.map((a, i) => a.roles.length
      ? `<span class="legend" style="background:${ACTOR_COLOURS[i % ACTOR_COLOURS.length]}">`
        + `Actor ${i + 1}: ${actorLabel(new Set(a.roles.map(r => r.name)))}</span>` : "")
      .join(" ");
    const body = renderPlayBody(sp => ({
      cls: sp && colourOf[sp] ? "mine" : "other",
      style: sp && colourOf[sp] ? `background:${colourOf[sp]};padding:0 .1em;border-radius:2px` : "",
    }), null);
    return `<div class="actor-script"><h2>${DATA.title} — full cast</h2>`
      + `<div class="roster"><b>Highlight key:</b><br>${key}</div>${body}</div>`;
  }

  // Per-actor.
  let html = "";
  LAST_ACTORS.forEach((actor, ai) => {
    const myChars = new Set(actor.roles.map(r => r.name));
    if (!myChars.size) return;
    const onlyScenes = opts.onlyMyScenes
      ? new Set(EFF.scenes.map((_, sc) => sc).filter(sc =>
          [...myChars].some(c => scenesOf(c).has(sc))))
      : null;
    const body = renderPlayBody(sp => {
      const mine = sp && myChars.has(sp);
      return { cls: mine ? "mine" : "other", style: mine ? "background:#ffe9a8;padding:0 .1em;border-radius:2px" : "" };
    }, onlyScenes);
    html += `<div class="actor-script" id="actor-${ai}"><h2>Actor ${ai + 1} — ${actorLabel(myChars)}</h2>`
      + `<div class="roster"><b>Your roles by scene:</b><br>`
      + (actorRoster(myChars).join("<br>") || "(none)") + `</div>${body}</div>`;
  });
  return html;
}

// Read the current script options from the UI.
function scriptOpts() {
  return {
    mode: document.getElementById("script-mode").value,
    onlyMyScenes: document.getElementById("only-my-scenes").checked,
  };
}

function escapeHTML(s) {
  return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function generateScripts() {
  document.getElementById("scripts").innerHTML = buildScriptsHTML(scriptOpts());
  renderScriptJump();
}

// A dropdown to jump to any actor (per-actor mode) or scene within the scripts.
function renderScriptJump() {
  const el = document.getElementById("script-jump");
  const opts = scriptOpts();
  let targets = [];
  if (opts.mode === "per-actor") {
    LAST_ACTORS.forEach((a, i) => {
      if (a.roles.length) targets.push([`actor-${i}`,
        `Actor ${i + 1} — ${actorLabel(new Set(a.roles.map(r => r.name)))}`]);
    });
  } else {
    EFF.scenes.forEach((t, sc) => targets.push([`sc-${sc}`, t.split(" — ")[0]]));
  }
  if (!targets.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<label class="hint">Jump to: <select id="jump-target">`
    + `<option value="">—</option>`
    + targets.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")
    + `</select></label>`;
  document.getElementById("jump-target").addEventListener("change", e => {
    const t = document.getElementById(e.target.value);
    if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function downloadScripts() {
  const inner = buildScriptsHTML(scriptOpts());
  if (!inner) { generateScripts(); return; }
  // Self-contained HTML file with the script styles inlined.
  const styles = `body{font:15px/1.5 system-ui,sans-serif;background:#fff;color:#1c1714;
    margin:0;padding:1rem}.actor-script{max-width:720px;margin:0 auto 2rem;
    page-break-after:always}.actor-script h2{color:#6b3f1d}.roster{background:#efe6d6;
    border-radius:6px;padding:.5rem .7rem;margin-bottom:1rem;font-size:.9rem}
    .legend{display:inline-block;padding:.1em .4em;margin:.1em;border-radius:3px}
    .sp{margin:.45rem 0}.sp .who{font-weight:700;font-variant:small-caps}
    .sp.other{color:#8a8278}.ln.hi{background:#ffe9a8;padding:0 .1em;border-radius:2px}
    .scene-h{font-weight:700;color:#6b3f1d;margin:1.1rem 0 .4rem;border-top:1px solid #d8cab0;
    padding-top:.6rem}.dir{font-style:italic;color:#7a6f5d}`;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">`
    + `<title>${DATA.title} — actor scripts</title><style>${styles}</style></head>`
    + `<body>${inner}</body></html>`;
  const blob = new Blob([doc], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${DATA.title.replace(/[^a-z0-9]+/gi, "_")}_actor_scripts.html`;
  a.click(); URL.revokeObjectURL(url);
}

// ---- Boot ----------------------------------------------------------------
// Pick the active play: ?play= (if valid) → last play chosen → first in manifest.
const LAST_PLAY_KEY = "doublingchart.lastplay";
function activeSlug() {
  const data = window.PLAY_DATA || {};
  const fromUrl = new URLSearchParams(location.search).get("play");
  if (fromUrl && data[fromUrl]) return fromUrl;
  try {
    const ls = localStorage.getItem(LAST_PLAY_KEY);
    if (ls && data[ls]) return ls;
  } catch (e) { /* private mode */ }
  return (window.PLAY_LIST && window.PLAY_LIST[0] && window.PLAY_LIST[0].slug)
    || Object.keys(data)[0] || "midsummer";
}

// Switch plays with a full reload (simplest correct path — no EFF teardown).
// Keep the play-independent view knobs, set ?play=, and DROP the #s= edit hash
// (it encodes one play's edits by character name and must not ride along).
function switchPlay(slug) {
  if (!slug || slug === SLUG) return;
  const q = new URLSearchParams(location.search);
  q.set("play", slug);
  const url = location.pathname + "?" + q.toString();   // note: no hash
  location.assign(url);
}

// Render the play's content/harm notes into the collapsible panel. Stays
// collapsed by default (available, not sprung on anyone) and hides entirely if
// a play has no notes.
function renderContentNotes() {
  const panel = document.getElementById("cnotes");
  const body = document.getElementById("cnotes-body");
  if (!panel || !body) return;
  const notes = (DATA && DATA.content_notes) || [];
  if (!notes.length) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.open = false;   // reset to collapsed when switching plays
  document.getElementById("cnotes-summary").textContent =
    `Content notes (${notes.length})`;
  body.innerHTML = notes.map(n =>
    `<div class="cn"><span class="tag">${escapeHTML(n.tag)}</span>`
    + `<span class="note">${escapeHTML(n.note)}</span></div>`).join("");
}

function boot() {
  // Each play's data is inlined via data/<slug>.js into window.PLAY_DATA[slug],
  // so the page works from a web server AND when opened directly as a local file
  // (file://), where fetch() would be blocked by the browser.
  SLUG = activeSlug();
  DATA = (window.PLAY_DATA || {})[SLUG];
  if (!DATA) {
    document.getElementById("summary").innerHTML =
      '<span class="warn">Could not load play data (data files missing).</span>';
    return;
  }
  STORE_KEY = "doublingchart." + SLUG;   // per-play saved edits (before loadState)
  try { localStorage.setItem(LAST_PLAY_KEY, SLUG); } catch (e) {}

  // Populate the play picker from the manifest and switch plays on change.
  const playSel = document.getElementById("play");
  if (playSel && window.PLAY_LIST) {
    playSel.innerHTML = window.PLAY_LIST
      .map(p => `<option value="${p.slug}">${p.title}</option>`).join("");
    playSel.value = SLUG;
    playSel.addEventListener("change", () => switchPlay(playSel.value));
  }

  loadState();                // restore any saved decisions/edits
  buildEFF();
  NAMES = EFF.names;

  document.getElementById("play-title").textContent = DATA.title;
  document.getElementById("stats").textContent =
    `${NAMES.length} castable characters · ${DATA.scenes.length} scenes · `
    + `${DATA.play_lines} lines`;

  renderContentNotes();

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
  if (q.has("spread")) document.getElementById("spread").value = q.get("spread");
  if (q.has("smode")) document.getElementById("script-mode").value = q.get("smode");
  if (q.get("onlymine") === "1") document.getElementById("only-my-scenes").checked = true;

  ["mode", "threshold", "actors", "breakcredit", "spread"].forEach(id =>
    document.getElementById(id).addEventListener("input", () => {
      if (id === "mode") syncThreshold();
      render();
    }));

  // Delegated click on role chips -> open the cut/lock/move/merge menu.
  document.getElementById("assignment").addEventListener("click", e => {
    const chip = e.target.closest(".role[data-role]");
    if (chip) {
      e.stopPropagation();
      openRoleMenu(chip.dataset.role, parseInt(chip.dataset.actor, 10), chip);
    }
  });

  // Edit-set controls.
  document.getElementById("clear-edits").addEventListener("click", () => {
    if (decisionCount() + editCount() === 0 || confirm("Clear all cuts, merges, "
      + "pins and line edits?")) clearAllEdits();
  });
  document.getElementById("export-edits").addEventListener("click", exportEdits);
  document.getElementById("import-edits").addEventListener("click", () =>
    document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", importEdits);

  document.getElementById("auto-spread").addEventListener("click", autoSpreadSplit);

  // Script generation.
  document.getElementById("gen-scripts").addEventListener("click", generateScripts);
  document.getElementById("download-scripts").addEventListener("click", downloadScripts);
  // Regenerate live if scripts are already showing and options change.
  ["script-mode", "only-my-scenes"].forEach(id =>
    document.getElementById(id).addEventListener("change", () => {
      if (document.getElementById("scripts").innerHTML.trim()) generateScripts();
    }));

  // Line editor panel.
  document.getElementById("line-scene").addEventListener("change", e => {
    EDITOR_SCENE = parseInt(e.target.value, 10); renderLineList();
  });
  document.getElementById("jump-conflict").addEventListener("click", jumpNextConflict);
  document.getElementById("jump-char").addEventListener("change", e => {
    jumpNextByChar(e.target.value); e.target.value = "";
  });
  document.getElementById("line-list").addEventListener("click", e => {
    const row = e.target.closest(".linerow[data-gli]");
    if (row) { e.stopPropagation();
      openLineMenu(parseInt(row.dataset.gli, 10), row); }
  });

  syncThreshold();
  render();
  if (new URLSearchParams(location.search).get("gen") === "1") generateScripts();
  const sg = new URLSearchParams(location.search).get("suggest");
  if (sg) renderSuggestions(document.getElementById("mode").value,
    parseInt(document.getElementById("threshold").value, 10) || 0, parseInt(sg, 10));
}

function exportEdits() {
  const blob = new Blob([JSON.stringify({ DECISIONS, EDITS }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "doublingchart-edits.json";
  a.click(); URL.revokeObjectURL(url);
}

function importEdits(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const o = JSON.parse(reader.result);
      if (o.DECISIONS) DECISIONS = { cutChars: [], merges: [], locks: {}, splits: {}, ...o.DECISIONS };
      if (o.EDITS) EDITS = { lineReassign: {}, lineEdits: {}, lineCuts: [], lineJoins: [], ...o.EDITS };
      saveState(); render();
    } catch (err) { alert("Could not read that edits file."); }
  };
  reader.readAsText(file);
  e.target.value = "";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
