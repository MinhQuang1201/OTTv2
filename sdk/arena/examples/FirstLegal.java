/**
 * Reference First-Legal Java 21 Bot for Arena AI protocol v1.
 * Demonstrates minimal compliant Java bot.
 * Reads turn NDJSON from stdin, selects first legal move, writes NDJSON response to stdout.
 * Diagnostic logs are directed strictly to stderr.
 */

import java.io.BufferedReader;
import java.io.InputStreamReader;

public class FirstLegal {
    private static final int PROTOCOL_VERSION = 1;

    private static String extractString(String json, String key) {
        String needle = "\"" + key + "\"";
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
        String needle = "\"" + key + "\"";
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
        int lmPos = json.indexOf("\"legalMoves\"");
        if (lmPos == -1) return null;
        int bracketPos = json.indexOf('[', lmPos);
        if (bracketPos == -1) return null;
        int objStart = json.indexOf('{', bracketPos);
        if (objStart == -1) return null;

        int fromPos = json.indexOf("\"from\"", objStart);
        int toPos = json.indexOf("\"to\"", objStart);
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

                if (!line.contains("\"type\":\"turn\"") && !line.contains("\"type\": \"turn\"")) {
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
                    "{\"protocolVersion\":%d,\"requestId\":\"%s\",\"move\":{\"from\":{\"x\":%d,\"y\":%d},\"to\":{\"x\":%d,\"y\":%d}},\"comment\":\"Java first-legal\"}",
                    PROTOCOL_VERSION, requestId, coords[0], coords[1], coords[2], coords[3]
                );

                System.out.println(response);
                System.out.flush();
            }
        } catch (Exception e) {
            System.err.println("Fatal error in FirstLegal bot: " + e.getMessage());
            System.exit(1);
        }
    }
}
