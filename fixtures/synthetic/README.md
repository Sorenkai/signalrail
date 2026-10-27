# Synthetic fixtures

**Everything in this directory is synthetic test data. None of it describes a real railway.**

- TIPLOCs use the reserved-looking prefix `SYN` (`SYNA`, `SYNB`, …) and do not exist in the real network.
- Train UIDs start with `Z9` and headcodes with `0Z`. Neither should be read as a real service.
- Provenance cites the source id `synthetic-fixture`. The validator rejects that source in real datasets unless `allowSynthetic` is set, which only the tests do.

Use these fixtures only to exercise parsers and validators.
