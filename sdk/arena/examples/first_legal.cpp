/**
 * Reference First-Legal C++17 Bot for Arena AI protocol v1.
 * Demonstrates minimal compliant C++ bot.
 * Reads turn NDJSON from stdin, selects first legal move, writes NDJSON response to stdout.
 * Diagnostic logs are directed strictly to stderr.
 */

#include <iostream>
#include <string>
#include <cctype>

namespace {

constexpr int PROTOCOL_VERSION = 1;

std::string extractString(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
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
    std::string needle = "\"" + key + "\"";
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
    auto lmPos = json.find("\"legalMoves\"");
    if (lmPos == std::string::npos) return false;
    auto bracketPos = json.find('[', lmPos);
    if (bracketPos == std::string::npos) return false;
    auto objStart = json.find('{', bracketPos);
    if (objStart == std::string::npos) return false;

    auto fromPos = json.find("\"from\"", objStart);
    if (fromPos == std::string::npos) return false;
    auto toPos = json.find("\"to\"", objStart);
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

        if (line.find("\"type\":\"turn\"") == std::string::npos &&
            line.find("\"type\": \"turn\"") == std::string::npos) {
            continue;
        }

        std::string requestId = extractString(line, "requestId");
        if (requestId.empty()) {
            std::cerr << "Missing requestId in turn payload\n";
            continue;
        }

        int fx = 0, fy = 0, tx = 0, ty = 0;
        if (!parseFirstMove(line, fx, fy, tx, ty)) {
            std::cerr << "No legal moves found in turn payload\n";
            return 1;
        }

        std::cout << "{\"protocolVersion\":" << PROTOCOL_VERSION
                  << ",\"requestId\":\"" << requestId << "\""
                  << ",\"move\":{\"from\":{\"x\":" << fx << ",\"y\":" << fy << "}"
                  << ",\"to\":{\"x\":" << tx << ",\"y\":" << ty << "}}"
                  << ",\"comment\":\"C++ first-legal\"}\n"
                  << std::flush;
    }

    return 0;
}
