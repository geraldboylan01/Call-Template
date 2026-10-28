# State Pension (Contributory) estimate

Replaces "do you expect the full State Pension?" with simple facts the household knows: years paying PRSI in Ireland, years at home caring full time, current age, and the age work is expected to stop. The rules are in `js/planning/social_welfare_rules.js`; every threshold is read from the figures register, never typed. Added 28 October 2026.

## The method

The Total Contributions Approach (TCA), from the Department of Social Protection's pages [State Pension (Contributory)](https://www.gov.ie/en/department-of-social-protection/services/state-pension-contributory/) and [calculation methods and rates](https://www.gov.ie/en/department-of-social-protection/publications/state-pension-contributory-calculation-methods-and-rates/):

- Paid (full-rate) contributions, plus HomeCaring periods (capped at 1,040, which is 20 years), plus credited contributions (capped at 520), make the total.
- The rate is the total's share of 2,080 (40 years, 52 a year), and the maximum at 2,080 or more.
- At least 520 paid contributions are needed to qualify. HomeCaring periods and credits cannot make up the 520. Class A and Class S both count as paid.
- It is paid from 66. A person born on or after 1 January 1958 can choose a date up to 70; the estimate assumes 66.

The thresholds are in the register as `ie.social_welfare.state_pension_contributory.{pension_age, maximum_rate_contributions, contributions_a_year, minimum_paid_contributions, home_caring_periods_cap, credited_contributions_cap}`, with their gov.ie source and the day they were read (catalogue `ie-social-welfare-2026.3`).

## What it is and is not

An **estimate under the Total Contributions Approach**. Until 2034 the Department also compares a rate that blends in the yearly-average method (80% yearly average and 20% TCA for 2026), which can give some people more, so the pension paid can be higher. The estimate is labelled so wherever it is shown. Credited contributions are not asked for, so none are counted, which also keeps it on the low side.

If a fact is not known it is a missing fact: `estimateStateContributoryPension` returns `status: "missing"`, names the facts, and holds no rate. Nothing is guessed. A stated zero (no years paying) is a fact.

## The functions

- `stateContributoryPensionFromContributions({ paidContributions, creditedContributions?, homeCaringPeriods? })`: the rate from counts. Tested against the Department's worked example (965 + 403 + 205 = 1,573, 75.62%, 218.80 a week at the 2025 maximum of 289.30).
- `estimateStateContributoryPension({ yearsPayingPrsi, yearsCaring, currentAge, workStopAge }, { year? })`: projects paid contributions to 66 (work stopping before 66 stops them; work after 66 adds nothing), caring at 52 periods a year, then the same rate. Returns the share of the maximum, the basis in words, and the register entries used with their sources and dates. With `year`, the weekly rate for the register's maximum that year, to the nearest 10 cent as the Department's example rounds.
- `survivorStatePayment({ statePension, bereavedPartners })`: the one-payment rule. A survivor with their own State Pension and the Bereaved Partner's (Contributory) Pension is paid only the higher of the two (a tie is their own State Pension). Before retirement there is no State Pension of their own and the rule does not arise. The retirement-years run uses this function.

## Where it is used

Wherever a plan has no confirmed State Pension fraction:

- **The pension engine** (`js/pension_math.js`): a member with `statePensionYears` and no `statePensionFraction` gets the estimate, with `statePensionBasis` recorded and shown in the assumptions table. With no years the full maximum stays as before, and with years only partly known the basis says it was not estimated. A confirmed fraction, or `includeStatePension: false`, is used as given.
- **The profile adapter** (`buildPensionProjectionInput`): reads `assumptions.values.retirement.statePensionContributions.<personId>` (`{ yearsPayingPrsi, yearsCaring }`). The form does not ask for these yet; the question swap comes with the new form questions.
- **The plan pack** pension chapter records the estimate and its basis as the assumption, and warns that it is an estimate, not a confirmed entitlement. With no facts the existing illustration-default warning stays.
- **The missing-facts list** stops asking for a fraction once both years are known.

## Not done

- The form is unchanged, so nothing writes `statePensionContributions` yet.
- The yearly-average method and the 2025 to 2034 blend are not calculated, so the estimate can be lower than the Department's.
- Credited contributions, Long-Term Carers Contributions, contributions from abroad and the 67 to 70 choice are not estimated.
- The one-payment function is not yet called by a retirement-years run; the death case in the protection chapter does not need it, because a survivor with a State Pension of their own is already left out there.
