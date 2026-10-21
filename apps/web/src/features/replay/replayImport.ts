import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { validateReplayDocument } from "../../../../../packages/arena/src/contracts/index.mjs";

export const MAX_REPLAY_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB

export type ParseReplayResult =
  | { readonly ok: true; readonly document: ReplayDocument }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

async function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === "function") {
    try {
      return await file.text();
    } catch {
      // Fallback to FileReader if file.text() is unsupported or fails
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Không thể đọc nội dung tập tin."));
    reader.readAsText(file);
  });
}

/**
 * Parses and validates an Arena replay file.
 *
 * Guarantees:
 * - Checks file size <= 8 MiB before reading content or attempting JSON parsing.
 * - Safely handles invalid JSON syntax with a retryable error without crashing.
 * - Validates schema and integrity with shared validateReplayDocument validator.
 * - Never executes executable code from the file.
 */
export async function parseReplayFile(file: File): Promise<ParseReplayResult> {
  if (file.size > MAX_REPLAY_FILE_BYTES) {
    return {
      ok: false,
      error: "Kích thước tập tin vượt quá giới hạn 8 MiB.",
      retryable: true,
    };
  }

  let text: string;
  try {
    text = await readFileAsText(file);
  } catch {
    return {
      ok: false,
      error: "Không thể đọc nội dung tập tin.",
      retryable: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "Tập tin không phải định dạng JSON hợp lệ.",
      retryable: true,
    };
  }

  const validation = validateReplayDocument(parsed);
  if (!validation.ok) {
    const errorMessages = validation.errors
      .map((err) => `${err.path}: ${err.message}`)
      .join("; ");
    return {
      ok: false,
      error: `Dữ liệu replay không hợp lệ: ${errorMessages}`,
      retryable: true,
    };
  }

  return {
    ok: true,
    document: parsed as ReplayDocument,
  };
}

/**
 * Serializes the original replay document into JSON text without mutation.
 */
export function serializeReplayDocument(document: ReplayDocument): string {
  return JSON.stringify(document, null, 2);
}

/**
 * Initiates browser download of the original finalized replay document.
 */
export function downloadReplayDocument(document: ReplayDocument, fileName?: string): void {
  const json = serializeReplayDocument(document);
  const blob = new Blob([json], { type: "application/json" });
  const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
  const name = fileName || `replay-${document.matchId || "match"}.json`;

  if (!url) return;
  try {
    const link = typeof window !== "undefined" && window.document?.createElement ? window.document.createElement("a") : null;
    if (link) {
      link.href = url;
      link.download = name;
      link.style.display = "none";
      window.document.body.appendChild(link);
      try {
        link.click();
      } finally {
        window.document.body.removeChild(link);
      }
    }
  } finally {
    if (typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
  }
}
