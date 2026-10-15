import { describe, expect, it } from "vitest";
import { normalizeLanguage, tokenizeCode } from "./codeTokenizer";

describe("codeTokenizer", () => {
  it("normalizes profiles correctly", () => {
    expect(normalizeLanguage("python-process-v1")).toBe("python");
    expect(normalizeLanguage("python")).toBe("python");
    expect(normalizeLanguage("node-process-v1")).toBe("javascript");
    expect(normalizeLanguage("controlled-node")).toBe("javascript");
    expect(normalizeLanguage("cpp-process-v1")).toBe("cpp");
    expect(normalizeLanguage("java-process-v1")).toBe("java");
  });

  it("tokenizes Python keywords, comments, strings and numbers", () => {
    const code = `# Python bot
def make_move(state):
    turn = "A"
    ply = 42
    if turn == "A":
        return {"from": {"x": 4, "y": 7}}
`;
    const tokens = tokenizeCode(code, "python");
    expect(tokens.length).toBeGreaterThan(0);

    const comments = tokens.filter((t) => t.type === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe("# Python bot");

    const keywords = tokens.filter((t) => t.type === "keyword");
    const keywordWords = keywords.map((k) => k.content);
    expect(keywordWords).toContain("def");
    expect(keywordWords).toContain("if");
    expect(keywordWords).toContain("return");

    const strings = tokens.filter((t) => t.type === "string");
    const stringVals = strings.map((s) => s.content);
    expect(stringVals).toContain('"A"');
    expect(stringVals).toContain('"from"');

    const numbers = tokens.filter((t) => t.type === "number");
    const numberVals = numbers.map((n) => n.content);
    expect(numberVals).toContain("42");
    expect(numberVals).toContain("4");
    expect(numberVals).toContain("7");
  });

  it("tokenizes JavaScript/Node code", () => {
    const code = `// Node bot
import readline from "node:readline";

export async function run() {
  const count = 100;
  if (count > 0) {
    return true;
  }
}
`;
    const tokens = tokenizeCode(code, "node");
    const comments = tokens.filter((t) => t.type === "comment");
    expect(comments[0].content).toBe("// Node bot");

    const keywords = tokens.filter((t) => t.type === "keyword").map((k) => k.content);
    expect(keywords).toContain("import");
    expect(keywords).toContain("from");
    expect(keywords).toContain("export");
    expect(keywords).toContain("async");
    expect(keywords).toContain("function");
    expect(keywords).toContain("const");
    expect(keywords).toContain("if");
    expect(keywords).toContain("return");
    expect(keywords).toContain("true");
  });

  it("tokenizes C++ preprocessor and types", () => {
    const code = `#include <iostream>
int main() {
    int x = 10;
    return 0;
}
`;
    const tokens = tokenizeCode(code, "cpp");
    const preprocessor = tokens.filter((t) => t.type === "comment");
    expect(preprocessor[0].content).toBe("#include <iostream>");

    const keywords = tokens.filter((t) => t.type === "keyword").map((k) => k.content);
    expect(keywords).toContain("int");
    expect(keywords).toContain("return");
  });

  it("handles empty strings safely", () => {
    expect(tokenizeCode("", "python")).toEqual([]);
  });
});
