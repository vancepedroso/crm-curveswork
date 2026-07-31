# Roof Pitch: Single Source of Truth (`pitchDegrees`) — Architecture Review

**Status: research/recommendation only — no code changes made. This document is the reviewed plan for
a future refactor pass on `src/App.jsx`.**

## Context

Pitch currently drives three things (surface area, sheet length, and — indirectly — cutting-list
direction), but the codebase computes `1/cos(angle)` from a **string** (`sec.pitch`, e.g. `"5:12"` or
`"22.62°"`) independently in three separate places, using two different parsers. The goal is a single
canonical numeric `pitchDegrees`, with ratio/degrees as pure UI presentation over that one value, and
`surfaceArea = planArea / cos(pitchDegrees)` as the one authoritative formula everywhere. This review
answers the original questions and inventories every location that needs to change.

## Answering the direct questions

**What do RoofSnap/RoofSwift/PlanSwift/EagleView/Hover typically ask for?**
The US-trade convention is rise-over-12 (`X:12`) as the primary input — that's the number roofers think
in. Tools that derive pitch from 3D/stereo aerial imagery (EagleView, Hover) compute it as an angle
internally (that's what the geometry naturally produces) and *display* it as `X:12` for the trade. AU/NZ
tools skew toward degrees since that's the metric-market default (this app's own code comments already
say "AU/NZ-practical" and default to Ratio mode). **Net: supporting both, with degrees as the internal
canonical value, is exactly the professional pattern** — not a deviation from it.

**Is degrees-internal the cleanest architecture while still letting users type either?** Yes, and this
codebase is already halfway there — see below.

**Can `surfaceArea = planArea / cos(pitchDegrees)` become the one authoritative formula everywhere?**
Yes. It already *is* used correctly in the sense that every current call site is mathematically
equivalent to it — the problem isn't wrong math, it's that the same math is independently re-derived
from a string in three places instead of from one shared numeric field, and one of those places has no
validation.

**Does pitch change sheet count?** No — confirmed already correct in the current code and should stay
exactly as-is: `sectionStripeInfo` (App.jsx:656) computes sheet count purely from
`(dirMax-dirMin)/sheetWidthPx` — a plan-space span divided by cover width — and never multiplies by the
pitch factor. The pitch factor (`fac`) is applied **only** to sheet *length* (`s.lengthPx*sfY*fac`,
App.jsx:1041) and to `surface_m2` (App.jsx:1062). This part of the engine already matches the
stated understanding of real-world roofing and needs no behavioral change — only the *source* of `fac`
changes in the refactor below.

## What's actually already there (don't rebuild this)

The Roof Pitch modal (App.jsx:2387-2484) **already treats degrees as the canonical live-editing value**:
- `pending.angleDeg` is explicitly commented as "the one true numeric source of truth" while the dialog
  is open.
- Ratio→degrees: `Math.atan(rise/12)*180/Math.PI` — exactly the requested formula.
- Degrees→ratio (for display): `12*Math.tan(deg*Math.PI/180)`.
- Multiplier preview: `1/Math.cos(Math.min(angleDeg,89)*Math.PI/180)` — exactly the requested formula.
- Switching modes always reformats fresh from `angleDeg`, never chains conversions from already-rounded
  displayed text (this was a deliberate earlier fix, per its own comment — avoids drift on repeated
  mode-switching).

**The gap is only what happens on *confirm*:** `confirmPitch()` (App.jsx:2453-2458) throws away
`angleDeg` and re-encodes it into a formatted string (`"${rawInput}:12"` or `"${rawInput}°"`) as the
persisted `sec.pitch`. Every downstream consumer then has to re-parse that string back into a multiplier
or angle. That reparse step, done three separate times with two different regexes, is the actual
source of the drift risk.

## Every location that computes a pitch multiplier / re-derives an angle from `sec.pitch`

1. **`parsePitch(str)`** — App.jsx:522-538. String → multiplier (`1/cos`). Called from the `geometry`
   useMemo (App.jsx:981) and again independently from EstimateEngine (App.jsx:3010). Two call sites,
   same function — not itself duplicated, but note it silently returns a fallback `1.15` for any
   unparseable string (App.jsx:538) rather than erroring — worth keeping in mind for the refactor's
   error-handling story.
2. **`deriveSectionPitchInput(str)`** — App.jsx:546-564. String → `{mode, angleDeg}`. Used to seed the
   modal (App.jsx:2409) and by `sectionAngleDeg` (below). A second, independent parser of the same
   string format `parsePitch` also parses — different regex, different code path, same source string.
3. **`sectionAngleDeg(pitchStr)`** — App.jsx:614-617. Wraps `deriveSectionPitchInput`, but **only returns
   an angle when the stored string happens to be in degrees mode** (`d?.mode==="degrees" ? d.angleDeg :
   null`) — a ratio-entered pitch returns `null` here. This feeds `trueAngleDeg` in the `geometry`
   useMemo (App.jsx:988), which decides the cutting-list stripe/cut direction when no manual
   `cutAngleDeg` override is set. **This is a real, currently-shipping inconsistency**: two sections with
   the identical real-world pitch (say 22.62° vs "5:12", the same angle) get *different* auto-detected
   cut directions today, purely because of which UI mode was used to enter an equivalent number. A single
   canonical `pitchDegrees` eliminates this by construction — there's no longer a "which mode was it
   entered in" question to ask.
4. **Roof Pitch modal's own multiplier preview** — App.jsx:2447. Computes `1/Math.cos(...)` directly
   (not via `parsePitch`) from the modal's live `angleDeg`, for the live surface-area preview shown
   before Save.
5. **EstimateEngine's free-text pitch field** — App.jsx:3006-3023. A raw `<input>` in the Estimate step
   (placeholder `"4:12 or 30°"`) that accepts **any string** and calls `parsePitch` directly, completely
   bypassing the modal's validation (no 85° ceiling, no ratio-range check, no "90° is a wall not a roof"
   error). Typing garbage here silently falls back to the `1.15` default via `parsePitch`'s catch-all,
   with no error shown to the user. This is the least-guarded of the three surface-area call sites and
   the one most likely to produce a wrong, unexplained number.
6. **Sync-back merge** — `handleEstimateChange` (App.jsx:3581-3596) — copies `pitch`/`pitchFactor`/
   `surface_m2` from the EstimateEngine's local copy of `sections` back into `geometryFull.sections` so a
   pitch edited in the Estimate step isn't lost when returning to the Measure step. This merge is correct
   as designed, but it's propagating a **derived, already-rounded** `pitchFactor`/`surface_m2` pair
   rather than the one canonical angle — another symptom of not having a single numeric source of truth
   to sync instead.

No backend involvement: `backend/routes/estimates.js` only stores whatever `pitch`/`area` values the
frontend already computed (App.jsx sends the final numbers; Postgres never recomputes `cos`). This is a
frontend-only refactor.

## Recommended target design

1. **Add `pitchDegrees: number | null` as the canonical field** on each section object (alongside, or
   eventually replacing, `sec.pitch`). `null` = "Unknown Pitch" (already an explicit state today, keep
   it).
2. **One shared utility, used everywhere a multiplier or surface area is needed:**
   ```js
   function pitchMultiplier(pitchDegrees) {
     if (pitchDegrees == null) return null
     return 1 / Math.cos(Math.min(Math.max(pitchDegrees, 0), 89) * Math.PI / 180)
   }
   function surfaceAreaFromPlan(planAreaM2, pitchDegrees) {
     const m = pitchMultiplier(pitchDegrees)
     return m == null ? null : planAreaM2 * m
   }
   ```
   Replace `parsePitch()`'s multiplier math, the modal's inline `1/Math.cos(...)` (App.jsx:2447), and
   EstimateEngine's `parsePitch(pitch)` call (App.jsx:3010) with calls to these two functions.
3. **Ratio ⇄ degrees become pure display-layer conversions, never stored:**
   ```js
   const degToRatioRise = deg => 12 * Math.tan(deg * Math.PI / 180)   // for showing "X:12"
   const ratioRiseToDeg = rise => Math.atan(rise / 12) * 180 / Math.PI // for parsing "X:12" entry
   ```
   These already exist inline in the modal (App.jsx:2398, 2431, 2452) — just hoist them to module-level
   shared functions so EstimateEngine's pitch editor can reuse the exact same conversions instead of
   going through the string-based `parsePitch`.
4. **`sectionAngleDeg`'s mode-dependent gap disappears by construction** — once `pitchDegrees` is a
   plain number regardless of which UI mode entered it, the cutting-list direction logic
   (App.jsx:988) can use `sec.cutAngleDeg ?? sec.pitchDegrees` directly, with no `mode==="degrees"` check
   needed at all. Ratio-entered and degrees-entered pitches become genuinely equivalent everywhere.
5. **EstimateEngine's free-text pitch input gets real validation for the first time** — either reuse the
   modal's `MAX_PITCH_DEG`/`MAX_RATIO_RISE` bounds, or (cleaner) replace that raw text input with the
   same Ratio/Degrees toggle component the modal already uses, extracted as a small shared component so
   there's exactly one pitch-entry UI implementation instead of two.
6. **Sheet-count logic is untouched** — reconfirm after the refactor that
   `sectionStripeInfo`'s count math still never references `pitchDegrees`/`pitchMultiplier` at all; that
   invariant is what keeps sheet count pitch-independent and should be called out in a code comment once
   the refactor lands, so it doesn't get "fixed" into something wrong later by someone assuming pitch
   *should* affect count.
7. **Stored-data compatibility:** existing saved sections have `pitch` as a string
   (`project_geometries` JSONB, `estimates` JSONB `sections`). Two options to decide before implementing:
   - **(a) Keep `sec.pitch` string for storage/display convenience, derive `pitchDegrees` from it once at
     load time** via the existing `deriveSectionPitchInput`, and treat `pitchDegrees` as a
     computed/cached in-memory value for the session. Lower migration risk, no backend/schema change,
     but still has "the string is technically the source of truth at rest" — acceptable since the
     in-memory session is where all the drift risk actually lived (repeated recompute during editing),
     not the one-time load.
   - **(b) Fully switch persisted storage to numeric `pitchDegrees`** (drop the string format), writing a
     one-time migration that runs `deriveSectionPitchInput` over existing rows. Cleaner long-term, but
     touches the `project_geometries`/`estimates` JSONB shape and needs a backend-side or one-off script
     migration plus back-compat reads for any already-saved projects.

   **Recommendation: start with (a).** It gets the single-source-of-truth *behavior* (one formula, one
   pair of conversion helpers, no more mode-dependent stripe-direction bug, validated EstimateEngine
   input) without a data migration, and can move to (b) later as a separate, lower-risk cleanup once (a)
   has been running in production for a while.

## Files to touch (when this moves to implementation)

- `src/App.jsx` — all changes are in this one file:
  - New module-level `pitchMultiplier`, `surfaceAreaFromPlan`, `degToRatioRise`, `ratioRiseToDeg`
    (near existing `parsePitch`/`deriveSectionPitchInput`, App.jsx:522-564).
  - `geometry` useMemo (App.jsx:975-1075) — swap `parsePitch(sec.pitch)` for
    `pitchMultiplier(sec.pitchDegrees)`, swap `sectionAngleDeg(sec.pitch)` for `sec.pitchDegrees`.
  - Roof Pitch modal (App.jsx:2387-2484) — `confirmPitch` writes `pitchDegrees` (and, if keeping option
    (a), the display string) instead of only the string.
  - EstimateEngine's pitch editor (App.jsx:3006-3023) — swap free text for the shared Ratio/Degrees
    component (new small component, factored out of the modal's existing JSX) and route through
    `pitchMultiplier`/`surfaceAreaFromPlan`.
  - `handleEstimateChange` sync-back (App.jsx:3581-3596) — sync `pitchDegrees` alongside/instead of
    `pitchFactor`.
  - `initialSectionsFrom` (App.jsx:752-762) — derive `pitchDegrees` once via `deriveSectionPitchInput`
    when restoring a saved project.

## Verification (once implemented)

1. Trace a rectangular section, set pitch via Ratio mode (e.g. `5:12`) — confirm surface area, sheet
   length, and sheet count match the same section traced identically but with pitch set via Degrees mode
   (`22.62°`, the equivalent angle) — they must now be pixel-for-pixel identical outputs (this is the
   specific bug this refactor fixes; today they can differ in cut direction).
2. Confirm sheet **count** is unchanged by pitch in both modes (re-derive the same section at 0°, 30°,
   60° pitch — count must stay identical, only length/area change) — regression check against the
   already-correct existing behavior.
3. Edit pitch from the Estimate step's field with an out-of-range value (e.g. `95°` or a garbage string)
   — confirm it's now rejected with an error instead of silently falling back to the `1.15` default.
4. Round-trip: set pitch, save project, reload — confirm `pitchDegrees` restores to the same value (no
   drift from the string-parse-once-at-load step).
5. `npx vite build` — compiles clean, no regressions elsewhere touching `sec.pitch`.
