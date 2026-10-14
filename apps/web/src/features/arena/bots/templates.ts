/**
 * Arena Bot Templates and Profile Metadata for Arena Protocol v1.
 *
 * Each template implements compliant STDIO NDJSON bot communication:
 * - Reads single-line JSON turn messages from standard input (stdin).
 * - Selects a valid move from turn.legalMoves.
 * - Writes single-line JSON response containing protocolVersion, requestId, and move to standard output (stdout).
 * - Diagnostic logs are directed strictly to standard error (stderr).
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

export const CPP_TEMPLATE = `/**
 * Arena AI Protocol v1 - C++17 Starter Bot
 * Protocol: Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
 * Diagnostics: Write strictly to stderr.
 */
#include <iostream>
#include <string>
#include <cctype>

namespace {

constexpr int PROTOCOL_VERSION = 1;

std::string extractString(const std::string& json, const std::string& key) {
    std::string needle = "\\"" + key + "\\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos);
    if (pos == std::string::npos) return "";
    auto endPos = json.find('"', pos + 1);
    if (endPos == std::string::npos) return "";
    return json.substr(pos + 1, endPos - pos - 1);
}

bool extractIntAfter(const std::string& json, const std::string& key, size_t start, int& out, size_t& nextPos) {
    std::string needle = "\\"" + key + "\\"";
    auto pos = json.find(needle, start);
    if (pos == std::string::npos) return false;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    while (pos < json.size() && (json[pos] == ':' || std::isspace(static_cast<unsigned char>(json[pos])))) {
        pos++;
    }
    if (pos >= json.size()) return false;
    size_t endNum = pos;
    if (json[endNum] == '-' || json[endNum] == '+') endNum++;
    while (endNum < json.size() && std::isdigit(static_cast<unsigned char>(json[endNum]))) {
        endNum++;
    }
    if (endNum == pos) return false;
    try {
        out = std::stoi(json.substr(pos, endNum - pos));
    } catch (...) {
        return false;
    }
    nextPos = endNum;
    return true;
}

bool parseFirstMove(const std::string& json, int& fx, int& fy, int& tx, int& ty) {
    auto lmPos = json.find("\\"legalMoves\\"");
    if (lmPos == std::string::npos) return false;
    auto bracketPos = json.find('[', lmPos);
    if (bracketPos == std::string::npos) return false;
    auto objStart = json.find('{', bracketPos);
    if (objStart == std::string::npos) return false;

    auto fromPos = json.find("\\"from\\"", objStart);
    if (fromPos == std::string::npos) return false;
    auto toPos = json.find("\\"to\\"", objStart);
    if (toPos == std::string::npos) return false;

    size_t next = fromPos;
    if (!extractIntAfter(json, "x", next, fx, next)) return false;
    if (!extractIntAfter(json, "y", next, fy, next)) return false;

    next = toPos;
    if (!extractIntAfter(json, "x", next, tx, next)) return false;
    if (!extractIntAfter(json, "y", next, ty, next)) return false;

    return true;
}

} // namespace

int main() {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        if (line.find("\\"type\\":\\"turn\\"") == std::string::npos &&
            line.find("\\"type\\": \\"turn\\"") == std::string::npos) {
            continue;
        }

        std::string requestId = extractString(line, "requestId");
        if (requestId.empty()) {
            std::cerr << "Missing requestId in turn payload\\n";
            continue;
        }

        int fx = 0, fy = 0, tx = 0, ty = 0;
        if (!parseFirstMove(line, fx, fy, tx, ty)) {
            std::cerr << "No legal moves parsed\\n";
            continue;
        }

        std::cout << "{\\"protocolVersion\\":" << PROTOCOL_VERSION
                  << ",\\"requestId\\":\\"" << requestId
                  << "\\",\\"move\\":{\\"from\\":{\\"x\\":" << fx << ",\\"y\\":" << fy
                  << "},\\"to\\":{\\"x\\":" << tx << ",\\"y\\":" << ty
                  << "}},\\"comment\\":\\"C++ bot\\"}\\n" << std::flush;
    }
    return 0;
}
`;

export const JAVA_TEMPLATE = `/**
 * Arena AI Protocol v1 - Java 21 Starter Bot
 * Protocol: Reads turn NDJSON from stdin, outputs chosen move NDJSON to stdout.
 * Diagnostics: Write strictly to stderr.
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;

public class FirstLegal {
    private static final int PROTOCOL_VERSION = 1;

    private static String extractString(String json, String key) {
        String needle = "\\"" + key + "\\"";
        int pos = json.indexOf(needle);
        if (pos == -1) return null;
        pos = json.indexOf(':', pos + needle.length());
        if (pos == -1) return null;
        pos = json.indexOf('"', pos);
        if (pos == -1) return null;
        int endPos = json.indexOf('"', pos + 1);
        if (endPos == -1) return null;
        return json.substring(pos + 1, endPos);
    }

    private static int extractIntAfter(String json, String key, int startPos) {
        String needle = "\\"" + key + "\\"";
        int pos = json.indexOf(needle, startPos);
        if (pos == -1) return -1;
        pos = json.indexOf(':', pos + needle.length());
        if (pos == -1) return -1;
        while (pos < json.length() && (json.charAt(pos) == ':' || Character.isWhitespace(json.charAt(pos)))) {
            pos++;
        }
        int end = pos;
        if (end < json.length() && (json.charAt(end) == '-' || json.charAt(end) == '+')) {
            end++;
        }
        while (end < json.length() && Character.isDigit(json.charAt(end))) {
            end++;
        }
        return Integer.parseInt(json.substring(pos, end));
    }

    private static int[] parseFirstMove(String json) {
        int lmPos = json.indexOf("\\"legalMoves\\"");
        if (lmPos == -1) return null;
        int bracketPos = json.indexOf('[', lmPos);
        if (bracketPos == -1) return null;
        int objStart = json.indexOf('{', bracketPos);
        if (objStart == -1) return null;

        int fromPos = json.indexOf("\\"from\\"", objStart);
        int toPos = json.indexOf("\\"to\\"", objStart);
        if (fromPos == -1 || toPos == -1) return null;

        int fx = extractIntAfter(json, "x", fromPos);
        int fy = extractIntAfter(json, "y", fromPos);
        int tx = extractIntAfter(json, "x", toPos);
        int ty = extractIntAfter(json, "y", toPos);

        return new int[]{fx, fy, tx, ty};
    }

    public static void main(String[] args) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;

                if (!line.contains("\\"type\\":\\"turn\\"") && !line.contains("\\"type\\": \\"turn\\"")) {
                    continue;
                }

                String requestId = extractString(line, "requestId");
                if (requestId == null || requestId.isEmpty()) {
                    System.err.println("Missing requestId in turn payload");
                    continue;
                }

                int[] coords = parseFirstMove(line);
                if (coords == null) {
                    System.err.println("No legal moves found in turn payload");
                    System.exit(1);
                }

                String response = String.format(
                    "{\\"protocolVersion\\":%d,\\"requestId\\":\\"%s\\",\\"move\\":{\\"from\\":{\\"x\\":%d,\\"y\\":%d},\\"to\\":{\\"x\\":%d,\\"y\\":%d}},\\"comment\\":\\"Java bot\\"}",
                    PROTOCOL_VERSION, requestId, coords[0], coords[1], coords[2], coords[3]
                );

                System.out.println(response);
                System.out.flush();
            }
        } catch (Exception e) {
            System.err.println("Fatal error in Java bot: " + e.getMessage());
            System.exit(1);
        }
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
    displayName: "C++17",
    language: "cpp",
    fileExtensions: [".cpp", ".cc", ".cxx", ".txt"],
    description: "Biên dịch và thực thi C++ tiêu chuẩn C++17.",
    protocolHint: "Đọc dòng NDJSON qua std::cin, phân tích requestId và legalMoves, xuất phản hồi ra std::cout và flush. Ghi log ra std::cerr.",
    template: CPP_TEMPLATE,
  },
  java: {
    id: "java",
    displayName: "Java 21",
    language: "java",
    fileExtensions: [".java", ".txt"],
    description: "Biên dịch và thực thi Java 21 (lớp chính FirstLegal).",
    protocolHint: "Đọc luồng System.in, trích xuất requestId và legalMoves, in phản hồi JSON một dòng ra System.out. Ghi log qua System.err.",
    template: JAVA_TEMPLATE,
  },
};

export function getProfileInfo(profileId: string): ProfileInfo {
  const normalized = normalizeProfileId(profileId);
  return (
    PROFILE_DEFINITIONS[normalized] || {
      id: profileId,
      displayName: profileId,
      language: "text",
      fileExtensions: [".txt", ".mjs", ".py", ".cpp", ".java"],
      description: `Môi trường ${profileId}.`,
      protocolHint: "Giao thức Arena Protocol v1 (STDIO NDJSON). Xuất kết quả ra stdout, ghi log vào stderr.",
      template: NODE_TEMPLATE,
    }
  );
}

export function getTemplateForProfile(profileId: string): string {
  return getProfileInfo(profileId).template;
}
