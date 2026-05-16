export function extractJsonObjectFromEditorText(input) {
  const text = String(input ?? '').trim();
  if (!text) {
    return '';
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fencedMatch ? fencedMatch[1].trim() : text;
  const startIndex = candidate.indexOf('{');
  if (startIndex === -1) {
    return '';
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < candidate.length; index += 1) {
    const char = candidate[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(startIndex, index + 1).trim();
      }
    }
  }

  return '';
}

export function normalizeEditorJsonInput(rawInput) {
  const normalizedInput = String(rawInput ?? '')
    .trim()
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, '\'');

  return extractJsonObjectFromEditorText(normalizedInput) || normalizedInput;
}
