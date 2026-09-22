"""Retirement bridge model, rebuilt from Gerry's Frasier Crane Report (21 Sept 2026).

Reference implementation: it reproduces every figure in the "Retirement Bridge -
Could You Retire at 57?" module from the assumptions that module states. Run it
with no arguments to print the year-by-year table and check it against the
figures in the published Report.

The parameters below are Frasier's. A future version would read them from a
JSON file so the makeover workflow can run the same model for any case.
"""

FRASIER = {
    "client_age": 54,
    "spouse_age": 60,
    "retire_age": 57,
    "end_age": 67,
    "growth": 0.05,
    "inflation": 0.02,
    "pension_tax": 0.30,
    "dc_pot": 143000 + 124000,
    "earnings_cap": 115000,
    "age_limits": [(60, 0.40), (55, 0.35), (50, 0.30), (40, 0.25), (30, 0.20), (0, 0.15)],
    "employer_contribution": 7800,
    "lump_sum_share": 0.25,
    "arf_distribution_age": 61,
    "arf_distribution_rate": 0.04,
    "shares_value": 220000,
    "cgt_rate": 0.33,
    "cgt_exemption": 1270,
    "cash": 150000,
    "annual_outgoings": 53352,
    "reserve_years": 2,
    "spending_ex_mortgage": 42000,
    "mortgage_annual": 11352,
    "mortgage_last_full_age": 62,
    "mortgage_final_payment": 946,
    "irish_sp_full": 299.30 * 52,
    "uk_sp_eur": 241.30 * 52 * 1.16,
    "client_irish_years": 12,
    "spouse_irish_years": 10,
    "db_eur": 24000 * 1.16,
    "db_start_age": 65,
    "foreign_annuity": 12000,
    "foreign_start_age": 65,
}


def age_limit(age, limits):
    for floor, pct in limits:
        if age >= floor:
            return pct
    return 0.0


def run(p):
    g, infl, tax = p["growth"], p["inflation"], p["pension_tax"]
    years_working = p["retire_age"] - p["client_age"]

    pot = p["dc_pot"]
    for age in range(p["client_age"], p["retire_age"]):
        personal = age_limit(age, p["age_limits"]) * p["earnings_cap"]
        pot = pot * (1 + g) + personal + p["employer_contribution"]
    lump = pot * p["lump_sum_share"]
    arf = pot - lump

    reserve = p["reserve_years"] * p["annual_outgoings"]
    net_shares = p["shares_value"] - (p["shares_value"] - p["cgt_exemption"]) * p["cgt_rate"]
    accessible = (net_shares + p["cash"] - reserve) * (1 + g) ** years_working

    client_irish = (p["client_irish_years"] + years_working) / 40 * p["irish_sp_full"]
    spouse_irish = (p["spouse_irish_years"] + years_working) / 40 * p["irish_sp_full"]

    summary = {"dc_at_retirement": pot, "lump_sum": lump, "arf_at_retirement": arf,
               "net_shares": net_shares, "accessible_at_retirement": accessible, "reserve": reserve}
    rows = []
    for age in range(p["retire_age"], p["end_age"] + 1):
        t = age - p["client_age"]
        index = (1 + infl) ** t
        mortgage = (p["mortgage_annual"] if age <= p["mortgage_last_full_age"]
                    else p["mortgage_final_payment"] if age == p["mortgage_last_full_age"] + 1 else 0)
        spend = p["spending_ex_mortgage"] * index + mortgage

        spouse_age = p["spouse_age"] + t
        gross = 0.0
        if spouse_age >= 66:
            gross += spouse_irish * index
        if spouse_age >= 67:
            gross += p["uk_sp_eur"] * index
        if age >= p["db_start_age"]:
            gross += p["db_eur"] * index
        if age >= p["foreign_start_age"]:
            gross += p["foreign_annuity"]
        if age >= 66:
            gross += client_irish * index
        if age >= 67:
            gross += p["uk_sp_eur"] * index
        net_income = gross * (1 - tax)

        arf *= 1 + g
        distribution = p["arf_distribution_rate"] * arf if age >= p["arf_distribution_age"] else 0.0
        arf -= distribution
        net_distribution = distribution * (1 - tax)

        need = spend - net_income - net_distribution
        from_lump = min(lump, max(need, 0.0))
        lump -= from_lump
        accessible = accessible * (1 + g) - (need - from_lump)

        rows.append({"age": age, "spend": spend, "net_income": net_income,
                     "net_arf": net_distribution, "accessible": accessible, "arf": arf,
                     "lump_left": lump})
    return summary, rows


EXPECTED = {
    "dc_at_retirement": 454224, "lump_sum": 113556, "arf_at_retirement": 340668,
    "net_shares": 147819, "accessible_at_retirement": 221240, "reserve": 106704,
    "spend": [55923, 56814, 57723, 58651, 59597, 60562, 51140, 51198, 52222, 53266, 54331],
    "net_income": [0, 0, 0, 3987, 15771, 16086, 16408, 16736, 49702, 55709, 69835],
    "net_arf": [0, 0, 0, 0, 12174, 12271, 12370, 12469, 12568, 12669, 12770],
    "accessible": [232302, 243917, 199208, 154505, 130579, 104903, 87786, 70182, 83740, 103038, 136464],
    "arf_at_65": 430915, "capital_at_67": 681005,
}


def check(summary, rows):
    problems = []
    for key in ("dc_at_retirement", "lump_sum", "arf_at_retirement", "net_shares",
                "accessible_at_retirement", "reserve"):
        if round(summary[key]) != EXPECTED[key]:
            problems.append(f"{key}: {round(summary[key])} vs {EXPECTED[key]}")
    for key in ("spend", "net_income", "net_arf", "accessible"):
        got = [round(r[key]) for r in rows]
        if got != EXPECTED[key]:
            problems.append(f"{key}: {got} vs {EXPECTED[key]}")
    at65 = next(r for r in rows if r["age"] == 65)
    at67 = next(r for r in rows if r["age"] == 67)
    if round(at65["arf"]) != EXPECTED["arf_at_65"]:
        problems.append(f"arf at 65: {round(at65['arf'])}")
    if round(at67["accessible"] + summary["reserve"] + at67["arf"]) != EXPECTED["capital_at_67"]:
        problems.append("capital at 67")
    return problems


if __name__ == "__main__":
    summary, rows = run(FRASIER)
    print("age   spend  net income  net ARF  accessible        ARF")
    for r in rows:
        print(f"{r['age']:>3} {r['spend']:>7,.0f} {r['net_income']:>11,.0f} {r['net_arf']:>8,.0f} "
              f"{r['accessible']:>11,.0f} {r['arf']:>10,.0f}")
    problems = check(summary, rows)
    print("All Report figures reproduced." if not problems else "Mismatches: " + "; ".join(problems))
