export declare const DEFAULT_MAX_OUTPUT_CHARS: number;

export interface OutputBudgetOptions {
  maxChars?: number;
  full?: boolean;
  tmpDir?: string;
  label?: string;
}

export interface OutputBudgetResult {
  text: string;
  truncated: boolean;
  totalChars: number;
  savedPath?: string;
}

export declare function stripTerminalEscapes(input: string): string;
export declare function wrapUntrustedContent(
  content: string,
  meta?: { source?: string; url?: string; nonce?: string },
): string;
export declare function applyOutputBudget(raw: string, options?: OutputBudgetOptions): OutputBudgetResult;
export declare function computeRpcTimeoutMs(
  method: string,
  params?: Record<string, unknown>,
  baseTimeoutMs?: number,
): number;
export declare function toCsv(rows: Array<Record<string, unknown>>): string;
