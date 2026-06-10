#!/usr/bin/env python3
"""
Parse an Open Source Shakespeare 'print' view into structured data for casting.

Produces, per scene:
  - line counts per speaking character
  - the on-stage set over the course of the scene (presence), tracked statefully
    from entrances/exits and cross-checked against who actually speaks.

Outputs two CSVs:
  - lines_by_scene.csv     (scene x character -> line count)
  - presence_by_scene.csv  (scene x character -> 1 if ever on stage)

And prints a doubling-compatibility summary: which characters never share a scene.

Usage:
  python parse_play.py midsummer.html [--out-dir .]

The parser deliberately works from primitives (scene breaks, speeches, lines,
entrances, exits) so it generalises to any OSS print-view play, not just MSND.
"""

import argparse
import csv
import html
import io
import json
import re
import sys
from collections import defaultdict

# Force UTF-8 stdout so em-dashes / apostrophes render on Windows consoles.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ---- Regexes over the raw HTML --------------------------------------------

SCENETITLE_RE = re.compile(r"<p class='scenetitle'>(.*?)</p>", re.S)
# A speech: <li class='playtext'><strong>Speaker. </strong>...body...</li>
SPEECH_RE = re.compile(
    r"<li class='playtext'><strong>(.*?)</strong>(.*?)</li>", re.S
)
# Stage directions come in two flavours in this source:
#   <p class='stagedir'>...<a name='N'></a>[TEXT]
#   <i>[TEXT]</i>   (inline, e.g. mid-speech [Exit X])
STAGEDIR_RE = re.compile(
    r"(?:class='stagedir'>(?:<a name='\d+'></a>)?\[(.*?)\])"
    r"|(?:<i>\[(.*?)\]</i>)",
    re.S,
)

# An "Act N, Scene M" title vs a locale title: only the former starts with "Act ".
ACT_SCENE_RE = re.compile(r"^Act\b", re.I)


def clean(text):
    """Strip tags, unescape entities, collapse whitespace."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_name(raw):
    """
    Normalise a name token to a canonical character key.
    Handles speech-prefix punctuation, case, and known aliases.
    Returns None for non-character tokens (train, all, etc.) handled elsewhere.
    """
    n = clean(raw).strip(".").strip().upper()
    n = re.sub(r"\s+", " ", n)
    # Strip trailing role qualifiers we don't want as separate characters.
    n = re.sub(r"\b(WITH HIS TRAIN|WITH HER TRAIN|AND HIS TRAIN)\b", "", n).strip()
    n = re.sub(r"^A FAIRY$", "FAIRY", n)
    n = aliases.get(n, n)
    return n or None


# Canonical aliases / role mappings. The play-within-a-play (Pyramus & Thisbe,
# performed in V.1) is acted by the mechanicals under fictional names that
# appear only in stage directions. Those names are the SAME bodies as the
# actors, so we map each fictional role to its real actor rather than dropping
# it — otherwise the actors' entrances/exits in V.1 are lost. Casting is fixed
# in I.2: Quince=Prologue, Bottom=Pyramus, Flute=Thisbe(/Thisby), Snout=Wall,
# Starveling=Moonshine, Snug=Lion.
aliases = {
    "ROBIN": "PUCK",
    "ROBIN GOODFELLOW": "PUCK",
    "A FAIRY": "FAIRY",
    "PYRAMUS": "BOTTOM",
    "THISBE": "FLUTE",
    "THISBY": "FLUTE",
    "WALL": "SNOUT",
    "MOONSHINE": "STARVELING",
    "LION": "SNUG",
    "PROLOGUE": "QUINCE",
}


# Tokens that denote groups/non-individuals; we keep them as presence markers
# but they never get doubled with a named role automatically.
GROUP_TOKENS = {"ATTENDANTS", "TRAIN", "FAIRIES", "FAIRY", "ALL",
                "LORDS", "OTHERS", "AND ATTENDANTS"}


# Title-case fictional roles from the play-within-a-play that appear in stage
# directions (not all-caps like real names). Whitelisted so split_names accepts
# them; normalize_name then maps them to the real actor via `aliases`.
FICTIONAL_ROLES = {"PYRAMUS", "THISBE", "THISBY", "WALL", "MOONSHINE", "LION",
                   "PROLOGUE"}


def split_names(text):
    """Extract candidate names from an enter/exit clause like
    'THESEUS, HIPPOLYTA, PHILOSTRATE, and Attendants'."""
    text = re.sub(r"\bfrom (one|opposite|the other) side[s]?\b", "", text, flags=re.I)
    text = re.sub(r"\b(from|with|following|behind|running|opposite|sides?)\b.*",
                  "", text, flags=re.I)
    parts = re.split(r",|\band\b", text, flags=re.I)
    names = []
    for p in parts:
        raw = clean(p).strip()
        if not raw:
            continue
        # Strip a trailing lowercase descriptor, e.g. "QUINCE for the Prologue"
        # -> "QUINCE", keeping the leading capitalised name run.
        m = re.match(r"((?:[A-Z][A-Za-z']*\s*)+)", raw)
        head = m.group(1).strip() if m else raw
        alpha_words = re.findall(r"[A-Za-z']+", head)
        # Accept if every word in the head is all-caps (real name, OSS
        # convention) — this rejects verb phrases like "squeezes the flower".
        is_caps = alpha_words and all(
            w.isupper() or w.lower() in {"a", "the", "his", "her", "with"}
            for w in alpha_words
        )
        # Or a known fictional role (title-case) or group word.
        first_upper = head.upper().split()
        is_fictional = bool(set(first_upper) & FICTIONAL_ROLES)
        is_group = head.lower() in {"attendants", "train", "fairies", "lords",
                                    "a train", "her train", "his train", "others"}
        if not (is_caps or is_fictional or is_group):
            continue
        # For a fictional role buried in a phrase, normalise just that token.
        token = next((w for w in first_upper if w in FICTIONAL_ROLES), head) \
            if is_fictional else head
        nm = normalize_name(token)
        if nm and nm not in {"", "HIS", "HER", "HERS"}:
            names.append(nm)
    return names


def build_events(html_text):
    """Return the ordered (pos, kind, payload) event stream for the document."""
    events = []
    for m in SCENETITLE_RE.finditer(html_text):
        title = clean(m.group(1))
        kind = "scene" if ACT_SCENE_RE.match(title) else "locale"
        events.append((m.start(), kind, title))
    for m in SPEECH_RE.finditer(html_text):
        speaker = normalize_name(m.group(1))
        body = m.group(2)
        body_wo_dir = re.sub(r"<i>\[.*?\]</i>", "", body, flags=re.S)
        n_lines = len(re.findall(r"<br\s*/?>", body_wo_dir)) + 1
        # Word count: strip tags/entities/linenums, then count word tokens.
        text = clean(re.sub(r"<span class='playlinenum'>\d+</span>", " ",
                            body_wo_dir))
        n_words = len(re.findall(r"[A-Za-z']+", text))
        events.append((m.start(), "speech", (speaker, n_lines, n_words)))
    for m in STAGEDIR_RE.finditer(html_text):
        payload = m.group(1) if m.group(1) is not None else m.group(2)
        events.append((m.start(), "stagedir", clean(payload)))
    events.sort(key=lambda e: e[0])
    return events


def build_timeline(html_text):
    """
    Produce a position-resolved timeline suitable for client-side conflict
    analysis under ANY mode (instant / scene / lines:N / words:N / scenes:N).

    We walk the same event stream as parse(), maintaining cumulative line and
    word counters across the whole play. Whenever a character's on-stage state
    flips, we close/open a 'segment' tagged with (scene index, line position,
    word position). Two characters never overlap iff their segments are
    disjoint; the minimum gap between consecutive segments of different
    characters drives the lines/words/scenes-apart modes — all computed in JS.

    Returns a JSON-serialisable dict:
      {
        "title": str,
        "scenes": [scene label, ...],
        "characters": {
          NAME: {
            "lines": {scene_idx: int},      # spoken lines per scene
            "words": {scene_idx: int},
            "total_lines": int, "total_words": int,
            "segments": [[scene_idx, line_start, word_start,
                          line_end, word_end], ...]
          }, ...
        },
        "play_lines": int, "play_words": int,
        "groups": [GROUP_TOKEN, ...]   # non-castable crowd markers present
      }
    """
    events = build_events(html_text)

    scenes = []                  # scene labels
    chars = {}                   # NAME -> data dict
    on_stage = {}                # NAME -> (scene_idx, line_at_entry, word_at_entry)
    cur_scene = -1
    last_speaker = None
    line_pos = 0                 # cumulative lines spoken across play
    word_pos = 0
    groups_seen = set()

    def ensure(name):
        if name not in chars:
            chars[name] = {
                "lines": defaultdict(int), "words": defaultdict(int),
                "total_lines": 0, "total_words": 0, "segments": [],
            }
        return chars[name]

    def enter(name):
        if name in GROUP_TOKENS:
            groups_seen.add(name)
            return
        ensure(name)
        if name not in on_stage:   # ignore redundant re-entries
            on_stage[name] = (cur_scene, line_pos, word_pos)

    def leave(name):
        if name in GROUP_TOKENS or name not in on_stage:
            return
        sc, ls, ws = on_stage.pop(name)
        chars[name]["segments"].append([sc, ls, ws, line_pos, word_pos])

    def clear_stage():
        for name in list(on_stage):
            leave(name)

    for _, kind, payload in events:
        if kind == "scene":
            clear_stage()          # a scene break implicitly clears the stage
            cur_scene = len(scenes)
            scenes.append(payload)
            last_speaker = None
        elif kind == "locale":
            if scenes and " — " not in scenes[-1]:
                scenes[-1] = f"{scenes[-1]} — {payload}"
        elif cur_scene < 0:
            continue
        elif kind == "speech":
            speaker, n_lines, n_words = payload
            if speaker and speaker not in GROUP_TOKENS:
                enter(speaker)     # speaking implies presence
                d = ensure(speaker)
                d["lines"][cur_scene] += n_lines
                d["words"][cur_scene] += n_words
                d["total_lines"] += n_lines
                d["total_words"] += n_words
                last_speaker = speaker
            line_pos += n_lines
            word_pos += n_words
        elif kind == "stagedir":
            _apply_timeline_stagedir(payload, enter, leave, clear_stage,
                                     on_stage, lambda: last_speaker)

    clear_stage()  # close any segments still open at end of play

    # Convert defaultdicts to plain dicts with string keys for JSON.
    out_chars = {}
    for name, d in chars.items():
        out_chars[name] = {
            "lines": {str(k): v for k, v in d["lines"].items()},
            "words": {str(k): v for k, v in d["words"].items()},
            "total_lines": d["total_lines"],
            "total_words": d["total_words"],
            "segments": d["segments"],
        }
    return {
        "title": "A Midsummer Night's Dream",
        "scenes": scenes,
        "characters": out_chars,
        "play_lines": line_pos,
        "play_words": word_pos,
        "groups": sorted(groups_seen),
    }


def _apply_timeline_stagedir(text, enter, leave, clear_stage, on_stage,
                             get_last_speaker):
    """Stage-direction handler for the timeline walk (mirrors apply_stagedir
    but drives the segment-tracking enter/leave callbacks)."""
    low = text.lower()
    is_enter = low.startswith("enter") or low.startswith("re-enter")
    is_exeunt = low.startswith("exeunt")
    is_exit = low.startswith("exit") and not is_exeunt

    if is_enter:
        body = re.sub(r"^(re-enter|enter)", "", text, flags=re.I)
        for nm in split_names(body):
            enter(nm)
    elif is_exeunt:
        body = re.sub(r"^exeunt", "", text, flags=re.I).strip()
        m = re.match(r"all but (.*)", body, flags=re.I)
        if m:  # everyone leaves except the named survivors
            keep = set(split_names(m.group(1)))
            for nm in list(on_stage):
                if nm not in keep:
                    leave(nm)
        elif split_names(body):
            for nm in split_names(body):
                leave(nm)
        else:
            clear_stage()
    elif is_exit:
        body = re.sub(r"^exit", "", text, flags=re.I).strip()
        names = split_names(body)
        if names:
            for nm in names:
                leave(nm)
        else:
            ls = get_last_speaker()
            if ls:
                leave(ls)


def parse(html_text):
    """Walk the document in order, segmenting into scenes and tracking state."""
    # Build a flat, ordered list of events by scanning all three patterns and
    # sorting by position in the document.
    events = []  # (pos, kind, payload)

    for m in SCENETITLE_RE.finditer(html_text):
        title = clean(m.group(1))
        kind = "scene" if ACT_SCENE_RE.match(title) else "locale"
        events.append((m.start(), kind, title))

    for m in SPEECH_RE.finditer(html_text):
        speaker = normalize_name(m.group(1))
        body = m.group(2)
        # Count typographic lines: number of <br> + 1 (the first line sits
        # right after the speaker tag). Drop trailing empties.
        # But first remove inline stagedirs so they don't inflate the count.
        body_wo_dir = re.sub(r"<i>\[.*?\]</i>", "", body, flags=re.S)
        n_lines = len(re.findall(r"<br\s*/?>", body_wo_dir)) + 1
        events.append((m.start(), "speech", (speaker, n_lines)))

    for m in STAGEDIR_RE.finditer(html_text):
        payload = m.group(1) if m.group(1) is not None else m.group(2)
        events.append((m.start(), "stagedir", clean(payload)))

    events.sort(key=lambda e: e[0])

    scenes = []  # list of dicts
    cur = None
    on_stage = set()
    last_speaker = None

    def open_scene(title):
        nonlocal cur, on_stage, last_speaker
        cur = {
            "title": title,
            "lines": defaultdict(int),
            "present": set(),     # everyone who was ever on stage
            "speakers": set(),
            "warnings": [],
        }
        scenes.append(cur)
        on_stage = set()
        last_speaker = None

    for _, kind, payload in events:
        if kind == "scene":
            open_scene(payload)
        elif kind == "locale":
            if cur is not None and cur["title"] and " — " not in cur["title"]:
                cur["title"] = f"{cur['title']} — {payload}"
        elif cur is None:
            continue  # ignore anything before the first scene
        elif kind == "speech":
            speaker, n_lines = payload
            if speaker:
                cur["lines"][speaker] += n_lines
                cur["speakers"].add(speaker)
                cur["present"].add(speaker)
                on_stage.add(speaker)
                last_speaker = speaker
        elif kind == "stagedir":
            apply_stagedir(payload, cur, on_stage, last_speaker)

    return scenes


def apply_stagedir(text, cur, on_stage, last_speaker):
    low = text.lower()
    is_enter = low.startswith("enter") or low.startswith("re-enter")
    is_exeunt = low.startswith("exeunt")
    is_exit = low.startswith("exit") and not is_exeunt

    if is_enter:
        body = re.sub(r"^(re-enter|enter)", "", text, flags=re.I)
        for nm in split_names(body):
            cur["present"].add(nm)
            on_stage.add(nm)
    elif is_exeunt:
        body = re.sub(r"^exeunt", "", text, flags=re.I).strip()
        m = re.match(r"all but (.*)", body, flags=re.I)
        if m:  # "Exeunt all but X and Y"
            keep = set(split_names(m.group(1)))
            on_stage.intersection_update(keep)
        elif split_names(body):  # named subset leaves
            for nm in split_names(body):
                on_stage.discard(nm)
        else:  # bare Exeunt -> everyone leaves
            on_stage.clear()
    elif is_exit:
        body = re.sub(r"^exit", "", text, flags=re.I).strip()
        names = split_names(body)
        if names:
            for nm in names:
                on_stage.discard(nm)
        elif last_speaker:  # bare [Exit] -> the current speaker leaves
            on_stage.discard(last_speaker)
        # else: ambiguous bare exit with no recent speaker; ignore.
    # non-movement directions (Awaking, Sings, They sleep, ...) are ignored.


def write_outputs(scenes, out_dir):
    # Stable scene labels + ordered character list.
    scene_labels = [s["title"] for s in scenes]
    chars = sorted({c for s in scenes for c in s["present"]})

    with open(f"{out_dir}/lines_by_scene.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["character"] + scene_labels + ["TOTAL"])
        for c in chars:
            row = [s["lines"].get(c, 0) for s in scenes]
            w.writerow([c] + row + [sum(row)])

    with open(f"{out_dir}/presence_by_scene.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["character"] + scene_labels)
        for c in chars:
            w.writerow([c] + [1 if c in s["present"] else 0 for s in scenes])

    return chars, scene_labels


def doubling_report(scenes, chars):
    """Two named chars are compatible iff they never share a scene."""
    present_in = {c: {i for i, s in enumerate(scenes) if c in s["present"]}
                  for c in chars}
    # Exclude group tokens from doubling suggestions.
    named = [c for c in chars if c not in GROUP_TOKENS]
    compatible = []
    for i, a in enumerate(named):
        for b in named[i + 1:]:
            if not (present_in[a] & present_in[b]):
                compatible.append((a, b))
    return compatible


def assign_actors(scenes, chars, n_actors):
    """
    Pack characters onto n_actors so that no actor holds two characters who
    share a scene (a conflict), while balancing total line load across actors.

    Heuristic: longest-processing-time-first with a conflict constraint.
    Process characters heaviest-first; assign each to the eligible actor
    (no conflict with anyone already on that actor) carrying the fewest lines.
    This is a good, fast approximation for the small N we care about.

    Returns (assignment, min_actors) where assignment maps actor_index ->
    list of (character, line_total, conflict) and conflict is True when that
    role had to share an actor with someone it overlaps on stage (only happens
    when n_actors is below the hard minimum). min_actors is that hard floor:
    the largest number of individual characters ever on stage simultaneously.
    """
    present_in = {c: frozenset(i for i, s in enumerate(scenes) if c in s["present"])
                  for c in chars}
    totals = defaultdict(int)
    for s in scenes:
        for c, n in s["lines"].items():
            totals[c] += n

    # Only individuals are castable; crowds/chorus markers are not doubled.
    castable = [c for c in chars if c not in GROUP_TOKENS]
    # The hard floor: no fewer actors than the busiest scene's headcount.
    min_actors = max((len({c for c in s["present"] if c not in GROUP_TOKENS})
                      for s in scenes), default=0)
    # Most-constrained-first: the roles on stage the most (largest footprint)
    # are hardest to double, so place them first and let small roles fill the
    # gaps. This avoids the greedy-colouring trap where balancing load too
    # eagerly creates an avoidable clash. Line total breaks ties.
    castable.sort(key=lambda c: (-len(present_in[c]), -totals[c]))

    actors = [{"chars": [], "scenes": set(), "load": 0} for _ in range(n_actors)]

    for c in castable:
        footprint = present_in[c]
        eligible = [a for a in actors if not (a["scenes"] & footprint)]
        if eligible:
            # Conflict-avoidance is a hard constraint; among conflict-free
            # actors, pick the least-loaded to balance lines.
            target = min(eligible, key=lambda a: a["load"])
            conflict = False
        else:
            # No conflict-free actor exists: n_actors is below the floor.
            # Place on the least-loaded actor and flag the clash so the chart
            # stays complete and the human sees exactly what must be cut.
            target = min(actors, key=lambda a: a["load"])
            conflict = True
        target["chars"].append((c, conflict))
        target["scenes"] |= footprint
        target["load"] += totals[c]

    assignment = {i: [(c, totals[c], conf) for c, conf in a["chars"]]
                  for i, a in enumerate(actors)}
    return assignment, min_actors


def reduction_cost(scenes, chars):
    """
    For each cast size from the hard floor down to 1, report how many roles
    and how many *lines* can no longer be cleanly covered (must clash). This
    is the "what does cutting an actor cost you" curve.
    """
    _, floor = assign_actors(scenes, chars, 1)
    rows = []
    for n in range(floor, 0, -1):
        assignment, _ = assign_actors(scenes, chars, n)
        clash_roles = [(c, ln) for roles in assignment.values()
                       for c, ln, conf in roles if conf]
        rows.append((n, len(clash_roles), sum(ln for _, ln in clash_roles),
                     clash_roles))
    return floor, rows


def print_reduction_cost(floor, rows):
    print(f"\n=== Cost of a smaller cast (uncut text; floor = {floor} actors) ===")
    print(f"  At {floor}+ actors every role is cleanly coverable.")
    print(f"  {'actors':>6}  {'roles broken':>12}  {'lines broken':>12}")
    for n, nroles, nlines, _ in rows:
        if nroles:
            print(f"  {n:>6}  {nroles:>12}  {nlines:>12}")
    # Show the first clash as the marginal cost of dropping below the floor.
    first = next((r for r in rows if r[1]), None)
    if first:
        n, _, nlines, clash_roles = first
        worst = ", ".join(f"{c} ({ln})"
                          for c, ln in sorted(clash_roles, key=lambda x: -x[1])[:4])
        print(f"\n  Dropping to {n} actors first breaks {nlines} lines "
              f"across these roles: {worst} …")


def print_assignment(assignment, min_actors, n_actors):
    print(f"\n=== Proposed casting for {n_actors} actor(s) ===")
    if n_actors < min_actors:
        print(f"  ⚠ This play needs at least {min_actors} actors uncut "
              f"(its busiest scene has {min_actors} characters on stage at once).")
        print(f"    Roles marked [CLASH] overlap on stage and can't truly be "
              f"doubled — cut or merge them, or add actors.\n")
    loads = []
    for i in sorted(assignment):
        roles = sorted(assignment[i], key=lambda r: -r[1])
        load = sum(n for _, n, _ in roles)
        loads.append(load)
        role_str = ", ".join(
            f"{c} ({n}){' [CLASH]' if conf else ''}" for c, n, conf in roles
        ) or "(none)"
        print(f"  Actor {i + 1:>2} [{load:>4} lines]: {role_str}")
    if loads:
        print(f"\n  Line load — min {min(loads)}, max {max(loads)}, "
              f"spread {max(loads) - min(loads)} "
              f"(ideal even split ≈ {sum(loads) // n_actors})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html_file")
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--actors", type=int, default=None,
                    help="Propose a doubling assignment for N actors.")
    ap.add_argument("--json", metavar="PATH", default=None,
                    help="Emit a position-resolved timeline JSON for the web UI.")
    args = ap.parse_args()

    with open(args.html_file, encoding="utf-8", errors="replace") as f:
        html_text = f.read()

    if args.json:
        timeline = build_timeline(html_text)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(timeline, f, ensure_ascii=False, indent=1)
        nseg = sum(len(c["segments"]) for c in timeline["characters"].values())
        print(f"Wrote {args.json}: {len(timeline['characters'])} characters, "
              f"{len(timeline['scenes'])} scenes, {nseg} on-stage segments, "
              f"{timeline['play_lines']} lines / {timeline['play_words']} words.")
        return

    scenes = parse(html_text)
    if not scenes:
        print("No scenes parsed — is this an OSS print view?", file=sys.stderr)
        sys.exit(1)

    chars, labels = write_outputs(scenes, args.out_dir)

    print(f"Parsed {len(scenes)} scenes, {len(chars)} characters.\n")
    print("Lines per character per scene:")
    for s in scenes:
        total = sum(s["lines"].values())
        print(f"\n  {s['title']}  ({total} lines)")
        for c, n in sorted(s["lines"].items(), key=lambda kv: -kv[1]):
            present = sorted(s["present"])
            print(f"    {c:<16} {n:>4}")
        silent = sorted(s["present"] - set(s["lines"]))
        if silent:
            print(f"    (present, silent: {', '.join(silent)})")

    print("\nCharacter line totals:")
    totals = defaultdict(int)
    for s in scenes:
        for c, n in s["lines"].items():
            totals[c] += n
    for c, n in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  {c:<16} {n:>5}")

    compat = doubling_report(scenes, chars)
    print(f"\n{len(compat)} doubling-compatible pairs (never share a scene). "
          f"Examples:")
    for a, b in compat[:25]:
        print(f"  {a} + {b}")

    if args.actors:
        assignment, min_actors = assign_actors(scenes, chars, args.actors)
        print_assignment(assignment, min_actors, args.actors)
        floor, rows = reduction_cost(scenes, chars)
        print_reduction_cost(floor, rows)

    print(f"\nWrote lines_by_scene.csv and presence_by_scene.csv to {args.out_dir}")


if __name__ == "__main__":
    main()
