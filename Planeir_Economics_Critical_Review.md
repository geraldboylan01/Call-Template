# Planéir Fact-Find Economics — Critical Review

*A deliberately sceptical read of `Planeir_Fact_Find_Economics_Model.xlsx` against what the Call-Template repo is actually building. Prepared for Gerry, July 2026. Brief: don't oversell — stress the numbers, the product, and the market.*

---

## Bottom line

The **problem** the model points at is real and well-evidenced. Advisers genuinely lose ~40% of their week to fact-find and suitability admin, so a tool that removes that time has a legitimate reason to exist.

The **economics as modelled are not yet a business case.** On the model's own figures, at €200/seat/month the tool only *breaks even* on hard labour cost (1.03x), and it does that only in the base case — across most of the plausible input range it is underwater. The headline that makes it look attractive (3.8x) rests entirely on "capacity value," a soft number that assumes freed hours are re-sold at full charge-out rate. For most practices that assumption does not hold.

And the **competitive and product context is the harder problem than the spreadsheet.** The exact job this model monetises — cutting fact-find and suitability admin — is the single most crowded corner of adviser AI right now (Aveni, AdvisoryAI, Saturn), and those players are UK/VC-funded, CRM-integrated, and *already claiming ~90% time reduction* versus the model's 50%. Meanwhile the live Planéir product is a free one-to-one consumer education service run by one QFA — a different business from the multi-adviser B2B SaaS the spreadsheet prices.

None of this means "don't build it." It means the value story in this model is aimed at the weakest, most contested part of the pitch. The defensible edge — visual client-facing education and Irish-tax specificity — isn't in the spreadsheet at all.

---

## What the model actually claims

| Metric | Base case |
|---|---|
| Work per fact-find cycle | 3.75 hrs (1.25 meeting + 2.5 analysis) |
| Internal economic cost per cycle | €206 |
| "Commercial capacity value" per cycle | €762 |
| Cycles / adviser / year | 24 |
| Time reduction from Planéir | 50% |
| Price | €200 / seat / month (€2,400/yr) |
| **Annual internal saving / adviser** | **€2,472 → 1.03x ROI** |
| **Annual "capacity released" / adviser** | **€9,150 → 3.81x ROI** |
| Ireland TAM / SAM / SOM | €2.55m / €1.53m / €76k |
| UK TAM | €89.9m |
| Europe proxy TAM | €240m |

I rebuilt every formula independently — the arithmetic is correct and internally consistent. The problems are in the assumptions and the framing, not the maths.

---

## What is genuinely good here

Worth saying plainly, because it matters for investor credibility:

- **It is honest.** Confidence levels are labelled, sources are cited, and the limitations section admits conversion, analysis time and utilisation are assumptions, not Irish facts. That intellectual honesty is an asset — most founder models hide this.
- **It is conservative in the right places.** 24 cycles/year, a 1,061-seat Irish base, and a 50% (not 90%) reduction are all defensible, restrained choices.
- **The unit-cost engine is sound.** Loaded hourly cost (€48.56 gross → €69.37 net productive) and the €250/€150 charge-out rates are reasonable and Irish-sourced.
- **The underlying pain is real.** Third-party benchmarks back the premise: suitability reports alone take 4–6 hours each and consume 10–15 hours/week — nearly 40% of an adviser's week. So the *time-saving thesis is directionally correct.*

---

## Where the economics are fragile

### 1. The honest ROI is breakeven, and the price captures ~97% of the value it creates

The hard-cost saving is €2,472/yr; the subscription is €2,400. **Planéir is charging the customer 97% of the hard money it saves them.** Software is normally priced at 10–30% of the value it delivers. At 97% capture there is almost no hard-dollar surplus left for the buyer, which means the entire purchase decision has to be carried by the *soft* benefits. That's a fragile place to price from.

### 2. The attractive multiple (3.8x) depends on an assumption most firms can't meet

"Capacity value" values every freed hour at the €250/€150 charge-out rate. That only becomes real money if the adviser (a) has unmet client demand queued up to fill the freed time, and (b) actually bills for that time. Commission/product-based advisers, or anyone not capacity-constrained, convert freed hours into *coffee, not revenue.* The 3.8x is a ceiling almost no one reaches, not a base case.

### 3. Under conservative inputs, the hard-cost case collapses

Same model, just moving the reduction rate and cycle count within the model's own low/high bounds:

| Time reduction | 18 cycles | 24 cycles | 36 cycles |
|---|---|---|---|
| 25% | 0.39x | 0.52x | 0.77x |
| 50% | 0.77x | **1.03x** | 1.55x |
| 75% | 1.16x | 1.55x | 2.32x |

Everything below the bold cell is a customer *losing money* on hard cost. The base case sits right on the knife-edge. A tool that only pays for itself in the top-right of its own sensitivity table is a hard sell.

### 4. A single-purpose tool is priced at the top of the market

Benchmarks for adviser software: FE CashCalc ~£75/mo (cashflow), Plannr ~£140/mo (full CRM+workflow), a full stack "comfortably three figures per seat/month" *across several tools.* At ~£170, €200/seat prices a *point solution* like a whole platform. Advisers already pay Intelliflo/CashCalc/etc., so Planéir is additive spend that must either displace an incumbent or justify a premium — while claiming a smaller time saving than the AI tools below.

---

## The product ↔ model mismatch

This is the gap I'd flag hardest. The spreadsheet prices a **B2B multi-adviser SaaS** (seats, TAM/SAM/SOM, firm-level ROI). The live product in the repo and on the landing page is a **free one-to-one consumer education service** run by a single QFA (you), explicitly "education only, not regulated advice," with no revenue model attached.

Those are two different companies:

- *Free B2C education* needs an audience and an eventual monetisation path (lead-gen into advice? paid tier?). None is in the model.
- *B2B adviser SaaS* needs a sales motion, CRM integrations, compliance/data-processing sign-off, multi-tenant security, and support — none of which a free consumer call service builds muscle for.

The repo shows heavy investment in the consumer journey, video capture and a Codex hand-off — impressive, but pointed at the B2C education experience, not at the B2B fact-find SaaS the economics model sells. Before trusting the model, decide which company Planéir is. The spreadsheet is quietly assuming a pivot that the product hasn't made.

---

## Market-size reality

**Ireland alone cannot support this as a venture.** The SOM is €76k/year — about **32 adviser seats.** Even the full Irish SAM (€1.53m) is ~637 seats. That's a lifestyle-scale SaaS at best, and that's *before* churn, discounting or the fact that you're one person selling it.

On the seat base itself: 1,061 (FPSB certified holistic planners) is a reasonable *narrow* definition. The broader pool is bigger — Brokers Ireland represents 1,200–1,250 firms, and there are 22,000+ QFA holders in Ireland — but stretching the denominator to all QFAs would be overselling, because most of them aren't doing holistic, fact-find-heavy advice. So the model is honest here, but the honest number is *small.*

**The real prize is UK (€89.9m) and Europe (€240m)** — and that's precisely where the entrenched competition lives. You can't have the big TAM without fighting the incumbents in the next section. The Irish numbers are a beachhead, not a market.

---

## Competitive environment — the part the model ignores

The model has no competition line, and that's its biggest blind spot. "Reduce fact-find and suitability admin with AI" is the most crowded category in adviser tech right now:

- **Aveni (Aveni Assist)** — generates suitability reports/letters/reviews from existing templates, pulling from meetings, CRM and fact-finds; integrates with Intelliflo Office and Xplan; markets "cut admin by 90%" and 90 min → 10 min on suitability reports. UK-focused, funded.
- **AdvisoryAI (Emma & Evie)** — suitability writing plus meeting notes and fact-find updates, with *published* per-seat monthly pricing.
- **Saturn** — meeting assistance and fact-check against suitability reports.

Two hard implications:

1. **They claim more value than Planéir's model assumes.** These tools advertise ~90% admin reduction; the model banks on 50%. Planéir is pricing at the *premium* end while promising *less* time saved than incumbents — on the exact axis they compete on.
2. **They're already integrated where the data lives.** Their moat is CRM integration (Intelliflo, Xplan). A standalone Irish fact-find tool starts behind on the one thing that makes these tools sticky.

Competing head-on on "admin reduction" means fighting better-funded, better-integrated players with a weaker headline number. That's the losing ground.

---

## The reframe that actually helps (without overselling)

The model buries its own best argument. The cost story is thin; the **revenue story is where the money is** — and the model already contains the ingredients:

- Internal cost per *converted* client: €687. Capacity value per converted client: €2,542. A converted advice client is worth vastly more than the €206 of admin a fact-find costs.
- So even a **small conversion lift outweighs the entire admin saving.** Moving conversion from 30% to 33% on 24 fact-finds is ~0.72 extra clients/year. At a conservative €1,500–3,000 of first-year value per client, that's **€1,080–2,160/year — rivalling the whole subscription, from conversion alone** — on top of any time saved.

That's the honest pitch: *Planéir isn't primarily a cost-cutter, it's a conversion and client-experience tool* — the visual "see your options, not just the maths" layer and Irish-tax-specific calculators are things Aveni/AdvisoryAI don't do. That's the differentiated ground.

**The catch, stated plainly so this stays honest:** conversion lift is the *least evidenced* number in the whole model (flagged "Low–Medium," no Irish data). The reframe increases the upside *and* the burden of proof. It's a hypothesis to test in a pilot, not a claim to put on a slide yet.

---

## What to prove before believing this model

1. **Actual hours saved** in a real practice — is it 50%, or the 20–30% that's more typical once review/QA is included?
2. **Conversion lift** — the single highest-value, least-proven number. Even 2–3 points changes the entire case.
3. **Willingness to pay €200 as *additional* spend** on top of an existing software stack, or evidence it displaces one.
4. **Whether freed capacity converts to revenue** for the target firm, or just to slack — this decides whether "capacity value" is real or decorative.
5. **A defensibility answer to Aveni/AdvisoryAI** — why an Irish adviser picks a standalone fact-find tool over a CRM-integrated incumbent claiming 90%.

Until at least (1) and (2) have pilot data, treat the spreadsheet as a *well-built hypothesis,* not a forecast.

---

## Sources

- [FPSB Ireland — certified planner base](https://www.fpsb.ie/about-us.html)
- [Central Bank of Ireland — Brokers / Retail Intermediaries](https://www.centralbank.ie/regulation/industry-market-sectors/brokers-retail-intermediaries) · [Brokers Ireland (1,200+ member firms)](https://brokersireland.ie/)
- [IOB — Qualified Financial Adviser (22,000+ QFA holders)](https://iob.ie/areas/qualified-financial-advisor)
- [FCA — Retail intermediary market data 2024 (UK adviser posts)](https://www.fca.org.uk/data/retail-intermediary-market-data-2024)
- [FE CashCalc — pricing/product](https://www.fefundinfo.com/products/financial-advisers/fe-cashcalc) · [What adviser software actually costs in the UK](https://wealthr.co.uk/blog/what-adviser-software-costs-uk) · [intelliflo](https://www.intelliflo.com/)
- [Aveni Assist — "cut admin by 90%"](https://aveni.ai/financial-adviser/) · [Aveni — suitability report time, manual vs automated](https://aveni.ai/blog/time-required-write-suitability-reports-manual-vs-automated/) · [Aveni — 7 best AI tools for UK advisers](https://aveni.ai/blog/7-best-ai-tools-for-uk-financial-advisers-in-2026/)
- [AdvisoryAI — paraplanner/suitability tools & pricing](https://advisoryai.com/pricing) · [Saturn](https://www.saturnos.com/)
- [Kitces — how advisers spend their time](https://www.kitces.com/blog/how-do-financial-advisors-spend-time-research-study-productivity-capacity-efficiency/) · [befree — paraplanning cost per suitability report](https://befreeltd.com/uk/resources/blogs/paraplanning-cost-per-report-ifa-budget/)
- Internal: `Planeir_Fact_Find_Economics_Model.xlsx`, repo `README.md` and landing page (`index.html`)

*Not financial or investment advice — an analytical review of your own model and market.*
