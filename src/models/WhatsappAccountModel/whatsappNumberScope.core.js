/**
 * Which stored messages belong to the organization's CURRENTLY ACTIVE business
 * number. Pure functions (no DB) so the rule is unit-testable.
 *
 * Model
 *   identities: rows { phone_number_id, business_number } — every transport id
 *   (phone_number_id) the organization has used, mapped to the canonical E.164
 *   business number it served.
 *
 * Rule
 *   The ACTIVE number is the canonical form of the current connection's business
 *   number — NOT "whichever identity has the account's current phone_number_id",
 *   because a Phone Number ID can change (re-onboarding, manual edit) while the
 *   business number stays the same.
 *
 *   A message is hidden from the active number's inbox ONLY when its
 *   phone_number_id belongs to a DIFFERENT business number of the same
 *   organization. Same number under a new WABA / Phone Number ID stays visible;
 *   organizations with no identity rows get no filtering at all.
 *   Nothing is deleted or rewritten — this is a read-side association rule.
 */

const SAFE_COLUMN = /^[a-z_]+(\.[a-z_]+)?$/i;

export const SCOPE_REASONS = Object.freeze({
  NO_IDENTITIES: "NO_IDENTITIES", // never switched → legacy behaviour, no filter
  NO_ACTIVE_ACCOUNT: "NO_ACTIVE_ACCOUNT", // disconnected → no filter
  BY_NUMBER: "BY_NUMBER", // active number resolved from the canonical business number
  BY_TRANSPORT: "BY_TRANSPORT", // number unparseable; matched via phone_number_id
  UNRESOLVED: "UNRESOLVED", // identities exist but the active number can't be resolved
});

/**
 * @param identities            [{ phone_number_id, business_number }]
 * @param activeBusinessNumber  canonical E.164 of the current connection, or null
 * @param activePhoneNumberId   current connection's transport id (fallback only)
 * @param hasActiveAccount      whether a non-deleted connection exists
 * @returns { excluded: string[], reason }
 */
export const resolveExcludedTransportIds = ({
  identities = [],
  activeBusinessNumber = null,
  activePhoneNumberId = null,
  hasActiveAccount = true,
}) => {
  if (!identities.length) return { excluded: [], reason: SCOPE_REASONS.NO_IDENTITIES };
  if (!hasActiveAccount) return { excluded: [], reason: SCOPE_REASONS.NO_ACTIVE_ACCOUNT };

  const unique = (rows) => [...new Set(rows.map((i) => String(i.phone_number_id)))];

  if (activeBusinessNumber) {
    // Identities of OTHER numbers are hidden. If the active number matches no
    // identity at all (the number itself was changed by hand), every known identity
    // belongs to a different number and is hidden — never silently shown.
    return {
      excluded: unique(identities.filter((i) => i.business_number !== activeBusinessNumber)),
      reason: SCOPE_REASONS.BY_NUMBER,
    };
  }

  // The stored number could not be canonicalized: fall back to the transport id.
  const byTransport = identities.find((i) => String(i.phone_number_id) === String(activePhoneNumberId));
  if (byTransport) {
    return {
      excluded: unique(identities.filter((i) => i.business_number !== byTransport.business_number)),
      reason: SCOPE_REASONS.BY_TRANSPORT,
    };
  }
  return { excluded: [], reason: SCOPE_REASONS.UNRESOLVED };
};

/**
 * SQL fragment with EXPLICIT flat placeholders — one `?` per id. Deliberately not
 * `IN (?)` with an array: flat binding is unambiguous for every Sequelize / MySQL
 * driver combination. Empty list → empty fragment (legacy-identical SQL).
 */
export const buildScopeClause = (excludedIds, column = "phone_number_id") => {
  if (!SAFE_COLUMN.test(column)) throw new Error("Invalid scope column");
  if (!excludedIds?.length) return { sql: "", params: [] };
  return {
    sql: ` AND ${column} NOT IN (${excludedIds.map(() => "?").join(",")})`,
    params: [...excludedIds],
  };
};

/** Same, for queries that use NAMED replacements (`:name`). */
export const buildNamedScopeClause = (excludedIds, column = "phone_number_id", prefix = "wa_scope") => {
  if (!SAFE_COLUMN.test(column)) throw new Error("Invalid scope column");
  if (!excludedIds?.length) return { sql: "", replacements: {} };
  const replacements = {};
  const names = excludedIds.map((id, i) => {
    replacements[`${prefix}${i}`] = id;
    return `:${prefix}${i}`;
  });
  return { sql: ` AND ${column} NOT IN (${names.join(",")})`, replacements };
};

/**
 * Identity rows to record when a connection is completed (append-only).
 *
 *  previous              the connection being superseded ({business_number,
 *                        phone_number_id, waba_id, connection_type}) or null
 *  next                  the new connection (same shape)
 *  historicalTransportIds  every phone_number_id already present on this
 *                        organization's stored messages, when no identity has been
 *                        recorded yet. Existing history is attributed to the
 *                        PREVIOUS number (it was the org's only connection).
 *
 * Returns rows in insert order: seeds first, then the new connection.
 */
export const planIdentityRows = ({ mode, previous, next, historicalTransportIds = [] }) => {
  const rows = [];
  if (previous) {
    const seedIds = new Set([String(previous.phone_number_id), ...historicalTransportIds.map(String)]);
    for (const pid of seedIds) {
      rows.push({
        phone_number_id: pid,
        business_number: previous.business_number,
        waba_id: pid === String(previous.phone_number_id) ? previous.waba_id ?? null : null,
        connection_type: pid === String(previous.phone_number_id) ? previous.connection_type ?? null : null,
        migration_mode: "LEGACY_SEED",
        previous_business_number: null,
        seed: true,
      });
    }
  }
  rows.push({
    phone_number_id: String(next.phone_number_id),
    business_number: next.business_number,
    waba_id: next.waba_id ?? null,
    connection_type: next.connection_type ?? null,
    migration_mode: mode,
    previous_business_number: previous?.business_number ?? null,
    seed: false,
  });
  return rows;
};
