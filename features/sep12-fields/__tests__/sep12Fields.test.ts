import { describe, expect, it } from "vitest";
import { runSep12Fields } from "@/features/sep12-fields/lib/sep12Fields";

describe("runSep12Fields", () => {
  it("finds canonical fields", async () => {
    const result = await runSep12Fields({ value: "country" }, "testnet");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fields[0]?.name).toBe("country");
  });
});
