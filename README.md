# Local Anaesthetic Maximum Dose

Chairside maximum safe dose calculator for dental local anaesthetics, for UK
clinicians. Part of the oral surgery tool set alongside the Third Molar Assessment
Tool and the Sedation Pre-Assessment form.

Handles more than one agent in a single appointment: doses are combined as shares of
each agent's own maximum, and adrenaline totals against a single ceiling.

## Layout

Everything at the repository root is deployed as-is. There is no build step.

```
index.html               the whole application — markup, styles, calculation
sw.js                    offline support
manifest.webmanifest     PWA manifest
icon-*.png               icon set
favicon-32.png
apple-touch-icon.png
tests/regression.js      80 checks, run before every deploy
tools/make-icons.py      regenerates the icon set
```

## Deploy

The eight root files are the deployment. Nothing is compiled and nothing is
minified — `index.html` is edited directly.

The tools share one origin, so this must be served at `/local-anaesthetic/` for the
switcher links to resolve. If it is deployed as its own project on its own domain,
change the `.ostb` hrefs in `index.html` to absolute URLs.

## Before deploying

```
node tests/regression.js
```

80 checks covering the agent registry, weight guards, the additive mix, the
adrenaline ceiling, headroom, and the rule that a maximum is never rounded upwards.
Check 1 is the one that catches the common mistake: `APP_VERSION` in `index.html`
and `CACHE` in `sw.js` must agree.

## Bumping the version

Two strings, both hand-edited, and they must match:

```
index.html    var APP_VERSION = "0.2.0";
sw.js         var CACHE = "la-v0-2-0";
```

Dots become hyphens, prefixed `la-v`. If the cache name does not change, anyone who
installed the previous version keeps being served it. The regression suite fails if
the two drift apart.

## Not yet signed off

The dose figures in the `AGENTS` block have not been clinically approved. They
follow standard UK dental school teaching rather than manufacturers' SPCs. See
`HANDOFF.md` for what still needs a decision.
