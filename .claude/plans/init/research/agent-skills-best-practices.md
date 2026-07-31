# Anthropic Agent Skills — Research & Best Practices

Sources:
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices (primary)
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/quickstart
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills (engineering blog)

Fetched 2026-07-31.

---

## 1. What Agent Skills are

Agent Skills are modular, filesystem-based capability packages: a directory containing a `SKILL.md` file (required) plus optional bundled files (scripts, references, templates, data). Claude discovers and loads them automatically when relevant — no manual invocation needed, unlike slash commands. They turn a general-purpose agent into a specialist by packaging procedural knowledge, organizational context, and reusable workflows, "like an onboarding guide you'd create for a new team member."

Skills run inside Claude's code-execution/agentic environment: Claude has filesystem access and bash, and navigates a skill directory with the same commands it would use to explore any filesystem.

**Why Skills vs. alternatives:**
- **vs. stuffing instructions in the system prompt**: Skills load on demand, so you don't pay context cost for capabilities you're not using this turn.
- **vs. MCP**: Skills package encapsulated expertise/workflows; MCP servers provide tool orchestration/external system access. They're meant to complement each other — a Skill can instruct Claude to call specific MCP tools (fully qualified as `ServerName:tool_name`).
- **vs. RAG**: Skills are actively triggered by the agent's own reasoning about relevance (via the description match), not passively retrieved by embedding similarity.

## 2. The three-level progressive disclosure model

| Level | When loaded | Token cost | Content |
|---|---|---|---|
| **1. Metadata** | Always, at startup | ~100 tokens/skill | `name` + `description` from YAML frontmatter, injected into system prompt |
| **2. Instructions** | When the skill is triggered | Should stay under ~5k tokens (SKILL.md body) | The markdown body of SKILL.md: workflows, guidance, quick-start code |
| **3. Resources/code** | Only as referenced/needed | Zero tokens until accessed | Bundled reference `.md` files (loaded into context only when read); scripts (executed via bash — code itself never enters context, only its output does) |

This is the central architectural idea: **the context window is a public good**. Every skill "costs" only ~100 tokens until it's actually relevant, so you can install/bundle many skills (100+) without penalty. Once triggered, the SKILL.md body competes with everything else in context, so keep it lean. Bundled reference files and scripts have effectively zero cost until Claude decides to read/run them — so there's no practical limit on how much supporting material you attach, as long as it's not force-loaded.

Mental model: table of contents (SKILL.md) → chapters (reference files) → appendix/scripts (executed, not read).

## 3. SKILL.md structure

Minimal required shape:

```markdown
---
name: your-skill-name
description: Brief description of what this Skill does and when to use it
---

# Your Skill Name

## Instructions
[Clear, step-by-step guidance for Claude to follow]

## Examples
[Concrete examples of using this Skill]
```

### Frontmatter field constraints (exact, from docs)

`name`:
- Max 64 characters
- Only lowercase letters, numbers, hyphens (no spaces, no underscores)
- No XML tags
- Cannot contain reserved words: `anthropic`, `claude`

`description`:
- Must be non-empty
- Max 1,024 characters
- No XML tags
- Must state **both** what the skill does and **when** to use it (this is the single most important field — it's what Claude matches against user requests to decide whether to trigger the skill, potentially choosing among 100+ installed skills)

### Directory layout example (from docs, PDF skill)

```text
pdf-processing/
├── SKILL.md              # Main instructions (loaded when triggered)
├── FORMS.md              # Form-filling guide (loaded as needed)
├── reference.md           # API reference (loaded as needed)
├── examples.md            # Usage examples (loaded as needed)
└── scripts/
    ├── analyze_form.py     # Utility script (executed, not loaded)
    ├── fill_form.py
    └── validate.py
```

### Where skills live

- Claude Code: `~/.claude/skills/` (personal) or `.claude/skills/` (project-scoped), or via Claude Code Plugins. Filesystem-based, no upload needed.
- claude.ai: uploaded as a zip via Settings > Features (Pro/Max/Team/Enterprise with code execution). Per-user, not org-shared.
- Claude API: uploaded via the Skills API (`/v1/skills`), referenced by `skill_id` in the `container.skills` param alongside the code-execution tool. Workspace-wide.
- Custom Skills do **not** sync across these surfaces — must be created/uploaded separately per surface.

## 4. Naming conventions

- Prefer **gerund form** (verb + -ing): `processing-pdfs`, `analyzing-spreadsheets`, `managing-databases`, `writing-documentation`.
- Acceptable alternatives: noun phrases (`pdf-processing`) or action-oriented (`process-pdfs`).
- Avoid: vague names (`helper`, `utils`, `tools`), overly generic (`documents`, `data`, `files`), reserved words (`anthropic-helper`), and inconsistent patterns across a skill library.
- Consistency matters for discoverability, documentation, and organizing multiple skills together.

## 5. Writing descriptions that trigger reliably

- **Always third person.** The description is injected into the system prompt verbatim; inconsistent point of view hurts discovery.
  - Good: "Processes Excel files and generates reports"
  - Avoid: "I can help you process Excel files" / "You can use this to process Excel files"
- **Be specific, include key trigger terms** — both the capability and the contexts/keywords a user might say.
- Each skill gets exactly one description field; it's the entire basis for skill *selection* among many installed skills, so front-load the discriminating terms.

Good examples from docs:
```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```
```yaml
description: Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```

Bad (too vague, will under-trigger or never trigger):
```yaml
description: Helps with documents
description: Processes data
description: Does stuff with files
```

## 6. Core authoring principles

### Conciseness ("Claude is already very smart")
Only add context Claude doesn't already have. For every sentence ask: does this justify its token cost, could Claude infer this, is this something Claude already knows? Cut background/explanation Claude doesn't need (e.g. don't explain what a PDF is).

### Match degrees of freedom to task fragility
- **High freedom** (prose/heuristics): when multiple valid approaches exist and judgment matters (e.g. code review process as a numbered list of considerations).
- **Medium freedom** (pseudocode / parameterized scripts): when there's a preferred pattern but some variation is fine.
- **Low freedom** (exact scripts/commands, "do not modify"): when operations are fragile, must be sequenced exactly, or consistency is critical (e.g. DB migrations).

Analogy: narrow bridge with cliffs → give exact instructions; open field → give general direction and trust judgment.

### Test across models you'll actually use
Haiku (enough guidance?), Sonnet (clear/efficient?), Opus (not over-explained?). A skill tuned for Opus may be too sparse for Haiku.

## 7. Progressive disclosure patterns (practical)

- **Keep SKILL.md body under 500 lines.** Split into separate files once you approach this.
- **Pattern 1 — high-level guide + references**: SKILL.md has quick-start + links to FORMS.md / REFERENCE.md / EXAMPLES.md, loaded only when needed.
- **Pattern 2 — domain-specific organization**: split reference material by domain (`reference/finance.md`, `reference/sales.md`, ...) so a task in one domain never pulls in irrelevant domains' tokens. Can even instruct Claude to `grep` within reference files for the specific metric it needs.
- **Pattern 3 — conditional details**: show the common-case content inline, link out only for advanced/rare branches (e.g. "For tracked changes, see REDLINING.md").

### Keep references one level deep
All reference files should link directly from SKILL.md. Nested references (`SKILL.md → advanced.md → details.md`) risk Claude doing partial reads (`head -100`) of intermediate files instead of following through, losing information. One level deep avoids this.

### Long reference files need a table of contents
For any reference file >100 lines, put a TOC at the top so Claude sees the full scope even on a partial/preview read, and can jump to the right section.

## 8. Workflows and feedback loops

- **Checklists for complex multi-step tasks**: give Claude a literal markdown checklist to copy into its own response and check off as it proceeds. Works for both code and non-code workflows.
- **Validator → fix → repeat loops** dramatically improve output quality. Example: "make edit → run validate.py → if fail, fix and re-run → only proceed once it passes → rebuild output → test."
- **Conditional workflow pattern**: explicit decision points ("Creating new content? → Follow X. Editing? → Follow Y.").
- If a workflow gets big, push it into its own file and tell Claude to read it when relevant.

## 9. Content guidelines

- **No time-sensitive info stated as fact** ("before August 2025 use X, after use Y" will go stale). Instead, describe the current method as current, and put deprecated/legacy info in a collapsed "Old patterns" section (e.g. an HTML `<details>` block) for historical context only.
- **Consistent terminology** throughout — pick one term ("API endpoint", not a mix of "endpoint/URL/route/path") so Claude can parse instructions reliably.

## 10. Common content patterns

- **Template pattern**: give an exact template for strict-format outputs ("ALWAYS use this exact structure"), or a "sensible default, use judgment" template for flexible outputs.
- **Examples pattern**: input/output pairs communicate style/tone far better than descriptions alone (e.g. commit-message examples with type(scope): format).
- **Avoid offering too many options.** Don't list five interchangeable libraries — pick one default and give a named escape hatch for the edge case ("use pdfplumber by default; for scanned PDFs needing OCR, use pdf2image + pytesseract instead").

## 11. Skills with executable code (relevant if slide-gen skill ships scripts)

- **Solve, don't defer**: scripts should handle errors themselves (create-if-missing, fallback on permission error) rather than crashing and leaving Claude to improvise.
- **No "voodoo constants"**: every magic number (timeouts, retry counts) needs an inline comment justifying the value, or Claude can't reason about it or override it correctly.
- **Provide utility scripts even when Claude could generate the code**: more reliable, no token cost for the code itself (only stdout enters context), faster, and consistent across runs. Be explicit whether Claude should **execute** a script ("Run `analyze_form.py`") vs **read it as reference** ("See `analyze_form.py` for the algorithm") — execution is the default/preferred mode for utility scripts.
- **Plan-validate-execute pattern** for risky/batch/destructive operations: have Claude write an intermediate structured plan (e.g. `changes.json`), validate it with a script, only then execute, then verify. Catches errors before they're applied; make validator error messages verbose/specific (e.g. list valid field names when one doesn't match) to help Claude self-correct.
- **Visual analysis**: if inputs can be rendered as images (e.g. PDF pages, or in our case draft slide renders), convert and let Claude look at them directly, exploiting vision.
- **Package dependencies**: claude.ai can pip/npm install and pull from GitHub at runtime; the **Claude API sandbox has no network access and no runtime installs** — only pre-configured packages; Claude Code has full network access but shouldn't install packages globally. List required packages explicitly in SKILL.md regardless.
- **MCP tool references** inside a skill must be fully qualified as `ServerName:tool_name` or Claude may fail to resolve them when multiple MCP servers are present.
- Always use forward slashes in paths (`scripts/helper.py`), even for Windows compatibility — backslashes break on Unix.
- Name files descriptively (`form_validation_rules.md`, not `doc2.md`); organize directories by domain, not arbitrary numbering.

## 12. Evaluation & iterative development

**Build evaluations before writing extensive docs** — evaluation-driven development:
1. Run Claude on representative tasks *without* the skill; document specific failures/gaps.
2. Write 3+ scenario evaluations that test exactly those gaps.
3. Establish a baseline (no-skill performance).
4. Write the *minimal* instructions needed to pass the evaluations — resist over-documenting imagined requirements.
5. Iterate: run evals, compare to baseline, refine.

Example eval structure (JSON), no built-in runner — you own the harness:
```json
{
  "skills": ["pdf-processing"],
  "query": "Extract all text from this PDF file and save it to output.txt",
  "files": ["test-files/document.pdf"],
  "expected_behavior": [
    "Successfully reads the PDF using an appropriate library",
    "Extracts text from all pages without missing any",
    "Saves output to output.txt in a clear, readable format"
  ]
}
```

**The two-Claude iteration loop** (from docs, this is a genuinely distinctive method):
- **Claude A** = the "expert" instance you work with interactively to *design/refine* the skill.
- **Claude B** = a fresh instance that *uses* the finished skill on real tasks, revealing gaps through actual behavior.
- Cycle: complete a task with Claude A without a skill → notice repeated context you supply → ask Claude A to turn that into a Skill ("Create a skill that captures this pattern, including X, Y, Z rules") → review for conciseness ("remove the explanation of win rate, Claude already knows that") → improve information architecture ("put the table schema in a separate reference file") → test with Claude B on similar tasks → observe where B struggles → bring specifics back to Claude A ("B forgot to filter test accounts even though the skill mentions it — maybe it's not prominent enough") → Claude A suggests fixes (reorganize, stronger imperative language like "MUST filter" instead of "always filter") → apply, retest.
- Also gather teammate feedback: does the skill trigger when expected, are instructions clear, what's missing.

**Watch how Claude actually navigates the skill** in practice:
- Unexpected exploration order → structure may not be as intuitive as assumed.
- Missed file references → links need to be more explicit/prominent.
- Repeatedly re-reading the same file → that content probably belongs directly in SKILL.md.
- A bundled file never accessed → it's unnecessary or poorly signaled.

The blog post frames this the same way: "Think from Claude's perspective," and notes a future direction where agents will autonomously create/edit/evaluate their own skills.

## 13. Anti-patterns to avoid (checklist form)

- Vague/generic names or descriptions that don't discriminate ("helper", "Processes data").
- First/second-person description phrasing.
- Windows-style backslash paths.
- Offering too many undifferentiated library/approach choices instead of one default + named escape hatch.
- Deeply nested file references (more than one hop from SKILL.md).
- Reference files >100 lines with no table of contents.
- Time-sensitive claims stated as unconditional fact.
- Inconsistent terminology for the same concept.
- Scripts that crash/defer instead of handling errors.
- Unexplained "magic number" constants.
- Assuming a package/tool is pre-installed without saying so or how to install it.
- SKILL.md bodies that balloon past ~500 lines instead of being split.
- Skills sourced from untrusted parties — a skill is effectively installable software with tool/bash access; audit all bundled files (SKILL.md, scripts, images) for unexpected network calls, file access, or instructions inconsistent with the stated purpose before using it, especially anything that fetches external URLs (fetched content can carry injected instructions).

## 14. Security considerations (brief)

Only use skills from trusted sources (self-authored or Anthropic's). A malicious/compromised skill can direct Claude to invoke tools or run code inconsistent with its stated purpose — audit scripts, references, and any external-fetch behavior before trusting a third-party skill, especially in production contexts with access to sensitive data.

## 15. Versioning / distribution notes

- Custom skills do not auto-sync between claude.ai, the API, and Claude Code — manage/upload separately per surface.
- API skills are referenced by `skill_id` + `version` (e.g. `"version": "latest"`) via the Skills API (`/v1/skills`), used together with the code-execution tool and the `skills-2025-10-02` beta header.
- Claude Code skills are plain directories (`.claude/skills/<name>/SKILL.md` for project scope, `~/.claude/skills/` for personal), discovered automatically — no upload/versioning ceremony, just files, so normal git versioning applies naturally to project-scoped skills.
- Sharing scope differs by surface: claude.ai = per-user only; API = workspace-wide; Claude Code = personal or project (or via Claude Code Plugins for wider distribution).

## 16. Checklist for shipping a skill (from docs, verbatim structure)

**Core quality**
- [ ] Description is specific and includes key terms
- [ ] Description includes both what the skill does and when to use it
- [ ] SKILL.md body is under 500 lines
- [ ] Additional details are in separate files (if needed)
- [ ] No time-sensitive information (or isolated in an "old patterns" section)
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract
- [ ] File references are one level deep
- [ ] Progressive disclosure used appropriately
- [ ] Workflows have clear steps

**Code and scripts**
- [ ] Scripts solve problems rather than defer to Claude
- [ ] Error handling is explicit and helpful
- [ ] No "voodoo constants"
- [ ] Required packages listed and verified available
- [ ] Scripts documented
- [ ] No Windows-style paths
- [ ] Validation/verification steps for critical operations
- [ ] Feedback loops for quality-critical tasks

**Testing**
- [ ] At least three evaluations created
- [ ] Tested with Haiku, Sonnet, and Opus
- [ ] Tested with real usage scenarios
- [ ] Team feedback incorporated (if applicable)

---

## 17. Reusable SKILL.md template (for slide-generation skills)

This is a starting template tailored to a skill that generates slide decks (e.g. a "sloodge"-style slide-generation capability). Copy this into `.claude/skills/<skill-name>/SKILL.md`, fill in the brackets, delete example sections you don't need, and keep the body under 500 lines. Bundle heavier material (design system rules, layout catalogs, brand assets) as separate reference files linked one level deep, and keep any deterministic operations (rendering, validation, export) as scripts rather than generated code.

```markdown
---
name: generating-slides
description: Generates presentation slide decks (title, content, and closing slides) from an outline or raw content, following a consistent visual design system. Use when the user asks to create a slide deck, presentation, pitch deck, or slides for a talk, or mentions PowerPoint/Google Slides/Keynote-style output.
---

# Generating Slides

## Quick start

1. Gather or confirm: topic, target slide count, audience, and any brand/theme constraints.
2. Draft an outline (one line per slide: title + key point) and confirm it matches the requested scope before building full slides.
3. Build each slide using the layout catalog below (or `reference/layouts.md` for the full set).
4. Validate the deck (see "Validation" below) before delivering.

## Slide layout basics

Use one of these default layouts per slide unless content demands otherwise:

- **Title slide**: deck title, subtitle, presenter/date (first slide only)
- **Section header**: large heading, used to break the deck into parts
- **Content slide**: heading + up to 5 bullet points OR one supporting visual
- **Comparison slide**: two-column layout for contrasting items
- **Closing slide**: summary or call-to-action (last slide only)

For less common layouts (data tables, quote slides, image-heavy slides), see [reference/layouts.md](reference/layouts.md).

## Content rules

- One idea per slide. If a slide needs more than ~5 bullets or 40 words, split it.
- Titles are short, declarative phrases, not full sentences ("Q3 Revenue Grew 18%", not "This slide is about how revenue grew in Q3").
- Use consistent terminology for recurring concepts across the deck — don't alternate between "customer" and "client," pick one.
- Avoid unnecessary bullets restating the title; each bullet should add new information.

## Design consistency

- Reuse one color palette, one heading font, one body font across all slides. See [reference/design-system.md](reference/design-system.md) for the default palette and type scale — swap for brand colors when provided.
- Keep consistent margins/padding across slides; don't mix layouts with different visual density inconsistently within the same section.

## Workflow

Copy this checklist and track progress:
```
Slide Deck Progress:
- [ ] Step 1: Confirm outline with user (topic, slide count, audience)
- [ ] Step 2: Draft slide-by-slide content
- [ ] Step 3: Apply layouts and design system
- [ ] Step 4: Validate deck (run scripts/validate_deck.py)
- [ ] Step 5: Export and deliver
```

**Step 4 — Validation**: Run `python scripts/validate_deck.py <deck-file>` to check for overflow text, missing titles, inconsistent fonts/colors, and slide count vs. plan. Fix any reported issues before delivering. Do not skip this step for decks over 5 slides.

## Utility scripts

**scripts/validate_deck.py**: Checks slide count, text overflow, and style consistency.
```bash
python scripts/validate_deck.py output.pptx
```

**scripts/render_preview.py**: Renders each slide to a PNG for visual review.
```bash
python scripts/render_preview.py output.pptx previews/
```

## Examples

**Example 1 — outline confirmation**
Input: "Make me a 6-slide deck pitching our new API product to enterprise buyers"
Output: A 6-slide outline (title, problem, solution, how it works, pricing/CTA, closing) presented for confirmation before full slide content is drafted.

**Example 2 — content slide**
Input topic point: "We reduced onboarding time from 3 weeks to 3 days"
Output slide:
```
Title: Onboarding Time Cut by 90%
Bullets:
- Previous process: 3 weeks, manual, 7 handoffs
- New process: 3 days, self-serve, 1 approval step
- Result: 40% faster time-to-first-value
```

## Old patterns

<details>
<summary>Legacy layouts (deprecated)</summary>

[Only fill in if a prior version of this skill used a layout system you've since replaced. Otherwise delete this section.]

</details>
```

### Companion reference file skeleton — `reference/design-system.md`

```markdown
# Design System Reference

## Contents
- Color palette
- Typography
- Spacing and margins
- Layout catalog cross-reference

## Color palette
[Default brand-neutral palette; document hex values and usage — swap for real brand colors when given]

## Typography
[Heading font, body font, sizes for title/heading/body/caption]

## Spacing and margins
[Standard slide margins, gutter widths, safe zones]
```

### Notes specific to a slide-generation skill

- Treat "validate before delivering" as a **low-freedom** step (run the exact validator script) even though slide *content* drafting is **high-freedom** (judgment-driven).
- Bundle a `render_preview.py` script so Claude can visually inspect generated slides (vision-based QA) rather than trusting layout code blindly — this directly follows the "use visual analysis" guidance in section 11 above.
- If multiple deck styles/brands are supported, use the **domain-specific organization pattern**: `reference/design-system-brandA.md`, `reference/design-system-brandB.md`, so an unrelated brand's palette never enters context for a given task.
- Keep the description trigger terms broad enough to catch "pitch deck," "presentation," "slides," "PowerPoint," "Google Slides," "Keynote" — users rarely say "generate a slide deck" verbatim.
