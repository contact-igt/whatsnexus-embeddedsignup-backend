import {
  normalizeBusinessNumber as n,
  isSameBusinessNumber,
  businessNumberStorageVariants,
  cleanCountryCode,
} from "../src/utils/businessNumber.js";

describe("business number → canonical E.164", () => {
  test.each([
    ["+91 98765 43210"],
    ["919876543210"],
    ["+919876543210"],
    ["00919876543210"],
    ["+91-98765-43210"],
  ])("%s → +919876543210", (raw) => {
    expect(n(raw)).toBe("+919876543210");
  });

  test("national forms use the tenant's default calling code", () => {
    expect(n("9876543210", { defaultCountryCode: "+91" })).toBe("+919876543210");
    expect(n("09876543210", { defaultCountryCode: "91" })).toBe("+919876543210");
    expect(n("9876543210")).toBe("+919876543210"); // project default (India)
    expect(n("4155552671", { defaultCountryCode: "+1" })).toBe("+14155552671");
  });

  test("other countries keep their own calling code", () => {
    expect(n("+1 415-555-2671")).toBe("+14155552671");
    expect(n("14155552671")).toBe("+14155552671");
    expect(n("+44 7911 123456")).toBe("+447911123456");
  });

  test("the same digits under different default country codes are different numbers", () => {
    expect(n("9876543210", { defaultCountryCode: "91" })).not.toBe(n("9876543210", { defaultCountryCode: "1" }));
  });

  test.each([[""], [null], [undefined], ["abc"], ["123"], ["+"], ["+0000"]])("junk %p → null", (raw) => {
    expect(n(raw)).toBeNull();
  });

  test("isSameBusinessNumber", () => {
    expect(isSameBusinessNumber("9876543210", "+919876543210", { defaultCountryCode: "+91" })).toBe(true);
    expect(isSameBusinessNumber("+919876543210", "+91 98111 12222")).toBe(false);
    expect(isSameBusinessNumber("junk", "junk")).toBe(false); // never "same" on garbage
  });

  test("storage variants cover both the full and national spelling", () => {
    expect(businessNumberStorageVariants("+919876543210")).toEqual(["919876543210", "9876543210"]);
    expect(businessNumberStorageVariants(null)).toEqual([]);
  });

  test("cleanCountryCode", () => {
    expect(cleanCountryCode("+91")).toBe("91");
    expect(cleanCountryCode(" 1 ")).toBe("1");
    expect(cleanCountryCode(null)).toBe("91");
  });
});
