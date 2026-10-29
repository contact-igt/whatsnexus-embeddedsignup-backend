import { jest } from "@jest/globals";
import {
  createEchoProcessor,
  normalizeEcho,
  ECHO_FIELD,
  BUSINESS_APP_SENDER_LABEL,
} from "../src/models/AuthWhatsapp/coexistenceEcho.core.js";
import {
  resolveConnectionType,
  resolveCapabilities,
  isLegacyManualConnection,
} from "../src/models/WhatsappAccountModel/whatsappConnectionTypes.js";

const body = (echoes, over = {}) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA1",
      changes: [
        {
          field: ECHO_FIELD,
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "919876543210", phone_number_id: "PNID1", ...over },
            message_echoes: echoes,
          },
        },
      ],
    },
  ],
});

const textEcho = (id = "wamid.A", to = "919111111111") => ({
  from: "919876543210",
  to,
  id,
  timestamp: "1700000000",
  type: "text",
  text: { body: "hello from the business app" },
});

const build = (accountOver = {}) => {
  const account = {
    tenant_id: "TT001",
    whatsapp_connection_type: "EMBEDDED_COEXISTENCE",
    ...accountOver,
  };
  const processed = new Set();
  const deps = {
    getAccountByPhoneNumberId: jest.fn(async (id) => (id === "PNID1" ? account : null)),
    formatPhone: (p) => String(p).replace(/\D/g, ""),
    tryMarkProcessed: jest.fn(async (_t, _p, id) => {
      if (processed.has(id)) return false;
      processed.add(id);
      return true;
    }),
    messageExists: jest.fn(async () => false),
    getOrCreateContact: jest.fn(async () => ({ contact: { contact_id: "C1", name: "Asha" } })),
    touchLiveChat: jest.fn(async () => {}),
    saveMessage: jest.fn(async () => ({ id: 42 })),
    emit: jest.fn(),
    afterSave: jest.fn(async () => {}),
    logger: { error: jest.fn() },
  };
  return { deps, processor: createEchoProcessor(deps) };
};

describe("normalizeEcho", () => {
  test("text", () => {
    expect(normalizeEcho(textEcho())).toMatchObject({ wamid: "wamid.A", message_type: "text", text: "hello from the business app" });
  });
  test("media keeps a Meta media reference, caption and mime", () => {
    const n = normalizeEcho({ id: "w", to: "9", type: "image", image: { id: "MEDIA1", caption: "cap", mime_type: "image/png" } });
    expect(n).toMatchObject({ message_type: "image", text: "cap", media_id: "MEDIA1", media_mime_type: "image/png" });
  });
  test("reactions and identity-less events are not messages", () => {
    expect(normalizeEcho({ id: "w", to: "9", type: "reaction" })).toBeNull();
    expect(normalizeEcho({ to: "9", type: "text" })).toBeNull();
    expect(normalizeEcho({ id: "w", type: "text" })).toBeNull();
    expect(normalizeEcho(null)).toBeNull();
  });
  test("unknown types degrade to a placeholder text, never crash", () => {
    expect(normalizeEcho({ id: "w", to: "9", type: "order" })).toMatchObject({ message_type: "text" });
  });
});

describe("coexistence echo processing", () => {
  test("stores the message under the coexistence tenant as an admin/Business App message", async () => {
    const { deps, processor } = build();
    const res = await processor.processWebhook({ body: body([textEcho()]) });

    expect(res).toEqual([{ stored: true, wamid: "wamid.A" }]);
    expect(deps.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "TT001",
        contact_id: "C1",
        phone: "919111111111", // recipient (customer), not the business number
        wamid: "wamid.A",
        sender: "admin",
        sender_id: BUSINESS_APP_SENDER_LABEL,
        status: "sent",
      }),
    );
    expect(deps.emit).toHaveBeenCalledWith(
      "TT001",
      "new-message",
      expect.objectContaining({ sender: "admin", source: "BUSINESS_APP", message: "hello from the business app" }),
    );
  });

  test("idempotent: the same Meta message id is processed once", async () => {
    const { deps, processor } = build();
    await processor.processWebhook({ body: body([textEcho("wamid.DUP")]) });
    const second = await processor.processWebhook({ body: body([textEcho("wamid.DUP")]) });

    expect(second).toEqual([{ skipped: "duplicate" }]);
    expect(deps.saveMessage).toHaveBeenCalledTimes(1);
  });

  test("a message already stored (e.g. sent via Cloud API) is not duplicated", async () => {
    const { deps, processor } = build();
    deps.messageExists.mockResolvedValueOnce(true);
    const res = await processor.processWebhook({ body: body([textEcho()]) });
    expect(res).toEqual([{ skipped: "already-stored" }]);
    expect(deps.saveMessage).not.toHaveBeenCalled();
  });

  test("LEGACY_MANUAL and NULL-type (existing production) accounts are completely ignored", async () => {
    for (const type of ["LEGACY_MANUAL", null, undefined, "EMBEDDED_STANDARD"]) {
      const { deps, processor } = build({ whatsapp_connection_type: type });
      const res = await processor.processWebhook({ body: body([textEcho()]) });
      expect(res).toEqual([{ skipped: "not-coexistence" }]);
      expect(deps.saveMessage).not.toHaveBeenCalled();
      expect(deps.getOrCreateContact).not.toHaveBeenCalled();
      expect(deps.emit).not.toHaveBeenCalled();
    }
  });

  test("tenant scoping: URL tenant must match the account's tenant; unknown numbers ignored", async () => {
    const { deps, processor } = build();
    expect(await processor.processWebhook({ body: body([textEcho()]), urlTenantId: "TT999" })).toEqual([
      { skipped: "tenant-mismatch" },
    ]);
    expect(await processor.processWebhook({ body: body([textEcho()], { phone_number_id: "UNKNOWN" }) })).toEqual([
      { skipped: "unknown-account" },
    ]);
    expect(deps.saveMessage).not.toHaveBeenCalled();
  });

  test("never throws: a failing dependency yields an error result and the webhook can still 200", async () => {
    const { deps, processor } = build();
    deps.saveMessage.mockRejectedValueOnce(new Error("db down"));
    const res = await processor.processWebhook({ body: body([textEcho(), textEcho("wamid.B")]) });
    expect(res[0]).toEqual({ error: true });
    expect(res[1]).toEqual({ stored: true, wamid: "wamid.B" });
  });

  test("other webhook fields in the body are not consumed", async () => {
    const { deps, processor } = build();
    const other = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID1" } } }] }] };
    expect(await processor.processWebhook({ body: other })).toEqual([]);
    expect(deps.getAccountByPhoneNumberId).not.toHaveBeenCalled();
  });
});

describe("legacy fallback + capabilities", () => {
  test("existing rows (NULL / unknown type) resolve to LEGACY_MANUAL", () => {
    expect(resolveConnectionType(null)).toBe("LEGACY_MANUAL");
    expect(resolveConnectionType(undefined)).toBe("LEGACY_MANUAL");
    expect(resolveConnectionType("garbage")).toBe("LEGACY_MANUAL");
    expect(resolveConnectionType("EMBEDDED_COEXISTENCE")).toBe("EMBEDDED_COEXISTENCE");
  });

  test("only legacy rows may use manual credential mutation routes", () => {
    expect(isLegacyManualConnection(null)).toBe(true);
    expect(isLegacyManualConnection("LEGACY_MANUAL")).toBe(true);
    expect(isLegacyManualConnection("EMBEDDED_STANDARD")).toBe(false);
    expect(isLegacyManualConnection("EMBEDDED_COEXISTENCE")).toBe(false);
  });

  test("existing tenants (no flags / 0) have every new capability OFF", () => {
    expect(resolveCapabilities({})).toEqual({ embedded_signup_enabled: false, coexistence_enabled: false });
    expect(resolveCapabilities(undefined)).toEqual({ embedded_signup_enabled: false, coexistence_enabled: false });
    expect(resolveCapabilities({ embedded_signup_enabled: 0, coexistence_enabled: 0 })).toEqual({
      embedded_signup_enabled: false,
      coexistence_enabled: false,
    });
  });

  test("coexistence is only effective when Embedded Signup is on", () => {
    expect(resolveCapabilities({ embedded_signup_enabled: 0, coexistence_enabled: 1 }).coexistence_enabled).toBe(false);
    expect(resolveCapabilities({ embedded_signup_enabled: 1, coexistence_enabled: 1 })).toEqual({
      embedded_signup_enabled: true,
      coexistence_enabled: true,
    });
  });
});
