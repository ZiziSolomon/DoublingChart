# DoublingChart

A casting helper for small-cast Shakespeare. Pick how much breathing room an
actor needs between two roles, and a number of actors, and it works out which
characters can share an actor — balancing the line load, and telling you
exactly what breaks if you go below the minimum feasible cast.

**Live:** https://zizisolomon.github.io/DoublingChart/

Currently loaded with *A Midsummer Night's Dream*. More plays to come.

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
  two places at once.

You can share a configuration via URL params, e.g.
`?mode=lines&n=30&actors=12`.

## How the data is made

`midsummer.json` is generated from the
[Open Source Shakespeare](https://www.opensourceshakespeare.org/) print view:

```
python parse_play.py midsummer.html --json data/midsummer.json
```

The parser tracks a position-resolved timeline (each character's on-stage
segments tagged with line/word positions), so the browser can evaluate any
conflict rule client-side. Notable handling: bare `[Exit]`/`[Exeunt]` resolved
from context, "Exeunt all but X", non-speaking presence, and the
play-within-a-play in V.1 (Pyramus→Bottom, Thisbe→Flute, Wall→Snout,
Moonshine→Starveling, Lion→Snug, Prologue→Quince) mapped to the real actors.

`data.js` is just `midsummer.json` wrapped as `window.PLAY_DATA = …` so the page
also works opened directly from disk (no server needed).

## Caveats

- Doubling = never *too close* under your rule. Even a clash-free assignment
  doesn't guarantee enough physical time for a costume change at every hand-off
  — check tight transitions by eye.
- Line counts are typographic lines (matching OSS), a proxy for role weight.
- The assignment uses a greedy most-constrained-first heuristic; it finds a
  clean assignment at the true minimum cast size but isn't a guaranteed-optimal
  load balance.
