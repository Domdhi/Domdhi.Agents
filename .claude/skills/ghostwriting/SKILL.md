---
name: ghostwriting
description: "Use WHEN writing a blog post, technical article, or long-form thought leadership piece in a specific author's voice. Triggers: article, blog, post, writing, content"
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [writing, blog, articles, content, thought-leadership]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob
---

<!-- Generated from .agents/skills/ghostwriting/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Ghostwriting — The Author's Voice

## Activation

Use when writing blog articles, transmissions, or long-form content in a specific person's voice. Load this skill, then the author's voice fingerprint, before drafting anything.

## Voice Source

This skill carries the craft: structure, anti-patterns, rhythm, review loop. The **voice itself** is the author's, supplied by the project:

1. Read `references/_voice/fingerprint.md` (relative to this skill).
2. If its first line is `<!-- @@template -->`, the fingerprint is unfilled. Stop and say so; do not invent a voice. Offer to build one from the author's own writing (see **Building a Fingerprint**).
3. The fingerprint's rules override the defaults below wherever they disagree. The author's actual samples override both.

## Craft Defaults

These hold for most strong long-form writing. A fingerprint may tighten or reverse any of them.

1. **First person, active voice.** "I built it", not "it was implemented".
2. **Specific numbers, never rounded.** An exact figure beats "hundreds" or "a significant increase".
3. **Evidence over opinion.** Show the commit hash, the test count, the measurement, the date.
4. **Concrete beats abstract.** A named tool, file or incident beats a general claim.
5. **Short sentences carry the argument; longer ones carry the data.** Fragments are allowed when they land.
6. **Open with the claim, the number or the provocation.** Never setup or preamble.
7. **Close on the point that sticks.** No summary paragraph, no formulaic wrap-up.
8. **Confidence earns its place.** Back a strong claim with a receipt in the same breath.

### Anti-Patterns (AI Slop Markers)

Never write these. They are the fingerprints of filtered, generic output.

#### Phrases
- "In this article, we'll explore..." (just start)
- "Let's dive in" / "Let's break this down"
- "It's worth noting that..." (if it is, note it)
- "At the end of the day..."
- "Game-changer" / "Revolutionary" / "Exciting" (marketing slop)
- "I think maybe..." / "You might consider..." (hedging)
- "On this journey" / "Along the way" (soft language)
- "Passionate about" (show, don't tell)
- Self-answering rhetorical questions ("But what if there was a better way?")
- Lists of three adjectives ("powerful, intuitive, and seamless")
- "Buckle up" / "Spoiler alert" / "Plot twist"
- Ending with "And that's the real [lesson/takeaway/point]"

#### Tone
- Gratitude and humility boilerplate ("I'm so grateful for this opportunity")
- Pep talks, validation and motivational filler
- Repeating the same point in different words
- "Thrilled to announce..." (platform-announcement voice)

#### Structure
- Formal essay shape with introduction, body and conclusion
- Polished, uniformly smooth prose with every transition spelled out
- Third-person self-reference ("one might consider")
- Passive constructions where the author did the thing

### Sentence Rhythm

Read the draft aloud. If every sentence has the same length and shape, it reads as generated. Vary it the way the fingerprint does: the author's cadence is the voice.

**Check pattern:** opening assertion → expansion → concrete example or number → closing point.

### Opening and Closing Lines

**Good open:** a specific claim with a number. **Bad open:** "After years of working in this industry, I started to wonder whether there was a better way."

**Good close:** one line that leaves the reader with the conclusion the evidence already built. **Bad close:** "In conclusion, we believe a mindful approach can lead to better outcomes for everyone."

## Article Structure

### Format
- **Title:** short and specific; under 10 words is ideal.
- **Domain:** the project's content domains (for example tech, finance, personal essays).
- **Length:** 600-1200 words by default; longer only when the piece earns it.
- **Structure:** Hook → Context → Receipts → So-What → Close.

### Sections

1. **Hook (1-3 sentences):** the most interesting fact or the most confrontational statement.
2. **Context (2-3 paragraphs):** the situation and the problem.
3. **The Receipts (the bulk):** the data, the before/after, the specifics.
4. **The So-What (1-2 paragraphs):** what it means and what the reader should take from it.
5. **The Close (1-3 sentences):** end hard, no soft landing.

### Formatting Rules
- Headers sparingly (`##`); the article should flow more than it chunks.
- `code blocks` for anything technical; tables for comparisons.
- Bold for key phrases, not whole sentences.
- No emoji in the article body unless the fingerprint uses them.

## Per-Domain Guidelines

Define each domain the author writes in as a short block in the project's fingerprint or in a project-additions section below. For each, record the register (tactical, reflective, instructional), typical length, and what proof it must show. Technical pieces should always be specific about tools, patterns and decisions, and include runnable examples.

## Source Material

When writing articles, pull from:
1. `docs/.output/.state/memory-daily/*.md` — daily session logs (auto-captured).
2. `docs/.output/.state/memory-concepts/**/*.md` — decision, constraint and pattern concepts compiled from session logs.
3. `references/_voice/fingerprint.md` — the author's quantitative voice analysis.
4. Real commit hashes, test counts and file counts from `git log`.

## Article Organization

The project decides where articles live. A workable layout:

```
docs/articles/
├── backlog/         # idea backlogs per domain
├── drafts/          # active drafts by domain
└── published/       # published articles
```

**Pipeline:** Idea → `backlog/[domain].md` → Draft → `drafts/[domain]/slug.md` → Published → `published/[domain]/YYYY-MM-DD_slug.md`

## Identifiability Rules

Articles may be read by people the author knows. Keep details universal enough that no one can be pinned down.

**Never include:**
- Job titles that trace back to the author
- Descriptions that identify a specific colleague
- Organization names or identifiable organization details
- Internal project names

**Safe to include:**
- Figures the author has chosen to share
- Role counts and general team dynamics
- Industry context that many organizations share
- Outcomes that are universal experiences

**The test:** could any one reader recognize that the piece is specifically about them? If yes, rewrite it.

## Cross-Article Linking

Articles should reference each other thematically and with real hyperlinks where the connection is natural.

- Inline references: "I measured this in [the migration write-up](/tech/logs/slug)".
- End-of-article related reads: "*Related: [Title](/domain/logs/slug)*".
- Tool or call-to-action links where a piece points at a platform feature.

Links should feel earned: if it reads like SEO stuffing, cut it. Keep a link map in the project's article backlog.

## Building a Fingerprint

When the fingerprint is unfilled, build it from the author's own writing (messages, drafts, transcripts):

1. Collect samples and note their size (messages, words).
2. Measure sentence length, punctuation habits, profanity frequency, favourite openers and transitions, metaphor families and typical self-corrections.
3. Record vocabulary the author uses and vocabulary they never use.
4. Capture a handful of verbatim samples as calibration.
5. Write it into `references/_voice/fingerprint.md` and remove the `<!-- @@template -->` line.

Treat the fingerprint as personal data: it belongs in the author's own project, not in a shared or published copy of the toolkit.

## Voice Tuning

The voice profile is a living document. After each article:
1. The author reviews and marks what sounds right and wrong.
2. Update the fingerprint with the corrections.
3. Add new "good" examples from approved pieces.
4. Add new anti-patterns from rejected phrasings.
5. Adjust how much raw voice is tightened versus preserved.

The goal: each article should sound more like the author than the last.

<!-- @@project-additions -->
