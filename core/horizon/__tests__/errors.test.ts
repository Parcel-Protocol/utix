import { describe, expect, it } from "vitest";
import { classifyHorizonError } from "@/core/horizon/errors";

describe("classifyHorizonError", () => {
  it("returns stable, safe, retryable metadata for transient failures", () => {
    const result = classifyHorizonError({ status: 503 });

    expect(result.code).toBe("server_error");
    expect(result.retryable).toBe(true);
    expect(result.safeMessage).not.toContain("503");
    expect(result.correlationId).toMatch(/^hzn-|^[0-9a-f-]{36}$/);
  });

  it("does not expose internal exception text", () => {
    const result = classifyHorizonError(new Error("secret database password"));

    expect(result.code).toBe("unknown");
    expect(result.safeMessage).not.toContain("secret");
  });
});