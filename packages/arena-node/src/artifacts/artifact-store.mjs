/**
 * Content-addressed ArtifactStore for Arena AI protocol v1.
 * Implements ArtifactPort with SHA-256 digest addressing, atomic publish,
 * tamper detection (integrity verification before resolving), and manifest storage.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Computes canonical SHA-256 digest formatted as 'sha256:<hex>'.
 * @param {string | Buffer | Uint8Array} content
 * @returns {string}
 */
export function computeSha256(content) {
  const hash = crypto.createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    hash.update(content);
  } else {
    throw new TypeError("Content must be a string, Buffer, or Uint8Array");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Creates an ArtifactStore instance conforming to ArtifactPort.
 * @param {object} [options]
 * @param {string} [options.storageDir] - Base artifact storage directory
 * @returns {import("../../../arena/src/ports/index.d.mts").ArtifactPort & { storageDir: string, computeDigest: (c: any) => string, getManifest: (d: string) => Promise<any> }}
 */
export function createArtifactStore(options = {}) {
  const rawDir = options.storageDir || options.baseDir;
  const storageDir = rawDir
    ? path.resolve(rawDir)
    : path.resolve(process.cwd(), "var/arena/artifacts");

  const sourcesDir = path.join(storageDir, "sources");
  const buildsDir = path.join(storageDir, "builds");

  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.mkdirSync(buildsDir, { recursive: true });

  function getKindDir(kind) {
    return kind === "build" ? buildsDir : sourcesDir;
  }

  function getArtifactPath(kind, digest) {
    const rawHash = digest.startsWith("sha256:") ? digest.slice(7) : digest;
    const prefix = rawHash.slice(0, 2);
    const rest = rawHash.slice(2);
    return path.join(getKindDir(kind), prefix, rest);
  }

  return {
    get storageDir() {
      return storageDir;
    },

    computeDigest(content) {
      return computeSha256(content);
    },

    verifyDigest(digest, content) {
      if (typeof digest !== "string" || !digest.startsWith("sha256:")) {
        return false;
      }
      return computeSha256(content) === digest;
    },

    async storeArtifact(kind, content, storeOptions = {}) {
      if (kind !== "source" && kind !== "build") {
        throw new TypeError(`Artifact kind must be 'source' or 'build', got '${kind}'`);
      }

      const buf = Buffer.isBuffer(content)
        ? content
        : (content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(String(content), "utf8"));

      const digest = computeSha256(buf);
      const targetDir = path.dirname(getArtifactPath(kind, digest));
      const targetPath = getArtifactPath(kind, digest);
      const manifestPath = `${targetPath}.manifest.json`;

      fs.mkdirSync(targetDir, { recursive: true });

      // If artifact already exists, verify its integrity
      if (fs.existsSync(targetPath)) {
        const existing = fs.readFileSync(targetPath);
        if (computeSha256(existing) === digest) {
          if (storeOptions.manifest) {
            fs.writeFileSync(manifestPath, JSON.stringify(storeOptions.manifest, null, 2), "utf8");
          }
          return { digest, path: targetPath, bytes: buf.length };
        }
      }

      // Atomic publish: write to temporary file, verify digest, then rename
      const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        fs.writeFileSync(tempPath, buf);

        // Verify digest before publishing
        const verifyBuf = fs.readFileSync(tempPath);
        if (computeSha256(verifyBuf) !== digest) {
          throw new Error("Internal digest mismatch during atomic write");
        }

        fs.renameSync(tempPath, targetPath);

        if (storeOptions.manifest) {
          fs.writeFileSync(manifestPath, JSON.stringify(storeOptions.manifest, null, 2), "utf8");
        }

        return { digest, path: targetPath, bytes: buf.length };
      } finally {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (_) {}
      }
    },

    async resolveArtifact(digest) {
      if (typeof digest !== "string" || !digest.startsWith("sha256:")) {
        return null;
      }

      // Search in builds first, then sources
      let filePath = getArtifactPath("build", digest);
      if (!fs.existsSync(filePath)) {
        filePath = getArtifactPath("source", digest);
      }
      if (!fs.existsSync(filePath)) {
        return null;
      }

      // Integrity verification before returning
      const fileContent = fs.readFileSync(filePath);
      const computed = computeSha256(fileContent);
      if (computed !== digest) {
        const err = new Error(`Artifact integrity check failed for digest ${digest}: content on disk has digest ${computed}`);
        err.kind = "infrastructure_error";
        err.code = "tamper_detected";
        err.retryable = false;
        throw err;
      }

      let manifest = null;
      const manifestPath = `${filePath}.manifest.json`;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (_) {}
      }

      return {
        digest,
        path: filePath,
        bytes: fileContent.length,
        manifest
      };
    },

    async getManifest(digest) {
      const resolved = await this.resolveArtifact(digest);
      return resolved?.manifest || null;
    }
  };
}
