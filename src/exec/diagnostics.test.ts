import { describe, expect, it } from "vitest";
import { parseDiagnostics } from "./diagnostics.js";

describe("parseDiagnostics", () => {
  it("parses TypeScript and test failure lines", () => {
    const result = parseDiagnostics([
      "src/app.ts(4,12): error TS2322: Type 'string' is not assignable to type 'number'.",
      "FAIL src/app.test.ts",
      "● renders the widget",
    ].join("\n"));
    expect(result[0]).toMatchObject({ file: "src/app.ts", line: 4, column: 12, code: "TS2322", source: "typescript" });
    expect(result[1]).toMatchObject({ file: "src/app.test.ts", severity: "error", source: "test" });
    expect(result[2]?.message).toContain("renders the widget");
  });
});
