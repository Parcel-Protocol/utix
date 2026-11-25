import { describe, it, expect } from "vitest";
import { checkOutboundDelivery } from "../outbound-allowlist";
import { createSafeDelivery } from "../safe-delivery";

const allowlist = {
  origins: ["https://hooks.example.com"],
  contentTypes: ["application/json"],
  maxBodyBytes: 64
};
const payload = { recipientKey: "account-1", eventId: "event-1", destination: "https://hooks.example.com/v1/notify", contentType: "application/json", body: '{"ok":true}' };

describe("strict destination/content policy", () => {
  it("accepts only exact configured HTTPS origins and content types", () => {
    expect(checkOutboundDelivery(payload.destination, "application/json; charset=utf-8", payload.body, allowlist).ok).toBe(true);
    for (const destination of [
      "http://hooks.example.com/v1",
      "https://hooks.example.com.evil.test/v1",
      "https://user:pass@hooks.example.com/v1",
      "https://localhost/v1",
      "https://hooks.example.com:444/v1"
    ]) {
      expect(checkOutboundDelivery(destination, "application/json", "{}", allowlist).ok).toBe(false);
    }
    expect(checkOutboundDelivery(payload.destination, "text/html", "{}", allowlist)).toMatchObject({ ok: false, code: "content_not_allowed" });
    expect(checkOutboundDelivery(payload.destination, "application/json", "x".repeat(65), allowlist)).toMatchObject({ ok: false, code: "payload_too_large" });
    expect(checkOutboundDelivery(payload.destination, "application/json", "{}", { origins: [], contentTypes: [] })).toMatchObject({ ok: false, code: "destination_not_allowed" });
  });

  it("sends once, suppresses duplicates and allows different events", async () => {
    const sent: string[] = [];
    const deliver = createSafeDelivery({ allowlist, send: async (url) => { sent.push(url); return true; } });
    expect((await deliver(payload)).ok).toBe(true);
    expect(await deliver(payload)).toMatchObject({ ok: false, code: "duplicate_delivery" });
    expect((await deliver({ ...payload, eventId: "event-2" })).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("retries after definitive rejection but not after unknown transport outcome", async () => {
    let calls = 0;
    const declined = createSafeDelivery({ allowlist, send: async () => { calls += 1; return calls > 1; } });
    expect(await declined(payload)).toMatchObject({ ok: false, code: "send_failed" });
    expect((await declined(payload)).ok).toBe(true);
    const uncertain = createSafeDelivery({ allowlist, send: async () => { throw Error("network timeout"); } });
    expect(await uncertain(payload)).toMatchObject({ ok: false, code: "send_failed" });
    expect(await uncertain(payload)).toMatchObject({ ok: false, code: "duplicate_delivery" });
  });

  it("fails closed for unauthorized destination without calling transport", async () => {
    let calls = 0;
    const deliver = createSafeDelivery({ allowlist, send: async () => { calls++; return true; } });
    expect(await deliver({ ...payload, destination: "https://evil.test/collect" })).toMatchObject({ ok: false, code: "destination_not_allowed" });
    expect(calls).toBe(0);
  });
});
