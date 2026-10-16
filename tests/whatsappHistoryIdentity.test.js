import { jest } from "@jest/globals";

/**
 * Phone-number identity + chat-history rules, exercised through the REAL wiring:
 * embeddedSignupService (start/complete) → real persist SQL → real read paths,
 * against an in-memory fake of the few SQL statements involved and a mocked Meta
 * HTTP layer. Only the database engine and Meta are faked.
 */
process.env.ENCRYPTION_MASTER_KEY = "11".repeat(32);
process.env.WHATSNEXUS_META_APP_ID = "111222333444";
process.env.WHATSNEXUS_META_APP_SECRET = "test-app-secret";
process.env.WHATSNEXUS_EMBEDDED_SIGNUP_CONFIG_ID = "cfg-1";
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-jwt-key";

// ── in-memory world ───────────────────────────────────────────────────────
let world;
const resetWorld = () => {
  world = {
    tenants: {}, // tenant_id → { embedded_signup_enabled, coexistence_enabled, owner_country_code }
    accounts: [], // whatsapp_accounts rows
    identities: [], // whatsapp_number_identities rows
    messages: [], // { id, tenant_id, contact_id, phone_number_id, message, created_at }
    contacts: [], // { contact_id, tenant_id, phone }
    secrets: {}, // `${tenant}|${type}` → encrypted parts
    captured: [], // every SQL seen (for shape assertions)
    onboardings: [],
    nextId: 1,
  };
};
resetWorld();

const norm = (sql) => sql.replace(/\s+/g, " ").trim();
const tenantIn = (repl) => repl.find((x) => typeof x === "string" && x.startsWith("TT"));
const contactIn = (repl) => repl.find((x) => typeof x === "string" && x.startsWith("CT"));

const query = jest.fn(async (rawSql, opts = {}) => {
  const sql = norm(rawSql);
  const r = opts.replacements || [];
  world.captured.push({ sql, replacements: r });

  // tenants
  if (sql.startsWith("SELECT embedded_signup_enabled, coexistence_enabled FROM tenants")) {
    const t = world.tenants[r[0]];
    return [t ? [t] : []];
  }
  if (sql.startsWith("SELECT owner_country_code FROM tenants")) {
    const t = world.tenants[r[0]];
    return [t ? [{ owner_country_code: t.owner_country_code }] : []];
  }

  // accounts
  if (sql.startsWith("SELECT id, tenant_id, whatsapp_number, phone_number_id, waba_id, whatsapp_connection_type, status, is_deleted FROM whatsapp_accounts")) {
    return [world.accounts.filter((a) => a.tenant_id === r[0]).slice(0, 1)];
  }
  if (sql.startsWith("SELECT id, phone_number_id, is_deleted FROM whatsapp_accounts WHERE tenant_id = ? FOR UPDATE")) {
    return [world.accounts.filter((a) => a.tenant_id === r[0])];
  }
  if (sql.startsWith("SELECT tenant_id, waba_id, phone_number_id, whatsapp_number, is_deleted FROM whatsapp_accounts WHERE tenant_id <> ?")) {
    const [tenant, pid, numbers, waba] = r;
    return [
      world.accounts.filter(
        (a) => a.tenant_id !== tenant && (a.phone_number_id === pid || numbers.includes(a.whatsapp_number) || a.waba_id === waba),
      ),
    ];
  }
  if (sql.startsWith("UPDATE whatsapp_accounts SET whatsapp_number = ?")) {
    const [number, pid, waba, app, type, biz, cfg, id] = r;
    const a = world.accounts.find((x) => x.id === id);
    Object.assign(a, {
      whatsapp_number: number, phone_number_id: pid, waba_id: waba, app_id: app,
      whatsapp_connection_type: type, meta_business_id: biz, meta_embedded_config_id: cfg,
      status: "active", is_deleted: false, meta_info_synced_at: null,
    });
    if (sql.includes("quality = 'UNKNOWN'")) Object.assign(a, { quality: "UNKNOWN", tier: "TIER_NOT_SET" });
    return [[], {}];
  }
  if (sql.startsWith("INSERT INTO whatsapp_accounts")) {
    const [number, pid, waba, app, type, biz, cfg, tenant] = r;
    world.accounts.push({
      id: world.nextId++, tenant_id: tenant, whatsapp_number: number, phone_number_id: pid, waba_id: waba,
      app_id: app, whatsapp_connection_type: type, meta_business_id: biz, meta_embedded_config_id: cfg,
      status: "active", is_deleted: false,
    });
    return [[], {}];
  }
  if (sql.startsWith("SELECT id, tenant_id, whatsapp_number, phone_number_id, waba_id, status, whatsapp_connection_type, connected_at FROM whatsapp_accounts")) {
    return [world.accounts.filter((a) => a.tenant_id === r[0]).slice(0, 1)];
  }

  // identities
  if (sql.startsWith("SELECT COUNT(*) AS n FROM whatsapp_number_identities")) {
    return [[{ n: world.identities.filter((i) => i.tenant_id === r[0]).length }]];
  }
  if (sql.startsWith("SELECT DISTINCT phone_number_id FROM messages")) {
    return [[...new Set(world.messages.filter((m) => m.tenant_id === r[0]).map((m) => m.phone_number_id))].map((p) => ({ phone_number_id: p }))];
  }
  if (sql.startsWith("INSERT IGNORE INTO whatsapp_number_identities") || sql.startsWith("INSERT INTO whatsapp_number_identities")) {
    const [tenant, biz, pid, waba, type, mode, prev] = r;
    const existing = world.identities.find((i) => i.tenant_id === tenant && i.phone_number_id === pid);
    if (existing) {
      if (!sql.startsWith("INSERT IGNORE")) Object.assign(existing, { waba_id: waba, connection_type: type, migration_mode: mode, previous_business_number: prev });
    } else {
      world.identities.push({ tenant_id: tenant, business_number: biz, phone_number_id: pid, waba_id: waba, connection_type: type, migration_mode: mode, previous_business_number: prev });
    }
    return [[], {}];
  }
  if (sql.startsWith("SELECT phone_number_id, business_number FROM whatsapp_number_identities")) {
    return [world.identities.filter((i) => i.tenant_id === r[0]).map((i) => ({ phone_number_id: i.phone_number_id, business_number: i.business_number }))];
  }
  if (sql.startsWith("SELECT a.whatsapp_number, a.phone_number_id, t.owner_country_code FROM whatsapp_accounts")) {
    const a = world.accounts.find((x) => x.tenant_id === r[0] && !x.is_deleted);
    const t = world.tenants[r[0]];
    return [a ? [{ ...a, owner_country_code: t?.owner_country_code }] : []];
  }
  if (sql.includes("FROM whatsapp_number_identities i LEFT JOIN whatsapp_accounts a")) {
    const active = world.accounts.find((a) => a.tenant_id === r[0] && !a.is_deleted);
    return [
      world.identities
        .filter((i) => i.tenant_id === r[0])
        .map((i) => ({ phone_number_id: i.phone_number_id, business_number: i.business_number, is_active: active && active.phone_number_id === i.phone_number_id ? 1 : 0 })),
    ];
  }

  // secrets
  if (sql.startsWith("INSERT INTO tenant_secrets")) {
    const [tenant, type, enc, iv, tag, ver] = r;
    world.secrets[`${tenant}|${type}`] = { encrypted_value: enc, iv, auth_tag: tag, key_version: ver };
    return [[], {}];
  }
  if (sql.startsWith("SELECT encrypted_value, iv, auth_tag, key_version FROM tenant_secrets")) {
    const s = world.secrets[`${r[0]}|${r[1]}`];
    return [s ? [s] : []];
  }

  // contacts (thread fetch resolves the contact by tenant + phone)
  if (/FROM contacts/i.test(sql)) {
    const tenant = tenantIn(r);
    const suffix = String(r[1] || "").slice(-10);
    return [world.contacts.filter((c) => c.tenant_id === tenant && c.phone.endsWith(suffix))];
  }

  // messages — thread / AI memory: evaluate tenant, contact, NOT IN scope, ORDER, LIMIT
  if (/FROM messages\s+WHERE/i.test(sql) && !/JOIN/i.test(sql)) {
    const tenant = tenantIn(r);
    const contact = contactIn(r);
    const excluded = r.filter((value) => typeof value === "string" && /^\d{5,}$/.test(value) && value !== tenant && value !== contact);
    const limit = Number((sql.match(/LIMIT (\d+)/i) || [])[1] || 1e9);
    const rows = world.messages
      .filter((m) => m.tenant_id === tenant && m.contact_id === contact && !excluded.includes(m.phone_number_id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
    return [rows];
  }

  return [[], {}];
});

const axiosGet = jest.fn();
const axiosPost = jest.fn();

jest.unstable_mockModule("../src/database/index.js", () => ({
  default: {
    sequelize: { query, transaction: async (cb) => cb({ LOCK: {} }) },
    AdminAuditLog: { create: jest.fn() },
  },
}));
jest.unstable_mockModule("axios", () => ({ default: { get: axiosGet, post: axiosPost } }));
jest.unstable_mockModule("../src/models/WhatsappAccountModel/whatsappOnboardingSession.store.js", () => ({
  whatsappOnboardingSessionStore: {
    findInFlight: async (tenant_id) => world.onboardings.find((s) => s.tenant_id === tenant_id && s.active_slot === 1) || null,
    create: async ({ tenant_id, connection_type }) => {
      const s = { id: `ob-${world.onboardings.length + 1}`, tenant_id, connection_type, state: "STARTED", active_slot: 1, secrets: {} };
      world.onboardings.push(s);
      return s;
    },
    claim: async (id) => world.onboardings.find((s) => s.id === id && s.active_slot === 1) || null,
    release: async () => {},
    readSecrets: async (s) => ({ ...s.secrets }),
    update: async (s, patch) => {
      Object.assign(s, patch);
      if (patch.token !== undefined) s.secrets.token = patch.token;
      if (patch.pin !== undefined) s.secrets.pin = patch.pin;
      if (patch.wipe) s.secrets = {};
    },
  },
}));

const { embeddedSignupService } = await import("../src/models/WhatsappAccountModel/whatsappEmbeddedSignup.service.js");
const { getHistoryScope } = await import("../src/models/WhatsappAccountModel/whatsappNumberScope.service.js");
const { getChatByPhoneService } = await import("../src/models/Messages/messages.service.js");
const { getConversationMemory } = await import("../src/models/Messages/messages.memory.js");
const { getLiveChatListService, getHistoryChatListService } = await import("../src/models/LiveChatModel/livechat.service.js");
const { getChatListService } = await import("../src/models/Messages/messages.service.js");

// ── helpers ───────────────────────────────────────────────────────────────
const STD = "EMBEDDED_STANDARD";
const TOKEN = "EAAtesttoken1234567890abcdef";

const seedTenant = (tenant_id, { enabled = true, cc = "+91" } = {}) => {
  world.tenants[tenant_id] = { embedded_signup_enabled: enabled ? 1 : 0, coexistence_enabled: 0, owner_country_code: cc };
};
const seedLegacyAccount = (tenant_id, { number, pid, waba }) => {
  world.accounts.push({
    id: world.nextId++, tenant_id, whatsapp_number: number, phone_number_id: pid, waba_id: waba,
    app_id: "legacy-app", whatsapp_connection_type: null, status: "active", is_deleted: false,
    quality: "GREEN", tier: "TIER_10K",
  });
};
const seedContact = (tenant_id, contact_id, phone) => world.contacts.push({ tenant_id, contact_id, phone });
let clock = 1_700_000_000_000;
const addMessages = (tenant_id, contact_id, phone_number_id, n, label = "msg") => {
  for (let i = 0; i < n; i++) {
    world.messages.push({ id: world.nextId++, tenant_id, contact_id, phone_number_id, message: `${label}-${i}`, created_at: (clock += 1000) });
  }
};
const visibleThread = async (tenant_id, phone = "919900001111") => (await getChatByPhoneService(phone, tenant_id)).length;

/** Meta mock: the customer authorised `waba` whose only phone is `display` (id `pid`). */
const mockMeta = ({ pid, display, waba = "999888777666", status = "CONNECTED", platform_type = "CLOUD_API" }) => {
  axiosGet.mockReset(); axiosPost.mockReset();
  axiosGet.mockImplementation(async (url) => {
    if (url.includes("/oauth/access_token")) return { data: { access_token: TOKEN } };
    if (url.includes("/phone_numbers")) return { data: { data: [{ id: pid, display_phone_number: display, status, platform_type }] } };
    throw new Error(`unexpected GET ${url}`);
  });
  axiosPost.mockImplementation(async (url) => {
    if (url.includes("/subscribed_apps")) return { data: { success: true } };
    if (url.includes("/register")) return { data: { success: true } };
    throw new Error(`unexpected POST ${url}`);
  });
};

const runEmbedded = async (tenant_id, { pid, display, waba = "999888777666", confirm = true, business_id = "555000111" }) => {
  mockMeta({ pid, display, waba });
  const start = await embeddedSignupService.startSignup({ tenant_id, connection_type: STD });
  return embeddedSignupService.completeSignup({
    tenant_id, session_token: start.session_token, code: "AQcode", waba_id: waba, phone_number_id: pid,
    business_id, event: "FINISH", confirm_switch: confirm,
  });
};

const snapshot = (rows) => JSON.stringify(rows);

beforeEach(() => { resetWorld(); query.mockClear(); });

// ── TEST A ────────────────────────────────────────────────────────────────
describe("TEST A — existing client + SAME number (WABA / Phone Number ID change)", () => {
  test("all 100 messages stay visible and the conversation continues", async () => {
    seedTenant("TT_A");
    seedLegacyAccount("TT_A", { number: "919876543210", pid: "1110001", waba: "2220001" });
    seedContact("TT_A", "CT_priya", "919900001111");
    addMessages("TT_A", "CT_priya", "1110001", 100, "old");
    const before = snapshot(world.messages);
    expect(await visibleThread("TT_A")).toBe(100);

    const r = await runEmbedded("TT_A", { pid: "1110002", display: "+91 98765 43210", waba: "2220002" });

    expect(r).toMatchObject({ migration_mode: "SAME_NUMBER", previous_history_hidden: false, business_number: "+919876543210" });
    // transport metadata changed …
    const acct = world.accounts.find((a) => a.tenant_id === "TT_A");
    expect(acct).toMatchObject({ phone_number_id: "1110002", waba_id: "2220002", whatsapp_connection_type: STD, status: "active" });
    // … but not one stored message was touched, and no exclusion applies
    expect(snapshot(world.messages)).toBe(before);
    expect((await getHistoryScope("TT_A")).sql).toBe("");

    expect(await visibleThread("TT_A")).toBe(100);

    // new traffic arrives under the new transport id → SAME thread, no duplicate contact
    addMessages("TT_A", "CT_priya", "1110002", 3, "new");
    expect(await visibleThread("TT_A")).toBe(103);
    expect(world.contacts.filter((c) => c.tenant_id === "TT_A")).toHaveLength(1);

    // both transport ids are recorded against the ONE canonical number
    expect(world.identities.map((i) => [i.phone_number_id, i.business_number, i.migration_mode])).toEqual(
      expect.arrayContaining([
        ["1110001", "+919876543210", "LEGACY_SEED"],
        ["1110002", "+919876543210", "SAME_NUMBER"],
      ]),
    );
    // AI context sees the continuous history too
    expect((await getConversationMemory("TT_A", null, "CT_priya")).length).toBe(50);
  });

  test("the superseded token is kept encrypted for recovery, never returned", async () => {
    seedTenant("TT_A");
    seedLegacyAccount("TT_A", { number: "919876543210", pid: "1110001", waba: "2220001" });
    const { storeSecret } = await import("../src/models/TenantSecretsModel/tenantSecrets.service.js");
    await storeSecret("TT_A", "whatsapp", "EAAlegacytoken1234567890");
    const r = await runEmbedded("TT_A", { pid: "1110002", display: "+919876543210" });
    expect(JSON.stringify(r)).not.toMatch(/EAA/);
    const { getSecret } = await import("../src/models/TenantSecretsModel/tenantSecrets.service.js");
    expect(await getSecret("TT_A", "whatsapp_previous")).toBe("EAAlegacytoken1234567890");
    expect(await getSecret("TT_A", "whatsapp")).toBe(TOKEN);
  });
});

// ── TEST B ────────────────────────────────────────────────────────────────
describe("TEST B — existing client + DIFFERENT number", () => {
  test("number B's inbox excludes number A's 100 messages; A's data is preserved; new B traffic is visible", async () => {
    seedTenant("TT_B");
    seedLegacyAccount("TT_B", { number: "919876543210", pid: "3330001", waba: "4440001" });
    seedContact("TT_B", "CT_priya", "919900001111");
    addMessages("TT_B", "CT_priya", "3330001", 100, "numA");
    const before = snapshot(world.messages);

    const r = await runEmbedded("TT_B", { pid: "3330002", display: "+91 98111 12222", waba: "4440002" });

    expect(r).toMatchObject({
      migration_mode: "NEW_NUMBER",
      business_number: "+919811112222",
      previous_business_number: "+919876543210",
      previous_history_hidden: true,
    });

    // Number A's messages remain stored, byte-for-byte (ownership NOT rewritten) …
    expect(snapshot(world.messages)).toBe(before);
    expect(world.messages).toHaveLength(100);
    // … but none of them appear under number B (thread, AI context)
    expect(await visibleThread("TT_B")).toBe(0);
    expect(await getConversationMemory("TT_B", null, "CT_priya")).toHaveLength(0);
    expect((await getHistoryScope("TT_B")).params).toEqual(["3330001"]);

    // new conversation context for B
    addMessages("TT_B", "CT_priya", "3330002", 2, "numB");
    expect(await visibleThread("TT_B")).toBe(2);

    // CRM/contact stays (org data), quality/tier of the OLD number are reset
    expect(world.contacts).toHaveLength(1);
    expect(world.accounts.find((a) => a.tenant_id === "TT_B")).toMatchObject({ quality: "UNKNOWN", tier: "TIER_NOT_SET" });
  });

  test("switching back to number A restores A's history and hides B's (identity is the business number)", async () => {
    seedTenant("TT_B");
    seedLegacyAccount("TT_B", { number: "919876543210", pid: "3330001", waba: "4440001" });
    seedContact("TT_B", "CT_priya", "919900001111");
    addMessages("TT_B", "CT_priya", "3330001", 100, "numA");

    await runEmbedded("TT_B", { pid: "3330002", display: "+919811112222", waba: "4440002" });
    addMessages("TT_B", "CT_priya", "3330002", 2, "numB");
    expect(await visibleThread("TT_B")).toBe(2);

    const back = await runEmbedded("TT_B", { pid: "3330003", display: "+919876543210", waba: "4440003" });
    expect(back.migration_mode).toBe("NEW_NUMBER"); // different from the CURRENT number (B)
    expect(await visibleThread("TT_B")).toBe(100); // A's history returns (3330001 + 3330003 are number A)
    expect((await getHistoryScope("TT_B")).params).toEqual(["3330002"]);
  });

  test("no confirmation → nothing is changed and the connection keeps working", async () => {
    seedTenant("TT_B");
    seedLegacyAccount("TT_B", { number: "919876543210", pid: "3330001", waba: "4440001" });
    addMessages("TT_B", "CT_priya", "3330001", 5);
    await expect(runEmbedded("TT_B", { pid: "3330002", display: "+919811112222", confirm: false })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
    expect(world.accounts[0]).toMatchObject({ phone_number_id: "3330001", whatsapp_connection_type: null });
    expect(world.identities).toHaveLength(0);
    expect(axiosGet).not.toHaveBeenCalledWith(expect.stringContaining("/oauth/access_token"), expect.anything());
  });
});

describe('older transport ids already present in history', () => {
  // A legacy client that once edited its Phone Number ID has messages under an id the
  // account row no longer names. They still belong to the (single) previous number.
  const seedWithOlderTransport = () => {
    seedTenant('TT_H');
    seedLegacyAccount('TT_H', { number: '919876543210', pid: '3330001', waba: '4440001' });
    seedContact('TT_H', 'CT_priya', '919900001111');
    addMessages('TT_H', 'CT_priya', '7770001', 40, 'older-id'); // no longer on the account row
    addMessages('TT_H', 'CT_priya', '3330001', 60, 'current-id');
  };

  test('NEW_NUMBER hides BOTH the current and the older transport id of the previous number', async () => {
    seedWithOlderTransport();
    await runEmbedded('TT_H', { pid: '3330002', display: '+919811112222', waba: '4440002' });
    expect((await getHistoryScope('TT_H')).params.sort()).toEqual(['3330001', '7770001']);
    expect(await visibleThread('TT_H')).toBe(0);
    expect(world.messages).toHaveLength(100);
  });

  test('SAME_NUMBER keeps all 100 visible, including the older transport id', async () => {
    seedWithOlderTransport();
    await runEmbedded('TT_H', { pid: '3330002', display: '+919876543210', waba: '4440002' });
    expect((await getHistoryScope('TT_H')).sql).toBe('');
    expect(await visibleThread('TT_H')).toBe(100);
  });
});

// ── TEST C ────────────────────────────────────────────────────────────────
describe("TEST C — brand-new organization", () => {
  test("starts empty; nothing from another organization is inherited", async () => {
    seedTenant("TT_OLD");
    seedLegacyAccount("TT_OLD", { number: "919876543210", pid: "1110001", waba: "2220001" });
    seedContact("TT_OLD", "CT_x", "919900001111");
    addMessages("TT_OLD", "CT_x", "1110001", 30);

    seedTenant("TT_NEW");
    const r = await runEmbedded("TT_NEW", { pid: "1110002", display: "+91 97000 00001", waba: "2220002" });

    expect(r).toMatchObject({ migration_mode: "FIRST_CONNECTION", previous_business_number: null, previous_history_hidden: false });
    expect(await visibleThread("TT_NEW")).toBe(0);
    expect(await getConversationMemory("TT_NEW", null, "CT_x")).toHaveLength(0);
    expect(world.identities.filter((i) => i.tenant_id === "TT_NEW")).toHaveLength(1);
    expect(world.messages.every((m) => m.tenant_id === "TT_OLD")).toBe(true);
  });
});

// ── TEST D ────────────────────────────────────────────────────────────────
describe("TEST D — formatting difference only", () => {
  test("stored '9876543210' (tenant +91) vs Embedded '+919876543210' → SAME_NUMBER via the real SQL path", async () => {
    seedTenant("TT_D", { cc: "+91" });
    seedLegacyAccount("TT_D", { number: "9876543210", pid: "1110001", waba: "2220001" });
    seedContact("TT_D", "CT_priya", "919900001111");
    addMessages("TT_D", "CT_priya", "1110001", 10);
    const r = await runEmbedded("TT_D", { pid: "1110002", display: "+919876543210" });
    expect(r.migration_mode).toBe("SAME_NUMBER");
    expect(await visibleThread("TT_D")).toBe(10);
  });
});

// ── TEST E ────────────────────────────────────────────────────────────────
describe("TEST E — tenant isolation", () => {
  test("two organizations, two business numbers: history never crosses, and a switch in one does not affect the other", async () => {
    seedTenant("TT_X"); seedTenant("TT_Y");
    seedLegacyAccount("TT_X", { number: "919000000001", pid: "5550001", waba: "6660001" });
    seedLegacyAccount("TT_Y", { number: "919000000002", pid: "5550002", waba: "6660002" });
    seedContact("TT_X", "CT_x", "919900001111");
    seedContact("TT_Y", "CT_y", "919900001111"); // SAME customer phone in both orgs
    addMessages("TT_X", "CT_x", "5550001", 10, "x");
    addMessages("TT_Y", "CT_y", "5550002", 7, "y");

    await runEmbedded("TT_Y", { pid: "5550003", display: "+919000000099", waba: "6660003" });

    expect(await visibleThread("TT_X")).toBe(10); // X untouched, no filter
    expect((await getHistoryScope("TT_X")).sql).toBe("");
    expect(await visibleThread("TT_Y")).toBe(0); // Y's old number hidden …
    const yMsgs = await getChatByPhoneService("919900001111", "TT_Y");
    expect(yMsgs.every((m) => m.tenant_id === "TT_Y")).toBe(true); // … and never X's
    // scope for Y only ever names Y's transport ids
    expect((await getHistoryScope("TT_Y")).params).toEqual(["5550002"]);
  });

  test("an organization cannot onboard a number owned by another organization", async () => {
    seedTenant("TT_X"); seedTenant("TT_Y");
    seedLegacyAccount("TT_X", { number: "9000000001", pid: "5550001", waba: "6660001" }); // national spelling
    seedLegacyAccount("TT_Y", { number: "919000000002", pid: "5550002", waba: "6660002" });
    await expect(runEmbedded("TT_Y", { pid: "5550004", display: "+919000000001", waba: "6660004" })).rejects.toMatchObject({
      code: "NUMBER_ALREADY_MAPPED_TO_ANOTHER_ORG",
    });
    expect(world.accounts.find((a) => a.tenant_id === "TT_Y").phone_number_id).toBe("5550002");
  });
});

// ── read-path SQL shape ───────────────────────────────────────────────────
describe("read paths: legacy queries are unchanged; switched orgs are scoped", () => {
  const capture = async (fn) => {
    world.captured.length = 0;
    await fn();
    return world.captured.filter((c) => /FROM messages/i.test(c.sql) && !/whatsapp_number_identities/.test(c.sql));
  };

  test("an organization with NO identity rows gets byte-identical replacements and no NOT IN", async () => {
    seedTenant("TT_LEG");
    for (const [fn, expectReps] of [
      [() => getLiveChatListService("TT_LEG"), ["TT_LEG", "TT_LEG", "TT_LEG", "TT_LEG", 200]],
      [() => getHistoryChatListService("TT_LEG"), ["TT_LEG", "TT_LEG", "TT_LEG", "TT_LEG", 200]],
      [() => getChatListService("TT_LEG"), ["TT_LEG", "TT_LEG", "TT_LEG", "TT_LEG", 200]],
    ]) {
      const [q] = await capture(fn);
      expect(q.sql).not.toMatch(/NOT IN/);
      expect(q.replacements).toEqual(expectReps);
    }
  });

  test("a switched organization gets the exclusion in BOTH aggregates of every list query", async () => {
    seedTenant("TT_SW");
    seedLegacyAccount("TT_SW", { number: "919876543210", pid: "3330001", waba: "4440001" });
    addMessages("TT_SW", "CT_1", "3330001", 1);
    await runEmbedded("TT_SW", { pid: "3330002", display: "+919811112222", waba: "4440002" });

    for (const fn of [
      () => getLiveChatListService("TT_SW"),
      () => getHistoryChatListService("TT_SW"),
      () => getChatListService("TT_SW"),
    ]) {
      const [q] = await capture(fn);
      expect(q.sql.match(/phone_number_id NOT IN \(\?\)/g)).toHaveLength(2);
      expect(q.replacements).toEqual(["TT_SW", "3330001", "TT_SW", "TT_SW", "3330001", "TT_SW", 200]);
    }
  });

  test("the scope lookup fails OPEN: an error leaves legacy behaviour intact", async () => {
    query.mockImplementationOnce(async () => { throw new Error("table missing"); });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await getHistoryScope("TT_ANY")).toMatchObject({ sql: "", params: [], reason: "LOOKUP_ERROR" });
    spy.mockRestore();
  });
});
