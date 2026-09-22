# Dropbox → Supabase Backfill: Claude Code Build Spec

**Companion to:** the build plan doc (Dropbox → Supabase Backfill: Build Plan). Read it first. Where this spec and the plan disagree, this spec wins, because it was written after the schema audit and the plan was not.

**Scope of this spec:** only the work that needs a repo. The reference-data reconciliation is being done separately and is not your job. Do not invent reference data.

---

## 0. Read this before writing code

### The schema already exists and is populated

A live audit on 2026-09-22 found the target tables already built and holding data. Any plan that says "create a properties table" is out of date. The relevant tables:

| Table | Rows | Role |
|---|---|---|
| `property` | 168 | One row per building/asset. PK `id` uuid. Unique on (`tenant_id`, `dba_name`). |
| `entity` | 110 | Legal entities. PK `id` uuid. Unique on (`tenant_id`, `name`). Self-FK `parent_entity_id`. |
| `document` | 0 | Target for Dropbox files. FKs to property, entity, loan, vendor, staff, financial_account. Has `ingestion_method`, `storage_url`, `document_date`. |
| `backfill_task` | 0 | Already shaped like a review queue: `area`, `entity_id`, `property_id`, `loan_id`, `title`, `source_document`, `owner`, `status`, `blocked_reason`, `question`. |
| `data_exception` | 36 | Existing exception log. Inspect before designing a new one. |
| `import_session_log` | 0 | Existing, empty. Inspect before designing a new one. |
| `unit` | 268 | Unit-level rows. |
| `property_parcel` | 295 | Parcel numbers, separate from property. |
| `loan`, `loan_balance`, `loan_collateral` | 75 / 41 / 57 | |
| `financial_account`, `account_balance` | 256 / 441 | |
| `insurance_policy` | 257 | |
| `ownership`, `investor_stake` | 90 / 0 | |

`property.entity_id` → `entity.id`. Single `tenant_id` in use.

**Your first task is to read these tables yourself and write up what you find.** Do not trust this table; it is a summary made at one point in time.

### `buildium_property_id` and `appfolio_property_id` exist and are 100% null

Both columns are on `property`. Populating them is higher leverage than every alias rule in the plan combined, because a PM export carries its own system ID and joining on that removes name matching entirely for those files. Treat backfilling these two columns as a first-class deliverable, sourced from the PM systems' own property lists, confirmed by a human once per property.

### There are already duplicate property rows

The same physical asset exists twice, once under its SPE and once under its parent portfolio entity. Confirmed pairs:

| SPE-level row | Parent-level row | Same asset |
|---|---|---|
| Carter Place K (1003 Avenue K, LLC) | Carter Place (Midwest Portfolio 4 LLC) | 1003 Avenue K, Carter Lake IA |
| Grandview / 15 Unit SC (15 Unit SC, LLC) | Grandview Apartments (Midwest Portfolio 4 LLC) | 301 21st St, Sioux City IA |
| The Todd - Bldg 2 (1851 Todd Road, LLC) | The Todd (Midwest Portfolio 4 LLC) | 1851 Todd Rd, Manhattan KS |
| Champion Villa (Champion Villa, LLC) | Champion Villas (BG Champion Partners LLC) | 3220 Champion Drive |
| College Heights KS (College Heights Partners LLC) | College Heights (Midwest Portfolio 5 LLC) | 1947 College Heights Rd |
| Indigo - 3009 Marcy (Marcy's Playground, LLC) | Indigo Apartments (Midwest Portfolio 2 LLC) | 3009 Marcy St |
| 15th Street 9 Plex (NCCS, held) | 316 East 15th Street (NCCS, sold) | 316 E 15th St — status conflict |

**Do not merge these.** Flag them. A human decides which row survives. Until then, any file resolving to one of these names is ambiguous and must not auto-write.

### Known data quality facts you will hit

- `street` sometimes holds a full Google-formatted address with `city` and `state` null. Sometimes it holds a bare street. `Langston Loge` has street `"7118-7122"` with no street name. `Eagle Creek` has city `"Brandon, SD 57005, USA"`.
- `unit_count_reported` and `unit_count_verified` disagree badly on many rows: Brent Village 12 vs 180, The Preserve 8 vs 248, Copperleaf 26 vs 87, Villa Blanca 24 vs 39. Do not use unit count as a hard corroborator. Use it only as a soft tiebreaker with wide tolerance, and prefer `unit_count_verified` when present.
- `taxpayer` contains bracket-disambiguated strings like `"BG Champion Partners LLC [1]"`, `"Midwest Portfolio [1] LLC [1]"`, `"Eagle Annex Partners LLC [2]"`. That notation is not a legal name. Strip it when matching; never write it.
- `entity.name` uses comma-before-LLC styling (`1003 Avenue K, LLC`) where other sources do not. Normalization must handle it.
- `Sarpy Doulgas Investments LLC` is a typo for Douglas and it is in the database. Do not silently correct it. Add the correct spelling as an alias.
- `2200 Ridgmar Plaza, LLC & Ridgmar Partners, LLC` is one `entity.name` holding two legal entities.

---

## 1. What you are building

Four components, in this order. Stop at each gate.

### 1.1 Schema audit and mapping note (do this first, then stop)

Read the live schema. Produce `docs/schema-map.md` answering, for each record type we intend to backfill:

- Which table does it land in?
- What is the uniqueness key, and does a real export actually satisfy it?
- Which column carries `property_id`, and is it nullable?
- Does an existing table (`data_exception`, `import_session_log`, `backfill_task`) already cover what the plan proposed building new? If so, use it.

**Gate: stop and hand this back for review before writing any pipeline code.** Everything downstream depends on getting this right, and it is cheap to correct now.

### 1.2 Alias and resolution layer

New tables (migration, additive only, no changes to existing tables except adding columns):

```
alias
  id, alias_text, alias_normalized, alias_level, 
  property_id  -> property(id)   nullable
  entity_id    -> entity(id)     nullable
  auto_write_ok boolean not null default false
  valid_from date, valid_to date
  source text, confirmed_by text, confirmed_at timestamptz
  exactly one of property_id / entity_id must be set
```

`alias_level` ∈ `spe | property | dba | nickname | parent | former`.

Indexes: unique on (`alias_normalized`, `alias_level`) where `auto_write_ok`; `pg_trgm` GIN on `alias_normalized`.

Seed data will be supplied as CSVs (`aliases.csv`, `properties.csv`, `property_addresses.csv`) keyed on a surrogate `P0001`-style id. **You must write a loader that maps those surrogate ids onto the real `property.id` uuids**, by exact normalized name against `entity.name`, `property.dba_name` and `property.trade_name`. Anything that does not map exactly goes in a report for a human, not a guess.

Normalization rules (implement once, test heavily):
- NFKC, collapse whitespace, strip non-breaking spaces
- strip legal suffixes: LLC, L.L.C., Inc, LP, LLP, Ltd, Co
- strip leading `The`
- strip bracket disambiguators `[n]`
- strip parentheticals, but keep the parenthetical as a separate candidate alias
- lowercase, strip punctuation

### 1.3 Resolver

Two passes, tight first. Pass 1 is the only pass that writes.

**Pass 1 requires both:**
1. Exact match on `alias_normalized` at level `spe` or `property`, `auto_write_ok = true`, valid for the file's period.
2. Corroboration: extracted address matches the property's street (normalized, compare first comma-delimited segment), or city and state both match.

**Hard vetoes — skip even on a clean name hit:**
- Match resolved at `parent` level
- Target entity has more than one property (`Red Park 2, LLC` has six; `Midwest Portfolio 4 LLC` has five; `Eagle Annex, LLC` has two in two different states)
- Target property is in the known-duplicate list above
- Extracted name contained a parenthetical qualifier, a newline, or a `/` joining two entities
- Any extracted field contradicts the stored value
- No determinable period on a period-keyed record type

**Pass 2** runs only on skips, writes nothing, produces ranked candidates with scores using `pg_trgm` on names plus partial address. Output goes to the review queue.

Do not use embeddings for matching. `Red Park, LLC` and `Red Park 2, LLC` are near-identical in vector space and are different companies.

### 1.4 Intake and pipeline

Dropbox Feed → Migrated → temp skip. Folders are a human signal; the ledger is state.

- Content-hash every file. Hash in the ledger before anything else. Same hash, already terminal → do nothing.
- Webhook gives you "folder changed", not which file. Use a delta cursor, stored durably, with a full-list fallback on cursor error.
- Check `size` and `rev` twice a few seconds apart before processing, so a still-uploading file is not parsed half-written.
- Moves fire the webhook too. Hash dedupe is what stops the loop.
- Team namespace uses a different root id than a personal account. Confirm which applies.
- One transaction per file. Partial import is worse than clean rejection.
- Every written row carries `batch_id` and `source_file_hash`.

Classifier then per-format parser. **No fallback parser.** Unrecognized → skip untouched.

Legal documents (DOCX, operating agreements, trust docs) are out of the write path entirely. Hash, file into `document`, link where confident, no structured extraction.

OCR output never auto-writes numeric financial values.

---

## 2. Things you must not do

- **Do not answer the 23 open name conflicts.** They are in `conflicts.csv` with blank DECISION columns awaiting a human. If a conflict blocks you, leave the alias non-auto and move on.
- **Do not merge the duplicate property rows.** Flag them.
- **Do not write to production.** Work against a Supabase branch or local instance until the pilot gate. The plan's rollback procedure is untested; do not be the one who tests it in production.
- **Do not modify existing table structures** beyond adding nullable columns. `property`, `entity`, `unit`, `loan` and friends have data in them and other consumers.
- **Do not invent reference data.** If a property has no address on file, that is a reference gap to report, not a value to infer.
- **Do not loosen pass 1 to raise the automation rate.** If the queue is long, that is the correct behaviour of a correct system.

---

## 3. Definition of done per component

- **1.1** `docs/schema-map.md` exists, names a target table and uniqueness key per record type, and flags anything the plan proposed that duplicates an existing table.
- **1.2** Migration applies cleanly on a branch. Loader maps the seed CSVs onto real uuids and reports every non-exact match rather than guessing. Normalization has unit tests covering: comma-LLC, bracket disambiguators, non-breaking spaces, leading The, the `Sarpy Doulgas` typo.
- **1.3** Resolver runs against a fixture set. Every veto has a test that proves it fires. Specifically test: `Eagle Annex, LLC` (parent-level, two states), `Red Park 2, LLC` (six properties), `Champion Villa` vs `Champion Villas` (duplicate pair), `4542 West Kiest Blvd LLC (majority owner)` (qualifier).
- **1.4** Dry-run mode produces a full report over a real corpus copy with zero writes and zero file moves.

---

## 4. Open questions to raise rather than decide

1. A financial statement covering a whole portfolio entity (Midwest Portfolio 4 LLC, five properties) has no single `property_id`. Does it get an entity-level record, an allocation rule, or manual handling? The plan does not answer this and it will come up immediately.
2. Which of `data_exception`, `import_session_log`, `backfill_task` is the intended review queue? All three exist and two are empty.
3. `unit_count_reported` vs `unit_count_verified` disagree on most rows. Which is authoritative?
4. Are the duplicate property rows intentional (SPE-level and portfolio-level reporting both wanted) or accidental?
