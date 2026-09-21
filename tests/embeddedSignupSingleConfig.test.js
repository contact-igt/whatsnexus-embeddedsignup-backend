import { jest } from "@jest/globals";
import {
  createEmbeddedSignupService,
  EmbeddedSignupError,
  SESSION_EVENTS,
} from "../src/models/WhatsappAccountModel/whatsappEmbeddedSignup.core.js";
import {
  META_FEATURE_TYPES,
  MODE_FEATURE_TYPE,
  getEmbeddedSignupConfig,
  getEmbeddedSignupLaunchConfig,
  getMissingEmbeddedSignupConfig,
} from "../src/config/metaEmbeddedSignup.config.js";

/**
 * ONE Embedded Signup configuration id serves both modes; the Meta Feature Type
 * (none vs WhatsApp Business App onboarding) is derived from the SERVER-side mode.
 */
const STD = "EMBEDDED_STANDARD";
const COEX = "EMBEDDED_COEXISTENCE";
const SECRET_TOKEN = "EAAGsecrettokenvalue1234567890";
const APP_SECRET = "super-app-secret-value";

const config = {
  appId: "111222333444",
  appSecret: APP_SECRET,
  graphApiVersion: "v25.0",
  configId: "cfg-single",
};

const phone = (over = {}) => ({
  id: "555666777888",
  display_phone_number: "+91 98765 43210",
  status: "PENDING",
  platform_type: "NOT_APPLICABLE",
  ...over,
});

const build = (over = {}) => {
  const state = {
    caps: { embedded_signup_enabled: true, coexistence_enabled: true },
    phones: [phone()],
    ...(over.state || {}),
  };
  const metaClient = {
    exchangeCode: jest.fn(async () => SECRET_TOKEN),
    listPhoneNumbers: jest.fn(async () => state.phones),
    registerPhone: jest.fn(async () => true),
    subscribeApp: jest.fn(async () => true),
    ...(over.metaClient || {}),
  };
  const persistConnection = jest.fn(async (c) => ({
    id: 1,
    tenant_id: c.tenant_id,
    whatsapp_number: c.whatsapp_number,
    phone_number_id: c.phone_number_id,
    waba_id: c.waba_id,
    status: "active",
    whatsapp_connection_type: c.connection_type,
    connected_at: new Date(),
  }));
  const sessions = [];
  const sessionStore = {
    findInFlight: jest.fn(async (t) => sessions.find((s) => s.tenant_id === t && s.active_slot === 1) || null),
    create: jest.fn(async ({ tenant_id, connection_type }) => {
      const s = { id: sessions.length + 1, tenant_id, connection_type, state: "STARTED", active_slot: 1, secrets: {} };
      sessions.push(s);
      return s;
    }),
    claim: jest.fn(async (id) => sessions.find((s) => s.id === id && s.active_slot === 1) || null),
    release: jest.fn(async () => {}),
    readSecrets: jest.fn(async (s) => ({ ...s.secrets })),
    update: jest.fn(async (s, patch) => {
      Object.assign(s, patch);
      if (patch.token !== undefined) s.secrets.token = patch.token;
      if (patch.pin !== undefined) s.secrets.pin = patch.pin;
      if (patch.wipe) s.secrets = {};
    }),
  };
  const logger = over.logger || { error: jest.fn(), warn: jest.fn() };
  const service = createEmbeddedSignupService({
    getConfig: () => over.config || config,
    getCapabilities: async () => state.caps,
    getExistingAccount: async () => null,
    getDefaultCountryCode: async () => "+91",
    findMappingConflicts: async () => ({ phone: false, waba: false }),
    metaClient,
    persistConnection,
    sessionStore,
    // the signed token carries tenant + mode + user, exactly like the real one
    signSession: ({ tenant_id, connection_type, user_id }) => JSON.stringify({ tenant_id, connection_type, user_id }),
    verifySession: (t) => {
      try { return JSON.parse(t); } catch { return null; }
    },
    logger,
  });
  return { service, metaClient, persistConnection, logger };
};

const token = (mode = STD, user_id = "U1") => JSON.stringify({ tenant_id: "TT001", connection_type: mode, user_id });
const completeArgs = (over = {}) => ({
  tenant_id: "TT001",
  user_id: "U1",
  session_token: token(),
  code: "AQCode123",
  waba_id: "999888777666",
  phone_number_id: "555666777888",
  business_id: "123123123",
  event: SESSION_EVENTS.STANDARD,
  ...over,
});
const start = (service, mode) => service.startSignup({ tenant_id: "TT001", connection_type: mode, user_id: "U1" });

const expectCode = async (promise, code, status) => {
  await expect(promise).rejects.toMatchObject({ code, ...(status ? { status } : {}) });
  await promise.catch((e) => expect(e).toBeInstanceOf(EmbeddedSignupError));
};

describe("start: same config id, mode-aware Meta Feature Type", () => {
  test("TEST 1 — STANDARD: single config id, mode STANDARD, feature type NONE (no featureType sent)", async () => {
    const { service } = build();
    const r = await start(service, STD);
    expect(r).toMatchObject({ mode: STD, connection_type: STD, config_id: "cfg-single", feature_type: "NONE" });
    expect(r.extras).toEqual({ setup: {}, sessionInfoVersion: "3" });
    expect("featureType" in r.extras).toBe(false); // "None" is never sent as a string
  });

  test("TEST 2 — COEXISTENCE: same config id, mode COEXISTENCE, feature type WhatsApp Business App onboarding", async () => {
    const { service } = build();
    const r = await start(service, COEX);
    expect(r).toMatchObject({ mode: COEX, config_id: "cfg-single", feature_type: "WHATSAPP_BUSINESS_APP_ONBOARDING" });
    expect(r.extras).toEqual({ setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" });
  });

  test("TEST 3 — both modes use the exact same config id (and the same app)", async () => {
    const { service } = build();
    const a = await start(service, STD);
    const b = await start(service, COEX);
    expect(a.config_id).toBe(b.config_id);
    expect(a.config_id).toBe(config.configId);
    expect(a.app_id).toBe(b.app_id);
    // the only launch difference is the feature type
    expect(a.feature_type).not.toBe(b.feature_type);
  });

  test("the mode → Meta Feature Type mapping is explicit; 'None' is not a WhatsNexus mode", () => {
    expect(MODE_FEATURE_TYPE).toEqual({
      EMBEDDED_STANDARD: META_FEATURE_TYPES.NONE,
      EMBEDDED_COEXISTENCE: META_FEATURE_TYPES.WHATSAPP_BUSINESS_APP_ONBOARDING,
    });
    expect(() => getEmbeddedSignupLaunchConfig("LEGACY_MANUAL", config)).toThrow();
    expect(() => getEmbeddedSignupLaunchConfig("NONE", config)).toThrow();
  });

  test("TEST 4 — coexistence disabled: the server rejects a coexistence start (standard still allowed)", async () => {
    const { service } = build({ state: { caps: { embedded_signup_enabled: true, coexistence_enabled: false } } });
    await expectCode(start(service, COEX), "COEXISTENCE_NOT_ENABLED", 403);
    await expect(start(service, STD)).resolves.toMatchObject({ mode: STD });
  });

  test("TEST 5 — Embedded Signup disabled: every start is rejected, whatever the mode", async () => {
    const { service } = build({ state: { caps: { embedded_signup_enabled: false, coexistence_enabled: true } } });
    await expectCode(start(service, STD), "FEATURE_DISABLED", 403);
    await expectCode(start(service, COEX), "FEATURE_DISABLED", 403);
  });
});

describe("complete: the mode comes from the server session", () => {
  test("TEST 6 — start STANDARD, complete claiming COEXISTENCE: rejected before the single-use code is spent", async () => {
    const { service, metaClient, persistConnection } = build();
    await start(service, STD);
    await expectCode(
      service.completeSignup(completeArgs({ session_token: token(STD), requested_mode: COEX })),
      "MODE_MISMATCH",
      400,
    );
    // and the reverse
    await expectCode(
      service.completeSignup(completeArgs({ session_token: token(COEX), requested_mode: STD })),
      "MODE_MISMATCH",
      400,
    );
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("a matching claim, or no claim, is accepted; a browser event cannot flip the mode", async () => {
    const a = build();
    await expect(a.service.completeSignup(completeArgs({ requested_mode: STD }))).resolves.toBeTruthy();
    const b = build();
    await expect(b.service.completeSignup(completeArgs())).resolves.toBeTruthy();

    const c = build();
    await expectCode(c.service.completeSignup(completeArgs({ event: SESSION_EVENTS.COEXISTENCE })), "INVALID_MODE", 400);
    expect(c.metaClient.registerPhone).not.toHaveBeenCalled();
  });

  test("the onboarding session is bound to the user that started it", async () => {
    const { service, metaClient } = build();
    await expectCode(service.completeSignup(completeArgs({ user_id: "U2" })), "INVALID_SESSION", 400);
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
    await expect(service.completeSignup(completeArgs({ user_id: "U1" }))).resolves.toBeTruthy();
  });

  test("TEST 7 — standard completion runs the register path and stores EMBEDDED_STANDARD (never 'NONE')", async () => {
    const { service, metaClient, persistConnection } = build();
    await service.completeSignup(completeArgs());
    expect(metaClient.registerPhone).toHaveBeenCalledTimes(1);
    const saved = persistConnection.mock.calls[0][0];
    expect(saved.connection_type).toBe(STD);
    expect(saved.meta_embedded_config_id).toBe("cfg-single");
    expect(JSON.stringify(saved)).not.toMatch(/"NONE"/);
  });

  test("TEST 8 — coexistence completion NEVER calls the standard register path, and reaches ACTIVE", async () => {
    const { service, metaClient, persistConnection } = build({
      state: { phones: [phone({ status: "CONNECTED", platform_type: "CLOUD_API" })] },
    });
    const r = await service.completeSignup(
      completeArgs({ session_token: token(COEX), event: SESSION_EVENTS.COEXISTENCE, phone_number_id: undefined }),
    );
    expect(metaClient.registerPhone).not.toHaveBeenCalled();
    expect(metaClient.subscribeApp).toHaveBeenCalledTimes(1);
    expect(r.onboarding.state).toBe("ACTIVE");
    const saved = persistConnection.mock.calls[0][0];
    expect(saved.connection_type).toBe(COEX);
    expect(saved.meta_embedded_config_id).toBe("cfg-single"); // same config, different connection_type
    expect(saved.register_pin).toBeNull();
  });
});

describe("TEST 9 — missing configuration", () => {
  const broken = {
    "app id": { ...config, appId: null },
    "app secret": { ...config, appSecret: null },
    "config id": { ...config, configId: null },
  };

  test.each(Object.entries(broken))("missing %s → sanitized EMBEDDED_SIGNUP_NOT_CONFIGURED at start", async (_n, cfg) => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const { service } = build({ config: cfg, logger });
    const err = await start(service, STD).catch((e) => e);
    expect(err).toMatchObject({ code: "EMBEDDED_SIGNUP_NOT_CONFIGURED", status: 503 });
    // users never see setting names or values …
    expect(err.message).not.toMatch(/WHATSNEXUS|META_|SECRET|CONFIG_ID/i);
    // … operators get the NAMES (never values) in the server log
    const logged = logger.warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/WHATSNEXUS_/);
    expect(logged).not.toContain(APP_SECRET);
  });

  test("complete refuses BEFORE the single-use code is spent", async () => {
    const { service, metaClient } = build({ config: broken["app secret"] });
    await expectCode(service.completeSignup(completeArgs()), "EMBEDDED_SIGNUP_NOT_CONFIGURED", 503);
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
  });

  test("getMissingEmbeddedSignupConfig reports names only", () => {
    expect(getMissingEmbeddedSignupConfig({})).toEqual([
      "WHATSNEXUS_META_APP_ID",
      "WHATSNEXUS_META_APP_SECRET",
      "WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID",
    ]);
    expect(getMissingEmbeddedSignupConfig(config)).toEqual([]);
  });
});

describe("TEST 10 — the App Secret never leaves the backend", () => {
  test("not in start payloads, completion payloads, error payloads or logs", async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const { service } = build({ logger });
    const payloads = [await start(service, STD), await start(service, COEX), await service.completeSignup(completeArgs())];

    const failing = build({
      logger,
      metaClient: { exchangeCode: jest.fn(async () => { throw new Error(`boom client_secret=${APP_SECRET}`); }) },
    });
    payloads.push(
      await failing.service.completeSignup(completeArgs()).catch((e) => ({ code: e.code, message: e.message, onboarding: e.onboarding })),
    );

    const everything = JSON.stringify(payloads);
    expect(everything).not.toContain(APP_SECRET);
    expect(everything).not.toContain(SECRET_TOKEN);
    expect(everything).not.toMatch(/app_secret|appSecret|access_token|register_pin|"pin"/);
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls].flat().join(" ");
    expect(logged).not.toContain(APP_SECRET);
    expect(logged).not.toContain(SECRET_TOKEN);
  });

  test("config deprecation warnings name variables but never print values", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const c = getEmbeddedSignupConfig({
      WHATSNEXUS_META_APP_ID: "111",
      WHATSNEXUS_META_APP_SECRET: APP_SECRET,
      META_EMBEDDED_SIGNUP_CONFIG_ID: "old-standard-cfg-value",
      META_EMBEDDED_SIGNUP_COEXISTENCE_CONFIG_ID: "old-coexistence-cfg-value",
    });
    const out = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(c.configId).toBe("old-standard-cfg-value"); // deprecated fallback still works during transition
    expect(out).toMatch(/META_EMBEDDED_SIGNUP_CONFIG_ID/);
    expect(out).not.toContain("old-standard-cfg-value");
    expect(out).not.toContain("old-coexistence-cfg-value");
    expect(out).not.toContain(APP_SECRET);
  });
});

describe("TEST 11 — legacy / shared variables are untouched", () => {
  test("the generic META_APP_ID / META_APP_SECRET (used by legacy code) are NEVER consumed by Embedded Signup", () => {
    const c = getEmbeddedSignupConfig({
      META_APP_ID: "legacy-app",
      META_APP_SECRET: "legacy-secret",
      META_API_VERSION: "v22.0",
    });
    expect(c.appId).toBeNull();
    expect(c.appSecret).toBeNull();
    expect(getMissingEmbeddedSignupConfig(c)).toHaveLength(3);
    expect(c.graphApiVersion).toBe("v22.0"); // the project-wide version is still honoured
  });

  test("the coexistence-specific config id is ignored: one configuration is authoritative", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const c = getEmbeddedSignupConfig({
      WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID: "the-one",
      META_EMBEDDED_SIGNUP_COEXISTENCE_CONFIG_ID: "second",
    });
    warn.mockRestore();
    expect(c.configId).toBe("the-one");
  });

  test("graph version precedence: WHATSNEXUS_META_GRAPH_API_VERSION > META_API_VERSION > v25.0", () => {
    expect(getEmbeddedSignupConfig({ WHATSNEXUS_META_GRAPH_API_VERSION: "v26.0", META_API_VERSION: "v22.0" }).graphApiVersion).toBe("v26.0");
    expect(getEmbeddedSignupConfig({ META_API_VERSION: "v22.0" }).graphApiVersion).toBe("v22.0");
    expect(getEmbeddedSignupConfig({}).graphApiVersion).toBe("v25.0");
  });

  test("customer WABA / Phone Number ids are never part of the environment configuration", () => {
    const c = getEmbeddedSignupConfig({ WHATSNEXUS_WABA_ID: "123", WHATSNEXUS_PHONE_NUMBER_ID: "456" });
    expect(Object.keys(c).sort()).toEqual(["appId", "appSecret", "configId", "graphApiVersion"]);
  });
});
