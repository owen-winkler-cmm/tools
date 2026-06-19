<!-- Meta-documentation skill: produce canonical meta-documents that describe what must
     exist or be true within a documentation hierarchy. The output is always a meta-document
     (a reference that explains requirements) — never the project documents that fulfill it.
     Usage: /metadoc [optional topic hint] -->

Conduct a short interactive interview, then draft a meta-document in the canonical shape
defined below. Ask questions one or two at a time — do not present the full list at once.
Use $ARGUMENTS as a starting hint if provided; skip questions already answered by it.

## Interview sequence

Work through these in order. Each answer may make later questions unnecessary or suggest
follow-up questions not on this list — use judgment.

1. **Topic and scope**: What is this meta-document governing? One sentence describing the
   subject and the boundary of what it covers.

2. **Primary audience**: Who is the primary reader, and what specific action or decision
   does reading this document enable for them? (Not "anyone who needs to know" — one role,
   one outcome.)

3. **Alternate audience**: Is there another audience with a related but different need?
   If so, does a document for them already exist? If not, note that one is needed and
   where it should eventually live.

4. **Level in the hierarchy**: Is this a master document, or a subordinate of an existing
   meta-document? If subordinate, what is the parent, and how does this document relate
   to it? (A subordinate expands one complex requirement from its parent into its own
   requirements and artifact inventory.)

5. **Phase or lifecycle stage**: What stage of a project or process does this govern?
   Be specific: "before architecture review," "at go-live," "ongoing after launch." A
   meta-document that governs multiple disconnected phases should probably be split.

6. **Requirements**: What must be true to satisfy this document? Work through these with
   the user — they may not arrive with a complete list. Suggest likely gaps based on the
   topic. For each requirement, determine:
   - Which tier it belongs to (see canonical shape below)
   - Who is accountable for it by role (not by name)
   - Whether it is criticality-dependent (i.e., required only above a certain service tier)

7. **What must exist**: Given the requirements, what artifacts does this imply? For each,
   determine whether it is:
   - A **subordinate meta-document** (a reference document that expands a complex
     requirement into its own structure, linked from this document)
   - A **project template** (a starter document teams clone into their folio — not linked
     from this meta-document; produced separately and referenced by name)
   
   For each artifact: who produces it (role), who reviews it (role), and what requirement
   or outcome it satisfies.

## Canonical shape

Enforce these constraints rigorously. They are design rules, not suggestions.

**Length**: If the requirements section would exceed ~15 items, split the overflow into a
subordinate meta-document rather than expanding this one. A meta-document that tries to
cover everything covers nothing well.

**One audience**: One primary audience per document. The alternate audience gets one line
in the header and a pointer — not a second requirements section.

**Requirements by phase**: Organize by when, not by topic. Three tiers:
- **G** (Gate): must be met or formally risk-accepted with a named owner and documented
  rationale. Absence blocks the phase.
- **S** (Standard): expected quality bar. Unmet items require a tracked remediation item
  (owner + date) but do not block the phase.
- **C** (Continuous): an obligation that must be owned and have a defined process before
  the phase ends, and which persists afterward.

Criticality modifier: mark requirements whose tier depends on service criticality as
**(G if [tier])** so teams know which standards harden into gates for their context.

**What must exist**: Lists subordinate meta-documents and project templates only. Project
documents themselves — the actual artifacts teams produce for their folios — are not listed
or linked here. They live in project folios. This document is what they reference, not
the other way around.

**Purpose**: 2–3 sentences. What this governs. Why a canonical reference exists. What it
enables the primary reader to do. Not a summary of the document's contents.

**What you do next**: One short paragraph. Points the practitioner outward: locate the
relevant templates or subordinate meta-docs, produce project-specific artifacts in your
folio, link back to this document as your compliance reference.

## Document template

Produce output in this shape. Do not add sections not listed here.

---

# [Title]

**Status:** Draft
**Audience:** [Primary audience role] — for [alternate audience], see [link or "companion
document needed"]
**Scope:** [One sentence: what this governs and its boundary]
[If subordinate: **Parent:** [link to parent meta-document]]

## Purpose

[2–3 sentences.]

## Requirements

[For master documents only: one sentence explaining the tier system (G/S/C) and the
criticality modifier pattern. Omit for subordinates — they inherit the tier definition
from the master.]

### [Phase or stage name]

| # | Requirement | Tier | Owner role |
|---|-------------|------|------------|
| 1.1 | [Requirement stated as an outcome, not a task] | G | [Role] |

[Repeat phase sections as needed. If a requirement is criticality-dependent, use G/S/C
notation in Tier column, e.g. "G if MC".]

## What must exist

Produce the following for your project. Do not contribute project documents back here.

| Item | Type | Owner role | Reviewer role | Satisfies |
|------|------|------------|---------------|-----------|
| [Name] | meta-doc | [role] | [role] | [requirement # or outcome] |
| [Name] | template | [role] | [role] | [requirement # or outcome] |

## What you do next

[One paragraph.]

---

## After the draft

Once the markdown draft exists and the user has reviewed it:

1. Ask whether to draft any of the subordinate meta-documents or templates listed in
   "What must exist." For subordinates, repeat the full interview at the child level.
   For templates: a template is a project-facing starter — it has the required sections
   from this meta-document pre-populated as headings with brief guidance notes, and
   placeholders for project-specific content. It includes a back-reference to this
   meta-document as its compliance standard.

2. Ask whether to publish to Confluence. If yes:
   - Ask for the parent page location (space + page title, or URL)
   - Use the Atlassian Rovo MCP (`createConfluencePage`) to publish
   - Subordinate meta-documents publish as children of their parent meta-document page
   - Templates publish in a designated templates space or as siblings, depending on the
     user's preference
   - After publishing, note the page URL so it can be linked from related documents
