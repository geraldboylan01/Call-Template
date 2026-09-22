/**
 * The next complete `{...}` at or after `fromIndex`, and where it ended.
 *
 * Brace counting rather than a regex, because a payload is full of braces
 * inside strings -- and the end index is returned so the caller can look for
 * the object after this one.
 */
function findJsonObjectAt(candidate, fromIndex = 0) {
  const startIndex = candidate.indexOf('{', fromIndex);
  if (startIndex === -1) {
    return null;
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
        return {
          text: candidate.slice(startIndex, index + 1).trim(),
          endIndex: index + 1
        };
      }
    }
  }

  return null;
}

export function extractJsonObjectFromEditorText(input) {
  const text = String(input ?? '').trim();
  if (!text) {
    return '';
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fencedMatch ? fencedMatch[1].trim() : text;
  return findJsonObjectAt(candidate)?.text || '';
}

function repairMissingLeadingObjectBrace(input) {
  const text = String(input ?? '').trim();
  if (!/^"[^"]+"\s*:/.test(text)) {
    return '';
  }

  const candidate = `{${text}`;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return candidate;
    }
  } catch (_error) {
    return '';
  }

  return '';
}

export function normalizeEditorJsonInput(rawInput) {
  const normalizedInput = String(rawInput ?? '')
    .trim()
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, '\'');

  const repairedInput = repairMissingLeadingObjectBrace(normalizedInput);
  if (repairedInput) {
    return repairedInput;
  }

  return extractJsonObjectFromEditorText(normalizedInput) || normalizedInput;
}

/**
 * The editor's text with the things people paste rather than type removed:
 * smart quotes from a document, and code fences from a chat window.
 *
 * EVERY fence is kept, not just the first. Someone pasting "a few modules"
 * out of a conversation pastes several fenced blocks, and taking only the
 * first would silently load one module and drop the rest.
 */
function cleanEditorText(rawInput) {
  const text = String(rawInput ?? '')
    .trim()
    .replace(/“|”/g, '"')
    .replace(/‘|’/g, '\'');

  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  return fences.length > 0
    ? fences.map(([, body]) => body.trim()).filter(Boolean).join('\n')
    : text;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_error) {
    return { ok: false, value: null };
  }
}

function requirePayloadObject(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Module ${index + 1} must be a payload object.`);
  }
  return entry;
}

/**
 * Every module payload in one paste.
 *
 * Three shapes, because all three are what someone actually pastes when they
 * mean "here are my modules": a JSON array of payloads, a `{ modules: [...] }`
 * file, or the payloads one after another with nothing between them. The last
 * is the one that used to fail quietly -- the single-payload path reads the
 * first complete object and ignores whatever follows it, so pasting six
 * modules loaded one and said nothing about the other five.
 *
 * Throws with a message fit for the warnings area rather than returning empty,
 * because "nothing happened" is the failure this is here to end.
 */
export function extractModulePayloadsFromEditorText(rawInput) {
  const text = cleanEditorText(rawInput);
  if (!text) {
    throw new Error('Paste one or more module payloads first.');
  }

  const whole = tryParseJson(text);
  if (whole.ok) {
    if (Array.isArray(whole.value)) {
      if (whole.value.length === 0) {
        throw new Error('That array has no modules in it.');
      }
      return whole.value.map(requirePayloadObject);
    }

    if (whole.value && typeof whole.value === 'object') {
      if (Array.isArray(whole.value.modules)) {
        if (whole.value.modules.length === 0) {
          throw new Error('That file has no modules in it.');
        }
        return whole.value.modules.map(requirePayloadObject);
      }
      return [whole.value];
    }

    throw new Error('That is valid JSON but not a module payload.');
  }

  const payloads = [];
  let cursor = 0;
  for (;;) {
    const found = findJsonObjectAt(text, cursor);
    if (!found) {
      break;
    }

    const parsed = tryParseJson(found.text);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      throw new Error(`Module ${payloads.length + 1} is not valid JSON (check quotes).`);
    }

    payloads.push(parsed.value);
    cursor = found.endIndex;
  }

  if (payloads.length === 0) {
    throw new Error('No module payloads found (check quotes).');
  }

  return payloads;
}
