import type { Persona } from "../generated/contracts.js";

export type PersonaInterpretation = Persona;
export type PersonaDiagnosticSeverity = "warning" | "error";

export interface PersonaDiagnostic {
  severity: PersonaDiagnosticSeverity;
  code: string;
  message: string;
  line: number;
  range: { start: number; end: number };
}

export type PersonaParseResult =
  | {
      ok: true;
      interpretation: PersonaInterpretation;
      canonicalJson: string;
      digest: string;
      warnings: readonly PersonaDiagnostic[];
    }
  | {
      ok: false;
      errors: readonly PersonaDiagnostic[];
      warnings: readonly PersonaDiagnostic[];
    };
