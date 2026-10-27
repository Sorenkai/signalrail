# Restricted: pending licence review

`signal-evidence.json` in this directory is derived from Network Rail **SMART** reference data. It holds raw berth step rows for TD area CL. Network Rail's licence and redistribution terms for SMART have not yet been confirmed (`data/sources.json`: `nr-open-data-feeds`, `licence.confirmed: false`).

Until they are, the file is kept local. It is git-ignored and must not be committed or published (DECISION_LOG D-016, D-019). This is a decision pending confirmation, not a statement that redistribution is prohibited.

If the file is absent (e.g. in a fresh clone), regenerate it from the owner's private SMART and CORPUS files:

```sh
npm run data:reconcile-signals -- --dataset carlisle --generated 2026-10-27
```

The other files here (`area.json`, `infrastructure.json` from OpenStreetMap under ODbL, and `playable-area.json`) contain no SMART data.
