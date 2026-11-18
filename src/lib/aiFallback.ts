// Phase 6: OPTIONAL, on-demand Gemini API fallback for Fast Entry's Smart
// Entry, used ONLY when the deterministic engine (fastEntrySuggestions.ts
// Rules 1-5, via resolveUniqueMatch()) has already run for the current
// text and found no match or genuine ambiguity. This module is never
// imported by fastEntrySuggestions.ts, and never calls back into it
// beyond reading the same already-loaded SuggestionCandidatePool — Rules
// 1-5's own logic is untouched by this phase.
//
// Design summary (see CHANGELOG-phase-6.md for the full research this was
// based on):
// - Endpoint: the classic `generateContent` REST call
//   (POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent),
//   confirmed still fully supported by Google and confirmed to support
//   direct browser-side calls with CORS (this app has no backend to proxy
//   through, so this was verified before writing any of this file - see
//   the changelog). Auth via the `x-goog-api-key` header. This is a
//   transport-level property of the endpoint itself, not tied to any one
//   model - re-confirmed still true at the Phase 6 model-fix date below.
// - Structured output: generationConfig.responseMimeType +
//   responseSchema with an `enum` constraint, so the model can ONLY ever
//   return one of the index strings for the candidates we actually sent
//   it, or the literal "NONE" - never a freeform/hallucinated id. The
//   returned index is ALSO re-validated against the candidate array
//   locally (defense in depth - never trust the API's schema compliance
//   alone for something that flows into the owner's ledger).
// - Every candidate offered to the model is a real name from the owner's
//   own master data (category/expense-head/cash-in-type/institution/
//   staff/vehicle) - the prompt explicitly forbids inventing a new one,
//   and the enum-constrained schema makes it structurally impossible for
//   a fabricated name to come back as a "match" even if the model ignored
//   that instruction.
//
// MODEL CURRENCY - read this before assuming the MODEL constant below is
// still correct, and update this note (not just the constant) the next
// time it needs to change:
//   - Phase 6 (original): gemini-2.5-flash-lite. Reasoning at the time:
//     current stable, non-preview, free-tier-friendly "lite" tier model.
//   - Phase 6 model-fix (verified 2026-09-20, live web search against
//     ai.google.dev/gemini-api/docs/models and .../deprecations, not
//     training-data recall): gemini-2.5-flash-lite's own deprecation
//     entry lists "Earliest shutdown: July 2026" - already past by the
//     verification date, consistent with real reports of it returning
//     "no longer available" errors. The model lineup has moved to a 3.x
//     generation since Phase 6 was built. As of the verification date,
//     TWO stable (GA, non-preview) lite-tier models exist:
//       - gemini-3.1-flash-lite - stable, but ALREADY has an announced
//         shutdown date of 2027-05-07 (~7.5 months of runway from the
//         verification date).
//       - gemini-3.5-flash-lite - stable, released 2026-07-21, "No
//         shutdown date announced" as of the verification date, and
//         explicitly named as gemini-3.1-flash-lite's own successor.
//     Picked gemini-3.5-flash-lite - the longest remaining runway of the
//     two, and still squarely the "lite" tier this feature was always
//     meant to use (never a reasoning/pro-tier model). Request/response
//     shape confirmed UNCHANGED for this model: same `contents`/`parts`
//     request body, same `x-goog-api-key` header, same
//     `generationConfig.responseMimeType`+`responseSchema` structured-
//     output mechanism, same `candidates[0].content.parts[0].text`
//     response field - no code changes were needed beyond the MODEL
//     constant itself. One minor, NOT-acted-on observation: Google's
//     release notes for this model generation list `temperature`,
//     `top_p`, and `top_k` as now-deprecated request parameters; this
//     file already didn't set `top_p`/`top_k`, and its existing
//     `temperature: 0` was left in place rather than removed, since
//     deprecated is not the same as removed/broken, this fix's own scope
//     is a targeted model-string swap rather than a redesign, and
//     lib/aiFallback.ts's own instructions for this fix say not to touch
//     anything beyond what's strictly necessary.
//   - Whoever updates this next: re-run the same verification (live
//     search of the two URLs above, not memory) rather than trusting
//     this comment's dates to still be current by the time you read it -
//     that staleness is exactly what caused this bug in the first place.
//
// Failure handling (constraint #6 - MUST degrade gracefully, always):
// every exported function here returns `{ ok: false, reason }` instead of
// throwing, for network errors, non-2xx responses (429/quota included),
// timeouts (AbortController, 15s), and malformed/empty responses alike.
// Nothing in this file ever touches the transaction-save path directly -
// FastEntryBar.tsx decides what to do with the result, and Fast Entry's
// save itself has zero dependency on anything in this module.

import type { Direction } from '../types';
import type { FastEntrySuggestionMatch, SuggestionCandidatePool } from './fastEntrySuggestions';
import { isAiFallbackConfigured, getAiFallbackSettings } from './aiSettingsStore';

const MODEL = 'gemini-3.5-flash-lite';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 15_000;

/** Re-exported so callers (FastEntryBar.tsx) have one place to check "should the Ask AI affordance even render". */
export { isAiFallbackConfigured };

export type AiFallbackResult =
  | { ok: true; suggestion: FastEntrySuggestionMatch }
  | { ok: true; suggestion: null } // reached the API, it confidently found nothing - not a failure, just "no match"
  | { ok: false; reason: string };

/** One flattened, taggable thing the AI can pick - see the file header for why everything is flattened into one list with the FastEntrySuggestionMatch fields already attached. */
interface AiCandidate {
  label: string;
  names: string[]; // name + aliases, everything the model should recognize this candidate by
  match: Omit<FastEntrySuggestionMatch, 'description' | 'source'>;
}

/** Same conventions rules 3/4/5 already use (see fastEntrySuggestions.ts's own doc comments on these two fields) - reused here rather than reinvented, since AI-sourced matches flow through the exact same selectSuggestion() in FastEntryBar.tsx. */
function expandFlagsFor(hasEntity: boolean, isInstitutionPattern: boolean): Pick<FastEntrySuggestionMatch, 'expandMoreFields' | 'nextFocusHint'> {
  return {
    expandMoreFields: hasEntity,
    nextFocusHint: isInstitutionPattern ? 'expenseHead' : 'amount',
  };
}

/**
 * Builds the flat candidate list the model is allowed to choose from,
 * straight from the SAME SuggestionCandidatePool FastEntryBar.tsx already
 * has loaded (no extra Dexie access here) - mirrors exactly how rules
 * 3/4/5 in fastEntrySuggestions.ts tag an institution/staff/vehicle
 * match, and rule 1/2 tag a plain category+expense-head or cash-in-type
 * match, WITHOUT importing or calling any of that file's own functions.
 */
export function buildAiCandidates(pool: SuggestionCandidatePool): AiCandidate[] {
  const candidates: AiCandidate[] = [];

  if (pool.direction === 'cash_in') {
    for (const t of pool.cashInTypeCandidates) {
      candidates.push({
        label: t.name,
        names: [t.name],
        match: { label: t.name, suggestedCategoryOrTypeId: t.id, ...expandFlagsFor(false, false) },
      });
    }
    return candidates;
  }

  // cash_out: plain category/expense-head combinations...
  for (const h of pool.expenseHeadCandidates) {
    const categoryName = pool.categoryNameById.get(h.categoryId) ?? 'Unknown category';
    const label = `${categoryName} / ${h.name}`;
    candidates.push({
      label,
      names: [h.name, label],
      match: { label, suggestedCategoryOrTypeId: h.categoryId, suggestedExpenseHeadId: h.id, ...expandFlagsFor(false, false) },
    });
  }

  // ...institutions (rule 3's own convention: Savings & Financial, no expense head)...
  if (pool.savingsCategoryId) {
    for (const inst of pool.institutionCandidates) {
      const label = `${inst.name} — ${pool.categoryNameById.get(pool.savingsCategoryId) ?? 'Savings & Financial'}`;
      candidates.push({
        label,
        names: [inst.name, ...(inst.aliases ?? [])],
        match: {
          label,
          suggestedCategoryOrTypeId: pool.savingsCategoryId,
          suggestedExpenseHeadId: null,
          suggestedInstitutionId: inst.id,
          ...expandFlagsFor(true, true),
        },
      });
    }
  }

  // ...staff+advance (rule 4's own convention: Staff / Advance)...
  if (pool.staffCategoryId && pool.staffAdvanceExpenseHeadId) {
    const staffCategoryName = pool.categoryNameById.get(pool.staffCategoryId) ?? 'Staff';
    const advanceHeadName = pool.expenseHeadNameById.get(pool.staffAdvanceExpenseHeadId) ?? 'Advance';
    for (const s of pool.staffCandidates) {
      const label = `${s.name} — ${staffCategoryName} / ${advanceHeadName}`;
      candidates.push({
        label,
        names: [s.name, ...(s.aliases ?? [])],
        match: {
          label,
          suggestedCategoryOrTypeId: pool.staffCategoryId,
          suggestedExpenseHeadId: pool.staffAdvanceExpenseHeadId,
          suggestedStaffId: s.id,
          ...expandFlagsFor(true, false),
        },
      });
    }
  }

  // ...vehicle maintenance (rule 5's own convention: Vehicle Maintenance / Service).
  if (pool.vehicleMaintenanceCategoryId && pool.vehicleServiceExpenseHeadId) {
    const vehCategoryName = pool.categoryNameById.get(pool.vehicleMaintenanceCategoryId) ?? 'Vehicle Maintenance';
    const serviceHeadName = pool.expenseHeadNameById.get(pool.vehicleServiceExpenseHeadId) ?? 'Service';
    for (const v of pool.vehicleCandidates ?? []) {
      const label = `${v.name} — ${vehCategoryName} / ${serviceHeadName}`;
      candidates.push({
        label,
        names: [v.name, ...(v.aliases ?? [])],
        match: {
          label,
          suggestedCategoryOrTypeId: pool.vehicleMaintenanceCategoryId,
          suggestedExpenseHeadId: pool.vehicleServiceExpenseHeadId,
          suggestedVehicleId: v.id,
          ...expandFlagsFor(true, false),
        },
      });
    }
  }

  return candidates;
}

function buildPrompt(description: string, direction: Direction, candidates: AiCandidate[]): string {
  const list = candidates
    .map((c, i) => `${i}. ${c.label}${c.names.length > 1 ? ` (also known as: ${c.names.slice(1).join(', ')})` : ''}`)
    .join('\n');
  return [
    'You are helping categorize one line of a small Nepali office cash ledger.',
    `The owner just typed this ${direction === 'cash_in' ? 'cash-IN' : 'cash-OUT'} description: "${description}"`,
    '',
    'Below is the COMPLETE list of the owner\'s own real categories/people/vehicles/institutions. Pick the single option that this description most plausibly refers to.',
    '',
    list,
    '',
    'Rules:',
    '- You MUST pick only from the numbered list above, or answer NONE.',
    '- NEVER invent a name, category, person, or vehicle that is not in the list.',
    '- If nothing in the list is a plausible match, or you are not reasonably confident, answer NONE - a wrong guess is worse than no guess.',
    'Respond with the index number as a string, or "NONE".',
  ].join('\n');
}

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * The one function FastEntryBar.tsx calls. Makes exactly one network
 * request (never retried automatically - a failed attempt is just a
 * failed attempt; the owner can click "Ask AI" again themselves).
 */
export async function requestAiFallbackSuggestion(
  description: string,
  direction: Direction,
  pool: SuggestionCandidatePool,
): Promise<AiFallbackResult> {
  const settings = getAiFallbackSettings();
  if (!settings.enabled || !settings.apiKey) {
    return { ok: false, reason: 'AI fallback is not configured.' };
  }
  const trimmed = description.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'Description too short.' };
  }

  const candidates = buildAiCandidates(pool);
  if (candidates.length === 0) {
    return { ok: false, reason: 'No candidates available yet.' };
  }

  const schema = {
    type: 'object',
    properties: {
      matchIndex: {
        type: 'string',
        enum: [...candidates.map((_, i) => String(i)), 'NONE'],
      },
    },
    required: ['matchIndex'],
  };

  const body = {
    contents: [{ parts: [{ text: buildPrompt(trimmed, direction, candidates) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure, DNS failure, CORS rejection, or our own
    // AbortController timeout - all land here. Never throw onward.
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, reason: 'AI suggestion timed out.' };
    }
    return { ok: false, reason: 'AI suggestion unavailable (network error).' };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // Covers 429 (quota/rate-limit), 401/403 (bad key), 500s, etc. - all
    // treated identically from the owner's point of view: a calm
    // "unavailable", never a crash, never a blocked save.
    if (response.status === 429) {
      return { ok: false, reason: 'AI suggestion unavailable (quota/rate limit reached).' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'AI suggestion unavailable (invalid API key).' };
    }
    return { ok: false, reason: `AI suggestion unavailable (HTTP ${response.status}).` };
  }

  let parsed: GeminiResponseShape;
  try {
    parsed = (await response.json()) as GeminiResponseShape;
  } catch {
    return { ok: false, reason: 'AI suggestion unavailable (malformed response).' };
  }

  if (parsed.promptFeedback?.blockReason) {
    return { ok: false, reason: 'AI suggestion unavailable (response blocked).' };
  }

  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return { ok: false, reason: 'AI suggestion unavailable (empty response).' };
  }

  let matchIndexRaw: unknown;
  try {
    const asJson = JSON.parse(text) as { matchIndex?: unknown };
    matchIndexRaw = asJson.matchIndex;
  } catch {
    return { ok: false, reason: 'AI suggestion unavailable (malformed response).' };
  }

  if (typeof matchIndexRaw !== 'string' || matchIndexRaw === 'NONE') {
    return { ok: true, suggestion: null };
  }

  // Defense in depth: never trust the schema constraint alone. If the
  // returned string somehow isn't a valid index into OUR OWN candidate
  // array (built moments ago from the owner's real data), treat it as no
  // match rather than guessing what was meant.
  const index = Number(matchIndexRaw);
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
    return { ok: true, suggestion: null };
  }

  const picked = candidates[index];
  return {
    ok: true,
    suggestion: {
      description: trimmed,
      source: 'ai',
      ...picked.match,
    },
  };
}
