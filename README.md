# DoublingChart

A casting helper for small-cast Shakespeare. Pick how much breathing room an
actor needs between two roles, and a number of actors, and it works out which
characters can share an actor — balancing the line load, and telling you
exactly what breaks if you go below the minimum feasible cast.

**Live:** https://zizisolomon.github.io/DoublingChart/

Loaded with *A Midsummer Night's Dream* and *Twelfth Night*; pick a play from
the **Play** dropdown. More plays to come. Each play keeps its own edits, and
`?play=<slug>` selects one by URL.

## What it does

- **Who's on stage when** and **lines per character per scene**, parsed from the
  full text (entrances, exits, scene breaks, speeches).
- **Doubling rules** — choose what counts as a clash between two roles:
  - *never on stage at the same instant* (tracks entrances/exits within a scene)
  - *never in the same scene*
  - *within N lines of each other* (unless a scene break separates them)
  - *within N words of each other* (unless a scene break separates them)
  - *within N scene breaks of each other*
- **Assignment** — packs roles onto your chosen number of actors with no clashes
  where possible, balancing total spoken lines per actor.
- **Cost of a smaller cast** — if you pick fewer actors than the floor, it tells
  you *which scenes clash* and *how many spoken lines* would need one actor in
  two places at once, and *where to cut* (the floor-forcing scene + its lightest
  roles).
- **Edit the play to fit your cast** — click a role chip to **cut** a character,
  **pin/move** it to an actor, or **merge** two characters into one body (which
  reduces headcount even where both were on stage). A **line editor** lets you
  jump to conflicting lines (or any character's lines) and **reassign / edit /
  delete** them. Every edit re-derives the cast and conflicts live.
- **Per-actor scripts** — generate one rehearsal script per actor: a per-scene
  roster of their roles, then the full play with their lines highlighted. Print
  to PDF or download as a self-contained HTML file.

Edits persist in your browser and to a shareable URL; export/import as JSON.
A scene break's worth of rest is tunable ("scene break = N lines"); set it to 0
to forbid an actor closing one scene and opening the next (the law of re-entry).

You can share a configuration via URL params, e.g.
`?mode=lines&n=30&actors=12&credit=10`.

## How the data is made

Each play is generated from its
[Open Source Shakespeare](https://www.opensourceshakespeare.org/) print view.
`--js` writes the data file the page actually loads
(`window.PLAY_DATA[slug] = …`, plain UTF-8, no BOM), so the page works opened
directly from disk (no server needed):

```
python parse_play.py midsummer.html --play midsummer --js data/midsummer.js
python parse_play.py 12night.html   --play 12night   --js data/12night.js
```

`--play <slug>` selects per-play config (cast aliases, crowd tokens, title) from
the `PLAYS` dict in `parse_play.py` — kept as small declarative data so adding a
play is mostly: download its print view, add a `PLAYS` entry, build, and add the
slug to `data/plays.js` + a `<script>` tag in `index.html`. Use `--json` instead
of `--js` for the raw timeline JSON, or no flag for a text casting report.

The parser tracks a position-resolved timeline (each character's on-stage
segments tagged with line/word positions), so the browser can evaluate any
conflict rule client-side. Notable handling: bare `[Exit]`/`[Exeunt]` resolved
from context, "Exeunt all but X", non-speaking presence, and per-play name
quirks via `aliases` — e.g. MSND's play-within-a-play roles (Pyramus→Bottom …
Prologue→Quince) mapped to the real actors, and Twelfth Night's Clown→Feste,
Duke Orsino→Orsino, Sir Andrew→Sir Andrew Aguecheek.

## Caveats

- Doubling = never *too close* under your rule. Even a clash-free assignment
  doesn't guarantee enough physical time for a costume change at every hand-off
  — check tight transitions by eye.
- Line counts are typographic lines (matching OSS), a proxy for role weight.
- The assignment uses a greedy most-constrained-first heuristic; it finds a
  clean assignment at the true minimum cast size but isn't a guaranteed-optimal
  load balance.
