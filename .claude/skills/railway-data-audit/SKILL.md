---
name: railway-data-audit
description: Audit Signal Network's railway infrastructure and timetable data for provenance, evidence labels, graph validity and gaps. Use when data is imported or changed, or before relying on an area's data in gameplay.
---

# Railway data audit

Audit the real-world data for correctness and honesty. The rules in CLAUDE.md under "Data integrity" govern this audit. Never invent or "repair" railway data to make a check pass.

## 1. Establish scope and provenance

- Read `data/sources.json` (the source registry), `docs/DATA_SOURCES.md`, `docs/DATA_GAPS.md` and `docs/INFERRED_BEHAVIOUR.md`. If any of them is missing, record that as a finding.
- Locate the data and importers. Search the repo for infrastructure, timetable and interlocking data files and the code that loads them; do not assume paths.
- If the user named an area, line or date, limit the audit to it. Otherwise audit everything.
- Check that every dataset traces back to a registered source with licence, attribution and retrieval date.

## 2. Run the existing validation

- Find the real commands in `package.json` scripts and any validator scripts (look for names like `import`, `validate`, `check-data` and `graph`). Run the relevant ones and capture their output.
- If no validator exists for a check below, do that check by reading the data. Note in the report that it was done manually.
- Never report a command as passing unless it ran and succeeded.

## 3. Audit

For each item, confirm it has an evidence label (`sourced`, `verified`, `inferred`, `placeholder` or `unknown`) and that the label is justified.

- **Infrastructure:** signals, points, track sections and berths have source references. There are no duplicate IDs and no orphan elements.
- **Track connections:** the graph is connected where it should be. Points have valid normal and reverse legs. Directions are consistent, and there are no dangling ends that aren't real buffer stops or area boundaries.
- **Platforms:** each platform maps to track sections and to timetable platform codes.
- **Timetable locations:** every TIPLOC or location code in a schedule maps to an infrastructure location. List any that are unmapped.
- **Train paths:** each scheduled path can be routed over the graph: lines, platforms and running directions all exist.
- **Service timings:** times are monotonic, dwells are plausible and dates are valid. Running times must be achievable over the path, or else be flagged.
- **Interlocking:** list every route and locking rule that is not backed by a control table or source. Make sure each one is labelled `inferred` and documented in `docs/INFERRED_BEHAVIOUR.md`.
- **Unsupported assumptions:** look for hard-coded values, defaults or fallbacks in code that stand in for missing real data without a `placeholder` or `unknown` label.

## 4. Corrections

Correct something only when **all** of these hold:

- The source data itself supports the fix: it was a transcription or mapping error, not a gap.
- The fix is minimal and local.
- The evidence label is preserved, or upgraded only on new evidence. Note the source reference in the change.

Otherwise, do not change the data. Record the issue in `docs/DATA_GAPS.md` (or `docs/INFERRED_BEHAVIOUR.md`) and in the report. Add a regression test or validator case for each correction if a test setup exists.

## 5. Report

Finish with:

1. **Scope:** what was audited, and the data versions or dates.
2. **Commands run:** each command with its result (passed, failed or could not run, and why).
3. **Findings:** grouped as missing mappings, invalid connections, incomplete data, unlabelled or mislabelled evidence, and undocumented inferences. Give file and ID references for each.
4. **Corrections made:** each one with its supporting source.
5. **Remaining gaps:** what still needs real data or a decision, and which docs were updated.
