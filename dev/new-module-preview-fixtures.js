// Fictional inputs from the reviewed recording packages; the native engines calculate all displayed figures.
export const newModulePreviews = {
  "future-cost-fund": {
    "id": "fictional-future-cost-fund-preview",
    "title": "College: fees and living costs",
    "media": [],
    "ui": {},
    "generated": {
      "futureCostFundInputs": {
        "costTitle": "College: fees and living costs",
        "costKind": "education",
        "startsInYears": 8,
        "durationYears": 4,
        "annualCostToday": 15000,
        "scenarios": [
          {
            "id": "lump",
            "lumpShare": 1
          },
          {
            "id": "yearly",
            "lumpShare": 0
          },
          {
            "id": "half",
            "lumpShare": 0.5
          },
          {
            "id": "delayed",
            "lumpShare": 0,
            "savingStartsInYears": 3
          }
        ],
        "baseScenarioId": "yearly"
      },
      "summaryHtml": "",
      "assumptions": {
        "columns": [],
        "rows": []
      },
      "outputs": {
        "columns": [],
        "rows": []
      },
      "tables": [],
      "charts": []
    }
  },
  "household-cash-flow": {
    "id": "fictional-household-cash-flow-preview",
    "title": "Household cash flow",
    "media": [],
    "ui": {},
    "generated": {
      "householdCashFlowInputs": {
        "householdTaxStatus": "married_or_civil_partners",
        "people": [
          {
            "id": "niamh",
            "age": 45,
            "label": "Niamh"
          },
          {
            "id": "dara",
            "age": 45,
            "label": "Dara"
          }
        ],
        "income": [
          {
            "personId": "niamh",
            "type": "employment",
            "amount": 75000
          },
          {
            "personId": "dara",
            "type": "employment",
            "amount": 75000
          }
        ],
        "outgoings": [
          {
            "id": "mortgage",
            "label": "Mortgage",
            "amount": 30000
          },
          {
            "id": "car",
            "label": "Car loan",
            "amount": 6000
          },
          {
            "id": "living",
            "label": "Living costs",
            "amount": 48000
          },
          {
            "id": "children",
            "label": "Children",
            "amount": 9000
          },
          {
            "id": "insurance",
            "label": "Insurance",
            "amount": 3000
          }
        ],
        "scenarios": [
          {
            "id": "today"
          },
          {
            "id": "clear-car",
            "changes": [
              {
                "type": "clearOutgoing",
                "outgoingId": "car",
                "paidFrom": "savings"
              }
            ]
          },
          {
            "id": "pension",
            "changes": [
              {
                "type": "extraPension",
                "amount": 10000
              }
            ]
          },
          {
            "id": "both",
            "changes": [
              {
                "type": "clearOutgoing",
                "outgoingId": "car",
                "paidFrom": "savings"
              },
              {
                "type": "extraPension",
                "amount": 10000
              }
            ]
          }
        ],
        "calculationYear": 2026
      },
      "summaryHtml": "",
      "assumptions": {
        "columns": [],
        "rows": []
      },
      "outputs": {
        "columns": [],
        "rows": []
      },
      "tables": [],
      "charts": []
    }
  },
  "protection-gap": {
    "id": "fictional-protection-gap-preview",
    "title": "Protection gap",
    "media": [],
    "ui": {},
    "generated": {
      "protectionGapInputs": {
        "householdLabel": "Maeve and Finn \u00b7 illustrative example",
        "people": [
          {
            "id": "maeve",
            "label": "Maeve",
            "takeHome": 57000
          },
          {
            "id": "finn",
            "label": "Finn",
            "takeHome": 45000
          }
        ],
        "needed": 96000,
        "savings": 60000,
        "scenarios": [
          {
            "id": "today"
          },
          {
            "id": "maeve-cannot-work",
            "event": {
              "type": "cannotWork",
              "personId": "maeve",
              "statePayment": 13000
            }
          },
          {
            "id": "finn-cannot-work",
            "event": {
              "type": "cannotWork",
              "personId": "finn",
              "statePayment": 13000
            }
          },
          {
            "id": "maeve-died",
            "event": {
              "type": "dies",
              "personId": "maeve",
              "survivorsPension": 13500,
              "neededAfter": 60000,
              "neededBecause": [
                "mortgageCleared",
                "livingCostsLower"
              ]
            }
          }
        ]
      },
      "summaryHtml": "",
      "assumptions": {
        "columns": [],
        "rows": []
      },
      "outputs": {
        "columns": [],
        "rows": []
      },
      "tables": [],
      "charts": []
    }
  }
};
