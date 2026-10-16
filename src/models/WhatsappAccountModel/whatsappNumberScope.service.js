import db from "../../database/index.js";
import { tableNames } from "../../database/tableName.js";
import { normalizeBusinessNumber } from "../../utils/businessNumber.js";
import {
  SCOPE_REASONS,
  buildNamedScopeClause,
  buildScopeClause,
  resolveExcludedTransportIds,
} from "./whatsappNumberScope.core.js";

/**
 * Read-side history scope for the inbox / AI context.
 *
 *   const scope = await getHistoryScope(tenant_id);
 *   `... WHERE tenant_id = ? AND is_deleted = false${scope.sql}`
 *   replacements: [tenant_id, ...scope.params]
 *
 * For an alias-qualified column use scope.forColumn("m.phone_number_id"); for named
 * replacements use scope.named().
 *
 * Returns the ORIGINAL query unchanged ({ sql: "", params: [] }) for every
 * organization that has never completed an Embedded Signup switch — that check is a
 * single indexed lookup. Only on an error in the lookup itself (e.g. migration not
 * applied) does it fail OPEN, so the inbox can never break for legacy clients.
 * "Identities exist but the active number can't be resolved" is NOT silent: it is
 * logged (once per process) so it can be investigated.
 */
let warnedError = false;
let warnedUnresolved = false;

const emptyScope = (reason) => ({
  sql: "",
  params: [],
  excludedIds: [],
  reason,
  forColumn: () => ({ sql: "", params: [] }),
  named: () => ({ sql: "", replacements: {} }),
});

const scopeFor = (excludedIds, reason) => ({
  ...buildScopeClause(excludedIds, "phone_number_id"),
  excludedIds,
  reason,
  forColumn: (column) => buildScopeClause(excludedIds, column),
  named: (column = "phone_number_id", prefix = "wa_scope") => buildNamedScopeClause(excludedIds, column, prefix),
});

export const getHistoryScope = async (tenant_id) => {
  try {
    const [identities] = await db.sequelize.query(
      `SELECT phone_number_id, business_number
         FROM ${tableNames.WHATSAPP_NUMBER_IDENTITIES}
        WHERE tenant_id = ?`,
      { replacements: [tenant_id] },
    );
    // Never switched → legacy behaviour, and the common case costs one indexed query.
    if (!identities.length) return emptyScope(SCOPE_REASONS.NO_IDENTITIES);

    const [accounts] = await db.sequelize.query(
      `SELECT a.whatsapp_number, a.phone_number_id, t.owner_country_code
         FROM ${tableNames.WHATSAPP_ACCOUNT} a
         LEFT JOIN ${tableNames.TENANTS} t ON t.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND a.is_deleted = false
        LIMIT 1`,
      { replacements: [tenant_id] },
    );
    const account = accounts[0] || null;

    const { excluded, reason } = resolveExcludedTransportIds({
      identities,
      hasActiveAccount: Boolean(account),
      activePhoneNumberId: account?.phone_number_id ?? null,
      activeBusinessNumber: account
        ? normalizeBusinessNumber(account.whatsapp_number, { defaultCountryCode: account.owner_country_code })
        : null,
    });

    if (reason === SCOPE_REASONS.UNRESOLVED && !warnedUnresolved) {
      warnedUnresolved = true;
      console.error(
        `[WA-SCOPE] tenant ${tenant_id} has number identities but its active number could not be resolved; history is unscoped until fixed`,
      );
    }
    return scopeFor(excluded, reason);
  } catch (err) {
    if (!warnedError) {
      warnedError = true;
      console.error("[WA-SCOPE] history scope lookup failed; using unscoped history:", err.message);
    }
    return emptyScope("LOOKUP_ERROR");
  }
};
