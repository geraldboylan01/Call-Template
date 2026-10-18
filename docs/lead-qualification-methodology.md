# Internal lead qualification pilot

Rules: `lead-qualification-1.0.0`. Price schedule: `lead-prices-pilot-1.0.0`.
This subsystem prepares internal, human-reviewed assessments. It does not send
financial profiles to an adviser, charge introduction fees, or infer a
conversion probability. An education call and an adviser introduction are
different services; paying for the former never qualifies someone for the latter.

## Money available for an adviser

For each distinct holding, using integer EUR cents:

```text
owned value = floor(whole holding value × participating ownership share / 10,000)
net available = max(0, owned value − confirmed deductions)
holding pFUM = min(net available, consumer-confirmed available amount)
pFUM within 12 months = sum of eligible holding pFUM
```

`ownershipShareBps` uses basis points: `10000` means 100%, `5000` means 50%.
The share concerns the owners participating in this introduction, not each owner
individually. A €100,000 jointly held account with both owners participating is
one €100,000 holding. With only a confirmed 50% participating share, it is
€50,000 before deductions. Every deduction and the available-amount cap must be
stated on that same participating-share basis.

The available amount replaces an invented “manageable fraction”. For €250,000
owned cash, €100,000 reserved and €150,000 confirmed available, the contribution
is €150,000. There is no multiplier for worry, AI confidence, likelihood of
conversion, or financial need.

| Asset | Pilot treatment |
| --- | --- |
| Cash, deposits, money-market funds | Available amount after reserves and commitments |
| Funds, ETFs, bonds, shares | Confirmed amount that this adviser can manage within 12 months |
| PRSA, personal pension, buyout bond, occupational DC pension | Only after explicit eligibility and manageability review; type alone proves neither |
| Defined-benefit, State Pension and annuity income | Excluded; never capitalise income into FUM |
| Home, other property, business or farm value | Excluded as gross illiquid wealth |
| Property/business sale proceeds | Reviewed proceeds within the horizon, net of related debt, sale costs, tax and replacement needs |
| Inheritance | Received eligible money may count; uncertain future inheritance does not |
| Salary, future contributions, borrowing capacity | Excluded; these are future capacity, not existing assets |
| Crypto, collectibles, personal possessions | Excluded in this pilot; realised eligible cash can be assessed as a new position |
| Funds already managed by the named recipient | Excluded from new FUM |

Assets need confirmed identity, valuation, participating ownership, available
amount, 12-month availability, recipient-specific eligibility, and confirmation
evidence. Deductions need their own confirmed amounts. Unknown facts remain
`unassessed`; they contribute nothing to the known subtotal and block the fee
quote. They must never be presented as assets worth zero. Non-EUR holdings need
a reviewed EUR figure: the engine performs no FX conversion. For an explicit
value range, a reviewer may use its confirmed lower bound and record that basis
in evidence; the engine does not invent a midpoint.

Each row has a stable `holdingId` and one or more `{collection,id}` source
references. Repeated holdings, references and deduction IDs are rejected. An
asset with multiple representations must become one row carrying all aliases,
with `identityConfirmed: true`. Sale proceeds identify their original holding
using `representsProceedsOf`; the original and its proceeds cannot both appear.
Different labels or IDs do not prove that holdings are distinct: human review
must resolve generic-asset versus specialist-pension/property duplicates before
confirming identity. Allocate each reserve/debt to one row; never deduct an
aggregate reserve and its component reserves again. Ordinary unrelated debts
are not automatically subtracted from every asset.

`prefillQualificationAssets()` accepts an authorised canonical profile and/or
verified native balance-sheet inputs. It never confirms availability, ownership
share, identity or eligibility. It does not infer an empty balance sheet from
missing profile data. Completed module outputs are not an asset ledger; the
current live planner may keep verified native inputs separately from canonical
profile collections. Generic pension/unknown types remain unassessed until
classified. Prefill conflicts return warnings and must be reviewed.

## Readiness and pilot prices

| Confirmed fact | Points |
| --- | ---: |
| Requests adviser introduction | 20 |
| Willing to meet | 10 |
| Consumer-confirmed adviser meeting, booked or already held | 10 |
| Decision within six months | 15 |
| Specific decision/event confirmed | 10 |
| Named adviser offers the required service | 10 |
| Meets that adviser's confirmed minimum | 10 |
| Contact route verified | 5 |
| Complete asset review confirmed by consumer | 5 |
| Relevant profile reviewed within the preceding 30 days | 5 |

Priority requires at least 80 points **and** requested introduction, willingness
to meet, confirmed adviser meeting, verified contact, confirmed asset review,
service fit, adviser minimum and a current profile review. Unknown facts score zero; the points are pilot
rules, not learned probabilities. The weights produce scores in multiples of
five; the threshold predicate nevertheless rejects 79 and accepts 80 when all
mandatory conditions hold. A cancelled meeting or an educational Zoom session
does not earn the adviser-meeting points or satisfy that condition.

An internal readiness classification is not a billable lead. A quote additionally
requires a completed asset review with no unassessed holdings, requested
introduction, verified contact, confirmed recipient fit/minimum, and current,
explicit sharing consent naming the same recipient. Existing education-call
permission must not be copied into that consent. The consent purpose must be
`adviser_introduction`, with `sharedDataCategories` explicitly including
`contact`, `asset_availability` and `qualification`. The current handoff shares
contact/request information; this engine does not broaden its scope.

| pFUM | Standard | Priority |
| --- | ---: | ---: |
| €50,000–<€100,000 | €165 | €215 |
| €100,000–<€250,000 | €235 | €305 |
| €250,000–<€500,000 | €350 | €455 |
| €500,000–<€1,000,000 | €500 | €650 |
| €1,000,000+ | €750 | €975 |

These are proposed pilot introduction prices, excluding VAT where applicable,
not validated willingness-to-pay or live charges. Priority adds 30% to the band
price, rounded to the nearest €5. Below €50,000 there is no quote from this
schedule. All published calculations and rounding use integer cents.

## Admin interface, storage and verification

- `GET /api/advisor/leads/:id/qualification` returns the latest assessment and up
  to 100 recorded outcomes. `POST` takes `{assessmentId?, assessment}` and saves
  an immutable assessment. The server owns `assessedAt` and computes results.
- An assessment has `schemaVersion:1`, `participatingOwnerIds`, `adviser`,
  `assets`, `assetReviewComplete`, `consumerConfirmedAt`, `readiness`, and
  `consent`. The normalizer in `js/planning/lead_qualification.js` is the exact
  field contract. Missing confirmations are represented as `null`/`false`.
- `GET /api/advisor/qualification/ranking` returns the eligible internal queue
  and counts of assessed/eligible/needs-review leads. It uses each lead's latest
  saved assessment, re-evaluated at the current time. Priority comes first, then
  readiness score descending, then oldest named-recipient introduction consent
  (`requestedAt`), with lead ID as the stable
  final tie-break. pFUM is displayed separately rather than used to alter the
  readiness order. A profile review over 30 days old loses Priority; a newer
  assessment with withdrawn consent removes the lead from the queue. This
  endpoint shares no asset ledger and performs no billing or distribution.
  Original pipeline creation time is returned separately as `leadCreatedAt`;
  an earlier education-call request never advances a later adviser introduction.
- `POST /api/advisor/leads/:id/qualification/outcomes` takes
  `{eventId?, assessmentId, event, occurredAt, amountCents?, notes?}`. Events are
  `contacted`, `meeting_held`, `client_won`, `funds_transferred`, `closed_lost`.
  Only transferred funds have an EUR amount. Outcomes describe observed history;
  they do not rewrite the assessment or trigger billing.
- Optional opaque IDs make retries idempotent; reusing an ID for different input
  returns 409. All routes require configured, authenticated adviser access and
  POST requires the host's CSRF guard. The API is internal: availability flags
  and consent must record facts reviewed by a human, never generated wishes.
- Migration `0022_lead_qualification.sql` adds encrypted assessments/outcomes to
  `LEADS_DB`. Snapshot values, assets, scores, fees, notes and outcome amounts
  stay inside authenticated encryption. Only IDs, version, digest and creation
  time are indexed. Lead deletion cascades to these tables.
- `QUALIFICATION_DATA_ENCRYPTION_KEY` and optional key ID/previous-key JSON can
  provide a dedicated key. Otherwise the existing application encryption
  configuration is reused with an isolated additional-authenticated-data prefix.
  When changing to a dedicated key, retain the former key ID/material in the
  qualification previous-key map so old snapshots remain readable. No new key
  is created by these endpoints.
- Saved assessments are historical snapshots. Reassess assets, appointment and
  consent before any future live delivery/charge; this pilot performs neither.
  Database storage/retention and consumer data rights must include these new
  records before external commercial use. The pilot has no background ML,
  marketplace routing or automatic deletion deadline.

Run `node scripts/check-lead-qualification.mjs` for the independent cents
examples, ownership/reserve/proceeds tests, all price-band boundaries, Priority
gates, unknown/consent exclusions, encrypted persistence, retry and outcome checks.
Later analyse meetings, clients won and actual transferred funds by asset band
and classification before claiming that a 30% Priority premium is justified.
