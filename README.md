# Dropbox to Supabase backfill

Build work for the Dropbox to Supabase document backfill. Spec in
[`docs/CLAUDE_CODE_SPEC.md`](docs/CLAUDE_CODE_SPEC.md); where it disagrees with the older
build plan doc, the spec wins.

## Status

| Component | State |
|---|---|
| 1.1 Schema audit and mapping note | **done, awaiting review** -> [`docs/schema-map.md`](docs/schema-map.md) |
| 1.2 Alias and resolution layer | not started (gated on 1.1 review) |
| 1.3 Resolver | not started |
| 1.4 Intake and pipeline | not started |

Nothing has been written to the database. No migration has been applied. The audit was
read-only.

## Layout

```
docs/schema-map.md          the 1.1 deliverable: live schema audit and record-type mapping
docs/CLAUDE_CODE_SPEC.md    the build spec this work follows
seed/properties.csv         seed reference data, surrogate P0001-style ids, unchanged
seed/aliases.csv
seed/property_addresses.csv
seed/conflicts.csv          23 open name conflicts, DECISION columns blank, awaiting a human
```

The seed CSVs are committed exactly as supplied. The 1.2 loader maps their surrogate ids onto
real `property.id` uuids and reports every non-exact match instead of guessing.
