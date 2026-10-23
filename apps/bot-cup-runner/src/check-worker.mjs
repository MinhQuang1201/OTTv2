/**
 * Syntax check of one submission in the container (py_compile / node --check), in a child process: the build service
 * waits on `docker run` synchronously, and doing that in the runner's own process would freeze the clocks of the games
 * running next to it. Reads {profileId, sourceBase64, image, expectedImageId} on stdin, writes {status, logs, error}.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createArtifactStore } from "../../../packages/arena-node/src/artifacts/artifact-store.mjs";
import { createContainerBuildService, probeContainerRuntime } from "../../../packages/arena-node/src/execution/container-executor.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cup-check-"));
try {
  const probe = probeContainerRuntime({ image: request.image, expectedImageId: request.expectedImageId });
  const service = createContainerBuildService({ artifactStore: createArtifactStore({ storageDir }), image: request.image, probe: () => probe });
  const result = await service.build({ sourceContent: Buffer.from(request.sourceBase64, "base64"), profileId: request.profileId });
  process.stdout.write(JSON.stringify({ status: result.status, logs: result.logs, error: result.error ?? null }));
} finally {
  fs.rmSync(storageDir, { recursive: true, force: true });
}
