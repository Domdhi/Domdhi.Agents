---
name: content-formats
description: "Use WHEN formatting content for a specific platform — LinkedIn posts, newsletters, Twitter threads, or YouTube scripts. Triggers: linkedin, newsletter, twitter, youtube, content format"
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [content, social-media, templates, formats]
user-invocable: false
allowed-tools: Read Grep Glob
---

# Content Formats

Format templates for platform-specific content. Load the relevant file for the target platform before drafting.

## Voice and publication

Use the project’s approved voice and verified claims. Drafting is not publishing: posting, sending, scheduling or boosting any piece requires explicit authorization from its owner for that action.

## Format Files

| File | Platform | When to Use |
|------|----------|-------------|
| `references/linkedin-post.md` | LinkedIn | Organization updates, program announcements, partner recognition and milestones for a professional or industry audience |
| `references/newsletter.md` | Email newsletter | Subscriber updates, periodic digests, curated roundups and program deep dives sent to an owned audience |
| `references/twitter-thread.md` | Twitter/X | Short announcement chains, event coverage and step-by-step explainers |
| `references/youtube-script.md` | YouTube | Spoken video scripts — tutorials, explainers, program walkthroughs — with hook, sections and call to action structured for on-camera delivery |

## Usage

Load the matching format file at the start of the task. Each file contains the structural template, length guidance, tone notes and platform-specific formatting rules for that content type.
