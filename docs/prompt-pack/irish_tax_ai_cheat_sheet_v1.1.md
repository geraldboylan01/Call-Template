# Irish Tax Relief & Scenario Logic Cheat Sheet
**Purpose:** project reference for an AI assistant.  
**Source base:** derived from the uploaded lecture solution workbooks on CGT, CAT and corporate tax.  
**Use case:** when the AI sees a fact pattern similar to the workbook scenarios, it should apply the logic below before drafting an answer.

## 1) How the AI should use this sheet
1. Identify the tax head first: **CGT**, **CAT**, **Corporation Tax**, or a combination.
2. Then check whether a **specific relief** is in point before doing any computation.
3. Do **not** jump straight to arithmetic. First test the conditions.
4. Where a relief only applies to part of the asset/business, calculate the **qualifying proportion first**.
5. Treat **rates, thresholds and annual exemptions as year-sensitive inputs**.  
   The workbook logic is reliable, but some thresholds differ by tax year.  
   The AI should therefore:
   - use this sheet for the legal/computational logic, and
   - use the correct tax-year parameters separately.

---

## 2) Core CGT rules that recur across the workbooks

### 2.1 Basic CGT computation
Use the standard structure:
- Disposal proceeds / market value if substituted
- less disposal costs
- less base cost
- less enhancement expenditure
- less any available relief / exemption
- tax remaining gain at the relevant CGT rate

### 2.2 Indexation
Where indexation is available in the workbook examples:
- index the **acquisition cost** and **enhancement expenditure** separately using the relevant factor
- deduct the indexed amounts from disposal proceeds
- do not index disposal costs
- where the asset was owned before **6 April 1974**, substitute **market value at 6 April 1974** as base cost and treat incidental acquisition costs as already reflected in that value

### 2.3 Connected persons
When an asset is transferred to a **connected person**:
- substitute **market value** for the actual consideration
- if a **loss** arises on disposal to a connected person, it is **ring-fenced**
- that loss can only be used against gains on disposals to the **same connected person / connected person context**, not ordinary gains

Workbook reminder:
- gifts to child / brother = connected person
- cousins are **not** connected persons in the relevant workbook example

### 2.4 Non-domiciled individual / remittance basis
Where a person is non-Irish domiciled but resident in Ireland:
- gains on foreign assets are taxed only if **remitted to Ireland**
- if the proceeds are kept abroad, the gain is outside the Irish CGT charge in the workbook scenario
- if a foreign asset would have been taxable only on remittance, a **loss on that asset is not relievable** merely because proceeds are remitted

### 2.5 Part disposal
When there is a part disposal:
- apportion base cost using the standard **A / (A + B)** logic
- `A = consideration for the part disposed of`
- `B = value of the part retained immediately after disposal`

### 2.6 Share disposals
In the worked examples, watch for:
- original acquisition cost pool
- bonus issues
- rights issues
- disposal ordering / allocation of base cost across the enlarged holding

### 2.7 Principal Private Residence (PPR)
PPR relief should be checked where the property was used as the owner’s home.
If not occupied as the owner’s residence, the workbook logic does **not** give PPR relief.

---

## 3) Revised Entrepreneur Relief (RER)

### 3.1 What the relief does
RER reduces the CGT rate from the ordinary rate to **10%** on qualifying gains up to the relevant **lifetime limit**.

Current nominal limits to use:
- for qualifying gains arising **from 1 January 2016 to 31 December 2025**, lifetime limit = **€1,000,000**
- for qualifying gains arising **on or after 1 January 2026**, lifetime limit = **€1,500,000**

The AI should therefore always identify the disposal date before applying the cap.

### 3.2 Conditions pulled from the workbooks
The AI should check:
- the disposer is an **individual**
- the disposal is of an **interest in a business** or qualifying shares/business assets
- there is ownership for the required **3-year period**
- where shares are involved, the disposer owns at least **5%**
- the disposer spent at least **50% of working time** in a **managerial or technical capacity** for the required period
- the disposal is for **bona fide commercial reasons**

### 3.3 Calculation logic
Typical workbook structure:
1. Compute the gain in the normal way.
2. Apply annual exemption if available for that year.
3. Split the taxable gain:
   - qualifying gain up to the lifetime cap at **10%**
   - excess at the ordinary CGT rate

### 3.4 Key traps
- If the person did **not** work in the company for the required **3 of the 5 years prior to disposal**, RER fails.
- RER and Retirement Relief can both be considered in the same fact pattern; the AI should compare which is actually beneficial / available.
- Do not assume RER applies just because the person is a shareholder. Check the **5%** and **working time** tests.

---

## 4) Incorporation Relief

### 4.1 What the relief does
Incorporation relief **defers** the CGT gain when a business is transferred to a company.

### 4.2 Exact conditions shown in the workbook
The AI should check all of the following:
- the transfer is by an **individual**
- the business is transferred as a **going concern**
- the transfer is for **bona fide commercial reasons**
- **all of the assets of the business** are transferred, **except cash**
- the consideration is **wholly or partly shares** in the company

### 4.3 Mathematical logic
The workbooks state that the gain is deferred in the proportion:

`value of shares received / gross value of all assets transferred`

That deferred gain reduces the **base cost of the shares** received.

### 4.4 Practical rule from the workbook
If the owner keeps back a business asset that should have gone across as part of the business transfer, the relief fails.  
The workbook example specifically says:
- transfer **all** assets including the premises → relief available
- retain the premises personally → relief **not** available

### 4.5 AI instruction
When incorporation relief is in point, the AI should explicitly say:
- whether all conditions are met,
- whether the gain is merely **deferred** rather than eliminated,
- and how the deferred gain reduces the base cost of the shares.

---

## 5) Retirement Relief

## 5A. Sole trader / business assets

### 5A.1 What the relief does
Retirement Relief can fully or partly exempt a gain on disposal of qualifying business assets.

### 5A.2 Conditions repeatedly stated in the workbook material
The AI should check:
- disposer is an **individual**
- disposer is at least **55**
- asset is a **qualifying business asset**
- qualifying assets have been **owned and used for the trade for at least 10 years**

### 5A.3 Partial business use restriction
Where an asset is used partly for trade and partly as an investment:
- relief applies only to the **chargeable business asset (CBA) portion**
- compute the gain first
- then exempt the business-use proportion

Workbook formula:
`Retirement Relief = Gain × (CBA / total chargeable asset use/value)`

Example logic used:
- premises 80% used in trade, 20% let out
- relief only shelters **80%** of the gain
- CGT remains on the non-business 20%

### 5A.4 Annual exemption trap
The workbook notes:
- once the person has **availed of retirement relief**, the **annual exemption is not available** in that year

---

## 5B. Retirement Relief on shares

### 5B.1 Conditions for shares in a family trading company
The AI should check all of the following:
- disposer is at least **55**
- shares have been owned for at least **10 years**
- company is a **family trading company**
- disposer owns at least **25% of voting rights**
- disposer has been a **working director for at least 10 years**
- disposer has been a **full-time working director for at least 5 years**

Important workbook note:
- the 10 years as working director does **not** have to be the final 10 years before disposal; it can be any qualifying 10-year period, provided the workbook conditions are otherwise met

### 5B.2 Child / favourite niece-nephew vs third party
The AI should distinguish:
- disposal to **child / favourite niece-nephew**
- disposal to **third party / unrelated person**

The relevant monetary cap differs by route, so the AI must identify the route first.

### 5B.3 Chargeable Business Asset (CBA) restriction
If the company owns investments or other non-business chargeable assets:
- not all share value qualifies
- compute the **CBA / CA** ratio first

Workbook logic:
- include items like **goodwill, premises, plant and machinery** in CBA
- exclude investment assets from CBA
- then restrict relief by the CBA proportion

Formula:
`Qualifying proportion = Chargeable Business Assets / Total Chargeable Assets`

This proportion is then used to:
- test the relevant consideration threshold, and/or
- restrict the exempt part of the gain

### 5B.4 Disposal to child / favourite niece-nephew
Workbook logic, updated for current nominal limits:
- for disposals to a child / favourite niece-nephew **from 1 January 2025**, if the disponer is aged **55 to 69**, Retirement Relief is restricted to **€10 million**
- if the disponer is aged **70 or older**, the restriction is **€3 million**
- if non-business assets exist in the company, test only the **CBA proportion** against the relevant cap

The AI should distinguish carefully between:
- **Retirement Relief itself** on the transfer, and
- the separate **CGT deferral** that may apply where the transfer to a child exceeds the €10 million relief limit.

### 5B.5 Disposal to unrelated third party
Workbook logic, updated for current nominal limits:
- if aged **55 to 69**, full relief only applies where the **CBA proportion of consideration** does not exceed **€750,000**
- if aged **70 or older**, the relevant threshold is **€500,000**

Formula repeatedly used:
`CBA consideration = total share consideration × (CBA / CA)`

### 5B.6 Marginal relief
If the CBA consideration exceeds the third-party threshold:
1. compute the total gain and normal CGT
2. compute excess over the threshold:
   `Excess = CBA consideration – threshold`
3. compute marginal relief limit:
   `Maximum tax on qualifying CBA element = 50% × excess`
4. separately compute the CGT attributable to the **non-CBA** element
5. total CGT after marginal relief:
   `Marginal relief tax on CBA + CGT on non-CBA portion`

### 5B.7 Interaction with non-business assets
The workbook is very clear:
- investments inside the company do **not** qualify
- tax on the non-CBA portion remains payable even if retirement relief shelters the business portion

### 5B.8 Clawback points from the workbook
Where a gift is made to a child / family successor, the workbook warns of clawback if the recipient disposes of the shares too early.  
The family transfer example refers to a clawback if the child disposes within the stated post-transfer period in the workbook.

---

## 6) CAT: core computation logic

### 6.1 Standard CAT structure
Use this order:
1. **Market value**
2. less **liabilities, costs and expenses** properly attaching
3. = **incumbrance-free value**
4. less **consideration** given by the beneficiary
5. = **taxable value**
6. less **small gift exemption** if applicable
7. less available **group threshold** after prior benefits
8. = **taxable excess**
9. CAT at the applicable rate

### 6.1A Current CAT thresholds
For gifts or inheritances taken **on or after 2 October 2024**, use:
- **Group A: €400,000**
- **Group B: €40,000**
- **Group C: €20,000**

These figures are nominal year-sensitive inputs, so the AI should still confirm the relevant date of the benefit before applying them.

### 6.2 Multiple beneficiaries
Allocate debts and costs correctly:
- debt secured on a specific asset follows that asset
- general estate liabilities and funeral/legal costs reduce the residue / relevant benefit, not every gift indiscriminately

### 6.3 Prior benefits
The AI should reduce the relevant group threshold by prior taxable benefits in that group.  
The workbook also notes:
- certain very old benefits may be ignored depending on date rules used in the example set

### 6.4 Consideration by beneficiary
If the beneficiary must pay money to another person or assume liabilities:
- deduct that consideration from the benefit before CAT

### 6.5 Free use of property
Where a person is allowed to occupy property rent-free:
- treat the annual market rent foregone as a taxable benefit at the relevant annual valuation date
- apply small gift exemption and then the relevant threshold year by year

---

## 7) Dwelling House Exemption

### 7.1 Core conditions shown in the workbook examples
The AI should check:
- the beneficiary has occupied the property as their **main residence for the 3 years immediately preceding the gift/inheritance**
- the disponer/deceased meets the required occupation condition at the relevant time in the inheritance example
- the beneficiary must **not** own or have an interest in another dwelling house at the date of the gift / inheritance

### 7.2 Workbook refusals
The workbook denies the exemption where:
- the beneficiary had **not** occupied the house as their main residence for the required 3-year period
- the deceased / disponer had not lived in the relevant house at the key time in the inheritance example

### 7.3 Planning logic shown in the workbook
If a parent owns a second property and wants to gift it to a dependent relative:
- allow the relative to live there for **3 years first**
- the donee may then meet the 3-year occupation requirement
- but the rent-free occupation itself can create an **annual CAT benefit** based on rent foregone

### 7.4 Alternatives explicitly noted in the workbook
The workbook gives alternatives such as:
- gift of a **life interest** only
- **simple rent-free occupation**
- settlement on **trust for life**

The AI should present these as planning alternatives, not as automatic outcomes.

---

## 8) Agricultural Relief

### 8.1 What the relief does
Agricultural Relief reduces the taxable value of qualifying agricultural property by **90%**.

### 8.2 Two key tests shown in the workbook
The AI should check:

#### (a) Gross asset / farmer test
The workbook applies the **80% gross asset test**:
- agricultural assets ÷ total assets after the benefit
- if agricultural assets are more than 80% of the beneficiary’s total assets, the test is met

#### (b) Active farmer test
The workbook treats the test as satisfied where the beneficiary:
- farms actively, or
- leases the land to an **active farmer** for the required period used in the example

### 8.3 Liability treatment in the workbook
- use net values where the workbook does so for non-agricultural assets
- but note the workbook’s specific point that certain liabilities on non-agricultural assets were not deductible in the way the student might expect

### 8.4 Calculation logic
1. Compute market value of agricultural property.
2. Apply **90% reduction**.
3. Then apply threshold logic and CAT rate.

### 8.5 AI instruction
Whenever Agricultural Relief is raised, the AI should always state:
- whether the **80% test** is met
- how the beneficiary will satisfy the **active farmer** requirement
- whether a lease to an active farmer is intended and for how long

---

## 9) Business Relief (CAT)

### 9.1 What the relief does
Business Relief reduces the taxable value of **relevant business property** by **90%**.

### 9.2 Conditions repeatedly shown in the workbook
The AI should check:
- the asset received is **relevant business property**
- the disponer has met the **minimum ownership period**
  - workbook examples use **more than 5 years** for gifts of shares
  - workbook examples use **more than 2 years** for inheritances / relevant business property situations
- after taking the benefit, the beneficiary owns **more than 25%** of the shares where relevant
- the company/business is a **trading business**, not an excluded investment-type business

### 9.3 Excluded assets
The workbook repeatedly excludes:
- investments held personally
- investment properties / investment assets inside the company
- other non-business assets

### 9.4 Calculation logic
For mixed assets:
- split the benefit into **RBP** and **non-RBP**
- apply the 90% reduction only to the **relevant business property** portion
- then apply thresholds

### 9.5 Clawback
The workbook says a clawback applies if the property ceases to be relevant business property within the required post-transfer period.  
In one homework solution the workbook refers to a **6-year** clawback period.

---

## 10) Favourite Niece / Nephew Relief

### 10.1 What the relief does in the workbook
This relief effectively allows the **Group A threshold** to apply to the qualifying business benefit instead of the lower threshold that would otherwise apply to a niece or nephew.

### 10.2 Conditions shown in the workbook
The AI should check:
- the benefit is a qualifying **business / business share** benefit from the aunt/uncle context
- the niece/nephew has worked in the business for the **immediately preceding 5 years**
- the relief applies to the qualifying business asset only

### 10.3 Important workbook distinction
Where a niece/nephew receives:
- qualifying business property, plus
- separate excluded / investment assets,

the **Group A threshold** under Favourite Niece/Nephew Relief applies only to the **qualifying business benefit** unless the workbook specifically states otherwise.

For shares, the workbook also notes:
- the Group A threshold can apply to the total value of the shares, even though part of that value may derive from excluded assets
- but **Business Relief** itself still only shelters the qualifying business portion

The AI must therefore keep the following separate:
- **threshold treatment**
- **Business Relief reduction**
- **excluded asset analysis**

---

## 11) CGT-CAT interaction on gifts

### 11.1 Same event can trigger both taxes
A gift can trigger:
- **CGT** for the disponer, and
- **CAT** for the beneficiary

### 11.2 CGT credit / offset against CAT
Where CGT is paid by the disponer on the same event:
- the workbook offsets that CGT against the beneficiary’s CAT liability

### 11.3 Clawback
The workbook notes a clawback if the donee disposes of the property within the relevant period after the gift.  
The examples refer to a **2-year** clawback in the CGT/CAT offset context.

---

## 12) Corporate tax items that appear in the workbook set

> Important: the uploaded corporate tax workbook is a **student copy**, so it does not provide the same full worked-solution detail as the CGT/CAT files.  
> The AI should therefore use the points below only as high-level prompts from the workbook structure, not as a substitute for a full corporation tax manual.

### 12.1 Loan to participator
Where a close company makes a loan to a participator:
- the AI should recognise an immediate corporation tax issue for the company
- check whether the borrower is a participator / associate
- check whether the borrower is also an employee/director and whether any exclusions apply
- do not treat it as tax-free cash extraction

### 12.2 Payments to participators
Where a close company pays personal expenses of a shareholder / participator:
- consider whether the payment is a **distribution**, **salary/benefit**, or otherwise non-deductible
- also consider payroll consequences if the recipient is an employee/director

### 12.3 Interest paid to directors/shareholders
Check:
- whether the recipient has a **material interest**
- whether withholding / distribution treatment arises
- whether the company gets a deduction

### 12.4 Close company surcharge
The workbook structure shows the AI should:
- compute **distributable estate and investment income**
- deduct corporation tax on passive income
- deduct the trading element / permitted reduction
- deduct distributions
- apply the surcharge rate to the remaining surchargeable amount

### 12.5 CT relief flags
If the company facts mention:
- experimental development
- failed trials
- software development
- patents / proprietary know-how
- purchased customer lists / brands / licences / designs

the AI should flag possible relevance of:
- **R&D tax credit**
- **capital allowances for specified intangibles**
- **Knowledge Development Box (KDB)**

Because the workbook copy does not contain the detailed solution text, the AI should flag these for tax-specialist review rather than present a definitive computational answer from this sheet alone.

---

## 13) Relief-by-relief decision list for the AI

### If the scenario mentions a sole trade being moved into a company
Check:
- individual?
- going concern?
- bona fide commercial reasons?
- all business assets transferred except cash?
- consideration at least partly shares?
- if yes: consider **Incorporation Relief**

### If the scenario mentions sale/gift of business assets by an individual entrepreneur
Check:
- individual disposing of business interest?
- 3-year ownership / operation?
- bona fide commercial reasons?
- if yes: consider **Revised Entrepreneur Relief**

### If the scenario mentions disposal of business assets or shares by someone aged 55+
Check:
- 10-year ownership?
- qualifying business assets / family trading company?
- 25% voting rights if shares?
- working director 10 years and full-time 5 years?
- child/favourite niece-nephew or third party?
- any non-business assets requiring CBA restriction?
- if yes: consider **Retirement Relief**

### If the scenario involves a house being inherited or gifted to someone living there
Check:
- main residence for 3 years before benefit?
- no other dwelling house interest?
- disponer/deceased occupation condition met where relevant?
- if yes: consider **Dwelling House Exemption**

### If the scenario involves agricultural land/farm assets
Check:
- 80% farmer / gross asset test?
- active farmer or lease to active farmer?
- if yes: consider **Agricultural Relief**

### If the scenario involves a business, company shares, or sole trade passing by gift/inheritance
Check:
- relevant business property?
- minimum ownership period met?
- beneficiary owns >25% after gift where needed?
- trading not investment business?
- excluded assets carved out?
- if yes: consider **Business Relief**

### If the recipient is a niece/nephew working in the family business
Check:
- worked in business for immediately preceding 5 years?
- qualifying business benefit from aunt/uncle?
- if yes: consider **Favourite Niece/Nephew Relief**

---

## 14) Formula bank for the AI

### Incorporation Relief deferral
`Deferred gain = total gain × (value of shares received / gross value of all assets transferred)`

### Retirement Relief restriction for partly qualifying asset
`Relievable gain = total gain × (qualifying business use or CBA proportion)`

### CBA proportion for shares
`CBA proportion = Chargeable Business Assets / Total Chargeable Assets`

### CBA consideration test
`CBA consideration = share sale proceeds × (CBA / CA)`

### Retirement Relief marginal relief
`Excess = CBA consideration – threshold`  
`Max tax on qualifying CBA portion = 50% × excess`  
`Total CGT = marginal relief tax on CBA portion + CGT on non-CBA portion`

### CAT taxable value
`Taxable value = Incumbrance-free value – consideration`

### CAT
`CAT = (taxable value – exemptions – remaining threshold) × CAT rate`

### Business / Agricultural Relief
`Reduced taxable value = taxable value – (taxable value × 90%)`

### Free use of property
`Annual taxable benefit = annual market rent foregone`

---

## 15) Final AI operating instruction
When answering a user:
1. State **which reliefs are potentially relevant**.
2. For each relief, list **why it does or does not apply**.
3. Only then do the arithmetic.
4. If a relief only applies partially, show the **qualifying proportion formula**.
5. If the scenario involves gifts of business assets, always check **both CGT and CAT**.
6. If the scenario involves company loans/payments to owners, flag **close company** rules.
7. Where a threshold/rate is year-dependent, do not guess — use the correct tax-year input separately.