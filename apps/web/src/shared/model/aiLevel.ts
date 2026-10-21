export type AiLevel = "easy" | "medium" | "hard";

export const DEFAULT_AI_LEVEL: AiLevel = "medium";

export const AI_LEVELS: readonly { readonly value: AiLevel; readonly label: string; readonly hint: string }[] = [
  { value: "easy", label: "Dễ", hint: "Đi nông, đôi khi đi bừa." },
  { value: "medium", label: "Vừa", hint: "Nhìn trước một nước đáp trả." },
  { value: "hard", label: "Khó", hint: "Tính trước nhiều nước, mất vài giây." },
];

export function isAiLevel(value: unknown): value is AiLevel {
  return value === "easy" || value === "medium" || value === "hard";
}
