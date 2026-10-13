/**
 * Execution Profile Registry for Arena AI protocol v1.
 * Manages language execution profiles (Python, Node, C++, Java, FunctionBot),
 * probes executable availability using fixed argument lists and timeouts (strictly shell=false),
 * provides build/validation compilation, and instantiates trusted BotPorts.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createProcessBot } from "./process-bot.mjs";
import { createFunctionBot } from "../../../arena/src/adapters/function-bot.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/**
 * Safely probes an executable with fixed arguments and a timeout.
 * Strictly shell=false.
 * @param {string} executable
 * @param {string[]} [args=["--version"]]
 * @param {number} [timeoutMs=2000]
 * @returns {{ ok: boolean, status: number | null, stdout: string, stderr: string, code?: string, error?: string, timedOut?: boolean }}
 */
export function probeExecutable(executable, args = ["--version"], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (typeof executable !== "string" || executable.trim().length === 0) {
    return { ok: false, status: null, stdout: "", stderr: "", code: "INVALID_EXECUTABLE", error: "Executable must be a non-empty string" };
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return { ok: false, status: null, stdout: "", stderr: "", code: "INVALID_ARGS", error: "Args must be an array of strings" };
  }

  try {
    const res = spawnSync(executable, args, {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      encoding: "utf8"
    });

    if (res.error) {
      const isTimeout = res.error.code === "ETIMEDOUT" || Boolean(res.error.timedOut);
      return {
        ok: false,
        status: res.status,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        code: res.error.code || (isTimeout ? "ETIMEDOUT" : "ERROR"),
        error: res.error.message,
        timedOut: isTimeout
      };
    }

    return {
      ok: res.status === 0,
      status: res.status,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      code: res.status === 0 ? undefined : "NON_ZERO_EXIT"
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      code: err.code || "SPAWN_FAILED",
      error: err.message
    };
  }
}

/**
 * Resolves candidate Python executable name or path according to environment and platform.
 */
export function resolvePythonExecutable(options = {}) {
  if (options.pythonExecutable && typeof options.pythonExecutable === "string") {
    return {
      executable: options.pythonExecutable,
      source: "explicit",
      candidates: [options.pythonExecutable]
    };
  }

  const envExe = process.env.OTT_ARENA_PYTHON;
  if (envExe && typeof envExe === "string" && envExe.trim().length > 0) {
    return {
      executable: envExe.trim(),
      source: "env",
      candidates: [envExe.trim()]
    };
  }

  const isWin = process.platform === "win32";
  const candidates = isWin ? ["python", "python3"] : ["python3", "python"];

  for (const cand of candidates) {
    const probe = probeExecutable(cand, ["--version"], 1500);
    if (probe.ok) {
      return {
        executable: cand,
        source: "platform_default",
        candidates
      };
    }
  }

  return {
    executable: candidates[0],
    source: "platform_default",
    candidates
  };
}

/**
 * Resolves candidate Node executable name or path.
 */
export function resolveNodeExecutable(options = {}) {
  if (options.nodeExecutable && typeof options.nodeExecutable === "string") {
    return {
      executable: options.nodeExecutable,
      source: "explicit",
      candidates: [options.nodeExecutable]
    };
  }

  const envExe = process.env.OTT_ARENA_NODE;
  if (envExe && typeof envExe === "string" && envExe.trim().length > 0) {
    return {
      executable: envExe.trim(),
      source: "env",
      candidates: [envExe.trim()]
    };
  }

  const candidates = [process.execPath, "node"];
  for (const cand of candidates) {
    const probe = probeExecutable(cand, ["--version"], 1500);
    if (probe.ok) {
      return {
        executable: cand,
        source: "platform_default",
        candidates
      };
    }
  }

  return {
    executable: candidates[0],
    source: "platform_default",
    candidates
  };
}

/**
 * Resolves candidate C++ compiler executable.
 */
export function resolveCppExecutable(options = {}) {
  if (options.cppExecutable && typeof options.cppExecutable === "string") {
    return {
      executable: options.cppExecutable,
      source: "explicit",
      candidates: [options.cppExecutable]
    };
  }

  const envExe = process.env.OTT_ARENA_CPP;
  if (envExe && typeof envExe === "string" && envExe.trim().length > 0) {
    return {
      executable: envExe.trim(),
      source: "env",
      candidates: [envExe.trim()]
    };
  }

  const isWin = process.platform === "win32";
  const candidates = isWin ? ["g++", "clang++"] : ["g++", "clang++", "c++"];

  for (const cand of candidates) {
    const probe = probeExecutable(cand, ["--version"], 1500);
    if (probe.ok) {
      return {
        executable: cand,
        source: "platform_default",
        candidates
      };
    }
  }

  return {
    executable: candidates[0],
    source: "platform_default",
    candidates
  };
}

/**
 * Parses major Java version from javac / java version string.
 * Supports patterns like "javac 23.0.1", "openjdk 21.0.2", "java version \"21.0.1\"".
 */
export function parseJavaMajorVersion(versionStr) {
  if (typeof versionStr !== "string") return null;
  const m = versionStr.match(/(?:javac|java|version|openjdk)?\s*"?(\d+)(?:\.(\d+))?/i);
  if (m && m[1]) {
    const major = parseInt(m[1], 10);
    if (major === 1 && m[2]) {
      return parseInt(m[2], 10);
    }
    return major;
  }
  return null;
}

/**
 * Resolves Java compiler, runtime, and archiver tools.
 */
export function resolveJavaExecutables(options = {}) {
  const javacExe = options.javacExecutable || process.env.OTT_ARENA_JAVAC || "javac";
  const javaExe = options.javaExecutable || process.env.OTT_ARENA_JAVA || "java";
  const jarExe = options.jarExecutable || process.env.OTT_ARENA_JAR || "jar";

  return {
    javac: javacExe,
    java: javaExe,
    jar: jarExe,
    candidates: {
      javac: [javacExe],
      java: [javaExe],
      jar: [jarExe]
    }
  };
}

/**
 * Creates an execution profile registry.
 * @param {object} [options]
 */
export function createProfileRegistry(options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const customPython = options.pythonExecutable;
  const customNode = options.nodeExecutable;
  const customCpp = options.cppExecutable;
  const customJavac = options.javacExecutable;
  const customJava = options.javaExecutable;
  const customJar = options.jarExecutable;

  const profiles = new Map();

  // 1. Python profile
  profiles.set("python", {
    id: "python",
    language: "python",
    revision: "python-trusted-v1",
    entryName: "bot.py",
    probe() {
      const resolution = resolvePythonExecutable({ pythonExecutable: customPython });
      for (const candidate of resolution.candidates) {
        const probeRes = probeExecutable(candidate, ["--version"], probeTimeoutMs);
        if (probeRes.ok) {
          const rawVer = (probeRes.stdout || probeRes.stderr || "").trim();
          return {
            available: true,
            executable: candidate,
            version: rawVer,
            revision: "python-trusted-v1"
          };
        }
      }
      return {
        available: false,
        executable: resolution.executable,
        version: null,
        error: "python_not_found"
      };
    },
    compile({ buildDir, sourceFilePath, timeoutMs = 15000, signal }) {
      const probeInfo = this.probe();
      if (!probeInfo.available) {
        return {
          status: 1,
          stdout: "",
          stderr: `Python runtime is not available: ${probeInfo.error}\n`,
          error: "runtime_unavailable"
        };
      }
      const res = spawnSync(probeInfo.executable, ["-m", "py_compile", sourceFilePath], {
        shell: false,
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        cwd: buildDir
      });
      if (res.error) {
        const isTimeout = res.error.code === "ETIMEDOUT" || Boolean(res.error.timedOut);
        return {
          status: 1,
          stdout: "",
          stderr: res.error.message,
          timedOut: isTimeout,
          aborted: signal?.aborted
        };
      }
      return {
        status: res.status ?? 1,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        entrypoint: path.basename(sourceFilePath)
      };
    },
    createBot(sourcePath, botOptions = {}) {
      if (!fs.existsSync(sourcePath)) {
        const err = new Error(`Bot source file does not exist: ${sourcePath}`);
        err.kind = "infrastructure_error";
        err.code = "missing_bot_source";
        err.retryable = false;
        throw err;
      }

      const probeInfo = this.probe();
      if (!probeInfo.available) {
        const err = new Error(`Python runtime is not available (probed '${probeInfo.executable}')`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      const resolvedPath = path.resolve(sourcePath);
      const cwd = botOptions.cwd || path.dirname(resolvedPath);

      return createProcessBot({
        botId: botOptions.botId || `python-${path.basename(sourcePath, ".py")}`,
        executable: probeInfo.executable,
        args: ["-u", resolvedPath],
        cwd,
        env: botOptions.env,
        clock: botOptions.clock,
        graceMs: botOptions.graceMs,
        maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
        maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
        maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
        onStderr: botOptions.onStderr
      });
    }
  });

  // 2. Node profile
  profiles.set("node", {
    id: "node",
    language: "javascript",
    revision: "node-trusted-v1",
    entryName: "bot.mjs",
    probe() {
      const resolution = resolveNodeExecutable({ nodeExecutable: customNode });
      for (const candidate of resolution.candidates) {
        const probeRes = probeExecutable(candidate, ["--version"], probeTimeoutMs);
        if (probeRes.ok) {
          const rawVer = (probeRes.stdout || probeRes.stderr || "").trim();
          return {
            available: true,
            executable: candidate,
            version: rawVer,
            revision: "node-trusted-v1"
          };
        }
      }
      return {
        available: false,
        executable: resolution.executable,
        version: null,
        error: "node_not_found"
      };
    },
    compile({ buildDir, sourceFilePath, timeoutMs = 15000, signal }) {
      const probeInfo = this.probe();
      if (!probeInfo.available) {
        return {
          status: 1,
          stdout: "",
          stderr: `Node runtime is not available: ${probeInfo.error}\n`,
          error: "runtime_unavailable"
        };
      }
      const res = spawnSync(probeInfo.executable, ["--check", sourceFilePath], {
        shell: false,
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        cwd: buildDir
      });
      if (res.error) {
        const isTimeout = res.error.code === "ETIMEDOUT" || Boolean(res.error.timedOut);
        return {
          status: 1,
          stdout: "",
          stderr: res.error.message,
          timedOut: isTimeout,
          aborted: signal?.aborted
        };
      }
      return {
        status: res.status ?? 1,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        entrypoint: path.basename(sourceFilePath)
      };
    },
    createBot(sourcePath, botOptions = {}) {
      if (!fs.existsSync(sourcePath)) {
        const err = new Error(`Bot source file does not exist: ${sourcePath}`);
        err.kind = "infrastructure_error";
        err.code = "missing_bot_source";
        err.retryable = false;
        throw err;
      }

      const probeInfo = this.probe();
      if (!probeInfo.available) {
        const err = new Error(`Node runtime is not available (probed '${probeInfo.executable}')`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      const resolvedPath = path.resolve(sourcePath);
      const cwd = botOptions.cwd || path.dirname(resolvedPath);

      return createProcessBot({
        botId: botOptions.botId || `node-${path.basename(sourcePath, path.extname(sourcePath))}`,
        executable: probeInfo.executable,
        args: [resolvedPath],
        cwd,
        env: botOptions.env,
        clock: botOptions.clock,
        graceMs: botOptions.graceMs,
        maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
        maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
        maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
        onStderr: botOptions.onStderr
      });
    }
  });

  // 3. C++ profile (C++17)
  profiles.set("cpp", {
    id: "cpp",
    language: "cpp",
    revision: "cpp17-trusted-v1",
    entryName: "bot.cpp",
    probe() {
      const resolution = resolveCppExecutable({ cppExecutable: customCpp });
      for (const candidate of resolution.candidates) {
        const probeRes = probeExecutable(candidate, ["--version"], probeTimeoutMs);
        if (probeRes.ok) {
          const rawVer = (probeRes.stdout || probeRes.stderr || "").trim().split("\n")[0];
          return {
            available: true,
            executable: candidate,
            version: rawVer,
            revision: "cpp17-trusted-v1"
          };
        }
      }
      return {
        available: false,
        executable: resolution.executable,
        version: null,
        error: "cpp_compiler_not_found"
      };
    },
    compile({ buildDir, sourceFilePath, compilerOptions = [], timeoutMs = 30000, signal }) {
      const probeInfo = this.probe();
      if (!probeInfo.available) {
        return {
          status: 1,
          stdout: "",
          stderr: `C++ compiler is not available: ${probeInfo.error}\n`,
          error: "runtime_unavailable"
        };
      }
      const isWin = process.platform === "win32";
      const outBinaryName = isWin ? "bot.exe" : "bot";
      const outBinaryPath = path.join(buildDir, outBinaryName);

      const defaultOpts = ["-O2", "-std=c++17", "-Wall"];
      const finalOpts = Array.isArray(compilerOptions) && compilerOptions.length > 0 ? compilerOptions : defaultOpts;

      const args = [...finalOpts, sourceFilePath, "-o", outBinaryPath];
      const res = spawnSync(probeInfo.executable, args, {
        shell: false,
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        cwd: buildDir
      });

      if (res.error) {
        const isTimeout = res.error.code === "ETIMEDOUT" || Boolean(res.error.timedOut);
        return {
          status: 1,
          stdout: "",
          stderr: res.error.message,
          timedOut: isTimeout,
          aborted: signal?.aborted
        };
      }

      if (res.status === 0 && !fs.existsSync(outBinaryPath)) {
        return {
          status: 1,
          stdout: res.stdout || "",
          stderr: (res.stderr || "") + "\nBinary was not created by compiler\n",
          error: "compile_failure"
        };
      }

      return {
        status: res.status ?? 1,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        entrypoint: outBinaryName
      };
    },
    createBot(sourcePath, botOptions = {}) {
      if (!fs.existsSync(sourcePath)) {
        const err = new Error(`Bot executable does not exist: ${sourcePath}`);
        err.kind = "infrastructure_error";
        err.code = "missing_bot_source";
        err.retryable = false;
        throw err;
      }

      const probeInfo = this.probe();
      if (!probeInfo.available) {
        const err = new Error(`C++ toolchain is not available (probed '${probeInfo.executable}')`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      const resolvedPath = path.resolve(sourcePath);
      const cwd = botOptions.cwd || path.dirname(resolvedPath);

      if (resolvedPath.endsWith(".cpp")) {
        const exeName = process.platform === "win32"
          ? resolvedPath.replace(/\.cpp$/i, ".exe")
          : resolvedPath.replace(/\.cpp$/i, "");
        if (fs.existsSync(exeName)) {
          return createProcessBot({
            botId: botOptions.botId || `cpp-${path.basename(exeName)}`,
            executable: exeName,
            args: [],
            cwd,
            env: botOptions.env,
            clock: botOptions.clock,
            graceMs: botOptions.graceMs,
            maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
            maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
            maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
            onStderr: botOptions.onStderr
          });
        }
        const err = new Error(`C++ source file '${sourcePath}' has not been compiled into an executable`);
        err.kind = "infrastructure_error";
        err.code = "uncompiled_source";
        err.retryable = false;
        throw err;
      }

      let execPath = resolvedPath;
      if (process.platform === "win32" && !execPath.toLowerCase().endsWith(".exe")) {
        const exePath = `${execPath}.exe`;
        if (!fs.existsSync(exePath)) {
          try {
            fs.linkSync(execPath, exePath);
          } catch (_) {
            fs.copyFileSync(execPath, exePath);
          }
        }
        execPath = exePath;
      }

      return createProcessBot({
        botId: botOptions.botId || `cpp-${path.basename(sourcePath, path.extname(sourcePath))}`,
        executable: execPath,
        args: [],
        cwd,
        env: botOptions.env,
        clock: botOptions.clock,
        graceMs: botOptions.graceMs,
        maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
        maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
        maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
        onStderr: botOptions.onStderr
      });
    }
  });

  // 4. Java profile (Java 21)
  profiles.set("java", {
    id: "java",
    language: "java",
    revision: "java21-trusted-v1",
    entryName: "FirstLegal.java",
    probe() {
      const resolution = resolveJavaExecutables({
        javacExecutable: customJavac,
        javaExecutable: customJava,
        jarExecutable: customJar
      });
      const javacProbe = probeExecutable(resolution.javac, ["-version"], probeTimeoutMs);
      const javaProbe = probeExecutable(resolution.java, ["-version"], probeTimeoutMs);

      if (!javacProbe.ok) {
        return {
          available: false,
          executable: resolution.javac,
          version: null,
          error: "javac_not_found"
        };
      }
      if (!javaProbe.ok) {
        return {
          available: false,
          executable: resolution.java,
          version: null,
          error: "java_runtime_not_found"
        };
      }

      const javacVerRaw = (javacProbe.stdout || javacProbe.stderr || "").trim();
      const major = parseJavaMajorVersion(javacVerRaw);

      if (major !== null && major < 21) {
        return {
          available: false,
          executable: resolution.javac,
          version: javacVerRaw,
          error: `java_version_too_old: required >= 21, found ${major}`
        };
      }

      return {
        available: true,
        executable: resolution.java,
        javacExecutable: resolution.javac,
        javaExecutable: resolution.java,
        jarExecutable: resolution.jar,
        version: javacVerRaw,
        revision: "java21-trusted-v1"
      };
    },
    compile({ buildDir, sourceFilePath, compilerOptions = [], timeoutMs = 30000, signal }) {
      const probeInfo = this.probe();
      if (!probeInfo.available) {
        return {
          status: 1,
          stdout: "",
          stderr: `Java toolchain is not available: ${probeInfo.error}\n`,
          error: "runtime_unavailable"
        };
      }
      const classesDir = path.join(buildDir, "classes");
      fs.mkdirSync(classesDir, { recursive: true });

      const javacArgs = ["-d", classesDir, ...(Array.isArray(compilerOptions) ? compilerOptions : []), sourceFilePath];
      const res = spawnSync(probeInfo.javacExecutable, javacArgs, {
        shell: false,
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        cwd: buildDir
      });

      if (res.error) {
        const isTimeout = res.error.code === "ETIMEDOUT" || Boolean(res.error.timedOut);
        return {
          status: 1,
          stdout: "",
          stderr: res.error.message,
          timedOut: isTimeout,
          aborted: signal?.aborted
        };
      }

      if (res.status !== 0) {
        return {
          status: res.status ?? 1,
          stdout: res.stdout || "",
          stderr: res.stderr || "",
          error: "compile_failure"
        };
      }

      const classFiles = fs.readdirSync(classesDir).filter((f) => f.endsWith(".class"));
      if (classFiles.length === 0) {
        return {
          status: 1,
          stdout: res.stdout || "",
          stderr: (res.stderr || "") + "\nNo .class files generated by javac\n",
          error: "compile_failure"
        };
      }

      const mainClass = path.basename(classFiles[0], ".class");
      const jarOut = path.join(buildDir, "bot.jar");
      const jarExe = probeInfo.jarExecutable || "jar";

      const jarRes = spawnSync(jarExe, ["cfe", jarOut, mainClass, "-C", classesDir, "."], {
        shell: false,
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        cwd: buildDir
      });

      if (jarRes.status === 0 && fs.existsSync(jarOut)) {
        return {
          status: 0,
          stdout: res.stdout || "",
          stderr: res.stderr || "",
          entrypoint: "bot.jar"
        };
      }

      const classTarget = path.join(buildDir, `${mainClass}.class`);
      fs.copyFileSync(path.join(classesDir, `${mainClass}.class`), classTarget);
      return {
        status: 0,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        entrypoint: `${mainClass}.class`
      };
    },
    createBot(sourcePath, botOptions = {}) {
      if (!fs.existsSync(sourcePath)) {
        const err = new Error(`Bot artifact does not exist: ${sourcePath}`);
        err.kind = "infrastructure_error";
        err.code = "missing_bot_source";
        err.retryable = false;
        throw err;
      }

      const probeInfo = this.probe();
      if (!probeInfo.available) {
        const err = new Error(`Java runtime is not available (probed '${probeInfo.executable}')`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      const resolvedPath = path.resolve(sourcePath);
      const cwd = botOptions.cwd || path.dirname(resolvedPath);

      if (resolvedPath.endsWith(".java")) {
        const jarName = resolvedPath.replace(/\.java$/i, ".jar");
        if (fs.existsSync(jarName)) {
          return createProcessBot({
            botId: botOptions.botId || `java-${path.basename(jarName, ".jar")}`,
            executable: probeInfo.javaExecutable,
            args: ["-jar", jarName],
            cwd,
            env: botOptions.env,
            clock: botOptions.clock,
            graceMs: botOptions.graceMs,
            maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
            maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
            maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
            onStderr: botOptions.onStderr
          });
        }
        const err = new Error(`Java source file '${sourcePath}' has not been compiled`);
        err.kind = "infrastructure_error";
        err.code = "uncompiled_source";
        err.retryable = false;
        throw err;
      }

      if (resolvedPath.endsWith(".class")) {
        return createProcessBot({
          botId: botOptions.botId || `java-${path.basename(resolvedPath, ".class")}`,
          executable: probeInfo.javaExecutable,
          args: ["-cp", path.dirname(resolvedPath), path.basename(resolvedPath, ".class")],
          cwd,
          env: botOptions.env,
          clock: botOptions.clock,
          graceMs: botOptions.graceMs,
          maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
          maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
          maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
          onStderr: botOptions.onStderr
        });
      }

      return createProcessBot({
        botId: botOptions.botId || `java-${path.basename(resolvedPath, path.extname(resolvedPath))}`,
        executable: probeInfo.javaExecutable,
        args: ["-jar", resolvedPath],
        cwd,
        env: botOptions.env,
        clock: botOptions.clock,
        graceMs: botOptions.graceMs,
        maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
        maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
        maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
        onStderr: botOptions.onStderr
      });
    }
  });

  return {
    listProfiles() {
      return Array.from(profiles.values()).map((p) => ({
        id: p.id,
        language: p.language,
        revision: p.revision
      }));
    },

    getProfile(id) {
      return profiles.get(id) || null;
    },

    registerProfile(profileDef) {
      if (!profileDef || typeof profileDef.id !== "string") {
        throw new Error("Profile definition must include a string id");
      }
      profiles.set(profileDef.id, profileDef);
    },

    probeProfile(id) {
      const p = profiles.get(id);
      if (!p) {
        return { available: false, error: `unknown_profile:${id}` };
      }
      return typeof p.probe === "function" ? p.probe() : { available: true };
    },

    probeAll() {
      const results = {};
      for (const [id, p] of profiles.entries()) {
        results[id] = typeof p.probe === "function" ? p.probe() : { available: true };
      }
      return results;
    },

    resolveBot(botSpec, botOptions = {}) {
      if (typeof botSpec !== "string" || botSpec.trim().length === 0) {
        throw new Error("botSpec must be a non-empty string");
      }

      const spec = botSpec.trim();

      // 1. Built-in FunctionBot: "first-legal"
      if (spec === "first-legal") {
        return createFunctionBot({
          botId: botOptions.botId || "first-legal",
          chooseFn: (turn) => {
            if (!turn.legalMoves || turn.legalMoves.length === 0) {
              throw new Error("No legal moves available in turn payload");
            }
            return turn.legalMoves[0];
          }
        });
      }

      // 2. Profile-based bots: "<profile>:<path>"
      const colonIdx = spec.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Unsupported bot specification "${spec}". Expected "first-legal" or "<profile>:<path>"`);
      }

      const profileId = spec.slice(0, colonIdx);
      const sourceSubpath = spec.slice(colonIdx + 1);

      if (!sourceSubpath || sourceSubpath.trim().length === 0) {
        throw new Error(`Invalid bot specification "${spec}": missing source path after prefix`);
      }

      const profile = profiles.get(profileId);
      if (!profile) {
        throw new Error(`Unknown bot profile "${profileId}" in spec "${spec}". Available profiles: ${Array.from(profiles.keys()).join(", ")}`);
      }

      const cwd = botOptions.cwd || process.cwd();
      const resolvedSourcePath = path.isAbsolute(sourceSubpath)
        ? path.normalize(sourceSubpath)
        : path.resolve(cwd, sourceSubpath);

      if (typeof profile.probe === "function") {
        const probeRes = profile.probe();
        if (probeRes && !probeRes.available) {
          const err = new Error(`Bot profile "${profileId}" runtime is unavailable: ${probeRes.error || "not found"}`);
          err.kind = "infrastructure_error";
          err.code = "runtime_unavailable";
          err.retryable = false;
          throw err;
        }
      }

      if (typeof profile.createBot !== "function") {
        const err = new Error(`Profile "${profileId}" does not support createBot`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      return profile.createBot(resolvedSourcePath, botOptions);
    }
  };
}
