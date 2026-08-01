# Local Anaesthetic Maximum Dose — handoff

Current version: **0.11.0**

Upload this file and `index.html` at the start of a new chat. Together they are the
whole project — there is no separate source file, because the shipped page is the
source.

---

## What it does

Calculates the maximum safe dose of dental local anaesthetic for a given patient,
across more than one agent used in the same appointment.

The core model is **additive toxicity**. Each agent contributes its dose as a
fraction of its own solo maximum, and the fractions are summed. Half the lidocaine
allowance plus half the articaine allowance is a full dose, not two half doses.
Adrenaline is separate and simpler: micrograms total across every cartridge, against
one ceiling.

Whichever of the two runs closer to its limit governs, and the interface says which.

---

## Deliberate divergences from the third molar tool

These are decisions, not oversights. Changing them back is a real decision, not a
tidy-up.

**No build step, no React.** The third molar tool compiles `bundle_entry.jsx`
through esbuild into `index.html`. This one is a single hand-written file with
vanilla JavaScript. There is no `build.js`, no bundle, no `html_head.txt`. A
calculator this size did not justify the pipeline, and the file stays readable.

The cost is that the two version strings are not rewritten automatically. Check 1 of
the regression suite exists to cover that gap.

**Styled like the sedation form, not the third molar tool.** CSS custom properties
in the head with class-based markup, using sedation's token values — `--ink #0F2F63`,
`--soft #3F5A8A`, `--amber #C43A32`. The third molar tool uses inline styles from JS
constants and slightly different values. Sedation was the more careful
implementation, and the tool switcher was already drawn from its palette.

**No step rail.** An assessment has an order; a calculation does not. One screen,
live results.

**Nothing is persisted.** No `localStorage`, no history, no saved calculations.
Weight is patient data and a dose calculation is not a record in the way an
assessment is. This also means no key namespace to collide with
`third-molar-assessment-*` on the shared origin.

---

## Clinical decisions

**Dose basis: cited sources where they exist, standard UK dental school teaching
where they do not.** Manufacturers' SPCs were considered as the primary basis and
rejected. Do not reopen that without reading why:

- The Lignospan Special SPC gives no adult mg/kg figure at all — it says not to
  exceed three cartridges, a flat 132 mg regardless of weight. A weight-based
  calculator has nothing to calculate.
- That is 132 mg against the BNF's 500 mg for the same product.
- Its paediatric figure of 5 mg/kg means a 30 kg child could have more than the
  adult ceiling. Implemented literally, the tool would say so.
- The SPCs are not one basis anyway: articaine's is weight-based, lidocaine's is a
  cartridge count, and they disagree with each other.

**Cartridge volume is 2.2 ml.** The 1.8 ml figure in American sources is the single
most likely cause of a wrong answer here. It is named once as `CARTRIDGE_ML` and
never inlined.

**Maxima are always floored, never rounded up.** `floorTo` exists for this and the
suite checks it.

**Verification is per-agent and split adult/child.** Each agent carries `source`,
`verified` and `childVerified`. Anything not verified renders a visible warning
naming it. Do not flip a flag without opening the source and reading the number.
Currently signed off: lidocaine (ref 1), articaine (ref 2), adults only.

**Where the tool sits below a figure it cites, it says so.** Prilocaine and
mepivacaine are deliberately more conservative than reference 2. That is defensible;
silently differing from a source you cite is not.

**Adrenaline has two independent limits.** A microgram ceiling, and an SPS cartridge
count for drug interactions. SPS express theirs as a cartridge count that applies at
any adrenaline concentration, and it is reproduced that way rather than converted to
micrograms. Only adrenaline-containing cartridges count towards it.

**Two presentations of one molecule share one allowance.** Both articaine products
carry the same `mgPerKg` and `capMg`, so their fractions add against the same
denominator. This falls out of the additive model rather than needing a special case.

**The prilocaine methaemoglobinaemia constant was removed.** A 600 mg ceiling could
never fire behind a 400 mg cap — it was dead code presenting as a safeguard. If 600
is the figure that matters, the 400 cap is what needs revisiting.

---

## Still outstanding

**No named clinician has signed the table off.** Two of four drugs now have cited
sources, but a citation is not sign-off. Record who reviewed it and when.

- Prilocaine and mepivacaine adult maxima have no cited source.
- No paediatric figure has one. Reference 2 does not cover paediatric dosing and the
  articaine SPC establishes no safety above 7 mg/kg in children.
- The 200 µg adrenaline ceiling is itself uncited and is doing real work: it governs
  a healthy 70 kg adult on lidocaine at 7.3 cartridges, before the anaesthetic limit
  of 11.1 is reached.

**The switcher is pasted into built pages, not source.** All three tools have it, but
the third molar copy lives in its generated `index.html`. Running `node build.js`
there regenerates the file and the bar disappears until the block is added to its
`html_head.txt`.

**The third molar cache-deletion bug is fixed.** Its `activate` handler used to
remove every cache on the origin, wiping `sedation-*` and `la-*` on each deploy.
All three workers now scope deletion to their own prefix. Keep it that way.

---

## Gotchas

**Agents key off `id`, never the label.** Wording can be edited freely. Changing an
id is the breaking operation. This is the same lesson the third molar tool learned at
1.4.8, and a dose table is a worse place to relearn it than a score.

**`APP_VERSION` and `CACHE` are two hand-edited strings.** They must agree. See the
README.

**The calculation is pure and DOM-free on purpose.** `anaestheticLimit`, `mixLoad`
and `headroom` take arguments and return values, so the suite can test the
arithmetic without driving the page. Keep it that way.

**Service worker scope.** The third molar worker sits at the origin root, so its
scope covers `/local-anaesthetic/` until this app registers its own. That
registration is guarded to `http:`/`https:` so opening the file from disk previews
cleanly without console noise.
