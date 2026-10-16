import libphonenumber from "google-libphonenumber";

/**
 * Canonical (E.164) identity for a WhatsApp BUSINESS number.
 *
 * Distinct from utils/helpers/formatPhoneNumber.js, which normalizes CUSTOMER
 * numbers under the project's strict 10/12-digit rule. Business numbers can
 * legitimately be any country, so this uses libphonenumber (already a project
 * dependency) and returns "+<cc><subscriber>", or null when the value cannot be
 * canonicalized with confidence.
 *
 *   "+91 98765 43210" | "919876543210" | "+919876543210" | "9876543210" (+ default CC 91)
 *     → "+919876543210"
 */
const phoneUtil = libphonenumber.PhoneNumberUtil.getInstance();
const E164 = libphonenumber.PhoneNumberFormat.E164;

const parseInternational = (digits) => {
  if (!digits) return null;
  try {
    const parsed = phoneUtil.parse(`+${digits}`);
    return phoneUtil.isPossibleNumber(parsed) ? phoneUtil.format(parsed, E164) : null;
  } catch {
    return null;
  }
};

/** "+91" / "91" / 91 / null → "91"; falls back to the project default (India). */
export const cleanCountryCode = (value, fallback = "91") => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || fallback;
};

export const normalizeBusinessNumber = (raw, { defaultCountryCode } = {}) => {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  const hasPlus = input.startsWith("+");
  let digits = input.replace(/\D/g, "");
  if (!digits) return null;

  // Explicit international forms: "+…" or "00…"
  if (hasPlus) return parseInternational(digits);
  if (digits.startsWith("00")) return parseInternational(digits.slice(2));

  const cc = cleanCountryCode(defaultCountryCode);

  // National format with trunk prefix ("098765 43210")
  if (digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
    return parseInternational(`${cc}${digits}`);
  }

  // Up to 10 digits = national number without country code → apply tenant default.
  if (digits.length <= 10) return parseInternational(`${cc}${digits}`);

  // Longer than a national number: country code is already included.
  return parseInternational(digits);
};

/** True when both values resolve to the SAME canonical business number. */
export const isSameBusinessNumber = (a, b, options) => {
  const na = normalizeBusinessNumber(a, options);
  const nb = normalizeBusinessNumber(b, options);
  return Boolean(na && nb && na === nb);
};

/**
 * Every spelling under which the same number may already be stored in
 * whatsapp_accounts.whatsapp_number (legacy rows may hold the national form).
 * Used for cross-organization conflict checks so the same number can't slip in
 * as "9876543210" vs "919876543210".
 */
export const businessNumberStorageVariants = (e164) => {
  if (!e164) return [];
  try {
    const parsed = phoneUtil.parse(e164);
    const full = e164.replace(/\D/g, "");
    const national = String(parsed.getNationalNumber());
    return [...new Set([full, national])];
  } catch {
    return [e164.replace(/\D/g, "")];
  }
};
