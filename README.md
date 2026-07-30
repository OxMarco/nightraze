# nightraze.io — Game Design Document

**Genre:** Free-for-all arena .io game (stealth / light-theft)
**Platform:** Browser-first (CrazyGames, Poki and similar portals), mobile and desktop, mobile playable
**Session length:** 3-8 minutes

Built ahead of the original plan: the arena runs on an authoritative server with real multiplayer, bots filling the population when humans are thin (§13). Perception is graded on the wire, not merely gated — the anti-cheat spine of a hidden-information game (§6). Leader-side answers shipping ahead of the §15 Q10 verdict: the crown (§11) and peak-as-run-score (§4). A leader-only offensive verb is held until that question has evidence.

---

## 1. Concept

nightraze.io is a free-for-all arena played in near-total darkness, where every player is a lantern. Light is the game's only resource: it is simultaneously your score, your health, your brightness, your vision range, and your heat. Collecting light makes you stronger and easier to find; hiding makes you safe and blind. Combat does not delete light — an open lantern burns whatever it touches, knocking light loose into the arena, where anyone can fight over it.

The complete rules in four sentences, which is also the tutorial:

> Collect motes to grow your light — it is your score, your health, and your glow.
> More light lets you see farther, but makes you easier to find.
> Shutter your lantern to disappear, though moving still makes faint ripples.
> A lit lantern spills light from whatever it touches — drain a lantern completely to snuff it out.

### Elevator pitch

Agar taught the world "eat smaller, flee bigger." nightraze asks a different question every second: *am I willing to be seen right now?*

---

## 2. Design pillars

**One resource explains everything.** There is a single number — held light — and every system reads from it: size, speed, vision, glow, damage taken, and now heat given off in a collision. Nothing in the game requires a second stat, an HP bar, or an ammo counter. This is what makes the game teachable in ten seconds on a portal, and it is the deepest structural difference from agar-likes, where mass is only score and size.

**Combat is resolved by the movement verb.** Agar's real genius was never simplicity of systems — it shipped with split, eject, and viruses that most portal players never touch. Its genius was that a brand-new player learns the entire combat system by accident, from one collision, because combat and movement are the same verb. nightraze reproduces this faithfully: steering into another lantern while lit *is* the attack. The dash exists on top as optional depth — discovered, not required — exactly the role split played.

**Growth is a tradeoff, not unqualified progress.** The more light you hold, the less completely you can hide — and, under the contact law, the more you bleed in every collision. The leader is the most hunted object on the map and pays the largest toll per touch. This inverts the agar snowball, where the big blob only gets safer, and it is the game's built-in rubber band — no artificial catch-up mechanics needed.

**Information over execution.** The skill ceiling lives in reading and manipulating what others can see — douse timing, juke prediction, ambush positioning, glow management, and now fighting *through* the collection scramble a burn creates — rather than in twitch execution like agar's popsplits. Information games survive the move to a single finger on a phone; execution games do not.

**Deaths must be legible.** Dark games attract one complaint above all others: "I died to something I never saw." Under the contact law this is structurally impossible: to hurt you at all, a lantern must be open and adjacent — the reveal *precedes* the damage. Stealth gets a hunter to you; it can never hurt you by itself. And the only lanterns that can be snuffed are guttering ones, which advertise their own fragility to everyone in range.

**Muted play is the default.** A large share of portal players play without sound. Every essential signal has a visual form — sparks, spills, gutter-flicker, shimmer; audio only reinforces.

---

## 3. The world

The arena is a bounded square (reference: 2600 × 2600 units) rendered as a dark void with a faint grid and a visible red boundary. Darkness is not a filter over the scene — it is the scene. The renderer draws the world, then lays a near-opaque darkness layer over it and cuts each light source's reach as a soft-edged circle of light. What a player perceives is exactly the union of their own lantern's reach and the glow that other entities emit.

The arena is deliberately featureless at launch: only players, motes, and the boundary. Occluder terrain (monoliths) is a held-back feature — see §14 To validate.

**Field motes** (reference: 260 concurrent, worth 1 light each) are small cyan twinkles scattered across the arena. Eating one immediately respawns a replacement elsewhere, so the field never depletes and standing still never generates progress — the anti-camping pressure is economic, not rule-based.

**Loose motes** are gold, carry variable value, and exist only as the product of combat. They scatter with physical velocity and decay to rest, forming contested piles. They do not respawn from nothing; they are wealth changing hands. And they have a lifecycle:

- **Merging.** Loose motes at rest within ~12 units combine into a single larger mote — for readability and for phone GPUs, since crescents near crowds would otherwise spray dozens of entities.
- **Settling.** A loose mote at rest for ~25 seconds flickers for 3 seconds, then settles: it becomes a single 1-value field mote in place, and any excess value returns to the global spawn budget to re-emerge elsewhere as cyan twinkles. Abandoned wealth dissolves back into the arena's ambient glitter — nothing leaks out of the economy, and nothing litters it.

---

## 4. The light resource

Held light `L` drives every derived stat. Reference formulas from the prototype, all tunable:

| Property | Formula (reference) | Effect of growth |
|---|---|---|
| Body radius | `9 + 1.9·√L` | Bigger target, longer reach, more contact surface |
| Speed | `2.7 − min(1.4, √L/9)`, ×1.15 while dark | Slower |
| Vision (lit) | `110 + 22·√L`, capped 560 | Sees much farther |
| Vision (dark) | flat 60 (lever) | Blind regardless of size |
| Glow (lit) | `60 + 24·√L`, capped 520 | Visible much farther |
| Glow (revealed) | `90 + 26·√L` | Brightest state |
| Irreducible glow (dark) | `max(0, (√L − 5) · G)`, G = 6 | Cannot fully hide |
| Spill per burn taken | `min(L, 4 + 16%·L)` | Richer targets bleed more |

Square-root scaling throughout keeps early growth dramatic and late growth logarithmic — the same instinct agar's mass curve follows, applied to visibility as well as size.

**The gutter state.** Below a threshold (reference: 6 light), the lantern *gutters*: the flame visibly sputters, the glow strobes, and the lantern is finishable — **any burn snuffs it outright**. A guttering lantern cannot dash (which also closes the self-extinguish edge case where dash costs could burn a lantern down to nothing). It can still shutter, hide, and eat its way back above the threshold. The gutter is what makes fights *end*: it raises the death rate to portal pacing, telegraphs finishability legibly to everyone in range, and gives the Vulture role a real target to circle. Without it, the spill recursion (`L → 0.84L − 4`) would make extinguishing a fresh spawn take several clean burns and a mid-size player most of ten — deaths would be nearly extinct, and portal sessions would end in tab-closes instead of "one more run."

Players spawn with a starter ember (reference: 12 light — comfortably above the gutter). Bots spawn between 8 and 45 to keep the arena's ecology varied from the first second. **Spawn protection:** for 2 seconds after spawning, a lantern neither burns nor can be burned; protection breaks early if the player dashes.

### What a run is scored on

A run is scored on **peak light — the brightest it ever got — not on what was left when it ended.** The number the death screen celebrates is the high-water mark, and the best of those persists between runs as a personal record, held locally in the browser (there are no accounts). Death takes your position in the arena; it was never meant to take the fact that you reached it.

This is deliberately *not* a bank, and the difference is the whole point. Peak is a record of something that happened, and it has exactly one way to rise: be lit, be fat, and be findable. It cannot be protected by hiding, it removes nothing from the arena, and holding it costs no one else anything.

**The live leaderboard still ranks current light, deliberately.** That board is a hunt list — it exists to tell the arena who is worth chasing *right now*, and ranking it by peak would fill it with players who are no longer carrying anything. Peak is the private record of a run; current light is the public target painted on a back.

**Rejected: banking held light** (a vault that carries score across a death). Recorded here so it is not re-proposed, because it is a reasonable-sounding fix for a real feeling:

- It makes "grow, stash, douse, sit safe" the optimal line — it *rewards* the dump-and-hide behaviour it is meant to cure.
- It leaks the economy. §3 conserves light: spilled wealth merges, settles, and returns to the field. Banked light stops being contestable, and contestable light is what the Vulture, the Baiter, and every minnow live on.
- The design already answers "death erases everything," and answers it better: losing a fight here spills you onto the table, where you can fight for your own light back (§12). That recovery is a skill expression. A vault is an accounting entry.

---

## 5. Lantern states

The lantern is a **toggle**, not a hold — a stance change made a few times per minute, deliberately.

**Lit** is the productive stance: full vision, full glow, and an open flame — your touch burns. You can see the food you need; everything that outsizes you can see you.

**Dark** is the survival stance. Vision collapses to a small fixed radius. Your glow drops to the irreducible minimum (§6). You move 15% faster, produce no light — and your shuttered lantern **burns nothing and protects against nothing** (§7). You are hidden, harmless, and vulnerable.

### Deprived, not disconnected

Going dark must feel like sensory loss, not like the game turning itself off. The dark state keeps faint, strictly *non-actionable* information:

- **Contracting iris.** Vision shrinks to 60 over ~0.45 seconds rather than snapping — which also mirrors the 0.4-second afterimage, so both players' information decays on the same clock during a juke.
- **Boundary sense.** The red arena wall renders through darkness within ~300 units. It is a wall, not information about anyone.
- **Distant light still arrives.** Perception is a union (§6): a dark player still sees every lit player whose glow reaches them, and every burn or dash flash that pierces the darkness. Battles read as distant flares on the horizon under the existing rules — no extra mechanic required.

What darkness *never* shows: motes. If dark players could farm from memory or feel, "lit is the productive stance" — the tension the entire toggle rests on — would quietly break. A dark player who physically blunders into a mote does collect it (rare, and pleasantly skill-flavored), but *finding* food requires light. Darkness deprives you of exactly one thing above all: income.

The moment of dousing is a designed beat: a sharp lantern-closing effect, a one-time outward ripple, and a fading afterimage lasting ~0.4 seconds where the light went out. The afterimage tells the pursuer this was a deliberate move, not a disconnect — and marks the exact point from which the guessing game begins.

### The douse juke — the signature moment

A bright player being chased toggles dark at speed. The pursuer arrives at a fading afterimage — with information that goes stale over the 0.4 seconds it burns — and four possibilities: the target reversed, stopped dead, cut sideways, or kept running straight expecting the hunter to overthink it. No system resolves this — only prediction. This interaction is the trailer, the clip generator, and the reason the game exists.

*Known risk of the featureless arena:* with no terrain to break line of sight, the pursuer can sweep an expanding radius for shimmer, and the four-way guess may collapse into a search pattern. Whether the juke holds up on afterimage timing and shimmer thresholds alone is a launch-blocking playtest question (§15); occluder terrain is the held-back answer if it does not (§14).

---

## 6. Visibility and stealth

### Irreducible glow

While dark, an entity still emits `max(0, (√L − 5) · G)` glow. At the reference curve, anyone below 25 light conceals completely; a 100-light player remains a dim 30-unit presence; a 400-light leader is a 90-unit smudge of light that cannot be extinguished. **This is the single most important differentiator in the design** — it is the mechanism that converts growth into a tradeoff and makes the leaderboard a hunt list. The curve's steepness (lever G) directly sets how miserable or comfortable being the leader feels.

### Movement shimmer

Sound made visible. A dark entity in motion emits faint expanding distortion rings — frequency and intensity scale with speed. The rings distort rather than glow, and critically they are *not* a trail: they mark where something was, at a rhythm, without drawing the line a hunter could simply follow.

*Hardware watch item:* pure distortion may be literally imperceptible on a 6-inch screen in daylight. If real-device testing confirms it, shimmer gains a faint luminance floor — just enough to survive small screens without becoming a glow.

This produces three stealth states with zero UI:

| Behaviour | Detectability |
|---|---|
| Stationary (below glow threshold) | Effectively invisible |
| Moving carefully | Faint, intermittent distortion |
| Moving quickly | Trackable with attention |

Stationary invisibility permits ambush camping. This is accepted because standing still earns nothing (§3): a camper's light is frozen while everyone else's compounds, so patience is paid for in rank.

*Watch item (new in v6):* that economic pressure now carries this argument **alone**. Vent-light used to carry the other half — a baiter had to spend real light to lay the pile that made camping worth doing — and it is cut (§8). If dark camping starts out-earning active play, this is the first place to look, and re-instating vent is the recorded answer (§14).

### Perception rules (applies symmetrically to players and bots)

Entity A perceives entity B if any of: B is within A's vision radius; A is within B's glow radius (light travels — a bright player is seen by people who cannot see anything else); or B is dark, moving, and close enough for its shimmer to register (reference: `65 + 20·speed`). **Bots run the identical perception tests.** A bot that tracks what it could not have perceived is detected by players instantly, and hated; symmetric perception is a correctness requirement, not a nicety.

A detail worth naming because it quietly makes the douse juke work: the shimmer-detection radius exceeds dark vision, so a doused player who keeps sprinting stays trackable at close range. The real decision after a douse is *run and be followed* versus *stop and vanish* — a genuine mind-game, not a free escape button.

### Perception is graded, and so is the wire

The three rules above do not grant equal knowledge, so they do not produce equal payloads. A modified client renders everything it receives, which means gating *whether* an entity is sent is only half the job — a contact this design means to be ambiguous has to **arrive** ambiguous, or the shimmer that is explicitly "not a trail a hunter could simply follow" becomes exactly that at 25 samples a second, with a name and a light value attached.

| Tier | What crosses the wire |
|---|---|
| **Seen** — in vision, or a burning/revealed lantern whose glow reaches you | Full state: position, light, name, gait |
| **Smudge** — a dark lantern's irreducible glow reaches you | Position and a light value rounded to the step its own radius already betrays. No name, no gait — a smudge has no identity |
| **Shimmer** — a dark mover's wake registers | A wake ring only: origin snapped to a 32-unit grid, emitted at the cadence, intensity in one of the three steps above. No id, no name, no light, no speed |

Two consequences worth holding onto. **The ring cadence is server-side**; a client-side throttle is one edit away from a continuous track. And **the fuzz is deterministic** — a fixed world grid, never per-tick jitter, because fresh noise on every snapshot is averaged away in a few hundred milliseconds, and a per-viewer offset is something two colluding accounts can intersect. A fixed grid tells everyone the same lie forever.

Bots run the degraded view too: a wake tells a bot that something is moving, never how big it is, so a shimmer contact is neither threat nor prey to them. Shuttering your flame drops you off their hunt list *and* their fear list.

---

## 7. Combat — the open flame

There are no projectiles, no hitscan, no attack button in the required loop, and no contact consumption. Combat is one law, learned by accident in the first collision:

### The contact law

**A lit lantern burns what it touches.** When an open lantern contacts another player, the touched player spills `min(L, 4 + 16%·L)` of their light, scattering as a broad crescent (±~100°) of loose motes away from the point of contact, with outward velocity. **Nothing transfers to the toucher** — spilled light lands on the table, and anyone may take it.

- **Lit on lit is symmetric.** Both lanterns are open, so both burn: every collision sprays both players' light into the world. A spark burst marks the contact point, and both parties flash to revealed glow for ~0.5 seconds.
- **Dark burns nothing and protects against nothing.** A shuttered lantern touching anything is a bump and a ripple. A lit lantern touching a dark player burns them one-way — and the burn's reveal flash lights the victim up. Dark is stealth, never armor: a hunter can sweep an area and flush hiders by touch, and to hurt *anyone* you must be glowing first.
- **Per-pair immunity.** After a burn event, that pair cannot burn each other again for 0.5 seconds. Multiple attackers still bite a leader independently — the intended anti-snowball counterplay — but no pair can grind.
- **Extinguishing.** Burning a guttering lantern (below 6 light, §4) snuffs it: a burst effect, its remaining light in the final crescent, instant respawn with a starter ember.

### What the symmetry buys

Run the contact law through the light curves and the design's stated goals fall out as consequences rather than tuning targets:

- **Attacking up is automatically profitable.** An ember ramming a 400-light leader spills ~6 of its own and knocks ~68 loose — and, being smaller, is faster to the pile. Lead the ram with a dash and the ember spills nothing at all (dash asymmetry, below). The percentage does the work; no "attacking up is lucrative" rule needed.
- **Attacking down is automatically a donation.** The bigger party always spills more absolute light. Farming tiny players by contact actively bleeds you.
- **The leader is a bonfire.** Every bite taken from first place burns the biter back — an entry fee per touch that replaces the strike model's per-attacker-commitment logic. Mobs can still bring the leader down; each mobber pays to try.
- **Equal fights are scrambles over the pot.** Both parties bleed at the same rate, the crescents intermingle, and the winner is whoever collects better mid-fight — while vultures circle the flare-light. "Combat is theft" made literal: the fight *is* the pile.

### The dash — flare lunge (optional depth)

Tap (mobile) or click (desktop) dashes ~95 units over 0.18 seconds toward the aim point. Cost: `max(0.8, 2.5% of current light)`, spent whether or not it connects. Cooldown 0.9 seconds. **Dashing always throws the lantern open** — the flame is the thrust — with a full-brightness reveal for the flare linger (reference 1.0s), regardless of prior stance. It is never a free stealth escape.

The dash carries no special damage: it is the gap closer and the aim expression, resolving through the same contact law by carrying you *through* someone. Big-and-slow catches small-and-fast with it; the ambush gesture survives intact — creep in shuttered, tap the victim, the lantern bursts open mid-lunge, one finger, three touches. The zero-knowledge player fights by steering into people; the skilled player fights by dashing through them. Same law, both depths. Guttering lanterns cannot dash.

### Why the interlock is fair

To hurt anyone, you must be lit — the reveal now *precedes* the damage rather than accompanying it. Ambush capability remains inversely proportional to lethality: a tiny player can approach invisibly but announces itself the instant its flame opens, and can only chip; a leader can burn you fast but is a beacon. The thing that killed you was, by law, glowing and adjacent, and your lantern was visibly guttering first. And a shuttered escape is real but pure: while hidden you can neither hurt, earn, nor see.

### Design red line

**Spilled light must never transfer directly to the toucher.** The moment contact *pays* instead of *spills* — however small the fraction, however reasonable the playtest note ("combat should feel more rewarding") — the game rebuilds agar's snowball with extra steps, and every anti-snowball property above evaporates. The spray is the design. Reward, if fights need more of it, is tuned through the spill amount and crescent geometry, never through transfer.

### Watch item: boundary corners

The red boundary is the arena's only pin surface. A faster chaser can press a victim into a corner and bite at the immunity cap (~1.4 burns/second), and the gutter state makes corners genuinely lethal. Agar corners are also death, so this may be acceptable flavor — but it is the one place a drag-kill can partially return. Mitigations held in reserve: rounded corners, or a gentle boundary repulsion.

### Dash asymmetry (lever, now on)

Under mutual spill alone, fights read as too slow and too fiddly against agar's one-touch clarity — the v5 playtest note. The reserved dial is now enabled: **during the dash strike window (~0.3s after a dash), you do not spill your own light when touched.** Brushes stay mutual; deliberate dashes become one-way. One learnable asymmetry, discovered the first time you dash, restoring decisive offense without touching the base law. The spill formula was retuned in the same pass (3 + 10% → 4 + 16%, pair immunity 0.7s → 0.5s) so committed fights close in roughly half the time. If two strike windows overlap (a dash clash), neither party spills — a clean parry. **Ships on.**

---

## 8. Vent-light — cut in v6

Shipped as provisional, removed to hold the arena at three verbs: **eat, lunge, shutter**. The full design, its guardrails, and the evidence that brings it back are retained in §14.

It was written with its own kill switch — *"whether a second verb overloads the one-finger scheme — ship v1 without it if mobile testing says so; nothing else in the design depends on it"* — and what tripped it was not thumb ergonomics but comprehension. Players could not name what light *was*, which makes a verb that spends it unreachable: you cannot value a trade you haven't priced. Vent was also the only binding in the game that had to be *explained* rather than discovered — steering, contact, and the shutter all teach themselves by being done, while `V` and the double-tap taught nothing until someone told you they existed.

Two consequences the rest of this document now carries, both recorded where they bite: baiting no longer costs the baiter anything, so the anti-camping argument rests on the economy alone (§6), and a leader has no way to shed light voluntarily — the only route down is being drained (§15 Q10).

*Section number retained: §-references from the rest of this document and from the code still land here.*

---

## 9. Controls

The allocation principle: the *required* game is played entirely with the steering pointer; the frequent optional action is a gesture on the play field; the infrequent stance change is a button.

**Desktop.** Cursor position steers continuously (no click-to-move). Steering into another lantern while lit is the attack. Left click = flare lunge toward the cursor. Space or L = lantern toggle.

**Mobile — one finger.** Drag anywhere to steer — and steering into contact is combat, so the zero-knowledge player has the full game on the drag alone. Quick tap (< 200ms, < 12px movement) = flare lunge **toward the tap point** — the touch scheme gets aimed dashes for free. Tap the corner lantern button = toggle; the ~200ms steering interruption is acceptable because toggling is rare, and reads thematically as pausing to shutter the lantern.

**Mobile — two thumbs (opt-in, v6).** Offered on the start screen and never imposed; the one-finger scheme above stays the default, so the platform claim in the header stays true. One corner, not two: a stick in the bottom-left steers, with the two action buttons in a row directly above it, shutter then lunge. They share a diameter — a row of unequal circles reads as a mistake before it reads as a hierarchy — so the lunge is marked as the primary by weight instead: brighter rim, hotter glow, and the near-white of held light against the shutter's teal. The whole scheme is a single narrow column up the left edge, kept small on purpose; these are instruments laid over the arena, and the arena is the thing the player is straining to see. This is the watch item below, shipped: a stick moves the steering thumb off the water.

*Capability gates the scheme, not the stored preference.* The choice follows a browser profile across machines, so a mouse-only desktop can inherit "pads" from a phone; it must never be handed thumb controls it cannot use and was never offered. The preference only picks between schemes a device could actually run.

Both buttons carry a Feather glyph (MIT), inlined rather than pulled in as a dependency and drawn in `currentColor`, so the control owns hue and opacity together and every state is one change rather than a second set of art. `chevrons-up` for the lunge — a burst forward rather than a stance. For the shutter, `sun` while the lantern burns and `moon` once it is closed: Feather has no lantern or bulb in the set, and its on/off pair for light reads correctly on a control that opens and closes one. The swap makes the button a readout of the stance it is about to change.

Two buttons, not one button with a press-pattern, and the reason is the same one that appears twice in the rejected list below. The verbs have opposite timing profiles — the lunge is the fastest verb in the game and *is* the ambush strike, while the shutter is rare and already costs an iris — and any short/long or multi-press scheme makes a touch-down ambiguous until its timer expires. Something has to wait, and it must never be the lunge. Separating them in space costs nothing and, unlike a hidden gesture, neither binding has to be *explained* — the failure that cost vent-light its place (§8).

**Tap-to-lunge survives on the water** under the pads, still aimed at the tap point. The button can only fire along the current heading, so making it the only lunge would quietly trade away the aimed strike; keeping the field tap costs nothing, because once steering moves to the stick the water has no other job — and accidental lunges *fall*, since the field is no longer being dragged. The stick's full deflection is the server's throttle ceiling and its dead zone is real: standing still is a stealth state (§6), and a stick that crept would delete it.

**Ambush strike.** Tapping while dark relights and lunges in a single gesture. The full stealth loop — go dark, creep in, tap the victim, lantern bursts open mid-strike — is one finger, three touches. It survives both schemes: under the pads the tap is still the strike.

Rejected alternatives, for the record: hold-to-douse (rejected by design preference; also imposed release-latency in the unified-button variant), double-tap-to-lunge (adds latency to the fastest verb), flick-to-lunge (undiscoverable, misreads fast drag releases), auto-attack-while-lit-at-range (deletes ambush timing), **continuous uncapped contact drain** (rejected: contact duration is controlled by the *faster* party, so drain empowers fast-small over slow-big — the exact inversion of the intended curve — and makes losses illegible; see Appendix A). Known cost of tap-vs-drag: occasional accidental lunges; softened because misfires are at least aimed, and the cost is dominated by the reveal rather than the light spent.

*Watch item:* drag-anywhere steering puts the player's thumb over the darkness they are squinting into. Offset-touch steering or an optional virtual stick are the fallbacks if testing confirms it. **The stick shipped in v6** as the opt-in scheme above; it is an option rather than a replacement precisely so this stays a live question rather than an answered one. What testing still has to say is which scheme players *keep* — if the pads win by a wide margin, the default moves and the one-finger claim goes with it.

### First descent — the three verbs, taught once

The control scheme is discoverable; the *game* was not. Playtesters could steer immediately and still never find out that light is a resource, that contact is the attack, or that the lantern closes — so the arena read as a screensaver with a score. The onboarding is therefore three beats, one per verb, in the order they compound: **eat to grow → lunge to take → go dark**.

Rules it holds to, because a tutorial that breaks them costs more than the confusion it fixes:

- **It teaches by watching, never by gating.** Nothing pauses, nothing is blocked, no server round-trip is involved, and the card is pointer-transparent — a lunge aimed through it lands. The arena is live the whole time, including the part where something eats you mid-lesson.
- **A step retires when the player does the thing** (past the starter ember, a lunge sent, a shutter worked), so a prompt is on screen exactly as long as it is still unanswered. Sequential: an out-of-order action does not retire text that has not been read.
- **Once per browser, and it means it.** Completing or skipping it is remembered. A personal best only grandfathers a player out well clear of the starter ember (40) — a first run that ends in a quick snuff records a best too, and that player is precisely the one whose next run should explain itself.

The arena carries no other lettering. A standing control hint used to sit along the bottom edge of every run; it was cut in v6 because it charged every player, forever, for a lesson only the first run needs — and because a permanent instruction strip is an admission that the game cannot teach itself. Controls are stated once on the start screen, taught once by the coach, and after that the arena is only the arena.

Implementation: `client/src/game/tutorial.ts` (state) + `client/src/ui/tutorial.tsx`.

---

## 10. Balance levers

Five dials, exposed as a live tuning panel in the prototype, plus one reserve switch. Nearly every balance complaint the game will ever receive maps to one of them.

| # | Lever | Reference | Governs |
|---|---|---|---|
| 1 | Irreducible glow curve (G) — **live** | 6 | How well leaders can hide; the anti-snowball strength |
| 2 | Spill formula (flat + %) | 4 + 16% | Value of attacking up vs. down; fight pace; crescent size |
| 3 | Gutter threshold | 6 | Death rate; how telegraphed finishability is |
| 4 | Dark-state vision radius | 60 | Whether darkness feels tactical or merely frustrating |
| 5 | Dash cost / reveal linger | 2.5% / 1.0s | Spam control; how dangerous and informative aggression is |
| R | Dash asymmetry | **on** (0.3s strike window) | Decisive offense; fight pace vs. agar's one-touch clarity |

**Lever 1 is live-tunable.** `GLOW_G` sets it at boot, and with `TUNE_TOKEN` configured, `POST /tune {"g": 11}` moves it mid-session and pushes the new value to every connected client (the `Tuning` message), so the darkness they draw keeps matching the perception the server is running. The route does not exist unless a token is set — it is a playtest instrument, not a game feature. This exists because §15 Q2 is a question you answer by sweeping a dial across one sitting with the same testers, not by rebuilding between them.

Tuning intuitions: G too steep and holding first place is pure misery, too shallow and the game regresses toward agar. Gutter too high and mid-size players live in execute-anxiety; too low and deaths go extinct again. Linger too long and nobody dashes; too short and ambushes feel like hitscan. Dark vision too small and darkness is a punishment players avoid, defeating the entire premise — this lever protects the design's soul.

---

## 11. Emergent roles

No classes exist, but the systems produce them. The **Farmer** stays lit, mid-size, and fat on motes, banking on vision to spot threats early — and steers wide of contact, since every brush is a donation downward. The **Ghost** stays deliberately below the glow threshold, trading all progress for perfect stealth and dash-chips on the wounded and the guttering. The **Vulture** follows fights at the edge of other people's flare-light and eats the intermingled crescents — and circles guttering lanterns waiting for someone else's burn. The **Leader** cannot hide, cannot slow down, burns everything it touches and bleeds richly for every touch taken — a bonfire playing the whole arena as a chase scene, which is exactly the pressure that keeps first place earned minute by minute.

The bot ecology inverts agar's, visibly. Agar bots chase smaller and flee bigger; nightraze bots avoid touching smaller players (donation) and seek grazing contact with bigger ones (profit). A fresh spawn watching the arena sees minnows harassing whales — the inverted power curve playing out on screen before the player has read a single word.

### The crown — prestige that pays for itself

The Leader role is the design's most-hunted seat, and §15 Q10 asks the honest question about it: desirable prey, or declawed misery? The first answer is the cheapest one — make the seat *look* like something worth taking. A lantern above the crown threshold (reference: from 120 light, full at 400) wears a ring of rays that intensify continuously with held light.

Two properties make this safe to ship ahead of the Q10 verdict. It is keyed to **held light, never to leaderboard position** — one resource explains everything (§2), so a rank check has no place in the renderer either; the crown grows and fades with the number that already drives every other derived stat. And it is drawn **only while the lantern is open**, tight to the body, well inside the existing glow: it is regalia, not reach. It changes nothing about who can perceive you. Shutter, and you drop your crown along with your income — which is the tradeoff the whole design rests on, made visible.

The point is that in *this* game prestige is self-balancing. A crown is only prestige if others can see it, and being seen is the currency of danger. The fantasy funds its own counterplay.

---

## 12. Differentiation ledger vs. agar-likes

**Kept from the chassis:** free-for-all arena, scattered pickups, growth-by-collection, size-speed inverse, leaderboard, death releasing resources, instant respawn, one-pointer movement, **and combat resolved by collision**. This familiarity is an asset: portals give a game ten seconds to teach itself, and "you already know this, except—" is the proven io formula. An agar player who rams someone gets exactly the spark-and-scatter lesson their instincts asked for.

**Removed:** split (its skill expression migrates to dash timing/aim and douse jukes — execution depth traded for information depth, the correct trade for mobile), and spit-mass — vent-light was its thematically inverted heir, growth-tool to escape-tool, and was itself cut in v6 (§8). Neither of agar's two extra verbs survives: the depth here is bought with information, not with inputs.

**Replaced:** contact consumption → **contact spill**. The collision verb survives; its consequence changes from existence to progress. Losing a fight in agar deletes you; losing a fight in nightraze spills you onto the table, where you can fight for your own light back.

**Added — the visibility economy:** unified light resource, lantern stances, irreducible glow scaled to wealth, three-state movement stealth, reveal-before-damage combat, symmetric spill, and the gutter execute. Interlocking mechanics, not a shader. The test that matters: an agar player's decision loop is "chase smaller, flee bigger"; a nightraze player's is "am I willing to be seen right now?" — and the ecology answers differently too, because under symmetric spill the minnows hunt the whales. Different question, different game.

---

## 13. Launch notes (portal strategy)

The original plan was single-player-with-bots first, presented as an arena — the standard, proven day-one path before netcode earns its server bill — with real multiplayer added once portal traffic justified it. **The authoritative server was built early instead, and the two strategies collapsed into one.** Bots are socket-less players inside the same simulation, so the population adapts: bots fill the arena when humans are thin and yield as humans arrive, down to none when the room is busy. A day-one player meets a full arena either way, and the sim never has two code paths to keep honest — which matters more here than usual, because the server is also the anti-cheat (§6).

**The bots must sell theory of mind.** This is the launch's strategic risk: the game's differentiator is prediction, and prediction against a bot is only convincing if the bot is genuinely uncertain and genuinely deceptive. Two disproportionate investments: (1) after a player's douse, bots *randomize* among the four post-afterimage guesses rather than cheating or following one heuristic; (2) bots **douse-juke the player** convincingly — being fooled is how players learn the move exists. Bots run the full ruleset otherwise: identical perception rules — including the degraded shimmer view, so a wake never tells a bot how big the thing making it is (§6) — flee glow, chip upward, avoid downward contact, respect the gutter.

Portal success metrics to build for: time-to-fun under 30 seconds (spawn → first mote → first spark), 3-5 minute average session with "one more run" death flow — which the gutter state exists to guarantee — load under 3 seconds, portrait-mode support.

**The returning player starts one tap from the arena.** The name box is pre-filled with the last name the server actually accepted (a sanitized or profanity-rejected name is never remembered — see §4 on what else the browser keeps), and the start screen shows the personal record they are about to play against. Both exist to make the second session cheaper to begin than the first, which is the metric that decides whether a portal game has a retention curve at all. Integrate the portal SDK (ads, and CrazyGames' Friends Connect one-click join) before submission, not after.

Marketing surface: the thumbnail is a lone gold lantern in blackness with dim eyes at the edge — high contrast, reads at 100px, unmistakable among a wall of bright clones. The hero clip is the douse juke mid-chase; the secondary clip is an ambush dash into a symmetric spill and the feeding frenzy that follows. Dark footage risks looking like nothing in muted autoplay, so clips must open on a bright chase, not on stealth.

Submission framing, one line: *"An arena game where your score is your health is your visibility — your lantern burns whatever it touches, and growth makes you hunted."* Curators filtering for low-effort clones respond to inverted power curves.

---

## 14. To validate — held-back features

Features designed in earlier revisions but cut from launch scope. Each ships only if the playtest evidence named below demands it; the designs are recorded here so they are not re-invented.

### Occluders (monoliths) — cut in v5, design retained

Dark crystal formations scattered on the arena (reference: 10-14, radii 70-150, minimum 350 units apart) that **block light but not movement**. Key properties of the retained design:

- **Never pin.** Because they don't block movement, they can't trap you against geometry, and drag-steering on mobile never snags. The juke space stays open in every direction.
- **Attenuate rather than block** (reference: 180 units of effective radius lost per sight-line crossing, exposed as a balance lever). Absolute occlusion would repeal irreducible glow — a leader parked behind a stone would be invisible, gutting the core differentiator. Under attenuation, small players hide completely behind stones while a 500+ glow leader leaks a halo around them: the stones become the leader's best-but-imperfect refuge and the map's hotspots.
- **Landmarks.** Faintly self-luminous at any range — fixed stars for dark navigation.
- **Corners for the juke.** Terrain lets a chased player break line of sight *before* dousing, upgrading the four-way douse guess from a radius search into a genuine mind-game.
- Loose motes that come to rest behind them become hidden treasure and natural bait spots at no extra rule cost.

**Validation trigger:** add occluders if featureless-arena playtests show either (a) the douse juke collapsing into a shimmer search pattern (§5 known risk), or (b) the arena reading as flat/featureless in player feedback. If added, the renderer upgrades from punched light circles to 2D shadow casting, and perception checks gain attenuation clipping — both prototyped and shelved, not lost.

Also held back: smoke curtains, eclipse zones, and other exotic occluders (content updates, contingent on monoliths shipping at all).

### Vent-light — cut in v6, design retained

The heir to agar's spit-mass, thematically inverted: players may deliberately shed a chunk of held light (reference: 25-30% per vent), dropped as a loose-mote pile. Shipped provisionally in v5, removed in v6 to hold the arena at three verbs (§8).

What the one verb generated: a **panic escape** — dumping light can carry a hunted mid-size player back below the irreducible-glow threshold, buying true invisibility at the price of score and health; a **bribe** — "take the pile, stop chasing me"; and a **bait** — sit dark and motionless beside your own vented pile and ambush the collector with a dash, which is the mechanic that put a price tag on ambush camping. It also produced a role, the **Baiter** (§11), which goes with it.

Guardrails, as built and now removed: cannot vent below the starter ember (12 — which also means venting can never carry you into the gutter voluntarily); a ~2s self-pickup lockout prevents free glow-toggling while still allowing reclaim-after-bait. Vented piles obeyed the standard loose-mote lifecycle (§3) — a bait left too long settles back into the field. Input was a secondary action: `V` on desktop, double-tap of the lantern button on touch.

**Validation triggers — bring it back if any of these show up:**

- **Camping out-earns playing.** Dark, stationary ambush is now answered by the economy alone (§6). If patient camping beats active play on light-per-minute, the bait cost is the designed fix.
- **Leaders read as trapped rather than hunted** (§15 Q10). Vent was the only voluntary way down from the top; without it, a leader's sole exit is being drained by someone else. Watch this before building a leader-only offensive verb, which is the expensive answer to the same complaint.
- **Mid-size players have no counterplay to a committed hunter.** The panic escape existed for exactly that squeeze.

If it returns, it returns *after* onboarding proves players can price their own light (§9, first descent) — the comprehension failure that killed it is a prerequisite problem, not an argument against the verb. Re-instating it is cheap and mechanical: the proto field numbers it used are reserved, not recycled (`ClientMessage` 4, `EffectKind` 5), so the wire has a vent-shaped hole kept open on purpose.

---

## 15. Open questions / playtest checklist

1. Does tap-vs-drag misfire enough on real thumbs to justify a fallback (double-tap mode toggle in settings)?
2. Irreducible glow at G=0 vs G=14: where between "leader hides freely" and "leader is food" does first place stay *desirable*? Runnable as a live sweep inside one sitting with the same testers (§10) — move the dial between rounds rather than between builds, and read it with the Q10 signals below.
3. **Does the douse juke survive a featureless arena** — do afterimage timing and shimmer thresholds alone produce a genuine guessing game, or does pursuit collapse into a radius sweep? This is the trigger question for §14 occluders.
4. *Retired in v6 (number kept so Q5-Q11 references stay put).* ~~Vent-light: does the bait loop justify a second verb on mobile?~~ — cut before it could be tested, on comprehension rather than ergonomics (§8). The question that replaces it lives in §14: does anything *break* without it?
5. Is dark vision at 60 tactical or claustrophobic on a 6-inch screen, with the contracting iris in place?
6. Time-to-first-scare: does a fresh spawn meet meaningful danger inside 30 seconds at 14 bots / 2600²?
7. Boundary corners: does corner-pinning against the gutter state get ugly enough to need rounded corners or repulsion?
8. Shimmer on real hardware: does distortion-only survive a 6-inch screen in daylight, or does it need the luminance floor?
9. Leader findability: glow caps at 520 on a 2600-unit arena — a fifth of the map — so hunters cannot actually locate first place. Does the hunt loop need a faint directional horizon-glow toward the leader?
10. **Leader agency:** is the bonfire role (burns all, profits from touching nobody) desirable prey or declawed misery? Dash asymmetry went live for this, and the crown (§11) is the cheap half of the answer; a leader-only offensive verb is the expensive half, and it stays held until this question has evidence.

    *How to read the answer.* The tempting test — "do top players say they want to hold first place, or do they just want to go dark and hide?" — fails, because hiding is a **designed stance** (§5) and a named role (§11, the Ghost). A tester who shutters may be reporting that the game works. The real distinction is agency versus relief, and self-report cannot separate them, because the words are identical. Watch behaviour instead:

    - **Re-ascent.** After dying at the top, do they climb again, or settle into a safe mid-band? Repeat ascent is the fantasy working.
    - **Time spent lit above the crown threshold.** If leaders spend their bright minutes dark, the role is a sentence they are serving.
    - **Shutter timing.** At the moment of a read — a hunter closing, a juke being set up — or pre-emptively and constantly? The first is a play; the second is an evacuation. Note what v6 changed here: with vent cut (§8), shuttering is the *only* voluntary move a leader has left, and it sheds no light at all — a leader who wants out has to be drained out. If the bonfire role reads as misery, that missing release valve is a prime suspect.
    - **Peak light per run trending up across a session.**

    Run this against a G sweep (lever 1 is live-tunable — §10), not against new mechanics. It would be an expensive mistake to build subsystems to fix a leader experience that turns out to be one number over-tuned — or, per Q9, one where nobody could find the leader to begin with.
11. Thumb occlusion: does drag-anywhere steering need an offset-touch or virtual-stick option?

---

## Appendix A — Design history: the strike model (v3, retired)

Through v3, the only attack was the **flare lunge as a discrete strike**: a dash that dealt `3 + 10%` on hit, with per-attacker immunity, full reveal, and the crescent scatter. A refinement ("graze ticks") briefly split the hit into up to three capped contact ticks across a short burn window, making aim quality analog.

The model was internally sound — the reveal-on-attack interlock, the crescent, and the immunity logic all survive in v4 in altered form — but it failed the test that made agar a phenomenon: **the zero-knowledge player had no combat.** Touch was inert; an agar-primed player who rammed someone got nothing and learned nothing, and the actual attack lived behind a gesture with aim, cost, and cooldown. Combat and movement were different verbs. v4's contact law resolves combat through steering itself and demotes the dash to optional depth — the role split played in agar.

Two adjacent designs were evaluated and rejected, recorded here so they are not re-proposed:

- **Continuous uncapped contact drain** ("burning window" — enemies touching an armed lantern lose light continuously). Fails because contact duration is controlled by whichever party is *faster*, and speed is inverse to size: big attackers can't hold contact on small victims (attacking down becomes worthless), while small attackers can ride big slow victims for the entire window (a drag-kill that empowers exactly the wrong players and lets one ghost solo the leader). It also makes losses unknowable-in-advance, violating the legibility pillar, and dissolves the crescent as a discrete readable event. The v4 contact law keeps burns as fixed, bounded, per-pair-throttled events for these reasons.
- **Direct transfer on contact** (toucher absorbs some or all of the spill). Rebuilds agar's snowball with extra steps; see the design red line in §7.

