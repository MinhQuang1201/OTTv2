import type { ArtifactPort } from "../../../arena/src/ports/index.d.mts";

export interface ArtifactStoreOptions {
  storageDir?: string;
}

export interface StoredArtifact {
  digest: string;
  path: string;
  bytes: number;
}

export interface ResolvedArtifact extends StoredArtifact {
  manifest?: Record<string, unknown> | null;
}

export interface ArtifactStore extends ArtifactPort {
  readonly storageDir: string;
  computeDigest(content: string | Uint8Array): string;
  verifyDigest(digest: string, content: string | Uint8Array): boolean;
  storeArtifact(
    kind: "source" | "build",
    content: string | Uint8Array,
    options?: { manifest?: Record<string, unknown> }
  ): Promise<StoredArtifact>;
  resolveArtifact(digest: string): Promise<ResolvedArtifact | null>;
  getManifest(digest: string): Promise<Record<string, unknown> | null>;
}

export declare function computeSha256(content: string | Uint8Array): string;

export declare function createArtifactStore(options?: ArtifactStoreOptions): ArtifactStore;
