export interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  code?: string;
  message: string;
  source: "typescript" | "test" | "compiler" | "unknown";
}
const MAX_DIAGNOSTICS = 50;

/** Parse common TypeScript/compiler/test output into stable, small records. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const add = (diagnostic: Diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key) || diagnostics.length >= MAX_DIAGNOSTICS) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // tsc: src/a.ts(4,12): error TS2322: Type ...
    const windowsStyle = line.match(/^(.*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+)):\s*(error|warning|info)\s*(TS\d+)?\s*:?\s*(.*)$/i);
    if (windowsStyle) {
      add({
        file: windowsStyle[1],
        line: Number.parseInt(windowsStyle[2] ?? windowsStyle[4] ?? "", 10) || undefined,
        column: Number.parseInt(windowsStyle[3] ?? windowsStyle[5] ?? "", 10) || undefined,
        severity: (windowsStyle[6]?.toLowerCase() as Diagnostic["severity"]) ?? "error",
        code: windowsStyle[7],
        message: windowsStyle[8] ?? "",
        source: windowsStyle[7] ? "typescript" : "compiler",
      });
      continue;
    }
    // Vitest/Jest: FAIL path/to/file.test.ts or ● test name
    const failedFile = line.match(/^(?:FAIL|FAILED)\s+(.+)$/i);
    if (failedFile) {
      add({ file: failedFile[1], severity: "error", message: line, source: "test" });
      continue;
    }
    if (/^(?:×|✕|●)\s+/.test(line)) {
      add({ severity: "error", message: line.replace(/^(?:×|✕|●)\s+/, ""), source: "test" });
    }
  }
  return diagnostics;
}
