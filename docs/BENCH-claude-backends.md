# Claude backends: HTTP API (OpenRouter) vs `claude -p` agents

Run 2026-10-13T22:00:17.470Z · 8 router / 5 progress-line / 4 Opus calls per variant, sequential, 2.5 s apart · same prompts for every variant.

- **api**: `@anthropic-ai/sdk` → OpenRouter's Anthropic-compatible endpoint (router: forced `route` tool with eager input streaming).
- **cli-warm**: pre-spawned `claude -p --input-format stream-json` agents (one waiting per role, replaced as soon as one is taken).
- **cli-cold**: `claude -p` spawned per call (no pool) — what the warm pool saves.

Router: Haiku 5.5, effort low, U3 transcript with one pointing word. Opus: Opus 5.5, effort medium, the fixture codebase in the system prompt.

### Router (Haiku)

| variant · metric (ms from request) | p50 | p90 | mean | n |
|---|---|---|---|---|
| api · first token | 726 | 924 | 769 | 8 |
| api · decision | 982 | 1090 | 1000 | 8 |
| api · ack text complete | 984 | 1094 | 1002 | 8 |
| api · total | 1503 | 1692 | 1530 | 8 |
| cli-warm · first token | 1015 | 1325 | 1025 | 8 |
| cli-warm · decision | 1120 | 1461 | 1175 | 8 |
| cli-warm · ack text complete | 1200 | 1510 | 1211 | 8 |
| cli-warm · total | 1817 | 2087 | 1767 | 8 |
| cli-cold · first token | 1455 | 2059 | 1601 | 8 |
| cli-cold · decision | 1578 | 2288 | 1773 | 8 |
| cli-cold · ack text complete | 1608 | 2289 | 1796 | 8 |
| cli-cold · total | 2215 | 2797 | 2344 | 8 |

| variant | cost/call p50 (API prices) | claude -p's own cost p50 | errors | warm agent used |
|---|---|---|---|---|
| api | $0.00015 | – | 0 | – |
| cli-warm | $0.00011 | $0.00011 | 0 | 8/8 |
| cli-cold | $0.00010 | $0.00010 | 0 | 0/8 |

### Progress lines (Haiku)

| variant · metric (ms from request) | p50 | p90 | mean | n |
|---|---|---|---|---|
| api · total | 1257 | 1307 | 1218 | 5 |
| cli-warm · total | 1171 | 1483 | 1209 | 4 |
| cli-cold · total | 1935 | 2189 | 1929 | 5 |

| variant | cost/call p50 (API prices) | claude -p's own cost p50 | errors | warm agent used |
|---|---|---|---|---|
| api | $0.00009 | – | 0 | – |
| cli-warm | $0.00004 | $0.00004 | 1 | 4/4 |
| cli-cold | $0.00004 | $0.00004 | 0 | 0/5 |

### Opus

| variant · metric (ms from request) | p50 | p90 | mean | n |
|---|---|---|---|---|
| api · first token | 1491 | 1639 | 1499 | 4 |
| api · SPOKEN line ready | 2568 | 2906 | 2511 | 4 |
| api · total | 7244 | 7770 | 7319 | 4 |
| cli-warm · first token | 696 | 787 | 713 | 4 |
| cli-warm · SPOKEN line ready | 1666 | 1815 | 1703 | 4 |
| cli-warm · total | 6359 | 6623 | 6405 | 4 |
| cli-cold · first token | 1250 | 1359 | 1260 | 4 |
| cli-cold · SPOKEN line ready | 2357 | 2401 | 2328 | 4 |
| cli-cold · total | 6905 | 7247 | 6924 | 4 |

| variant | cost/call p50 (API prices) | claude -p's own cost p50 | errors | warm agent used |
|---|---|---|---|---|
| api | $0.0170 | – | 0 | – |
| cli-warm | $0.0161 | $0.0161 | 0 | 4/4 |
| cli-cold | $0.0160 | $0.0160 | 0 | 0/4 |

### End-to-end B turns (pipeline, real audio over /ws, forced router, no fillers)

| variant · metric (ms from key release) | p50 | p90 | mean | n |
|---|---|---|---|---|
| api · TTFA (ack heard) | 1485 | 2121 | 1693 | 4 |
| api · router first token | 1140 | 1773 | 1339 | 4 |
| api · Opus first token | 4115 | 5222 | 4301 | 4 |
| api · Opus spoken line | 5023 | 6308 | 5261 | 4 |
| api · TTA (answer heard) | 5139 | 6418 | 5390 | 4 |
| cli-warm · TTFA (ack heard) | 1456 | 2300 | 1667 | 4 |
| cli-warm · router first token | 1249 | 2117 | 1441 | 4 |
| cli-warm · Opus first token | 2558 | 3289 | 2749 | 4 |
| cli-warm · Opus spoken line | 3558 | 4285 | 3723 | 4 |
| cli-warm · TTA (answer heard) | 3702 | 4398 | 3854 | 4 |

Errors: 0. Played times are approximate (headless client reports the first byte as played).

Raw runs: `docs/report-data/bench-claude-backends.json`.

## Findings

*(Hand-written from the run above; kept when the tables are regenerated. Small samples: 4–8 calls per cell, one machine, one evening — treat differences under ~200 ms as noise.)*

**Opus is clearly faster through `claude -p`.** Pre-spawned agents: first token 0.70 s vs 1.49 s over OpenRouter (p50), SPOKEN line ready 1.67 s vs 2.57 s, full answer 6.36 s vs 7.24 s. Even a cold `claude -p` beats the API on Opus's first token (1.25 s). Same prompt, same model and effort; the gap is in the request path (OpenRouter → Anthropic vs Claude Code → Anthropic directly).

**The Haiku router is a bit slower through `claude -p`.** First token 1.02 s vs 0.73 s, decision 1.12 s vs 0.98 s, total 1.82 s vs 1.50 s. Not thinking (0 thinking tokens on every CLI call) and a similar output length: again the request path, but in the other direction for Haiku. The CLI can't force a tool call, so the route JSON comes as text; the streaming parser treats it the same.

**Progress lines: about equal** (1.17 s vs 1.26 s). One CLI call in 10 (5 in the benchmark, 5 more afterwards) returned no usable lines.

**Pre-spawned agents matter.** Compared with spawning `claude -p` per call, a waiting agent saves ~0.45 s on the router's first token, ~0.55 s on Opus's and ~0.75 s on the progress lines. After the message arrives, the CLI itself adds only 20–35 ms; the rest is the API.

**End to end (B, real audio): the answer arrives ~1.4 s sooner.** Time to first audio is the same (1.46 s vs 1.49 s p50 — the router difference is absorbed by STT and TTS), but time to the answer drops from 5.14 s to 3.70 s because of Opus.

**Cost per call at API prices is about the same** (Opus $0.016 vs $0.017; Haiku fractions of a cent). Through `claude -p` it's billed to the Claude Code login (subscription), not OpenRouter; the CLI's own cost estimate matches ours.

**Recommendation.** Keep `claude -p` agents as the default for Opus. For the router, the API path is ~0.3 s faster to first token, but that doesn't show up in time to first audio in these runs; a per-role backend (router over the API, Opus via `claude -p`) would take the best of both if it starts to matter.
