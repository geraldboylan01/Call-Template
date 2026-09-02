/**
 * WHAT THE CLIENT HAS ESTABLISHED, AS MEANING RATHER THAN AS STORAGE.
 *
 * NOT WIRED INTO PRODUCTION. This is the model-facing half of the semantic-claims
 * spike. Nothing imports it from the live lane; `run-semantic-claims-spike.mjs`
 * is its only caller. It exists to answer one question with evidence rather than
 * argument: can a model that is never shown a slot, a note id, a JSON pointer or
 * a mutation group produce a description of the client's finances that
 * deterministic code can compile into the same canonical state — or better?
 *
 * WHY THE CURRENT CONTRACT IS THE THING UNDER TEST. `ReconciliationPlanV1` asks
 * one model call to be a semantic reader, an entity resolver, a diff engine, a
 * storage-operation author and a clarification planner at once: eight operation
 * types, fourteen reason codes, six note kinds, roughly fifteen fields per
 * operation, and `valueJson` — a JSON *string*, so Structured Outputs cannot
 * constrain the one field carrying the actual money. Measured on one fixture,
 * the model receives 11,226 characters of scaffolding against 349 characters of
 * conversation. The independent reader, asked one narrow question with a 3,548
 * character prompt, has never missed a figure or agreed to a wrong one.
 *
 * So the hypothesis is that task width, not model capability, is the ceiling.
 *
 * WHAT A CLAIM DELIBERATELY DOES NOT CONTAIN: note ids, entity ids the server
 * allocated, collection indices, JSON pointers, revisions, note kinds, reason
 * codes, operation ids, group ids. Every one is an artefact of where the answer
 * gets stored, and a model holding them is doing two jobs at once.
 */

import { CURRENCY_CODES } from '../../../js/planning/contracts.js';

const INTERPRETER_PROMPT_VERSION = 'planeir-semantic-claims-v1';
const VERIFIER_PROMPT_VERSION = 'planeir-semantic-verify-v1';

/**
 * ORTHOGONAL FIELDS, NOT ONE STATUS.
 *
 * A first draft of this collapsed assertion, lifecycle and modality into a
 * single enum — `established | ambiguous | superseded | absent | hypothetical`.
 * That is three unrelated questions wearing one hat, and it silently re-broke a
 * distinction this project already paid to learn: "no other debts" is a
 * COMPLETION of a collection that still holds the mortgage, and it is not the
 * same claim as "I have no debts". Collapsing them writes an empty liabilities
 * list over a real EUR 340,000 mortgage.
 *
 * LIFECYCLE AND TRUST ARE ABSENT ON PURPOSE. Whether a claim is active,
 * superseded, corroborated or disputed is not something the model asserts — it
 * is what the system works out by comparing two readings and watching what
 * happens next. Asking the model for it invites it to grade its own homework.
 */
const CLAIM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'factId', 'assertion', 'amount', 'currency', 'cadence', 'text',
          'ownerRef', 'entityAction', 'existingEntityId', 'entityLabel',
          'modality', 'certainty', 'supersedesMention', 'mentionRef',
          'quote', 'turnId', 'ambiguityQuestion'
        ],
        properties: {
          factId: { type: 'string' },
          // WHAT KIND OF STATEMENT THIS IS. "I have none" and "no others" are
          // different answers; so are "I don't know" and "ignore what I said".
          assertion: {
            type: 'string',
            enum: ['value', 'presence', 'absence', 'completion', 'unknown', 'retraction']
          },
          amount: { type: ['number', 'null'] },
          currency: { type: 'string', enum: [...CURRENCY_CODES, 'unstated'] },
          cadence: { type: 'string', enum: ['once', 'monthly', 'annual', 'weekly', 'unstated'] },
          // For choice-valued facts and labels. Never a serialized object.
          text: { type: ['string', 'null'] },
          // WHOSE, IN THE CLIENT'S OWN WORDS. Never an owner id: the reader is
          // shown no household, so it has nothing to name. Turning "hers" into
          // a particular person is identity work, done downstream against a
          // catalogue this reader never sees.
          ownerRef: {
            type: 'string',
            enum: ['speaker', 'other_person', 'joint', 'unstated']
          },
          // ENTITY CONTINUITY IS THE HARDEST SAFETY PROBLEM HERE, and the model
          // owns only the part it can see: is this the holding we already have,
          // a different one, or genuinely unclear? The server allocates every
          // durable id. `mentionRef` lets two independent readings be lined up
          // against each other by what they were reading, not by labels they
          // each invented.
          entityAction: { type: 'string', enum: ['none', 'existing', 'new', 'ambiguous'] },
          existingEntityId: { type: ['string', 'null'] },
          entityLabel: { type: ['string', 'null'] },
          modality: { type: 'string', enum: ['current', 'historical', 'future', 'hypothetical'] },
          certainty: { type: 'string', enum: ['exact', 'approximate', 'range', 'unknown'] },
          // A correction points at what it replaces, by the mention it replaces.
          supersedesMention: { type: ['string', 'null'] },
          mentionRef: { type: 'string' },
          quote: { type: 'string' },
          turnId: { type: 'string' },
          // Non-null means the reader could not settle this and says why. It is
          // a question for the client, never a guess with a warning attached.
          ambiguityQuestion: { type: ['string', 'null'] }
        }
      }
    }
  }
});

const SHARED_RULES = `A CLAIM IS SOMETHING THE CLIENT ESTABLISHED, not something you inferred would be sensible. If they did not say it, there is no claim. Never fill a gap with a plausible figure.

For each claim give:
- "factId": which of the listed facts this is. Only ids from the list.
- "assertion": "value" when they stated an amount or a figure; "presence" when they said a holding exists but gave no figure; "absence" when they said they have none of something; "completion" when they said there are no OTHERS beyond what is already discussed; "unknown" when they said they do not know; "retraction" when they withdrew something they said earlier.
- "amount"/"currency"/"cadence": the figure as stated. Spoken numbers are figures and transcribing them is your job — "two and a half thousand" is 2500, "a hundred and eighty grand" is 180000. NEVER do arithmetic: no totals, no differences, no splitting a range. Use null for amount when there is no figure. Use "unstated" for a currency or cadence the client did not say.
- "text": for a fact whose answer is a word rather than a number, or a short label for a holding. Otherwise null.
- "ownerRef": whose the CLIENT said it is, taken only from the client's own words — "speaker" for "mine"/"I have", "other_person" for "hers"/"my wife's", "joint" for "ours"/"we have", "unstated" when the client used no possessive of their own. Do not carry ownership over from how the adviser phrased the question: if the adviser said "the household" and the client just gave a figure, that is "unstated". You are not told who is in this household and must not guess.
- "entityAction": "none" for a fact that is not a holding; "existing" when this is one of the holdings listed in knownEntities, and then give its id in "existingEntityId"; "new" when it is a holding not in that list; "ambiguous" when you genuinely cannot tell whether it is one already listed or a different one.
- "entityLabel": how the client referred to a new holding, in their words. Null otherwise.
- "modality": "current" for what they have now; "future" for something planned; "hypothetical" for a what-if they are exploring; "historical" for something that used to be true. A figure inside "what if I had…" is NOT a current holding.
- "certainty": "exact", "approximate" for a rough figure, "range" when they gave a span, "unknown".
- "supersedesMention": when this claim CORRECTS an earlier one in this same conversation, the mentionRef of the claim it replaces. Otherwise null.
- "mentionRef": a short identifier of your own for this claim, so a correction can point at it. Use the turn and a counter, like "t14-2".
- "quote": the exact contiguous words from the client's turn that establish this claim. Copy verbatim, never paraphrase.
- "turnId": the id of the client turn the quote came from.
- "ambiguityQuestion": when you cannot honestly settle this claim, the question you would ask the client. Otherwise null. An honest question costs one turn; a guess costs a wrong number in someone's financial plan.

"NO OTHERS" IS NOT "NONE". "No other debts apart from the mortgage" is a completion — the mortgage stays. Only use "absence" when the client says they hold none at all.

A correction is ordinary speech, not ambiguity. "Three hundred and twenty, sorry, three hundred and forty thousand" is one claim of 340000 that supersedes nothing else; do not also report the withdrawn figure.

Read the whole conversation together. A scale stated once carries across a sentence: in "mine is a hundred and eighty grand and hers is ninety", the second figure is 90000. Use the assistant's question to understand what a bare answer refers to — a client answering "400" to a question about savings is stating their savings — but never to invent a figure they did not give.

If the client established nothing, return an empty list. That is a normal answer.`;

export const INTERPRETER_SYSTEM_PROMPT = `You read a financial planning conversation and report what the client has established.

${SHARED_RULES}`;

/**
 * The second reading, which never sees the first.
 *
 * Independence is about the ANSWER, not the context: both readers get the whole
 * conversation, because that is what makes "hers is ninety" mean ninety
 * thousand. What the verifier is never shown is what the interpreter concluded,
 * so it cannot agree with a candidate it was handed.
 *
 * Two readings agreeing is CORROBORATION, not truth — same model family, same
 * transcript, so correlated error is possible and an ASR mistake is invisible to
 * both. It buys enough confidence to calculate with; it does not buy certainty.
 */
export const VERIFIER_SYSTEM_PROMPT = `You read a financial planning conversation and report what the client has established.

Work only from the conversation in front of you. You are given no prior interpretation and no expectations, and there is no answer you are meant to match.

${SHARED_RULES}`;

/** A claim list longer than this is not a conversation; it is a parse gone wrong. */
const MAX_CLAIMS = 80;

// Internal until the spike earns a place. Exporting it for a test it does not
// have yet would be dead surface on code that may be deleted.
function normalizeClaims(raw, { turnIndex = new Map() } = {}, promptVersion = INTERPRETER_PROMPT_VERSION) {
  const claims = Array.isArray(raw?.claims) ? raw.claims : [];
  const normalized = [];
  for (const claim of claims.slice(0, MAX_CLAIMS)) {
    const factId = String(claim?.factId || '').trim();
    if (!factId) continue;
    const quote = String(claim?.quote || '').trim();
    const turnId = String(claim?.turnId || '').trim();
    // A quote that is not in the turn it names is not evidence from that turn.
    // The claim may still be wrong about what the words MEAN, but it must not be
    // able to invent the words. This is the one structural check available here
    // and it costs nothing.
    const text = turnIndex.get(turnId) || '';
    if (quote && text && !text.includes(quote)) continue;
    const amount = Number(claim?.amount);
    normalized.push(Object.freeze({
      factId,
      assertion: ['value', 'presence', 'absence', 'completion', 'unknown', 'retraction']
        .includes(claim?.assertion) ? claim.assertion : 'value',
      amount: Number.isFinite(amount) ? amount : null,
      currency: CURRENCY_CODES.includes(claim?.currency) ? claim.currency : null,
      cadence: ['once', 'monthly', 'annual', 'weekly'].includes(claim?.cadence) ? claim.cadence : null,
      text: typeof claim?.text === 'string' && claim.text.trim() ? claim.text.trim() : null,
      ownerRef: ['speaker', 'other_person', 'joint'].includes(claim?.ownerRef) ? claim.ownerRef : 'unstated',
      entityAction: ['existing', 'new', 'ambiguous'].includes(claim?.entityAction) ? claim.entityAction : 'none',
      existingEntityId: typeof claim?.existingEntityId === 'string' && claim.existingEntityId.trim()
        ? claim.existingEntityId.trim()
        : null,
      entityLabel: typeof claim?.entityLabel === 'string' && claim.entityLabel.trim()
        ? claim.entityLabel.trim()
        : null,
      modality: ['current', 'historical', 'future', 'hypothetical'].includes(claim?.modality)
        ? claim.modality
        : 'current',
      certainty: ['exact', 'approximate', 'range', 'unknown'].includes(claim?.certainty)
        ? claim.certainty
        : 'approximate',
      supersedesMention: typeof claim?.supersedesMention === 'string' && claim.supersedesMention.trim()
        ? claim.supersedesMention.trim()
        : null,
      mentionRef: String(claim?.mentionRef || `${turnId}-${normalized.length + 1}`),
      quote,
      turnId,
      ambiguityQuestion: typeof claim?.ambiguityQuestion === 'string' && claim.ambiguityQuestion.trim()
        ? claim.ambiguityQuestion.trim()
        : null
    }));
  }
  return Object.freeze({ promptVersion, claims: Object.freeze(normalized) });
}

/**
 * THE SIGNATURE TWO READINGS MUST MATCH FOR A CLAIM TO BE CORROBORATED.
 *
 * Not the number. "Both models saw 90,000" was never evidence that it belongs to
 * the same person, means the same thing, or is even a current holding — and the
 * previous design credited a purely numeric agreement with having checked all of
 * that, which is how two pensions could be written to the wrong two people with
 * a verification attached.
 *
 * Entity identity is compared by the QUOTE the reading was looking at, never by
 * a label either model invented: two readers describing the same new pension
 * will pick different words for it and the same words for the same evidence.
 */
function claimSignature(claim, { ownerScoped = true } = {}) {
  return JSON.stringify([
    claim.factId,
    claim.assertion,
    claim.amount,
    claim.currency,
    claim.cadence,
    claim.text,
    // OWNERSHIP IS ONLY PART OF THE MEANING WHERE THE FACT HAS OWNERS. A
    // household's monthly spending has ONE slot, so "we spend" and a bare
    // figure are the same claim — and two readers reporting `joint` and
    // `unstated` for the same sentence were being called a disagreement and
    // sent to the client as a question. That is a false dispute manufactured by
    // asking an owner-scoped question about a fact that has no owner.
    ownerScoped ? claim.ownerRef : null,
    claim.entityAction,
    claim.existingEntityId,
    claim.modality,
    claim.turnId
    // QUOTE IS PROVENANCE, NOT IDENTITY. Two careful readings of the same
    // sentence pick different spans of it — "two and a half thousand" and
    // "About two and a half thousand." — and requiring the words to match makes
    // disagreement the default. Each claim still carries its own quote, and
    // each is still checked against the turn it names.
    // CERTAINTY IS A HEDGE, NOT A VALUE. "exact" versus "approximate" does not
    // change the figure that gets written, and disputing a correct claim over
    // it costs the client a question for nothing.
  ]);
}

/**
 * Compare two independent readings.
 *
 * CORROBORATION IS ATOMIC. Two readings that agree on a figure and disagree on
 * whose it is have not partly agreed — they have disagreed, and the honest
 * outcome is a disputed claim and a question for the client. Accepting the half
 * they concur on is how a correct number reaches the wrong person's plan.
 */
export function corroborate(interpreted, verified, { singletonFactIds = [] } = {}) {
  // A fact with one household-wide slot has no owner to agree about.
  const singletons = new Set(singletonFactIds);
  const signature = (claim) => claimSignature(claim, { ownerScoped: !singletons.has(claim.factId) });
  const byVerifier = new Map();
  for (const claim of verified.claims) {
    const key = signature(claim);
    byVerifier.set(key, (byVerifier.get(key) || 0) + 1);
  }
  const corroborated = [];
  const disputed = [];
  for (const claim of interpreted.claims) {
    const key = signature(claim);
    const available = byVerifier.get(key) || 0;
    if (available > 0) {
      byVerifier.set(key, available - 1);
      corroborated.push(claim);
    } else {
      disputed.push({ claim, reason: 'verifier_did_not_produce_this_claim' });
    }
  }
  // A claim only the VERIFIER found is equally a disagreement. Dropping these
  // silently would make the interpreter's omissions invisible, which is the
  // failure the second reading exists to catch.
  const claimedBySignature = new Map();
  for (const claim of interpreted.claims) {
    const key = signature(claim);
    claimedBySignature.set(key, (claimedBySignature.get(key) || 0) + 1);
  }
  for (const claim of verified.claims) {
    const key = signature(claim);
    const spent = claimedBySignature.get(key) || 0;
    if (spent > 0) { claimedBySignature.set(key, spent - 1); continue; }
    disputed.push({ claim, reason: 'interpreter_did_not_produce_this_claim' });
  }
  return { corroborated, disputed };
}

/**
 * One reading of a conversation.
 *
 * Returns `{ reading, usage }` so the harness can measure tokens from the
 * provider's own accounting. Our metering cannot be trusted for this: the
 * planner's usage is priced through the Realtime model's rates, and the turn
 * reader is not metered at all, so any cost comparison drawn from our telemetry
 * would be comparing two different fictions.
 */
export async function readSemanticClaims({
  env,
  config,
  systemPrompt,
  promptVersion,
  transcript,
  knownEntities = [],
  factCatalogue = []
}) {
  const turnIndex = new Map(transcript.map((turn) => [String(turn.turnId), String(turn.text || '')]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.semanticClaimsTimeoutMs || 45_000);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.semanticClaimsModel,
        store: false,
        max_output_tokens: config.semanticClaimsMaxOutputTokens || 8_000,
        reasoning: { effort: config.semanticClaimsReasoningEffort || 'low' },
        input: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: JSON.stringify({
              // The conversation, in order, with roles. Nothing else about the
              // storage layer appears here at all.
              conversation: transcript.map((turn) => ({
                turnId: turn.turnId,
                speaker: turn.role === 'assistant' ? 'adviser' : 'client',
                said: turn.text
              })),
              // Holdings already on file, so a second mention can be recognised
              // rather than duplicated. Labels and ids only — no indices, no
              // schema, no slots.
              knownEntities,
              // Which facts exist, by id and plain label. Not where they are
              // stored, not what shape the record takes.
              facts: factCatalogue
            })
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'semantic_claims_v1',
            strict: true,
            schema: CLAIM_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    return { reading: null, usage: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return { reading: null, usage: null, error: `provider_${response.status}` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { reading: null, usage: null, error: 'unparseable_provider_response' };
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textPart = output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .find((part) => typeof part?.text === 'string');
  if (!textPart) return { reading: null, usage: payload?.usage || null, error: 'no_output_text' };
  let parsed;
  try {
    parsed = JSON.parse(textPart.text);
  } catch (error) {
    return { reading: null, usage: payload?.usage || null, error: 'unparseable_claims' };
  }
  return {
    reading: normalizeClaims(parsed, { turnIndex }, promptVersion),
    usage: payload?.usage || null,
    error: null
  };
}

export const PROMPT_VERSIONS = Object.freeze({
  interpreter: INTERPRETER_PROMPT_VERSION,
  verifier: VERIFIER_PROMPT_VERSION
});
