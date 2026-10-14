/**
 * Arena Bot Templates and Profile Metadata for Arena Protocol v1.
 *
 * Scoped to available execution profiles in Arena AI workbench:
 * - controlled-node: Node.js (ECMAScript Modules)
 * - python-v1: Python 3
 *
 * Protocol: Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
 * Diagnostics: Write strictly to stderr.
 */

export interface ProfileInfo {
  readonly id: string;
  readonly displayName: string;
  readonly language: string;
  readonly fileExtensions: readonly string[];
  readonly description: string;
  readonly protocolHint: string;
  readonly template: string;
}

export const NODE_TEMPLATE = `/**
 * Arena AI Protocol v1 - Node.js Starter Bot (ESM)
 * Protocol: Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
 * Diagnostics: Write strictly to stderr.
 */
import readline from "node:readline";

const PROTOCOL_VERSION = 1;

function log(...args) {
  process.stderr.write(args.join(" ") + "\\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let turn;
  try {
    turn = JSON.parse(trimmed);
  } catch (err) {
    log("Failed to parse turn JSON:", err.message);
    return;
  }

  if (turn.protocolVersion !== PROTOCOL_VERSION || turn.type !== "turn") {
    return;
  }

  const { requestId, legalMoves } = turn;
  if (!requestId || !Array.isArray(legalMoves) || legalMoves.length === 0) {
    log("Missing requestId or empty legalMoves in turn payload");
    return;
  }

  // Strategy: Select the first legal move provided by referee
  const chosenMove = legalMoves[0];
  const response = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    move: {
      from: { x: Number(chosenMove.from.x), y: Number(chosenMove.from.y) },
      to: { x: Number(chosenMove.to.x), y: Number(chosenMove.to.y) }
    },
    comment: \`Node bot ply \${turn.ply ?? 0}\`
  };

  process.stdout.write(JSON.stringify(response) + "\\n");
});
`;

export const PYTHON_TEMPLATE = `"""Arena AI Protocol v1 - Python Starter Bot

Protocol: Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
Diagnostics: Write strictly to stderr.
"""
import sys
import json

PROTOCOL_VERSION = 1


def log(*args):
    sys.stderr.write(" ".join(str(a) for a in args) + "\\n")
    sys.stderr.flush()


def main():
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            turn = json.loads(line)
        except Exception as err:
            log("Failed to parse turn JSON:", err)
            continue

        if turn.get("protocolVersion") != PROTOCOL_VERSION or turn.get("type") != "turn":
            continue

        request_id = turn.get("requestId")
        legal_moves = turn.get("legalMoves")
        if not request_id or not legal_moves:
            log("Missing requestId or empty legalMoves in turn payload")
            continue

        # Strategy: Select the first legal move provided by referee
        chosen = legal_moves[0]
        response = {
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "move": {
                "from": {"x": int(chosen["from"]["x"]), "y": int(chosen["from"]["y"])},
                "to": {"x": int(chosen["to"]["x"]), "y": int(chosen["to"]["y"])}
            },
            "comment": f"Python bot ply {turn.get('ply', 0)}"
        }

        sys.stdout.write(json.dumps(response) + "\\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
`;

export const CPP_TEMPLATE = `// Arena AI Protocol v1 - C++ Starter Bot
// Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
#include <iostream>
#include <string>

int main() {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        // Parse turn NDJSON and output: {"protocolVersion":1,"requestId":...,"move":...}
    }
    return 0;
}
`;

export const JAVA_TEMPLATE = `// Arena AI Protocol v1 - Java 21 Starter Bot
// Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
import java.io.BufferedReader;
import java.io.InputStreamReader;

public class FirstLegal {
    public static void main(String[] args) {
        // Reads turn NDJSON from System.in and outputs move to System.out
    }
}
`;

export function normalizeProfileId(profileId: string): string {
  const norm = (profileId || "").toLowerCase().trim();
  if (norm === "controlled-node" || norm === "node" || norm === "javascript" || norm === "js") {
    return "node";
  }
  if (norm === "python-v1" || norm === "python" || norm === "py") {
    return "python";
  }
  if (norm === "cpp" || norm === "c++") {
    return "cpp";
  }
  if (norm === "java") {
    return "java";
  }
  return norm;
}

export const PROFILE_DEFINITIONS: Record<string, ProfileInfo> = {
  node: {
    id: "node",
    displayName: "Node.js (ESM)",
    language: "javascript",
    fileExtensions: [".mjs", ".js", ".txt"],
    description: "Môi trường thực thi JavaScript / Node.js (ECMAScript Modules).",
    protocolHint: "Đọc thông điệp turn NDJSON từ stdin, ghi nước đi hợp lệ ra stdout theo Arena Protocol v1. Đưa nhật ký chẩn đoán vào stderr.",
    template: NODE_TEMPLATE,
  },
  python: {
    id: "python",
    displayName: "Python 3",
    language: "python",
    fileExtensions: [".py", ".txt"],
    description: "Môi trường thực thi Python 3.",
    protocolHint: "Đọc turn JSON từ stdin, ghi response chứa requestId và move ra stdout. Nhật ký chẩn đoán ghi vào sys.stderr.",
    template: PYTHON_TEMPLATE,
  },
  cpp: {
    id: "cpp",
    displayName: "C++17 · chỉ nhập tệp",
    language: "cpp",
    fileExtensions: [".cpp", ".cc", ".cxx", ".txt"],
    description: "Biên dịch và thực thi C++ tiêu chuẩn C++17 (nhập từ tệp, không kèm mã mẫu).",
    protocolHint: "Đọc dòng NDJSON qua std::cin, xuất phản hồi ra std::cout và flush. Ghi log ra std::cerr.",
    template: CPP_TEMPLATE,
  },
  java: {
    id: "java",
    displayName: "Java 21 · chỉ nhập tệp",
    language: "java",
    fileExtensions: [".java", ".txt"],
    description: "Biên dịch và thực thi Java 21 (lớp chính FirstLegal, nhập từ tệp, không kèm mã mẫu).",
    protocolHint: "Đọc luồng System.in, in phản hồi JSON một dòng ra System.out. Ghi log qua System.err.",
    template: JAVA_TEMPLATE,
  },
};

// Aliases for legacy compatibility
PROFILE_DEFINITIONS["controlled-node"] = PROFILE_DEFINITIONS.node;
PROFILE_DEFINITIONS["python-v1"] = PROFILE_DEFINITIONS.python;

export function getProfileInfo(profileId: string): ProfileInfo {
  const normalized = normalizeProfileId(profileId);
  return (
    PROFILE_DEFINITIONS[normalized] || {
      id: normalized || profileId,
      displayName: profileId,
      language: "text",
      fileExtensions: [".txt", ".mjs", ".py"],
      description: `Môi trường ${profileId}.`,
      protocolHint: "Giao thức Arena Protocol v1 (STDIO NDJSON). Xuất kết quả ra stdout, ghi log vào stderr.",
      template: NODE_TEMPLATE,
    }
  );
}

export function getTemplateForProfile(profileId: string): string {
  return getProfileInfo(profileId).template;
}
