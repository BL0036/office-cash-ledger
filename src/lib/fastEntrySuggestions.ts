// Phase 12a Part D: the swappable seam Phase 12b (smart autocomplete /
// auto-tagging) and Phase 12c (institution/petrol/advance intelligence)
// fill in. Fast Entry's Description onChange and Category/Expense
// Head selection call into this module rather than doing any inline
// "guess the right category" logic themselves, so each phase can
// replace/extend the body of `deriveSuggestions` (and widen
// `DerivedSuggestions`) without touching FastEntryBar.tsx's wiring itself.
//
// Phase 12b: deriveSuggestions() became real. It is a PURE function - all
// Dexie access lives in hooks/useFastEntrySuggestions.ts's
// useSuggestionCandidatePool(), which loads/caches the candidate pool once
// via a live (reactive) Dexie query rather than re-querying on every
// keystroke. That keeps this file trivially unit-testable (see
// scripts/test-fastentry-suggestions.ts) the same way fastEntry.ts's
// validateFastEntry/buildFastEntryTransactionInput are, without a
// DOM/fake-indexeddb harness.
//
// Phase 12c: extends the same three Part C patterns (never adds new ones,
// per this phase's Non-Goals) to also resolve suggestedInstitutionId
// (rule 3) and suggestedStaffId (rule 4), and adds the shared
// `expandMoreFields` flag (also set when rule 2 resolves specifically to
// the Petrol expense head) so FastEntryBar.tsx's selectSuggestion() can
// auto-open "+ more fields" from one place. `suggestedVehicleId` was
// deliberately NEVER set here through Phase 12c — see its doc comment on
// FastEntrySuggestionMatch below for the one exception Phase 3 (rule 5)
// adds.

import type { Direction } from '../types';

/** One ranked, keyboard-navigable autocomplete entry for the Description dropdown. */
export interface FastEntrySuggestionMatch {
  /** The candidate description text - filled into the field on selection. */
  description: string;
  /** Display label for the dropdown row, e.g. "Petrol — Travel & Fuel / Petrol". */
  label: string;
  /**
   * categoryId (cash_out) or cashInTypeId (cash_in) to auto-tag when this
   * suggestion is selected. Undefined only if no Part C rule resolved a
   * tag for this description (shouldn't happen for pool-derived candidates,
   * since they're built from the same sources Part C rules 1/2 match
   * against - kept optional defensively).
   */
  suggestedCategoryOrTypeId?: string;
  /**
   * Expense head to auto-tag (cash_out only). `null` means "tag the
   * category but explicitly clear/omit the head" (e.g. the institution
   * pattern, Part C rule 3); `undefined` means no category was resolved
   * either, so there's nothing to apply.
   */
  suggestedExpenseHeadId?: string | null;
  /** Phase 12c: set when the institution-name pattern (rule 3) matches. */
  suggestedInstitutionId?: string;
  /** Phase 12c: set when the staff-advance pattern (rule 4) matches. */
  suggestedStaffId?: string;
  /**
   * Deliberately NEVER set by rules 1-4 (Phase 12c's own scope): the
   * Petrol chain reveals Staff/Vehicle for the owner to pick, but there's
   * no signal yet for WHICH vehicle from "Petrol" alone — that comes from
   * the existing staff→vehicle assignment (resolveAssignedVehicleId() in
   * lib/staff.ts) once Staff is actually chosen, wired directly in
   * FastEntryBar.tsx rather than through this suggestion engine.
   *
   * Phase 3's rule 5 (vehicle-maintenance pattern) is the SINGLE
   * exception: unlike Petrol, a maintenance-style description directly
   * NAMES the vehicle in the typed text ("PULSAR 220 SERVICE"), so
   * there's a real signal to resolve here, the same way rule 3 resolves
   * suggestedInstitutionId and rule 4 resolves suggestedStaffId from
   * their own typed-text matches.
   */
  suggestedVehicleId?: string;
  /**
   * Phase 12c Part D: one shared flag every pattern that fills Staff/
   * Vehicle/Institution sets, so FastEntryBar.tsx's selectSuggestion()
   * only needs a single "should '+ more fields' open?" check instead of
   * three separate ones per pattern.
   */
  expandMoreFields: boolean;
  /**
   * Phase 12f Part D: which field genuinely still needs input after this
   * match's own auto-tag is applied, in forward tab order - computed per
   * pattern (not a generic "first empty required field" guess) so
   * FastEntryBar.tsx's post-accept focus lands somewhere useful instead of
   * on the field that was just auto-filled. 'amount' for every rule except
   * the institution pattern (rule 3), which tags Category+Institution but
   * deliberately leaves Expense Head for a manual pick (Phase 12c's own
   * scope), so Expense Head is what still needs a human decision there.
   */
  nextFocusHint: 'amount' | 'expenseHead';
  /**
   * Phase 6: set to 'ai' when this suggestion came from the optional
   * Gemini fallback (lib/aiFallback.ts) instead of Rules 1-5 below.
   * Undefined for every deterministic match - Rules 1-5 themselves are
   * untouched by Phase 6 and never set this. FastEntryBar.tsx uses it
   * only to render a visual "AI" badge distinguishing the two; selection
   * (selectSuggestion()) treats both kinds identically otherwise -
   * requiring the owner's explicit click either way, per this phase's
   * constraint #4.
   */
  source?: 'ai';
}

export interface DerivedSuggestions {
  /** Ranked, capped candidate list for the autocomplete dropdown. */
  descriptionMatches: FastEntrySuggestionMatch[];
}

/** One active Expense Head, carrying its parent Category for labeling (Part A source 1). */
export interface ExpenseHeadSuggestionCandidate {
  id: string;
  name: string;
  categoryId: string;
}

/** One active CashInType (Part A source 1). */
export interface CashInTypeSuggestionCandidate {
  id: string;
  name: string;
}

/** One past Transaction.description usage, direction-scoped (Part A source 2). */
export interface SuggestionHistoryEntry {
  description: string;
  /** categoryId (cash_out) or cashInTypeId (cash_in) that description was tagged with. */
  categoryOrTypeId: string;
  /** cash_out only; null otherwise/when no head was set. */
  expenseHeadId: string | null;
  createdAt: number; // epoch ms, for the most-recent-wins tie-break (Part C rule 1)
}

/** One active FinancialInstitution, for the institution-name pattern (Part C rule 3). */
export interface InstitutionSuggestionCandidate {
  id: string;
  name: string;
  /**
   * Phase 12g: other spellings/short forms this institution is also known
   * by - matched alongside `name`. Optional (defaults to `[]` wherever
   * read) so pool-building code that predates this phase still type-checks
   * and behaves correctly (matching on `name` alone) without being touched.
   */
  aliases?: string[];
}

/** One active Staff member, for the staff+"advance" pattern (Part C rule 4). */
export interface StaffSuggestionCandidate {
  id: string;
  name: string;
  /**
   * Phase 12g: other spellings/short forms (e.g. a nickname) this staff
   * member is also known by - matched alongside `name`. Optional, same
   * reasoning as InstitutionSuggestionCandidate.aliases above.
   */
  aliases?: string[];
}

/** One active Vehicle, for the vehicle-maintenance pattern (Phase 3 rule 5). */
export interface VehicleSuggestionCandidate {
  id: string;
  name: string;
  /**
   * Phase 3: other spellings/short forms this vehicle is also known by -
   * matched alongside `name`, same reasoning/optionality as
   * InstitutionSuggestionCandidate.aliases and StaffSuggestionCandidate.aliases
   * above (this candidate type is new, but keeping `aliases` optional here
   * too means any future pool-building code that only sets `id`/`name`
   * still type-checks).
   */
  aliases?: string[];
}

/**
 * Everything deriveSuggestions() matches/tags against, loaded once (not
 * per-keystroke) by useSuggestionCandidatePool(). Direction-scoped: a
 * fresh pool is built when Fast Entry's direction toggles.
 */
export interface SuggestionCandidatePool {
  direction: Direction;
  expenseHeadCandidates: ExpenseHeadSuggestionCandidate[];
  cashInTypeCandidates: CashInTypeSuggestionCandidate[];
  historyEntries: SuggestionHistoryEntry[];
  /** Active institutions - matching purposes only (Part A: NOT autocomplete candidates themselves). */
  institutionCandidates: InstitutionSuggestionCandidate[];
  /** Active staff - matching purposes only, same reasoning. */
  staffCandidates: StaffSuggestionCandidate[];
  /**
   * Phase 3: active vehicles - matching purposes only, same reasoning as
   * institutionCandidates/staffCandidates above (rule 5). Optional (and
   * defaulted to `[]` wherever read) so the pre-Phase-3 pool builders in
   * scripts/test-fastentry-suggestions.ts and scripts/test-fastentry-enter.ts
   * - which have no reason to exercise rule 5 - keep type-checking and
   * behaving correctly (rule 5 simply never matches anything) without
   * being touched, exactly the precedent Phase 12g set for `aliases`.
   */
  vehicleCandidates?: VehicleSuggestionCandidate[];
  categoryNameById: Map<string, string>;
  expenseHeadNameById: Map<string, string>;
  cashInTypeNameById: Map<string, string>;
  /** Resolved 'Savings & Financial' category id, or null if not seeded yet. */
  savingsCategoryId: string | null;
  /** Resolved 'Staff' category id, or null if not seeded yet. */
  staffCategoryId: string | null;
  /** Resolved 'Advance' expense head id under Staff, or null if not seeded yet. */
  staffAdvanceExpenseHeadId: string | null;
  /**
   * Phase 3: resolved 'Vehicle Maintenance' category id, or null/undefined
   * if not seeded yet (or if this pool predates rule 5 - see
   * vehicleCandidates above). Same optionality reasoning.
   */
  vehicleMaintenanceCategoryId?: string | null;
  /**
   * Phase 3: resolved 'Service' expense head id under Vehicle Maintenance
   * (seeded by Phase 12g's ensureVehicleServiceExpenseHead), or
   * null/undefined if not seeded yet / pool predates rule 5.
   */
  vehicleServiceExpenseHeadId?: string | null;
}

const MIN_INPUT_LENGTH = 2;
const MAX_SUGGESTIONS = 5;
const ADVANCE_KEYWORD = 'advance';
/**
 * Phase 3 rule 5's fixed, explicit maintenance-keyword list — EXACT SCOPE
 * says not to attempt synonym cleverness beyond this list, so this is
 * intentionally short and literal rather than stemmed/expanded.
 */
const MAINTENANCE_KEYWORDS = ['service', 'servicing', 'repair', 'maintenance', 'overhaul'];

interface ResolvedTag {
  categoryOrTypeId: string;
  expenseHeadId: string | null;
  label: string;
  institutionId?: string;
  staffId?: string;
  /** Phase 3 rule 5 only - see FastEntrySuggestionMatch.suggestedVehicleId's doc comment. */
  vehicleId?: string;
  expandMoreFields?: boolean;
  /** Phase 12f Part D - see FastEntrySuggestionMatch.nextFocusHint. Defaults to 'amount' when unset. */
  nextFocusHint?: 'amount' | 'expenseHead';
}

function labelFor(
  categoryOrTypeId: string,
  expenseHeadId: string | null,
  direction: Direction,
  pool: SuggestionCandidatePool,
): string {
  if (direction === 'cash_in') {
    return pool.cashInTypeNameById.get(categoryOrTypeId) ?? 'Unknown source';
  }
  const categoryName = pool.categoryNameById.get(categoryOrTypeId) ?? 'Unknown category';
  const headName = expenseHeadId ? pool.expenseHeadNameById.get(expenseHeadId) : undefined;
  return headName ? `${categoryName} / ${headName}` : categoryName;
}

/**
 * Part C rules 3 & 4, and Phase 3's rule 5 - the pattern-based rules that
 * can fire for text that ISN'T itself a known candidate name (an
 * institution, a staff+"advance" phrase, or a vehicle-maintenance
 * mention). All three are cash_out-only: 'Savings & Financial', 'Staff',
 * and 'Vehicle Maintenance' are all cash_out categories, and per 12b's
 * Non-Goals (still respected this phase) tagging a cash_in institution
 * match would need deposit-vs-withdrawal type intelligence this app
 * doesn't build. The Deposit/Withdrawal *label* Phase 12c adds in
 * FastEntryBar.tsx is a pure display concern layered on top of whatever
 * institutionId + direction already are — it doesn't change when this
 * rule itself fires.
 */
/**
 * Phase 12g: does `inputToken` (one whitespace-separated piece of the
 * owner's typed text) match `targetToken` (one whitespace-separated piece
 * of a candidate's name or alias)? Tiered per EXACT SCOPE 4.b: (i) exact,
 * (ii) either token is a prefix of the other, (iii) fuzzy via the
 * EXISTING isFuzzyMatch()/levenshteinDistance() functions above - reused
 * as-is, not reimplemented.
 */
/**
 * Phase 12g: does `inputToken` (one whitespace-separated piece of the
 * owner's typed text) match `targetToken` (one whitespace-separated piece
 * of a candidate's name or alias)? Tiered per EXACT SCOPE 4.b: (i) exact,
 * (ii) either token is a prefix of the other, (iii) fuzzy via the
 * EXISTING isFuzzyMatch()/levenshteinDistance() functions above - reused
 * as-is, not reimplemented.
 *
 * The fuzzy tier is additionally floored at 4 characters on BOTH tokens
 * (beyond isFuzzyMatch()'s own 3-character floor): isFuzzyMatch() slides a
 * short window across the whole target token, so at 3 characters it
 * happily "fuzzy-matches" common short words against a passing substring
 * of an unrelated long name (e.g. "DAI" against "DHANONDAYA" via its
 * "day" run) purely by coincidence. A short word that's genuinely meant to
 * abbreviate a candidate is caught by the prefix tier just above instead
 * ("ADV" -> "ADVANCE"), so nothing legitimate is lost by holding fuzzy
 * matching to 4+ characters.
 */
function tokensMatch(inputToken: string, targetToken: string): boolean {
  if (!inputToken || !targetToken) return false;
  if (inputToken === targetToken) return true;
  if (targetToken.startsWith(inputToken) || inputToken.startsWith(targetToken)) return true;
  if (Math.min(inputToken.length, targetToken.length) < 4) return false;
  return isFuzzyMatch(targetToken, inputToken);
}

/**
 * Phase 12g.1 bugfix: generic bipartite "does every element of `mustCover`
 * find its own distinct partner in `pool`" check, via standard
 * augmenting-path (Kuhn's) matching - fine at token-list sizes. An
 * unmatched `pool` element is fine; every `mustCover` element must be
 * matched to a DIFFERENT `pool` element (no reusing one partner for two).
 */
function everyElementMatchesDistinctPartner(
  mustCover: string[],
  pool: string[],
  matches: (a: string, b: string) => boolean,
): boolean {
  if (mustCover.length === 0) return false;
  const edges = mustCover.map((m) => pool.map((_, idx) => idx).filter((idx) => matches(m, pool[idx])));
  const owner: (number | null)[] = new Array(pool.length).fill(null);

  function tryAssign(i: number, visited: boolean[]): boolean {
    for (const j of edges[i]) {
      if (visited[j]) continue;
      visited[j] = true;
      if (owner[j] === null || tryAssign(owner[j]!, visited)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < mustCover.length; i++) {
    const visited = new Array(pool.length).fill(false);
    if (!tryAssign(i, visited)) return false;
  }
  return true;
}

/**
 * Phase 12g.1 bugfix: tier (iii) of matchesCandidateNameOrAlias() below.
 * The old version returned true the moment ANY single input-token/
 * target-token pair matched ANYWHERE - so one coincidentally-shared word
 * ("SAVING", shared by several unrelated cooperatives) or one fuzzily-
 * similar buried word ("KUMDAR" fuzzy-matching an unrelated "KUMAR") was
 * enough to validate a match while every other word the owner typed was
 * silently ignored. That's the exact bug reported against "JOIN SAVING"
 * (falsely made ambiguous by two unrelated "...SAVING..." institutions)
 * and "KUMAR DAI CASH" (falsely, uniquely auto-tagged via "KUMDAR" alone).
 *
 * The fix requires every INPUT token to be accounted for (a distinct
 * target token via tokensMatch()) - EXCEPT for short candidate names
 * (single institution names, staff names) where that's needlessly strict:
 * "Deposit to Dhanodaya" and "Advance - Sijan" are pre-existing,
 * intentional full-SENTENCE descriptions where "Deposit"/"to"/"Advance"/
 * "-" are sentence filler, never meant to be name-tokens at all - genuine
 * institution/staff-name mentions embedded in an otherwise free-form
 * description. Demanding every one of THOSE filler words also match the
 * name would silently break that (real, currently-tested) usage, for
 * exactly the same structural reason it fixes the two bugs above - one
 * word identifies the entity, the rest is unrelated - so token-count
 * alone can't tell "wanted" and "unwanted" apart on the input side.
 *
 * What DOES separate them: in both bugs, the false match only ever
 * explains a MINORITY of the CANDIDATE's own tokens too (ZEST's name has
 * 9 tokens, "SAVING" is 1 of them; KUMDAR's has 9, "KUMDAR" is 1). In the
 * genuine full-sentence cases, the matched name is short enough that the
 * one real token that DOES match is the candidate's ENTIRE name (or all
 * of it) - "Dhanodaya" is one token, wholly matched; "Sijan" is one
 * token, wholly matched. So a candidate counts as matching when EITHER
 * every input token is covered by a distinct target token (the literal,
 * general case - "JOIN SAVING" against "JOIN SAVING & CREDIT CO-OPERATIVE
 * LIMITED" needs exactly this, and per EXACT SCOPE the candidate's own
 * remaining tokens do NOT all need covering) OR every one of the
 * candidate's own tokens is covered by a distinct input token (the
 * "embedded in a longer sentence" case - only reachable at all for short
 * candidate names, since it needs one distinct input token per candidate
 * token). Both directions reuse the exact same tokensMatch() tiers -
 * exact/prefix/fuzzy - nothing new there.
 */
function tokenSetsMatch(inputTokens: string[], targetTokens: string[]): boolean {
  if (everyElementMatchesDistinctPartner(inputTokens, targetTokens, tokensMatch)) return true;
  return everyElementMatchesDistinctPartner(targetTokens, inputTokens, (t, i) => tokensMatch(i, t));
}

/**
 * Phase 12g: does the owner's typed text match this institution/staff
 * candidate's name or any of its aliases? Priority per EXACT SCOPE 4.b:
 *   (i)   exact case-insensitive match of the WHOLE input to the whole
 *         name/alias;
 *   (ii)  the whole input is a prefix of the whole name/alias, or vice
 *         versa (handles e.g. "JOIN SAVING" against "Join Saving & Credit
 *         Co-operative Limited", since the latter starts with the
 *         former);
 *   (iii) a per-TOKEN comparison (via tokenSetsMatch()/tokensMatch()
 *         above) between every token of the input and every token of the
 *         name/alias - the tier that makes a short abbreviation match a
 *         long multi-word name ("DHANODAYA" can only ever match
 *         "DHANONDAYA MULTIPURPOSE CO-OPERATIVE LTD" one token at a time,
 *         never as whole strings).
 *
 * Bugfix (this phase - see CHANGELOG-phase-12g2-bugfix.md): tier (ii)
 * used to ALSO count a match when any SINGLE name/alias token was a
 * prefix of the ENTIRE input string (e.g. "PULSAR" alone being a prefix
 * of "PULSAR 150 SERVICE"). That extra check is removed. It was far
 * looser than intended - it let one shared/generic word decide a match
 * before the precise, per-token tier (iii) ever ran, which both produced
 * false ambiguity (two vehicles/institutions sharing a first word) and
 * masked genuine gaps in tier (iii)'s own coverage by accident (see this
 * phase's changelog for both categories of proven real-data case). Tier
 * (ii) is now ONLY the whole-string prefix check; anything that isn't a
 * whole-string prefix match falls straight through to tier (iii).
 *
 * This only ever needs to answer yes/no (never rank), since rule 3/rule 4
 * pick uniquely among whichever candidates match at all - see
 * resolvePatternOnlyTags below.
 */
function matchesCandidateNameOrAlias(
  inputLower: string,
  inputTokens: string[],
  name: string,
  aliases: string[] | undefined,
): boolean {
  for (const target of [name, ...(aliases ?? [])]) {
    const targetLower = target.trim().toLowerCase();
    if (!targetLower) continue;

    // (i) exact whole-string match.
    if (inputLower === targetLower) return true;

    // (ii) whole-string prefix, either direction.
    if (targetLower.startsWith(inputLower) || inputLower.startsWith(targetLower)) return true;
    const targetTokens = targetLower.split(/\s+/).filter(Boolean);

    // (iii) tokenSetsMatch() - see its own doc comment for why this is
    // NOT simply "does any one token pair match" (that was the bug).
    if (tokenSetsMatch(inputTokens, targetTokens)) return true;
  }
  return false;
}

/**
 * Phase 12g: same tiered priority as matchesCandidateNameOrAlias above
 * (minus the alias list, since "advance" has no aliases of its own),
 * applied to the fixed ADVANCE_KEYWORD - so "SIJAN ADV" gates rule 4 the
 * same way "SIJAN ADVANCE" always has (typo/prefix tolerance shouldn't
 * apply to a candidate's own name/alias only and stop short at the literal
 * keyword the rule is named after).
 */
function textMatchesAdvanceKeyword(inputLower: string, inputTokens: string[]): boolean {
  if (inputLower.includes(ADVANCE_KEYWORD)) return true;
  return inputTokens.some((t) => tokensMatch(t, ADVANCE_KEYWORD));
}

/**
 * Phase 3 rule 5's keyword gate - same tiered shape as
 * textMatchesAdvanceKeyword above (whole-string substring, else
 * token-tolerant), just checked against each of the fixed
 * MAINTENANCE_KEYWORDS in turn instead of a single fixed word. Matching
 * ANY one of the five keywords is enough to gate the rule; which one
 * matched doesn't affect the resolved tag (Category/ExpenseHead are the
 * same "Vehicle Maintenance" / "Service" regardless).
 */
function textMatchesMaintenanceKeyword(inputLower: string, inputTokens: string[]): boolean {
  return MAINTENANCE_KEYWORDS.some(
    (keyword) => inputLower.includes(keyword) || inputTokens.some((t) => tokensMatch(t, keyword)),
  );
}

function resolvePatternOnlyTags(
  text: string,
  direction: Direction,
  pool: SuggestionCandidatePool,
): ResolvedTag | null {
  if (direction !== 'cash_out') return null;
  const textLower = text.toLowerCase();
  const textTokens = textLower.split(/\s+/).filter(Boolean);

  // Rule 3: institution-name pattern -> category, AND (Phase 12c) the
  // specific matched institution id. Phase 12g: matches against every
  // institution's aliases too, with typo tolerance - see
  // matchesCandidateNameOrAlias(). Never guesses: 2+ distinct institutions
  // matching the same typed text resolves to no match at all (same
  // ambiguity contract as resolveUniqueMatch()), rather than picking the
  // first one found.
  if (pool.savingsCategoryId) {
    const matchingInstitutions = pool.institutionCandidates.filter((inst) =>
      matchesCandidateNameOrAlias(textLower, textTokens, inst.name, inst.aliases),
    );
    if (matchingInstitutions.length > 1) return null; // genuine ambiguity - never guess
    const institution = matchingInstitutions[0];
    if (institution) {
      return {
        categoryOrTypeId: pool.savingsCategoryId,
        expenseHeadId: null,
        label: labelFor(pool.savingsCategoryId, null, direction, pool),
        institutionId: institution.id,
        expandMoreFields: true,
        // Part D: this pattern only ever tags Category, never Expense
        // Head (that's a manual pick per Phase 12c's own scope) - so
        // Expense Head, not Amount, is the next thing that genuinely
        // needs the owner's input.
        nextFocusHint: 'expenseHead',
      };
    }
  }

  // Rule 4: staff-name + "advance" keyword pattern -> category + head,
  // AND (Phase 12c) the specific matched staff id. Phase 12g: same
  // alias/typo tolerance and ambiguity contract as rule 3 above, and the
  // "advance" keyword gate itself is now typo/prefix-tolerant too (see
  // textMatchesAdvanceKeyword()) so "SIJAN ADV" gates exactly like "SIJAN
  // ADVANCE" always has.
  if (pool.staffCategoryId && textMatchesAdvanceKeyword(textLower, textTokens)) {
    const matchingStaff = pool.staffCandidates.filter((s) =>
      matchesCandidateNameOrAlias(textLower, textTokens, s.name, s.aliases),
    );
    if (matchingStaff.length > 1) return null; // genuine ambiguity - never guess
    const staff = matchingStaff[0];
    if (staff) {
      return {
        categoryOrTypeId: pool.staffCategoryId,
        expenseHeadId: pool.staffAdvanceExpenseHeadId,
        label: labelFor(pool.staffCategoryId, pool.staffAdvanceExpenseHeadId, direction, pool),
        staffId: staff.id,
        expandMoreFields: true,
      };
    }
  }

  // Rule 5 (Phase 3): vehicle-maintenance pattern -> Category "Vehicle
  // Maintenance" + ExpenseHead "Service" + the specific matched vehicle,
  // and (optionally) the specific matched staff member. Fires only for a
  // description containing one of the fixed MAINTENANCE_KEYWORDS, and
  // only once a Vehicle is actually matched — a staff mention alone,
  // with no vehicle match and no "advance" keyword, is NOT this rule's
  // territory (it stays unresolved here, same as it always has; rule 4
  // above is the only rule that ever resolves a staff-only mention, and
  // only when "advance" is present). Reuses the exact same
  // matchesCandidateNameOrAlias() token-matching rule 3/4 use — no second
  // matcher, no loosened tolerance. Same never-guess contract as every
  // other rule here: 2+ matching vehicles, or 2+ matching staff for the
  // optional staff portion, resolves to no match at all.
  if (
    pool.vehicleMaintenanceCategoryId &&
    pool.vehicleServiceExpenseHeadId &&
    textMatchesMaintenanceKeyword(textLower, textTokens)
  ) {
    const matchingVehicles = (pool.vehicleCandidates ?? []).filter((v) =>
      matchesCandidateNameOrAlias(textLower, textTokens, v.name, v.aliases),
    );
    if (matchingVehicles.length > 1) return null; // genuine ambiguity - never guess
    const vehicle = matchingVehicles[0];
    if (vehicle) {
      const matchingStaff = pool.staffCandidates.filter((s) =>
        matchesCandidateNameOrAlias(textLower, textTokens, s.name, s.aliases),
      );
      if (matchingStaff.length > 1) return null; // genuine ambiguity on the OPTIONAL staff match - never guess
      const staff = matchingStaff[0];
      return {
        categoryOrTypeId: pool.vehicleMaintenanceCategoryId,
        expenseHeadId: pool.vehicleServiceExpenseHeadId,
        label: labelFor(pool.vehicleMaintenanceCategoryId, pool.vehicleServiceExpenseHeadId, direction, pool),
        vehicleId: vehicle.id,
        staffId: staff?.id,
        expandMoreFields: true,
      };
    }
  }

  return null;
}

/**
 * Part C's rules, plus Phase 3's rule 5, in priority order (first match
 * wins). `name` is a candidate description string (either a pool
 * candidate or the owner's raw typed text).
 */
function resolveTags(
  name: string,
  direction: Direction,
  pool: SuggestionCandidatePool,
): ResolvedTag | null {
  const nameLower = name.trim().toLowerCase();
  if (!nameLower) return null;

  // Rule 1: learned from history - exact description match, most-recent
  // usage wins. Most-recent (not most-frequent) because it reflects the
  // owner's CURRENT habit: if they used to tag "Milk" under Groceries but
  // recently switched to tagging it under Kitchen, most-recent follows
  // that correction immediately, where most-frequent would keep dragging
  // it back to the old (now-wrong) answer until the new usage outnumbers
  // months of old history. This takes priority over every rule below it
  // exactly per Part C's stated reasoning: it's the owner's own actual
  // usage, the strongest signal available.
  const historyHits = pool.historyEntries.filter(
    (h) => h.description.trim().toLowerCase() === nameLower,
  );
  if (historyHits.length > 0) {
    const mostRecent = historyHits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    return {
      categoryOrTypeId: mostRecent.categoryOrTypeId,
      expenseHeadId: mostRecent.expenseHeadId,
      label: labelFor(mostRecent.categoryOrTypeId, mostRecent.expenseHeadId, direction, pool),
    };
  }

  // Rule 2: direct expense-head / cash-in-type name match.
  if (direction === 'cash_out') {
    const head = pool.expenseHeadCandidates.find((h) => h.name.toLowerCase() === nameLower);
    if (head) {
      // Phase 12c Part B: "Petrol" specifically (not expense heads in
      // general) additionally surfaces Staff/Vehicle as quick-picks by
      // expanding "+ more fields" — the master spec's explicit worked
      // example. No staffId/vehicleId is set here; there's no signal yet
      // for which one (see suggestedVehicleId's doc comment).
      const isPetrol = head.name.trim().toLowerCase() === 'petrol';
      return {
        categoryOrTypeId: head.categoryId,
        expenseHeadId: head.id,
        label: labelFor(head.categoryId, head.id, direction, pool),
        expandMoreFields: isPetrol,
      };
    }
  } else {
    const type = pool.cashInTypeCandidates.find((t) => t.name.toLowerCase() === nameLower);
    if (type) {
      return {
        categoryOrTypeId: type.id,
        expenseHeadId: null,
        label: labelFor(type.id, null, direction, pool),
      };
    }
  }

  // Rules 3 & 4: institution / staff-advance patterns.
  return resolvePatternOnlyTags(name, direction, pool);
}

function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Simple substring-with-typo-tolerance check (Part B tier 3): does any
 * window of `candidateLower` the same length as `inputLower` fall within a
 * small edit-distance budget? Deliberately basic - no fuzzy-search library
 * dependency, just a bounded nested loop over short strings.
 */
function isFuzzyMatch(candidateLower: string, inputLower: string): boolean {
  if (inputLower.length < 3) return false; // too short - would match almost anything
  const windowLen = inputLower.length;
  const threshold = windowLen <= 4 ? 1 : 2;
  if (candidateLower.length <= windowLen) {
    return levenshteinDistance(candidateLower, inputLower) <= threshold;
  }
  for (let start = 0; start <= candidateLower.length - windowLen; start++) {
    if (levenshteinDistance(candidateLower.slice(start, start + windowLen), inputLower) <= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Given the current Fast Entry description text (and direction, since
 * suggestions are direction-scoped), derive ranked autocomplete
 * suggestions and their auto-tag targets.
 *
 * Deterministic, offline, no external/AI service (Part B). Returns null
 * below the minimum input length or when nothing matches.
 */
/**
 * Direction-scoped reference names + the owner's own history, deduplicated
 * case-insensitively (first-seen casing wins - reference names are added
 * first so a seeded "Petrol" wins over a historically-typed "petrol").
 * Shared by deriveSuggestions() (dropdown ranking) and resolveUniqueMatch()
 * (Phase 12f) so both work off exactly the same candidate set.
 */
function buildRawCandidateNames(direction: Direction, pool: SuggestionCandidatePool): string[] {
  const seen = new Set<string>();
  const rawCandidates: string[] = [];
  const addCandidate = (name: string) => {
    const key = name.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      rawCandidates.push(name.trim());
    }
  };
  if (direction === 'cash_out') {
    for (const h of pool.expenseHeadCandidates) addCandidate(h.name);
  } else {
    for (const t of pool.cashInTypeCandidates) addCandidate(t.name);
  }
  for (const h of pool.historyEntries) addCandidate(h.description);
  return rawCandidates;
}

/**
 * Part B's three match tiers (exact / starts-with / contains-or-fuzzy), as
 * a single reusable check. Returns null when `nameLower` doesn't match
 * `inputLower` at all. Shared by deriveSuggestions() and
 * resolveUniqueMatch() (Phase 12f) - the tier NUMBER matters for
 * deriveSuggestions' dropdown ordering; resolveUniqueMatch only cares
 * whether it's non-null (any tier counts as "matches at all").
 */
function matchTier(nameLower: string, inputLower: string): number | null {
  if (nameLower === inputLower) return 0;
  if (nameLower.startsWith(inputLower)) return 1;
  if (nameLower.includes(inputLower) || isFuzzyMatch(nameLower, inputLower)) return 2;
  return null;
}

/** Builds the FastEntrySuggestionMatch shape from a resolved tag - shared by deriveSuggestions() and resolveUniqueMatch(). */
function buildSuggestionMatch(name: string, tag: ResolvedTag | null): FastEntrySuggestionMatch {
  return {
    description: name,
    label: tag ? `${name} — ${tag.label}` : name,
    suggestedCategoryOrTypeId: tag?.categoryOrTypeId,
    suggestedExpenseHeadId: tag ? tag.expenseHeadId : undefined,
    suggestedInstitutionId: tag?.institutionId,
    suggestedStaffId: tag?.staffId,
    suggestedVehicleId: tag?.vehicleId,
    expandMoreFields: tag?.expandMoreFields ?? false,
    nextFocusHint: tag?.nextFocusHint ?? 'amount',
  };
}

export function deriveSuggestions(
  description: string,
  direction: Direction,
  pool: SuggestionCandidatePool,
): DerivedSuggestions | null {
  const input = description.trim();
  if (input.length < MIN_INPUT_LENGTH) return null;
  const inputLower = input.toLowerCase();

  const rawCandidates = buildRawCandidateNames(direction, pool);
  const seen = new Set(rawCandidates.map((n) => n.toLowerCase()));

  // Frequency, case-insensitive, from history only (Part B: "rank by how
  // frequently that exact description has been used historically").
  const freq = new Map<string, number>();
  for (const h of pool.historyEntries) {
    const key = h.description.trim().toLowerCase();
    if (!key) continue;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }

  const scored: { name: string; tier: number; freq: number }[] = [];
  for (const name of rawCandidates) {
    const tier = matchTier(name.toLowerCase(), inputLower);
    if (tier == null) continue;
    scored.push({ name, tier, freq: freq.get(name.toLowerCase()) ?? 0 });
  }
  scored.sort((a, b) => a.tier - b.tier || b.freq - a.freq || a.name.localeCompare(b.name));
  let names = scored.map((s) => s.name);

  // Institution / staff-advance patterns (Part C rules 3/4) can apply to
  // the owner's raw typed text even when it isn't itself a known candidate
  // name (Part A deliberately keeps institution names out of the
  // candidate pool). Surface the typed text as a top suggestion in that
  // case so selecting it can still auto-tag.
  if (!seen.has(inputLower) && resolvePatternOnlyTags(input, direction, pool)) {
    names = [input, ...names];
  }

  names = names.slice(0, MAX_SUGGESTIONS);
  if (names.length === 0) return null;

  const descriptionMatches: FastEntrySuggestionMatch[] = names.map((name) =>
    buildSuggestionMatch(name, resolveTags(name, direction, pool)),
  );

  return { descriptionMatches };
}

/**
 * Phase 12f Part A: resolves the current Description text to a single
 * unique auto-tag candidate, or null when there is genuine ambiguity (or
 * no match at all). Pure and DOM-independent so it's directly
 * unit-testable (see scripts/test-fastentry-smart-entry.ts) without
 * driving FastEntryBar.tsx's keyboard handling.
 *
 * Priority, exactly per the correction doc's §7:
 *   1. An EXACT (case-insensitive) match to exactly one candidate - an
 *      Expense Head/CashInType name, a FinancialInstitution/staff-advance
 *      pattern (Part C rules 3/4, cash_out only), or a historically-used
 *      exact description (Part C rule 1) - wins outright, regardless of
 *      how many OTHER candidates also partially match the same text.
 *      resolveTags() already implements exactly this priority order and
 *      only ever fires on an exact name/pattern match (never a partial
 *      one), so it's reused as-is rather than reimplemented here.
 *   2. No exact match: if exactly ONE of deriveSuggestions' own dropdown
 *      candidates (Expense Head/CashInType names + history descriptions)
 *      matches at ALL (any tier, via the same matchTier() deriveSuggestions
 *      uses for ranking) - that's a "strong unique match", since nothing
 *      else even partially matches.
 *   3. Two or more candidates match with no exact match among them -> NOT
 *      unique, return null (e.g. "Kh" matching both "Khaja" and "Khana").
 */
export function resolveUniqueMatch(
  description: string,
  pool: SuggestionCandidatePool,
): FastEntrySuggestionMatch | null {
  const input = description.trim();
  if (!input) return null;
  const direction = pool.direction;

  const exactTag = resolveTags(input, direction, pool);
  if (exactTag) return buildSuggestionMatch(input, exactTag);

  const inputLower = input.toLowerCase();
  const candidateNames = buildRawCandidateNames(direction, pool);
  const matches = candidateNames.filter((name) => matchTier(name.toLowerCase(), inputLower) != null);
  if (matches.length !== 1) return null;

  const tag = resolveTags(matches[0], direction, pool);
  if (!tag) return null; // defensive - every pool candidate name is taggable
  return buildSuggestionMatch(matches[0], tag);
}
