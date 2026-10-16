import { jest } from "@jest/globals";
import {
  createEmbeddedSignupService,
  EmbeddedSignupError,
  SESSION_EVENTS,
} from "../src/models/WhatsappAccountModel/whatsappEmbeddedSignup.core.js";
import {
  MODE_FEATURE_TYPE,
  META_FEATURE_TYPES,
  getEmbeddedSignupConfig,
  getEmbeddedSignupLaunchConfig,
  getMissingEmbeddedSignupConfig,
} from "../src/config/metaEmbeddedSignup.config.js";
import { redactSecrets } from "../src/utils/redactSecrets.js";

const STD = "EMBEDDED_STANDARD";
const COEX = "EMBEDDED_COEXISTENCE";
const SECRET_TOKEN = "EAAGsecrettokenvalue1234567890";
const APP_SECRET = "super-app-secret-value";

const config = {
  appId: "111222333444",
  appSecret: APP_SECRET,
  graphApiVersion: "v25.0",
  configId: "cfg-single", // ONE Embedded Signup configuration serves both modes
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
    existing: null,
    defaultCountryCode: "+91",
    conflicts: { phone: false, waba: false },
    phones: [phone()],
  };
  Object.assign(state, over.state || {});

  const metaClient = {
    exchangeCode: jest.fn(async () => SECRET_TOKEN),
    listPhoneNumbers: jest.fn(async () => state.phones),
    registerPhone: jest.fn(async () => true),
    subscribeApp: jest.fn(async () => true),
    ...(over.metaClient || {}),
  };
  const persistConnection = over.persistConnection || jest.fn(async (c) => ({
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
    findInFlight: jest.fn(async (tenant_id) => sessions.find((s) => s.tenant_id === tenant_id && s.active_slot === 1) || null),
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

  const deps = {
    getConfig: () => over.config || config,
    getCapabilities: async () => state.caps,
    getExistingAccount: async () => state.existing,
    getDefaultCountryCode: async () => state.defaultCountryCode,
    findMappingConflicts: (state.findMappingConflicts = jest.fn(async () => state.conflicts)),
    metaClient,
    persistConnection,
    sessionStore,
    signSession: ({ tenant_id, connection_type }) => JSON.stringify({ tenant_id, connection_type }),
    verifySession: (t) => {
      try { return JSON.parse(t); } catch { return null; }
    },
    logger: over.logger || { error: jest.fn(), warn: jest.fn() },
  };
  const service = createEmbeddedSignupService(deps);
  return { service, state, metaClient, persistConnection, sessionStore, deps };
};

const session = (tenant_id = "TT001", connection_type = STD) =>
  JSON.stringify({ tenant_id, connection_type });

const completeArgs = (over = {}) => ({
  tenant_id: "TT001",
  session_token: session(),
  code: "AQCode123",
  waba_id: "999888777666",
  phone_number_id: "555666777888",
  business_id: "123123123",
  event: SESSION_EVENTS.STANDARD,
  ...over,
});

const expectCode = async (promise, code, status) => {
  await expect(promise).rejects.toMatchObject({ code, ...(status ? { status } : {}) });
  await promise.catch((e) => expect(e).toBeInstanceOf(EmbeddedSignupError));
};

describe("feature gating (server-side)", () => {
  test("Embedded Signup OFF cannot start signup", async () => {
    const { service } = build({ state: { caps: { embedded_signup_enabled: false, coexistence_enabled: false } } });
    await expectCode(service.startSignup({ tenant_id: "TT001", connection_type: STD }), "FEATURE_DISABLED", 403);
  });

  test("Embedded Signup ON can start standard signup", async () => {
    const { service } = build({ state: { caps: { embedded_signup_enabled: true, coexistence_enabled: false } } });
    const r = await service.startSignup({ tenant_id: "TT001", connection_type: STD });
    expect(r).toMatchObject({ connection_type: STD, app_id: "111222333444", config_id: "cfg-single" });
    expect(r.extras.featureType).toBeUndefined();
    expect(r.session_token).toBeTruthy();
  });

  test("coexistence requires coexistence permission", async () => {
    const { service } = build({ state: { caps: { embedded_signup_enabled: true, coexistence_enabled: false } } });
    await expectCode(service.startSignup({ tenant_id: "TT001", connection_type: COEX }), "COEXISTENCE_NOT_ENABLED", 403);
  });

  test("coexistence with permission uses the Business App onboarding feature type", async () => {
    const { service } = build();
    const r = await service.startSignup({ tenant_id: "TT001", connection_type: COEX });
    expect(r.config_id).toBe("cfg-single");
    expect(r.extras).toEqual({ setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" });
  });

  test("unsupported / legacy modes are rejected", async () => {
    const { service } = build();
    await expectCode(service.startSignup({ tenant_id: "TT001", connection_type: "LEGACY_MANUAL" }), "INVALID_MODE", 400);
    await expectCode(service.startSignup({ tenant_id: "TT001", connection_type: undefined }), "INVALID_MODE", 400);
  });

  test("missing Meta app configuration is a safe 503", async () => {
    const service = createEmbeddedSignupService({
      getConfig: () => ({ ...config, appSecret: null }),
      getCapabilities: async () => ({ embedded_signup_enabled: true, coexistence_enabled: true }),
      getExistingAccount: async () => null,
      findMappingConflicts: async () => ({}),
      metaClient: {},
      persistConnection: jest.fn(),
      signSession: () => "x",
      verifySession: () => null,
    });
    await expectCode(service.startSignup({ tenant_id: "TT001", connection_type: STD }), "EMBEDDED_SIGNUP_NOT_CONFIGURED", 503);
  });

  test("an existing connection does not block start, but replacing it needs explicit confirmation", async () => {
    const { service, metaClient, persistConnection } = build({
      state: { existing: { id: 9, whatsapp_number: "919876543210", phone_number_id: "OLD", is_deleted: false } },
    });
    await expect(service.startSignup({ tenant_id: "TT001", connection_type: STD })).resolves.toBeTruthy();

    // No confirmation → rejected BEFORE the single-use code is consumed.
    await expectCode(service.completeSignup(completeArgs()), "CONFIRMATION_REQUIRED", 409);
    await expectCode(service.completeSignup(completeArgs({ confirm_switch: "yes" })), "CONFIRMATION_REQUIRED", 409);
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("complete re-checks flags even with a valid session (flag turned off after start)", async () => {
    const { service, metaClient } = build({ state: { caps: { embedded_signup_enabled: false, coexistence_enabled: false } } });
    await expectCode(service.completeSignup(completeArgs()), "FEATURE_DISABLED", 403);
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
  });
});

describe("completion — standard", () => {
  test("valid completion registers, subscribes, persists and returns no credentials", async () => {
    const { service, metaClient, persistConnection } = build();
    const result = await service.completeSignup(completeArgs());

    expect(metaClient.exchangeCode).toHaveBeenCalledWith("AQCode123");
    expect(metaClient.registerPhone).toHaveBeenCalledTimes(1);
    expect(metaClient.subscribeApp).toHaveBeenCalledWith("999888777666", SECRET_TOKEN);

    const saved = persistConnection.mock.calls[0][0];
    expect(saved).toMatchObject({
      tenant_id: "TT001",
      connection_type: STD,
      waba_id: "999888777666",
      phone_number_id: "555666777888",
      whatsapp_number: "919876543210",
      meta_business_id: "123123123",
      meta_embedded_config_id: "cfg-single",
      app_id: "111222333444",
    });
    expect(saved.register_pin).toMatch(/^\d{6}$/);
    expect(result.status).toBe("active");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toMatch(/access_token|app_secret|register_pin/);
  });

  test("already-registered Cloud API numbers are not re-registered", async () => {
    const { service, metaClient } = build({
      state: { phones: [phone({ status: "CONNECTED", platform_type: "CLOUD_API" })] },
    });
    await service.completeSignup(completeArgs());
    expect(metaClient.registerPhone).not.toHaveBeenCalled();
  });

  test("persists the PIN before register and resumes at subscribe without registering twice", async () => {
    const subscribeApp = jest.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(true);
    const { service, metaClient, sessionStore } = build({ metaClient: { subscribeApp } });
    await expectCode(service.completeSignup(completeArgs()), "SUBSCRIPTION_FAILED", 502);
    const stored = await sessionStore.findInFlight("TT001");
    expect(stored.state).toBe("SUBSCRIBE_PENDING");
    expect((await sessionStore.readSecrets(stored)).pin).toMatch(/^\d{6}$/);
    await service.resumeSignup({ tenant_id: "TT001" });
    expect(metaClient.registerPhone).toHaveBeenCalledTimes(1);
    expect(subscribeApp).toHaveBeenCalledTimes(2);
  });

  test("a final persistence failure retains state and PIN for a safe retry", async () => {
    const persistConnection = jest.fn().mockRejectedValueOnce(new EmbeddedSignupError("PERSIST_FAILED", "save failed", 500)).mockResolvedValue({ id: 1, tenant_id: "TT001", status: "active" });
    const { service, metaClient, sessionStore } = build({ persistConnection });
    await expectCode(service.completeSignup(completeArgs()), "PERSIST_FAILED", 500);
    const stored = await sessionStore.findInFlight("TT001");
    expect(stored.state).toBe("VALIDATING");
    expect((await sessionStore.readSecrets(stored)).pin).toMatch(/^\d{6}$/);
    await service.resumeSignup({ tenant_id: "TT001" });
    expect(metaClient.registerPhone).toHaveBeenCalledTimes(1);
    expect(persistConnection).toHaveBeenCalledTimes(2);
  });

  test("missing authorization code", async () => {
    const { service, metaClient, persistConnection } = build();
    await expectCode(service.completeSignup(completeArgs({ code: undefined })), "AUTH_CODE_MISSING", 400);
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("invalid / expired code: token exchange failure, nothing persisted, no leak", async () => {
    const { service, persistConnection } = build({
      metaClient: { exchangeCode: jest.fn(async () => { throw new Error(`bad code client_secret=${APP_SECRET}`); }) },
    });
    const err = await service.completeSignup(completeArgs()).catch((e) => e);
    expect(err).toMatchObject({ code: "TOKEN_EXCHANGE_FAILED", status: 400 });
    expect(err.message).not.toContain(APP_SECRET);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("no WABA returned", async () => {
    const { service, persistConnection } = build();
    await expectCode(service.completeSignup(completeArgs({ waba_id: undefined })), "WABA_NOT_RETURNED", 400);
    await expectCode(service.completeSignup(completeArgs({ waba_id: "abc; DROP" })), "WABA_NOT_RETURNED", 400);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("WABA not accessible with the exchanged token", async () => {
    const { service, persistConnection } = build({
      metaClient: { listPhoneNumbers: jest.fn(async () => { throw new Error("nope"); }) },
    });
    await expectCode(service.completeSignup(completeArgs()), "WABA_NOT_ACCESSIBLE", 502);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("no phone number id (empty WABA)", async () => {
    const { service, persistConnection } = build({ state: { phones: [] } });
    await expectCode(service.completeSignup(completeArgs({ phone_number_id: undefined })), "PHONE_NOT_RETURNED", 400);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("phone id that is not on the returned WABA is rejected", async () => {
    const { service } = build();
    await expectCode(service.completeSignup(completeArgs({ phone_number_id: "111111111111" })), "PHONE_NOT_RETURNED", 400);
  });

  test("subscription failure persists nothing", async () => {
    const { service, persistConnection } = build({
      metaClient: { subscribeApp: jest.fn(async () => { throw new Error("subscribe failed"); }) },
    });
    await expectCode(service.completeSignup(completeArgs()), "SUBSCRIPTION_FAILED", 502);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("registration failure persists nothing", async () => {
    const { service, persistConnection } = build({
      metaClient: { registerPhone: jest.fn(async () => { throw new Error("register failed"); }) },
    });
    await expectCode(service.completeSignup(completeArgs()), "REGISTRATION_FAILED", 502);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("duplicate number mapped to another organization", async () => {
    const { service, persistConnection } = build({ state: { conflicts: { phone: true, waba: false } } });
    await expectCode(service.completeSignup(completeArgs()), "NUMBER_ALREADY_MAPPED_TO_ANOTHER_ORG", 409);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("WABA already owned by another organization", async () => {
    const { service } = build({ state: { conflicts: { phone: false, waba: true } } });
    await expectCode(service.completeSignup(completeArgs()), "WABA_ALREADY_MAPPED", 409);
  });

  test("tenant mismatch: a session started by another tenant is rejected", async () => {
    const { service, metaClient } = build();
    await expectCode(
      service.completeSignup(completeArgs({ session_token: session("TT999") })),
      "INVALID_SESSION",
      400,
    );
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
  });

  test("garbage / missing session token is rejected", async () => {
    const { service } = build();
    await expectCode(service.completeSignup(completeArgs({ session_token: "not-a-session" })), "INVALID_SESSION");
    await expectCode(service.completeSignup(completeArgs({ session_token: undefined })), "INVALID_SESSION");
  });

  test("Business App event during a standard setup is not silently converted", async () => {
    const { service } = build();
    await expectCode(
      service.completeSignup(completeArgs({ event: SESSION_EVENTS.COEXISTENCE })),
      "INVALID_MODE",
      400,
    );
  });
});

describe("completion — coexistence", () => {
  const coexArgs = (over = {}) =>
    completeArgs({
      session_token: session("TT001", COEX),
      event: SESSION_EVENTS.COEXISTENCE,
      phone_number_id: undefined, // coexistence session events only carry waba_id
      ...over,
    });
  const connected = { phones: [phone({ status: "CONNECTED", platform_type: "CLOUD_API" })] };

  test("resolves the single phone from the WABA and NEVER calls /register", async () => {
    const { service, metaClient, persistConnection } = build({ state: connected });
    const result = await service.completeSignup(coexArgs());

    expect(metaClient.registerPhone).not.toHaveBeenCalled();
    expect(metaClient.subscribeApp).toHaveBeenCalledTimes(1);
    const saved = persistConnection.mock.calls[0][0];
    expect(saved).toMatchObject({
      connection_type: COEX,
      phone_number_id: "555666777888",
      meta_embedded_config_id: "cfg-single",
      register_pin: null,
    });
    expect(result.whatsapp_connection_type).toBe(COEX);
  });

  test("coexistence flag is enforced again at completion", async () => {
    const { service } = build({
      state: { ...connected, caps: { embedded_signup_enabled: true, coexistence_enabled: false } },
    });
    await expectCode(service.completeSignup(coexArgs()), "COEXISTENCE_NOT_ENABLED", 403);
  });

  test("Meta did not offer the coexistence path (standard finish event)", async () => {
    const { service, persistConnection, metaClient } = build({ state: connected });
    await expectCode(
      service.completeSignup(coexArgs({ event: SESSION_EVENTS.STANDARD })),
      "COEXISTENCE_NOT_ELIGIBLE",
      422,
    );
    expect(metaClient.exchangeCode).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("number not already connected is not treated as coexistence", async () => {
    const { service, persistConnection, metaClient } = build(); // default phone status PENDING
    await expectCode(service.completeSignup(coexArgs()), "COEXISTENCE_NOT_ELIGIBLE", 422);
    expect(metaClient.registerPhone).not.toHaveBeenCalled();
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("several numbers and no hint is ambiguous", async () => {
    const { service } = build({
      state: { phones: [phone({ status: "CONNECTED" }), phone({ id: "999", status: "CONNECTED" })] },
    });
    await expectCode(service.completeSignup(coexArgs()), "PHONE_AMBIGUOUS", 400);
  });
});

describe("security helpers", () => {
  test("redactSecrets strips tokens, secrets and codes", () => {
    const out = redactSecrets(
      `failed ${SECRET_TOKEN} url?client_secret=${APP_SECRET}&code=AQAbc&access_token=xyz`,
    );
    expect(out).not.toContain(SECRET_TOKEN);
    expect(out).not.toContain(APP_SECRET);
    expect(out).not.toContain("AQAbc");
    expect(out).not.toContain("xyz");
  });

  test("config exposes only what the browser may see via start() — secret stays server-side", async () => {
    const { service } = build();
    const r = await service.startSignup({ tenant_id: "TT001", connection_type: STD });
    expect(JSON.stringify(r)).not.toContain(APP_SECRET);
    expect(Object.keys(r).sort()).toEqual(
      ["app_id", "config_id", "connection_type", "extras", "feature_type", "graph_api_version", "mode", "session_token"].sort(),
    );
  });

  test("env config: single WHATSNEXUS_* configuration; version defaults", () => {
    const c = getEmbeddedSignupConfig({
      WHATSNEXUS_META_APP_ID: " 1 ",
      WHATSNEXUS_META_APP_SECRET: "s",
      WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID: "cfg",
    });
    expect(c).toMatchObject({ appId: "1", appSecret: "s", configId: "cfg", graphApiVersion: "v25.0" });
  });
});

describe("phone identity: SAME_NUMBER vs NEW_NUMBER (server-side decision)", () => {
  const existing = (over = {}) => ({
    id: 9,
    whatsapp_number: "919876543210",
    phone_number_id: "OLD_PID",
    waba_id: "OLD_WABA",
    whatsapp_connection_type: null,
    is_deleted: false,
    ...over,
  });
  const args = (over = {}) => completeArgs({ confirm_switch: true, ...over });
  const phoneFor = (display) => ({ state: { phones: [phone({ display_phone_number: display })] } });

  test("no previous connection → FIRST_CONNECTION (nothing inherited, no previous)", async () => {
    const { service, persistConnection } = build();
    const r = await service.completeSignup(completeArgs());
    expect(r).toMatchObject({ migration_mode: "FIRST_CONNECTION", previous_history_hidden: false, previous_business_number: null });
    expect(persistConnection.mock.calls[0][0].previous).toBeNull();
  });

  test("same number in a different spelling → SAME_NUMBER, history preserved, new transport ids recorded", async () => {
    const { service, persistConnection } = build({
      state: { existing: existing(), ...phoneFor("+91 98765 43210").state },
    });
    const r = await service.completeSignup(args());
    expect(r).toMatchObject({
      migration_mode: "SAME_NUMBER",
      business_number: "+919876543210",
      previous_history_hidden: false,
    });
    const saved = persistConnection.mock.calls[0][0];
    expect(saved).toMatchObject({ mode: "SAME_NUMBER", phone_number_id: "555666777888", waba_id: "999888777666" });
    expect(saved.previous).toMatchObject({ business_number: "+919876543210", phone_number_id: "OLD_PID", waba_id: "OLD_WABA" });
  });

  test("TEST D: legacy row stored as national '9876543210' (tenant +91) vs '+919876543210' → SAME_NUMBER", async () => {
    const { service } = build({
      state: {
        existing: existing({ whatsapp_number: "9876543210" }),
        defaultCountryCode: "+91",
        ...phoneFor("+919876543210").state,
      },
    });
    expect((await service.completeSignup(args())).migration_mode).toBe("SAME_NUMBER");
  });

  test("the identical digits are NOT the same number under a different country code default", async () => {
    // 10-digit national number + tenant CC +1 → +1 987 654 3210, which is not +91 98765 43210
    const { service } = build({
      state: {
        existing: existing({ whatsapp_number: "9876543210" }),
        defaultCountryCode: "+1",
        ...phoneFor("+919876543210").state,
      },
    });
    const r = await service.completeSignup(args()).catch((e) => e);
    // either classified as a different number, or refused as unverifiable — never SAME_NUMBER
    expect(r.migration_mode ?? r.code).not.toBe("SAME_NUMBER");
  });

  test("different number → NEW_NUMBER, previous history flagged hidden, previous identity passed to persist", async () => {
    const { service, persistConnection } = build({
      state: { existing: existing(), ...phoneFor("+91 98111 12222").state },
    });
    const r = await service.completeSignup(args());
    expect(r).toMatchObject({
      migration_mode: "NEW_NUMBER",
      business_number: "+919811112222",
      previous_business_number: "+919876543210",
      previous_history_hidden: true,
    });
    expect(persistConnection.mock.calls[0][0].previous.business_number).toBe("+919876543210");
  });

  test("the frontend cannot influence the decision (extra fields are ignored)", async () => {
    const { service } = build({ state: { existing: existing(), ...phoneFor("+919811112222").state } });
    const r = await service.completeSignup(
      args({ migration_mode: "SAME_NUMBER", preserve_history: true, business_number: "+919876543210" }),
    );
    expect(r.migration_mode).toBe("NEW_NUMBER");
  });

  test("unverifiable existing number → refused, nothing changes", async () => {
    const { service, persistConnection } = build({
      state: { existing: existing({ whatsapp_number: "not-a-number" }), ...phoneFor("+919811112222").state },
    });
    await expectCode(service.completeSignup(args()), "EXISTING_NUMBER_UNVERIFIABLE", 422);
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test("a soft-disconnected previous row still counts: a different number does not inherit its history", async () => {
    const { service, persistConnection } = build({
      state: { existing: existing({ is_deleted: true }), ...phoneFor("+919811112222").state },
    });
    // disconnected → no confirmation needed
    const r = await service.completeSignup(completeArgs());
    expect(r.migration_mode).toBe("NEW_NUMBER");
    expect(persistConnection.mock.calls[0][0].previous.was_deleted).toBe(true);
  });

  test("cross-tenant conflict check covers the national-format spelling too", async () => {
    const { service, state } = build({ state: phoneFor("+919876543210").state });
    await service.completeSignup(completeArgs());
    const call = state.findMappingConflicts.mock.calls[0][0];
    expect(call.whatsapp_numbers).toEqual(expect.arrayContaining(["919876543210", "9876543210"]));
  });
});
