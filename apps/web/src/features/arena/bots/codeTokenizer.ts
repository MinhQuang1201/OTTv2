export type TokenType = "keyword" | "string" | "comment" | "number" | "punctuation" | "text";

export interface CodeToken {
  readonly type: TokenType;
  readonly content: string;
}

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "False", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass",
  "raise", "return", "True", "try", "while", "with", "yield", "self"
]);

const JS_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "export", "extends", "false",
  "finally", "for", "from", "function", "if", "import", "in", "instanceof", "let",
  "new", "null", "of", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "undefined", "var", "void", "while", "with", "yield"
]);

const CPP_KEYWORDS = new Set([
  "auto", "bool", "break", "case", "catch", "char", "class", "const",
  "constexpr", "continue", "default", "delete", "do", "double", "else", "enum",
  "explicit", "export", "extern", "false", "float", "for", "friend", "if",
  "inline", "int", "long", "namespace", "new", "noexcept", "nullptr", "operator",
  "private", "protected", "public", "return", "short", "signed", "sizeof",
  "static", "struct", "switch", "template", "this", "throw", "true", "try",
  "typedef", "typename", "union", "unsigned", "using", "virtual", "void",
  "volatile", "while"
]);

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "default", "do", "double", "else", "enum",
  "extends", "false", "final", "finally", "float", "for", "if", "implements",
  "import", "instanceof", "int", "interface", "long", "native", "new", "null",
  "package", "private", "protected", "public", "return", "short", "static",
  "super", "switch", "synchronized", "this", "throw", "throws", "true", "try",
  "void", "volatile", "while"
]);

export function normalizeLanguage(profileId: string): "python" | "javascript" | "cpp" | "java" {
  const norm = profileId.toLowerCase();
  if (norm.includes("python") || norm.endsWith(".py")) return "python";
  if (norm.includes("cpp") || norm.includes("c++") || norm.endsWith(".cpp")) return "cpp";
  if (norm.includes("java") || norm.endsWith(".java")) return "java";
  return "javascript";
}

/**
 * Tokenizes source code into an array of styled tokens.
 * Pure tokenizer; never produces HTML strings.
 */
export function tokenizeCode(code: string, profileId: string): readonly CodeToken[] {
  if (!code) return [];

  const lang = normalizeLanguage(profileId);
  const keywords =
    lang === "python"
      ? PYTHON_KEYWORDS
      : lang === "cpp"
        ? CPP_KEYWORDS
        : lang === "java"
          ? JAVA_KEYWORDS
          : JS_KEYWORDS;

  // Single regex combining tokens for fast O(N) linear scanning
  // Order matters: comments first, strings second, numbers third, words/identifiers fourth, punctuation last
  let regex: RegExp;
  if (lang === "python") {
    regex = /(#.*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[a-zA-Z_]\w*\b)|([{}()\[\];,.:+\-*/%&|^!=<>?~])/g;
  } else if (lang === "cpp") {
    regex = /(\/\/.*|\/\*[\s\S]*?\*\/|#(?:include|define|ifdef|ifndef|endif)\b[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[a-zA-Z_]\w*\b)|([{}()\[\];,.:+\-*/%&|^!=<>?~])/g;
  } else {
    // javascript or java
    regex = /(\/\/.*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[a-zA-Z_]\w*\b)|([{}()\[\];,.:+\-*/%&|^!=<>?~])/g;
  }

  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      tokens.push({
        type: "text",
        content: code.slice(lastIndex, matchIndex),
      });
    }

    const [full, comment, str, num, word, punct] = match;

    if (comment !== undefined) {
      tokens.push({ type: "comment", content: full });
    } else if (str !== undefined) {
      tokens.push({ type: "string", content: full });
    } else if (num !== undefined) {
      tokens.push({ type: "number", content: full });
    } else if (word !== undefined) {
      if (keywords.has(word)) {
        tokens.push({ type: "keyword", content: full });
      } else {
        tokens.push({ type: "text", content: full });
      }
    } else if (punct !== undefined) {
      tokens.push({ type: "punctuation", content: full });
    } else {
      tokens.push({ type: "text", content: full });
    }

    lastIndex = matchIndex + full.length;
  }

  if (lastIndex < code.length) {
    tokens.push({
      type: "text",
      content: code.slice(lastIndex),
    });
  }

  return tokens;
}
