# Irish illness and disability payments: reference for protection-gap cases

Checked 16 October 2026. This is a source-backed reference for discussing the annual State payment supplied to the protection-gap module. It is not an entitlement calculator.

## Current personal rates and the latest Budget

| Scheme | Current 2026 weekly personal maximum | 52-week reference | 2027 announced reference | 52-week reference |
|---|---:|---:|---:|---:|
| Illness Benefit | €254 | €13,208 | €264 | €13,728 |
| Disability Allowance | €254 | €13,208 | €264 | €13,728 |
| Invalidity Pension | €259.50 | €13,494 | €269.50 | €14,014 |

The 2026 rates are published by the Department of Social Protection in its [Budget 2026 rates table](https://www.gov.ie/en/department-of-social-protection/publications/budget-2026/), [Illness Benefit scheme page](https://www.gov.ie/en/service/ddf6e3-illness-benefit/), [Disability Allowance scheme page](https://www.gov.ie/en/department-of-social-protection/services/disability-allowance/) and [Invalidity Pension scheme page](https://www.gov.ie/en/department-of-social-protection/services/invalidity-pension/).

The latest Budget is Budget 2027, announced on 6 October 2026. The [Budget Statement](https://prelive.oireachtas.ie/en/debates/debate/dail/2026-10-06/3/) announces a €10 weekly increase, including disability scheme recipients. The 2027 amounts above are the Department of Social Protection's own [Budget 2027 rates table](https://www.gov.ie/en/department-of-social-protection/publications/budget-2027/) (maximum weekly rates "from January 2027": Illness Benefit and Disability Allowance €264.00, Invalidity Pension €269.50), read on 22 October 2026, and they equal the 2026 maxima plus the announced €10. They are announced references, not rates already payable in October 2026: the scheme pages still print the 2026 rates. The figures register (`docs/figures-register.md`) holds each rate by effective date with its source, and `getFigures` reads it. The earlier 7 October link led to Commencement Matters, not the Budget statement, and has been removed.

The Budget Statement also announces a €500 cost-of-disability payment for recipients of long-term disability payments. Keep this separate from recurring weekly income; do not turn it into a permanent annual addition to `statePayment`.

The 52-week figures are multiplication for comparison, not a forecast of a first claim year. Start dates, waiting days, claim duration, eligibility, dependent increases and tax can change the actual annual figure.

## Which scheme might apply?

- **Illness Benefit:** short-term medically certified incapacity, subject to PRSI and earnings conditions. €254 is the highest earnings-band rate, not the rate for every claimant. It is taxable, although paid without tax deducted. It is not a permanent income assumption. See the [scheme page](https://www.gov.ie/en/service/ddf6e3-illness-benefit/) and [operational guidelines](https://www.gov.ie/en/department-of-social-protection/publications/operational-guidelines-illness-benefit/).
- **Disability Allowance:** longer-lasting disability with work restrictions, age and residence conditions, and a means test that includes a spouse or partner's income. It can be reduced or unavailable. The payment is exempt from income tax, USC and PRSI. See the [scheme page](https://www.gov.ie/en/department-of-social-protection/services/disability-allowance/).
- **Invalidity Pension:** longer-term incapacity or permanent incapacity with medical and PRSI conditions. It requires a contribution record; it is taxable, without USC or PRSI. See the [scheme page](https://www.gov.ie/en/department-of-social-protection/services/invalidity-pension/).

Other schemes and supplementary supports may apply. These three are alternative possibilities, not three amounts to add together.

## What the app accepts

The protection-gap module accepts a stated yearly `statePayment`, in whole euros, including 0. A confirmed no-payment case is valid. Unknown entitlement is still missing information, not 0.

The existing authoring rule remains: show a suggested scheme/rate, source, calculation and assumptions in the author's notes, then obtain Gerry's confirmation before it enters a client payload. Keep gross statutory references distinct from spendable income: the protection-gap engine does not calculate tax or entitlement. Do not silently combine a taxable gross maximum with net take-home figures and describe the result as an after-tax projection. A net payment assumption or the existing tax limitation must be made explicit.

On 17 October, Gerry approved a central Illness Benefit assumption for hypothetical employee illness scenarios, with no question asking a client to predict an entitlement. The implementation plan in #56 records that future adapter contract, its versioned Budget updates, and the required shared tax-engine and duration work. This PR only enables an explicit zero in the existing stated-input engine; it does not activate the central assumption or rewrite the current manual authoring contract.

No automatic default, eligibility calculation, first-year claim calculation or new means test is introduced by allowing 0. The dated references are available for the separate prompt-pack documentation update after the code lands.
