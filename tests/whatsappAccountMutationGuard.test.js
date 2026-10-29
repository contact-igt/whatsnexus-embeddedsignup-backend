import { jest } from "@jest/globals";

let connectionType = "EMBEDDED_STANDARD";
const queries = [];
const db = {
  sequelize: {
    query: jest.fn(async (sql, options) => {
      queries.push({ sql, options });
      if (/SELECT whatsapp_connection_type/i.test(sql)) {
        return [[{ whatsapp_connection_type: connectionType }]];
      }
      return [[], {}];
    }),
  },
};
const storeSecret = jest.fn(async () => {});

jest.unstable_mockModule("../src/database/index.js", () => ({ default: db }));
jest.unstable_mockModule("../src/models/TenantSecretsModel/tenantSecrets.service.js", () => ({
  storeSecret,
  getSecret: jest.fn(async () => null),
}));

const { updateAccessTokenService, updateWhatsappAccountService } = await import(
  "../src/models/WhatsappAccountModel/whatsappAccount.service.js"
);

beforeEach(() => {
  queries.length = 0;
  storeSecret.mockClear();
  connectionType = "EMBEDDED_STANDARD";
});

describe("manual credential mutation guard", () => {
  test.each(["EMBEDDED_STANDARD", "EMBEDDED_COEXISTENCE"])(
    "rejects token updates for %s",
    async (type) => {
      connectionType = type;
      await expect(updateAccessTokenService("TT001", "token")).rejects.toMatchObject({
        statusCode: 409,
        code: "EMBEDDED_CONNECTION_MANAGED",
      });
      expect(storeSecret).not.toHaveBeenCalled();
    },
  );

  test("rejects identifier updates for an embedded account", async () => {
    await expect(
      updateWhatsappAccountService("TT001", { phone_number_id: "new-id" }),
    ).rejects.toMatchObject({ code: "EMBEDDED_CONNECTION_MANAGED" });
    expect(queries.some((q) => /SET phone_number_id/i.test(q.sql))).toBe(false);
  });

  test("keeps legacy manual token updates working", async () => {
    connectionType = null;
    await updateAccessTokenService("TT001", "token");
    expect(storeSecret).toHaveBeenCalledWith("TT001", "whatsapp", "token");
    expect(queries.some((q) => /SET status = 'pending'/i.test(q.sql))).toBe(true);
  });
});
