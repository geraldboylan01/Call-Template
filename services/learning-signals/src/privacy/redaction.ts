const redactions: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/giu, "[REDACTED_IBAN]"],
  [
    /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b|\b[A-Z]\d{2}\s?[A-Z0-9]{4}\b/giu,
    "[REDACTED_POSTCODE]",
  ],
  [
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+)\d{2,4}\b/giu,
    "[REDACTED_DATE]",
  ],
  [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    "[REDACTED_EMAIL]",
  ],
  [
    /(?:\+?\d[\d\s().-]{7,}\d)/gu,
    "[REDACTED_PHONE_OR_ACCOUNT]",
  ],
  [
    /\b(?:account|acct|sort[\s-]?code)\s*(?:number|no\.?|#|:)?\s*[A-Z0-9 -]{4,32}\b/giu,
    "[REDACTED_ACCOUNT]",
  ],
  [
    /\b(?:(?:my\s+)?name\s*(?:is|:)|i(?:['’]m| am)|mr\.?|mrs\.?|ms\.?|dr\.?)\s+\p{L}[\p{L}'’-]+(?:\s+\p{L}[\p{L}'’-]+){1,3}\b/giu,
    "[REDACTED_NAME]",
  ],
  [
    /\b(?:works?|worked|working)\s+(?:at|for)\s+[\p{L}\p{N}&'’. -]{2,80}|\b(?:employed\s+by|employer\s*(?:is|:)|company\s*(?:is|:))\s*[\p{L}\p{N}&'’. -]{2,80}/giu,
    "[REDACTED_EMPLOYER]",
  ],
  [
    /\b(?:cancer|diabetes|depression|anxiety|bipolar|diagnos(?:is|ed)|medical condition|mental health|heart disease|hiv|aids)\b/giu,
    "[REDACTED_HEALTH]",
  ],
];

export function redactFreeText(value: string): string {
  let redacted = value
    .slice(0, 16_384)
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ");
  for (const [pattern, replacement] of redactions) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.slice(0, 4_096);
}

export const redact_free_text = redactFreeText;
