# Schema map: where each backfilled record type lands

**Status:** component 1.1 of the build spec. This is the gate deliverable. No pipeline code
has been written and no migration has been applied.

**How this was produced:** direct reads of the live `public` schema on the LeavenWealth
database (Supabase project `LW Data base`, ref `lhdpzalqrwepfjoicdiz`) on 2026-09-22, via
`information_schema.columns`, `pg_constraint`, `pg_indexes`, `pg_extension` and row-level
profiling queries. Nothing here is copied from the spec's summary table. Where the spec and
the live database disagree, the database is quoted below.

**Tenant:** one, `72381c81-af95-4e1d-ad0d-20a3a3421119`. Every `property` row carries it,
every `entity` row carries it. Several tables default `tenant_id` to that literal.

---

## 0. Corrections to the spec's opening table

The spec's row counts came from a stale source (`list_tables` reports planner estimates, not
real counts). Actual counts as of 2026-09-22:

| Table | Spec said | Actually | Why it matters |
|---|---|---|---|
| `property` | 168 | **167** | Minor, but the spec's number is not a checksum you can trust. |
| `document` | 0 | **8** | Not an empty target. Eight manual rows already exist with Dropbox share links in `storage_url` and `doc_type` values already in use. |
| `backfill_task` | 0 | **31** | **In active use as a live human work queue** (Jay and Mitch, areas: integrations, leads, subscribers, financials). It is not a free review queue to dump resolver output into. |
| `import_session_log` | 0 | **21** | In active use as a per-session narrative log, written by Jay and Mitch. |
| `data_exception` | 36 | **41** | In use, 26 open. |
| `loan_balance` | 41 | **91** | |
| `financial_account` | 256 | **258** | |
| `ownership` | 90 | **89** | |
| `statement` | not listed | **0** | Empty and unconstrained. See section 3. |
| `transaction` | not listed | **1** | Effectively empty. |
| `property_operations` | not listed | **14** | |

Two other things the spec asserts that the database contradicts:

- **`buildium_property_id` / `appfolio_property_id` are already protected.** Both columns
  exist, both are 100% null as the spec says, but partial unique indexes
  `uq_property_buildium` and `uq_property_appfolio` already exist. No migration needed for
  those two, only the data.
- **The duplicate-property list is partly stale.** See section 5.

---

## 1. Record type to table

One row per record type we intend to write from a Dropbox file.

| Record type | Target table | Uniqueness key enforced today | `property_id` column | Nullable? |
|---|---|---|---|---|
| The file itself | `document` | **none at all** (only `id`) | `property_id` | yes |
| Property-level financial period (EGI, NOI, occupancy, DCR) | `property_financials` | `(property_id, unit_id, as_of_date, accounting_basis)` NULLS NOT DISTINCT | `property_id` | yes, but a CHECK forces exactly one of property/unit |
| Loan balance as of a date | `loan_balance` | `(loan_id, as_of_date)` | none (goes via `loan_collateral`) | n/a |
| Bank / processor account balance | `account_balance` | `(account_id, as_of_date)` | none (via `financial_account.property_id`) | n/a |
| Bank or PM statement header | `statement` | **none at all** | `property_id` | yes |
| Statement line item | `transaction` | `(financial_account_id, external_id)` and `(source_system, external_id)`, both partial on `external_id IS NOT NULL` | `property_id` | yes |
| Insurance policy / SOV row | `insurance_policy` | **none at all** | `property_id` | yes, CHECK forces exactly one of property/unit |
| Unit / building | `unit` | `(property_id, unit_identifier)` | `property_id` | **no, NOT NULL** |
| Parcel number | `property_parcel` | `(tenant_id, parcel_number)` and `(property_id, parcel_number)` | `property_id` | yes |
| Entity owns property | `ownership` | `(entity_id, property_id)` | `property_id` | yes, CHECK forces exactly one of property/unit |
| Loan secured by property | `loan_collateral` | `(loan_id, property_id)` | `property_id` | yes, CHECK needs property or unit |
| Property operating detail | `property_operations` | `(property_id)`, one row per property | `property_id` | **no, NOT NULL** |
| PM system id | `property.buildium_property_id` / `.appfolio_property_id` | partial unique on each | n/a | n/a |
| Alias / name variant | **does not exist yet** | n/a | n/a | n/a |
| File content hash ledger | **does not exist yet** | n/a | n/a | n/a |

Reference tables (`property`, `entity`, `loan`, `financial_account`, `vendor`) are not write
targets for this pipeline beyond the PM ids. Their uniqueness keys: `property` is
`(tenant_id, dba_name)`, `entity` is `(tenant_id, name)`, `loan` has **none**.

---

## 2. Does a real export actually satisfy the key?

This is the question that decides whether an import can be re-run safely. Six of them fail.

**Satisfied.**

- `unit`: `(property_id, unit_identifier)`. A rent roll gives a unit number. All 268 existing
  rows have a non-null `unit_identifier`. Works, once the property resolves.
- `property_parcel`: `(tenant_id, parcel_number)`. A county or SOV export gives a parcel
  number. Caveat below.
- `property_financials`: `(property_id, unit_id, as_of_date, accounting_basis)` with NULLS
  NOT DISTINCT, so a null basis still collides correctly rather than duplicating. This is the
  best-designed key in the set. It needs a written convention for what `as_of_date` means for
  a period statement (period end, presumably) because the column is a single date and a PM
  statement covers a month.
- `ownership`, `loan_collateral`: link tables, keys are the two ids. Fine.
- `account_balance`: `(account_id, as_of_date)` is sound **given** the account resolves. It
  often will not, see below.

**Not satisfied.**

- **`document` has no uniqueness key at all.** Re-running the same Dropbox file creates a
  second row, silently. The spec's whole dedupe design (content hash, terminal state, moves
  firing the webhook again) has nowhere to live. There is no `content_hash` column anywhere
  in the database, and no `batch_id` column anywhere either. This is the single biggest gap.
- **`statement` has no uniqueness key at all** and zero rows. Same statement imported twice
  gives two headers and two sets of children.
- **`insurance_policy` has no uniqueness key** and no policy-number column at all. Carrier,
  premium, renewal date, limits, deductibles, but nothing identifying the policy. On the 257
  existing rows, `(property_id, carrier, renewal_date)` already collides in 26 groups, so
  there is no natural key to add retroactively either. An SOV re-import cannot be made
  idempotent as the table stands.
- **`loan` cannot be joined from a lender statement.** 72 of 75 loans have a null
  `loan_number`, and of the 3 that have one, two share the same value. So a loan balance
  extracted from a lender statement has no key to land on. `loan_balance` itself is keyed
  correctly, but getting to the right `loan_id` is the unsolved half.
- **`financial_account` cannot be joined from a bank statement.** 258 rows, no unique
  constraint on name, and 11 names are already duplicated. `account_number_last4` exists but
  last-4 is not unique across institutions. So `account_balance (account_id, as_of_date)`
  is a good key hanging off an unresolvable parent.
- **`property_parcel` caveat:** the seed `property_addresses.csv` contains combined values
  like `00584684 / 30030037` and `s 1713040001 & 1713040003` in the parcel column. Those are
  two parcels in one string. Loading them verbatim puts a value in the unique key that will
  never match a county export. They need splitting or rejecting, not loading.

---

## 3. Which existing table already covers what the plan proposed building

Four proposed-new components already exist. Use these, do not build parallel ones.

| The plan proposed | Already exists | Verdict |
|---|---|---|
| A row-level exception log | **`data_exception`** (41 rows, 26 open) | Use it. It already has `source_document`, `source_row`, `area`, `table_name`, `field_name`, `property_id`/`entity_id`/`loan_id`, `raw_value`, `issue_type` (CHECK: unparseable, ambiguous, conflicting, no_matching_record, out_of_range, needs_confirmation, duplicate), `suggested_value`, `owner` (defaults to Megan), `status`, `resolution`, `question`. Resolver Pass 2 output maps onto it cleanly: `issue_type='ambiguous'`, ranked candidates into `suggested_value` and `notes`. |
| A per-run import log | **`import_session_log`** (21 rows) | Use it. `operator`, `area`, `action` (CHECK: import, correction, cleanup, verification, analysis), `summary`, `records_inserted/updated/skipped`, `new_rules`, `follow_ups`. One row per pipeline run. |
| A human review queue | **`backfill_task`** (31 rows, live) | Use it **sparingly**. It is a real queue that two people work from. Write to it only for genuine human chase work ("find the missing operating agreement"), never for per-file resolver skips. Those belong in `data_exception` or the queue becomes unusable. |
| A webhook receipt store | **`webhook_events`** (`provider`, `event_type`, `external_id`, `payload jsonb`, `processed`, `error`, `processed_at`) | Use it for the Dropbox webhook. Currently only `provider='ghl'`. |
| A delta cursor store | **`sync_state`** (`key` PK, `cursor`, `last_run`, `status`, `last_error`, `started_at`, `finished_at`) | Use it for the Dropbox delta cursor. Existing key convention is colon-scoped, e.g. `ghl:<location>:contacts`, so `dropbox:<namespace>:delta` fits. |
| A field-level change log | **`sov_edit_log`** (`target_table`, `target_id`, `column_name`, `old_value`, `new_value`, `edited_by`) | Exists, empty. Worth considering before writing a new audit table. |
| A schema change log | **`schema_changelog`** (52 rows, in use) | Any migration we apply should get a row here, matching existing practice. |

**Answer to the spec's open question 2** (which of the three is the review queue): they are
not three candidates for one job, they are three layers, and all three are in use. Row-level
triage goes to `data_exception`, run-level narrative to `import_session_log`, human chase
work to `backfill_task`. I am recommending this rather than deciding it, since `backfill_task`
belongs to Jay and Mitch and they may want the resolver's output in front of them there.

---

## 4. What is actually missing, and would need an additive migration in 1.2

All additive. No existing column or constraint is altered or dropped.

1. **`alias` table**, per the spec's shape. Nothing like it exists.
2. **`pg_trgm` is not installed.** Installed extensions are `pg_stat_statements`, `pgcrypto`,
   `plpgsql`, `supabase_vault`, `uuid-ossp`. The spec's GIN trigram index on
   `alias_normalized` and the Pass 2 similarity scoring both need
   `CREATE EXTENSION pg_trgm`. That is a database-level change and needs the branch (the
   read/write connector rejects DDL by design).
3. **A file ledger.** No `content_hash`, `source_file_hash` or `batch_id` column exists
   anywhere in the database. Two options, and I would like a ruling before building either:
   - (a) add nullable columns to `document`: `content_hash`, `dropbox_path`, `dropbox_rev`,
     `size_bytes`, `batch_id`, plus a partial unique index on `(tenant_id, content_hash)`;
   - (b) a separate `ingest_file` ledger table that `document` references, keeping the
     pipeline's state machine out of a table humans also write to by hand.
   I lean to (b), because `document` already holds hand-entered rows with no hash and the
   ledger needs states (`seen`, `parsed`, `skipped`, `failed`, `terminal`) that are not a
   natural fit for a document record.
4. **`batch_id` + source-file linkage on written rows.** `statement`, `transaction` and
   `account_balance` already have `source_document_id` FKs to `document`, which is a better
   link than a raw hash and should be used. `property_financials`, `loan_balance`,
   `insurance_policy`, `unit`, `property_parcel` have no such column and would each need a
   nullable `source_document_id` plus `batch_id`.
5. **Idempotency keys for `statement` and `document`**, as above.

Not proposed: anything on `insurance_policy`. Adding a policy-number column is a real schema
question for whoever owns insurance data, and 257 existing rows would be null on it. Flagging
it rather than deciding it.

---

## 5. Resolver blockers found in the data

These feed component 1.3 directly, and some contradict the spec.

**The duplicate pairs.** Six of the spec's seven pairs are live and both rows exist. One is
not:

| SPE-level row | Parent-level row | Present? |
|---|---|---|
| Carter Place K (1003 Avenue K, LLC) | Carter Place (Midwest Portfolio 4 LLC) | both |
| Grandview / 15 Unit SC (15 Unit SC, LLC) | Grandview Apartments (Midwest Portfolio 4 LLC) | both |
| The Todd - Bldg 2 (1851 Todd Road, LLC) | The Todd (Midwest Portfolio 4 LLC) | both |
| College Heights KS (College Heights Partners LLC dba College Heights) | College Heights (Midwest Portfolio 5 LLC) | both |
| Indigo - 3009 Marcy (Marcy's Playground, LLC) | Indigo Apartments (Midwest Portfolio 2 LLC) | both |
| 15th Street 9 Plex (NCCS, held) | 316 East 15th Street (NCCS, sold) | both, status conflict as described |
| **Champion Villa** (Champion Villa, LLC) | Champion Villas (BG Champion Partners LLC) | **only the parent-level row exists.** The entity `Champion Villa, LLC` exists with zero properties. Someone already resolved this one, or the SPE row was never created. |

`Champion Villa` vs `Champion Villas` is still a required resolver test case per the spec's
definition of done, but the test now proves a near-miss name does **not** resolve, rather than
that a duplicate pair is vetoed.

**Multi-property entities (the veto that fires most).** 31 entities own more than one
property. The worst:

| Entity | Properties |
|---|---|
| Lincoln Portfolio, LLC | 16 |
| Hickman Partners LLC | 12 |
| 115 S 38th Street LLC | 7 |
| Red Park 2, LLC | 7 (spec said six) |
| Core Investments LLC | 6 |
| Midwest Portfolio 4 LLC | 5 |

`Eagle Annex, LLC` has 2, in two states, as the spec says. `Red Park, LLC` has exactly 1, so
`Red Park` and `Red Park 2` really do need to stay apart.

**Entities with zero properties.** `4542 West Kiest Blvd LLC`, `Midwest Portfolio 3 LLC`,
`Midwest Portfolio 6 LLC`, `Midwest Portfolio 7 LLC`, `Champion Villa, LLC`, `4542 Kiest TIC
2/3/4 LLC` all exist as entities with no property rows. The seed CSV has properties under
several of them (P0001 Estrella at Kiest, P0007, P0025, P0026, P0027, P0033). So the 1.2
loader will not be able to map those surrogate ids to a `property.id`, and per the spec they
go into a report rather than being guessed or created. Expect a meaningful non-match count.

**Address quality, confirmed.** `Langston Loge` street is `7118-7122` with no street name.
`Eagle Creek` city is `Brandon, SD 57005, USA`. `Carter Place` street is a full Google-format
string and its city is `Sioux City, IA, USA` while the asset is in Carter Lake, IA. 56
properties have a null city, 58 a null state, 61 a null zip. The corroboration half of Pass 1
(address match or city+state match) is therefore unavailable for roughly a third of the
portfolio, which means Pass 1 will skip them. That is correct behaviour, and it is worth
saying out loud now: the automation rate will be low at first and the fix is reference data,
not a looser rule.

**Unit counts.** Confirmed useless as a corroborator. The Preserve is 8 reported vs 248
verified, Langston Loge 35 vs 80, Villa Blanca 24 vs 39. The Todd - Bldg 2 is verified at 4
while the seed CSV says the whole Todd is 20, which is the building-versus-asset grain
problem in one row.

**Name normalization.** No two `property.dba_name` values collide after the spec's
normalization rules, so exact-normalized matching on property names is sound today. 18
properties have bracket disambiguators in `taxpayer`. `Sarpy Doulgas Investments LLC` is in
`entity` exactly as the spec warns. `2200 Ridgmar Plaza, LLC & Ridgmar Partners, LLC` is one
entity row holding two legal names, and it owns one property.

**Other consumers.** Views `v_property_held`, `v_loan_detail` and `v_capex_funding` read
these tables, which is a further reason nothing structural gets altered.

---

## 5a. Seed data state (updated 2026-09-22, second delivery)

`properties.csv` and `aliases.csv` were resent to correct a mistake in the first delivery.
The corrected files drop seven rows that were not properties at all, six of them spreadsheet
artefacts sitting in the `spe_legal_name` column (`Deleted Properties`, `2023 they no longer
own this property`, `2024 they no longer own this property`, and four rows of `24. Confirmed
properties were sold`). 126 property rows became 119, 429 alias rows became 422.

The two corrected files agree with each other exactly: every `property_id` in `aliases.csv`
exists in `properties.csv` and every property has at least one alias.

**`property_addresses.csv` was not resent and is now misaligned.** Dropping those seven rows
renumbered everything from `P0062` onward, and the address file still carries the old
numbering:

- 83 of its 305 address rows now point at the wrong property.
- 6 more rows are stranded on ids that no longer exist at all (`P0087`, `P0088`, `P0090`
  through `P0093`, which are real addresses: 4319-4325 S 22nd Street, 135 E Sheridan Street,
  4915/4917 Davenport Street, 3419 Dewey Avenue, 3146 Chicago Street).
- 7 ids in the address file (`P0120` through `P0126`) have no property row in the new file.
- 216 rows, everything up to `P0061`, are unaffected.

The worst single case: `P0117` is `15th Street 9 Plex` in Sioux Falls SD under the new
numbering, and the address file gives it `4541 Tranquility Drive - Garage 3` in Lincoln NE.
Loading it as it stands would attach a Lincoln garage to a Sioux Falls nine-plex, and the
address corroboration step in Pass 1 would then reject every genuine match for both.

`docs/seed-id-remap.csv` holds the full old-to-new correspondence. It is derived, not guessed:
the new file is the old file minus seven rows with order preserved, and every one of the 119
surviving rows was matched on `common_name`, `spe_legal_name` and `notes` together. It has
**not** been applied to `property_addresses.csv`, which is committed exactly as supplied. The
six stranded rows have no mechanical answer and need a human either way.


---

## 6. Questions I am raising rather than deciding

The spec's four, updated with what the audit found, plus three new ones.

1. **Portfolio-level financial statements.** A statement covering Midwest Portfolio 4 LLC
   (five properties) has no single `property_id`. `property_financials` requires exactly one
   of property or unit, so an entity-level row cannot be stored there at all. `statement` and
   `transaction` both have a nullable `entity_id`, so entity-level storage is possible there.
   Entity-level record, allocation rule, or manual handling?
2. **Review queue.** Recommendation in section 3. Confirm before I write to `backfill_task`.
3. **`unit_count_reported` vs `unit_count_verified`.** Still open. `property_unit_count_history`
   exists and is empty, which suggests someone intended to track the reconciliation.
4. **Are the duplicate property rows intentional?** Still open, and now sharper: the pairs
   are consistently SPE-row-has-clean-address plus parent-row-has-Google-format-address, and
   the verified unit count sits on the SPE row while the reported count sits on the parent
   row. That looks like two imports of the same asset from two sources, not a deliberate
   reporting design. Champion Villa suggests one has already been cleaned up.
5. **New: how should a loan balance find its loan?** 72 of 75 loans have no loan number. Until
   that is fixed, loan balances cannot be auto-written from lender statements at all.
6. **New: how should a bank statement find its account?** 258 accounts, 11 duplicate names, no
   unique key. Same problem.
7. **New: file ledger shape.** Option (a) or (b) in section 4. I lean to (b).
8. **New: `property_addresses.csv`.** Regenerate it on the new numbering, or apply
   `docs/seed-id-remap.csv` to the copy in `seed/`? And what should happen to the six address
   rows whose property rows were dropped as artefacts? See section 5a.

---

## 7. What I have not done

Per the spec's gate, no pipeline code, no migration, no writes to production, and no answers
to the 23 conflicts in `conflicts.csv`. The seed CSVs are committed under `seed/` unchanged
for the 1.2 loader to consume.
