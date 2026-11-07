# Design guide: how to make design decisions while building `viz/`

The **Design section of `docs/phase6-plan.md`** (cited as "Design §N") is the spec: tokens, screens, components, copy. This guide covers the gaps: what to do when the spec says nothing, when two rules seem to pull apart, or when you feel like adding something. It holds no values of its own; every fact links back to the spec, so if the two ever disagree, the spec wins.

Read it once before your first UI session, and again when you hit a decision the spec doesn't answer.

---

## 1. The questions, in order

When a design question isn't answered by the Design section, go down this list and stop at the first "no".

1. **Is it true?** Every value on screen must come from chain state, a run log or a labelled simulation, and must carry its provenance mark (Design §4). If you can't name the source, the answer is `—` with a reason, not a design. *Nothing in the UI is worth showing a guessed value.*
2. **Does the specimen still lead?** On a screen with art or the network map, that stays the largest and brightest thing (Design §2, principle 1). If your addition competes with it in size, brightness or motion, shrink it or move it into a tooltip or the inspector.
3. **Is it needed now?** One primary figure per screen, at most four secondary figures inline, the rest on demand (principle 2). If adding it would make a fifth, something else goes or it moves behind a click.
4. **Does a token or component already do it?** Use what exists: `ui/tokens.*`, `ui/format.ts`, `ui/states.tsx`, `ui/status.tsx`, `ui/Tooltip.tsx`, `ui/motion.ts`, `ui/VeinPulse.tsx`, `ui/TxTray.tsx`, `components/SporeArtwork.tsx`, and the component catalogue (Design §7). New tokens and components are a last resort (§4 below).
5. **Does it still work with no colour and no motion?** Status needs a glyph and a word (Design §3.1.2). Every animation needs a reduced-motion form (Design §3.5). If it only makes sense in colour or in motion, it isn't finished.
6. **Does it fit the budgets?** 180 kB gzip of initial JS, 60 fps network pan, no per-spore polling (Design §10).

If you reach the end with every answer "yes", choose the **plainer** option. When two options are equally valid, the one with less chrome, less motion and fewer words wins.

---

## 2. Decision rules for common cases

### Colour: what does this colour *mean*?

Pick a colour by what it means, never by how it looks. There are four families, and each has one job:

| You want to show… | Use | Never use |
| --- | --- | --- |
| A status (settled, agent, money, rejected, stale) | the semantic token plus its glyph and word (Design §3.1.2) | `--slime`, palette colours |
| "This is the interface": active nav, focus, primary button, the countdown arc, veins | `--slime` (Design §3.1.1) | a status colour |
| Which spore this is | that spore's palette, only in the allowed places (Design §3.1.3) | buttons, status, links, body text |
| Everything else | `--text`, `--text-2`, `--text-3` on `--bg` and the surfaces | new hex values |

- **Emphasis comes from type, size and space first.** Reach for colour last. To make something stand out, try `--text` instead of `--text-2`, a larger type token, or more space around it.
- **Close-looking colours mean a design bug.** This is why money moved to amber when the yolk accent arrived (Design §13, item 8). If a new colour could be confused with an existing one, don't add it.
- **A tinted row background (`-dim`)** goes only behind a row whose status word is visible.

### Motion: is there a confirmed trigger?

```
Is there a chain or app event behind this motion (close observed, render done, tx final, row arrived)?
├─ no  → Don't animate. The shell's ambient motions (the vein tubes' peristalsis and breathing, wordmark breathing), the
│        Network map's living tubes and the Rogue stage's membrane are logged exceptions (Design §13, items 9, 14 and 19); don't add another.
└─ yes → Is the event *confirmed* (final tx outcome, epoch_info advanced, pixels + hash returned)?
         ├─ no  → Wait for it. No optimistic motion (Design §3.5, "Truth rule").
         └─ yes → Does the Design §3.5 table already have a row for it?
                  ├─ yes → Use that row's motion and duration token exactly.
                  └─ no  → Use an existing duration and easing token, give it a reduced-motion
                           form, and add a row to the §3.5 table.
```

- **What changes on screen must match what changed in the data.** For example, a tube never grows on `job_settled`. D only changes at a close, so the tube animates at the close.
- **Durations come only from tokens**, so reduced motion can zero them. A perpetual animation must also be switched off outright under `[data-reduced-motion='true']`.
- **Growth and decay look different.** Growth uses `--ease-grow`; decay uses the slower, even `--ease-decay`.
- **The slime theme is the organism, not a toy.** No drips, wobble, jelly, gloss or neon (Design §2, "Explicitly not used").

### Shape: what kind of thing is it?

| Thing | Shape |
| --- | --- |
| Art (any size) | square, `--r-0`, no border, the bloom only once real pixels show |
| Button, chip, source badge | `--r-blob` (hover morphs to `--r-blob-2`) |
| Panel, menu, dialog, tooltip, tx row | `--r-2` |
| Input, select | `--r-1` |
| Avatar, node dot | `--r-full` |
| Shell edge (top bar, footer, bottom bar) | a vein, not a rule |
| Table, list, form rule | a plain 1 px `--line` (veins there hurt scanning) |

Don't put cards inside cards, and don't put a rounded container around art.

### Type: which face?

- **Display (Gluten, the gooey face)** for organism names, the wordmark, the landing page's line and section lines (Design §13 item 23) and a Demo Lab scene's question and narrator (Design §13 item 19), at 22 px or larger. Never for numbers, buttons or labels.
- **Mono** for evidence: hashes, ids, epochs, amounts, D and R. Always with tabular figures. Evidence never goes doodle.
- **Sans (Shantell Sans, the doodle hand)** for everything else, through the type tokens, which set the `--doodle` axes. Bounce (`--doodle-loud`) is for titles, headings and eyebrows only; reading text stays still.
- **Weight moves only on a confirmed event** (the name swell at a close, Design §3.5). Don't animate weight on hover or loading.

If you're unsure, ask whether the text names a living thing (display), is a fact a judge could check (mono), or operates the interface (sans).

### Numbers and unknown values

- **Format** with `ui/format.ts` (Design §8.1). NEAR amounts come from the yocto string via BigInt, never `Number`.
- **Unknown** is `—` in `--text-3` with a tooltip saying what's missing and how to get it. Never `0`, `n/a` or a blank (Design §4.2).
- **Computed in the browser** gets the `≈` prefix. **Re-checked** gets `↻` plus the result word.
- **A number that needs a source the view doesn't have** (decision logs, past tube sets, finished jobs; Design §1.7): the region says which source it needs.

### Layout

- **Annotate, don't build a dashboard.** A number sits next to what it describes, like a label on a plate. No grids of equal stat tiles.
- **Separation** comes from `--surface` against `--bg` and from space. Floating layers get the one shadow token; in-flow content gets none.
- **Space** comes only from the spacing scale (`--s-*`): `--s-7` between sections, `--s-3` to `--s-4` inside a block.

### States

Every region you build has a loading, empty, error and (if it's live) stale form, all from `ui/states.tsx` (Design §6.0). Design the empty state as a sentence about what would fill it, plus one action. Loading never uses a skeleton shimmer or a page spinner.

### Copy

Write short, declarative sentences that name the mechanism ("the contract refused", "the router computed"). Quote contract errors verbatim in mono, then add one plain sentence about what to do. Transaction states use the fixed copy in Design §8.3. Never write "AI-powered", "unlock" or anything that implies returns.

---

## 3. Anti-patterns (and why they're tempting)

| Tempting | Why it's wrong here | Do instead |
| --- | --- | --- |
| Making a hovered gallery card glow | Glow belongs to the art's own bloom (Design §3.4), and the card's art already has it | the focus ring, `--surface-2` on the meta row |
| Showing a sample number "until the data loads" | it's an invented value | the 1 px `--line` loading bar, then the real value or `—` |
| Using `--slime` for "good" | yolk is the interface accent, not a status; `--growth` with `✓` means settled | the semantic token plus glyph and word |
| A palette colour on a button "to match the spore" | palettes are identity only and vary per spore, so button meaning would vary too | `.btn-primary` / `.btn-secondary` |
| Animating on a pending tx or `job_settled` | the motion would claim something the chain hasn't confirmed | wait for the confirmed trigger (§2, Motion) |
| A generic `Card` / `StatTile` / `Chart` wrapper | Design §7 rules them out; they pull screens toward a dashboard look | the specific catalogue component |
| A one-off hex value or pixel size in a component | it skips the contrast test and drifts from the system | an existing token, or a new one (§4) |
| Falling back to recorded data when RPC fails | it hides a failure, and the badge would be wrong | `ErrorState` naming the endpoint, plus Retry |

---

## 4. Changing the system itself

Sometimes the right decision is a new token, component or rule. Do it on purpose:

1. **Check that it's really missing.** Search `viz/src/ui/` and Design §7 first.
2. **Team-level changes need the user.** These are changes to the look (colours, radii, motion rules, the "not used" list), to provenance marks, or to a D-decision. Ask with concrete options, like the slime theme and animation choices were made. Changes within the rules (a new row in the §3.5 table, a component variant) don't need a question.
3. **Tokens:**
   - Add the token to both `tokens.css` and `tokens.ts` (`viz/test/shell.test.tsx` checks they match).
   - A text or control colour must pass the contrast test in the same file: 4.5:1 for text and 3:1 for control outlines on `--bg`, `--surface` and `--surface-2`.
   - Put the measured values into the Design §3.1.2 table.
   - A CSS variable that reads a per-element value (like `--accent`) can't be a `:root` token; write it in the rule that uses it (see the art bloom in `shell.css`).
4. **Write it down:**
   - Update the Design subsection the change affects.
   - If it departs from the brief or an earlier rule, add a numbered item to Design §13 with the replaced values.
   - Add a row to the session log.

---

## 5. Before you finish a UI session

Copy this into your session notes and tick each item honestly. An unchecked item goes in the log's "Left" column.

- [ ] Every value has a source, and every view has a source badge (Design §4).
- [ ] No hex, pixel size, radius or duration outside the tokens (`grep -n '#[0-9a-fA-F]\{3,6\}' viz/src --include='*.css'` should only hit `tokens.css`).
- [ ] Every status has a glyph and a word; nothing depends on colour alone.
- [ ] Every state in the screen's Design subsection is reachable in a test or the manual check.
- [ ] Reduced motion is on: nothing moves except what Design §3.5 allows, and all information is still there.
- [ ] Keyboard only: focus is visible on everything, and the screen's keyboard path (Design §9) works.
- [ ] Looked at in Chrome at 1440 and 390 wide (`npm run dev`, 127.0.0.1). If something couldn't be seen for real (no data, no close), say so in the log rather than implying it was checked.
- [ ] `(cd viz && npm test)` passes, and the build stays under the JS budget (Design §10).
- [ ] Design changes are written into the spec, Design §13 and the session log (§4 above).

---

## 6. Worked examples

**"Should the Network tube flash when a settlement row arrives in Activity?"**
1. Is it true? No: D changes only at the next close, so a flash would claim growth that hasn't happened.
2. Answer: the row slides in (Design §3.5, "Settlement in feed"). The tube tweens at the close.

**"The detail page has room for balance, allowance, R, age, degree and sales. Show them all?"**
1. Is it needed now? Only partly: one primary figure, four inline secondary figures at most.
2. Answer: pick the primary from the screen's Design subsection. The rest go inline or into Technical, and each shows its value-level mark (Design §4.2).

**"This source has no close tx for some epochs: hide those scrubber ticks?"**
1. Is it true? Hiding them would imply those epochs don't exist.
2. Answer: draw them as hollow ticks with the tooltip "No close tx for epoch 4 in this source", and show `—` for their values (Design §6.C scrubber, §4.3).

**"I want a slimy loading animation for the gallery."**
1. Is there a confirmed trigger? No: loading isn't an event. Loading also never uses shimmer (Design §6.0).
2. Answer: the on-chain glyph shows (it's real data), with the "rendering…" caption, then the image crossfades in on render done. The slime character comes from the art's bloom when the real pixels arrive.
