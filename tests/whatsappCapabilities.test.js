import { jest } from "@jest/globals";

// Only the DB module is mocked; the real service + real route config are exercised.
const queries = [];
let tenantRow = { embedded_signup_enabled: 0, coexistence_enabled: 0 };

const db = {
  sequelize: {
    query: jest.fn(async (sql, opts) => {
      queries.push({ sql, opts });
      if (/^\s*SELECT/i.test(sql)) return [tenantRow ? [tenantRow] : []];
      return [[], {}];
    }),
  },
  AdminAuditLog: { create: jest.fn(async () => ({})) },
};

jest.unstable_mockModule("../src/database/index.js", () => ({ default: db }));
// The route file imports auth middleware, which imports services that import
// the DB / management layers. Stub those so the real router can be loaded.
jest.unstable_mockModule("../src/models/ManagementModel/management.service.js", () => ({ getManagementByIdService: jest.fn() }));
jest.unstable_mockModule("../src/models/TenantUserModel/tenantuser.service.js", () => ({ findTenantUserByIdService: jest.fn() }));
jest.unstable_mockModule("../src/models/TenantModel/tenant.service.js", () => ({ findTenantByIdService: jest.fn() }));

const {
  getTenantWhatsappCapabilitiesService,
  updateTenantWhatsappCapabilitiesService,
} = await import("../src/models/WhatsappAccountModel/whatsappCapabilities.service.js");
const { default: router } = await import(
  "../src/models/WhatsappAccountModel/whatsappCapabilities.management.routes.js"
);

const resMock = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn(() => res);
  return res;
};

// Middleware stack for a route: [authenticate, authorize, handler]
const layerFor = (method) =>
  router.stack.find((l) => l.route && l.route.methods[method])?.route.stack.map((s) => s.handle);

const runAuthorize = (method, user) => {
  const [, authorize] = layerFor(method);
  const res = resMock();
  const next = jest.fn();
  authorize({ user }, res, next);
  return { res, next };
};

beforeEach(() => {
  queries.length = 0;
  tenantRow = { embedded_signup_enabled: 0, coexistence_enabled: 0 };
  db.AdminAuditLog.create.mockClear();
});

describe("Super Admin only can modify flags (real route config)", () => {
  test("PATCH: super_admin allowed", () => {
    const { next, res } = runAuthorize("patch", { user_type: "management", role: "super_admin" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("PATCH: platform_admin, tenant admin and staff are denied", () => {
    for (const user of [
      { user_type: "management", role: "platform_admin" },
      { user_type: "tenant", role: "tenant_admin" },
      { user_type: "tenant", role: "staff" },
    ]) {
      const { next, res } = runAuthorize("patch", user);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  test("GET (read-only) is limited to management users, never tenants", () => {
    expect(runAuthorize("get", { user_type: "management", role: "platform_admin" }).next).toHaveBeenCalled();
    const denied = runAuthorize("get", { user_type: "tenant", role: "tenant_admin" });
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.statusCode).toBe(403);
  });
});

describe("capability service", () => {
  test("a tenant with no flags set has everything OFF (existing production behaviour)", async () => {
    expect(await getTenantWhatsappCapabilitiesService("TT001")).toEqual({
      embedded_signup_enabled: false,
      coexistence_enabled: false,
    });
  });

  test("unknown tenant → null", async () => {
    tenantRow = null;
    expect(await getTenantWhatsappCapabilitiesService("NOPE")).toBeNull();
  });

  test("enabling stores both flags and writes an audit row", async () => {
    const out = await updateTenantWhatsappCapabilitiesService(
      "TT001",
      { embedded_signup_enabled: true, coexistence_enabled: true },
      { unique_id: "MGT1" },
    );
    expect(out).toEqual({ embedded_signup_enabled: true, coexistence_enabled: true });
    const update = queries.find((q) => /^\s*UPDATE/i.test(q.sql));
    expect(update.opts.replacements).toEqual([true, true, "TT001"]);
    expect(db.AdminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        admin_id: "MGT1",
        tenant_id: "TT001",
        action_type: "whatsapp_capability_change",
        before_state: { embedded_signup_enabled: false, coexistence_enabled: false },
        after_state: { embedded_signup_enabled: true, coexistence_enabled: true },
      }),
    );
  });

  test("coexistence cannot be enabled without Embedded Signup", async () => {
    await expect(
      updateTenantWhatsappCapabilitiesService("TT001", { coexistence_enabled: true }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(queries.some((q) => /^\s*UPDATE/i.test(q.sql))).toBe(false);
  });

  test("turning Embedded Signup off also clears coexistence", async () => {
    tenantRow = { embedded_signup_enabled: 1, coexistence_enabled: 1 };
    const out = await updateTenantWhatsappCapabilitiesService("TT001", { embedded_signup_enabled: false });
    expect(out).toEqual({ embedded_signup_enabled: false, coexistence_enabled: false });
  });

  test("changing flags never touches whatsapp_accounts (established connection is not disconnected)", async () => {
    tenantRow = { embedded_signup_enabled: 1, coexistence_enabled: 1 };
    await updateTenantWhatsappCapabilitiesService("TT001", { embedded_signup_enabled: false });
    expect(queries.every((q) => !/whatsapp_accounts|tenant_secrets/i.test(q.sql))).toBe(true);
  });

  test("non-boolean and empty patches are rejected", async () => {
    await expect(
      updateTenantWhatsappCapabilitiesService("TT001", { embedded_signup_enabled: "true" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateTenantWhatsappCapabilitiesService("TT001", {})).rejects.toMatchObject({ statusCode: 400 });
  });

  test("unknown tenant → 404", async () => {
    tenantRow = null;
    await expect(
      updateTenantWhatsappCapabilitiesService("NOPE", { embedded_signup_enabled: true }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("an audit-log failure does not block the capability change", async () => {
    db.AdminAuditLog.create.mockRejectedValueOnce(new Error("enum not migrated"));
    const out = await updateTenantWhatsappCapabilitiesService("TT001", { embedded_signup_enabled: true });
    expect(out.embedded_signup_enabled).toBe(true);
  });
});
