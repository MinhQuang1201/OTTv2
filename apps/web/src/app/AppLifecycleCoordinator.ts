import type { GameSession, StartGameOptions } from "../sessions/contract";
import { OnlineLobbyGateway } from "../sessions/online/OnlineLobbyGateway";
import { OnlineLobbyStream } from "../sessions/online/OnlineLobbyStream";
import type { RuntimeBridge } from "../sessions/online/runtimeBridge";
import type { PlayhtmlSpectatorAllocation } from "../sessions/online/globals";

type SpectatorIntent = {
  readonly mode: "spectator";
  readonly allocationId: string;
  readonly roomId: string;
};

export type AppLifecycleOptions = Exclude<StartGameOptions, { readonly mode: "spectator" }> | SpectatorIntent;

export interface AppLifecycleTransition {
  readonly factory: () => GameSession;
  readonly options: AppLifecycleOptions;
  readonly openLobbyStream?: boolean;
  readonly lobby?: {
    readonly factory: () => GameSession;
    readonly options: Exclude<StartGameOptions, { readonly mode: "spectator" }>;
    readonly onSession?: (session: GameSession, generation: number) => void;
  };
  readonly onSession: (session: GameSession, generation: number) => void;
  readonly onLobbyStream: (stream: OnlineLobbyStream | null, generation: number) => void;
  readonly onError?: (error: unknown, session: GameSession | null, generation: number) => void;
}

export interface AppLifecycleCoordinatorDependencies {
  readonly runtime: RuntimeBridge;
  readonly gateway: OnlineLobbyGateway;
  readonly createLobbyStream: (runtime: RuntimeBridge) => OnlineLobbyStream;
}

type CapturedDependencies = AppLifecycleCoordinatorDependencies;
type ResourceOwner<T> = { readonly resource: T; readonly token: number; readonly generation: number };
type SpectatorTransitionContext = {
  request: AppLifecycleTransition | null;
  readonly generation: number;
  dependencies: CapturedDependencies | null;
};
type PendingSpectatorTransition = {
  readonly context: SpectatorTransitionContext;
  readonly promise: Promise<void>;
};

function isSpectatorAllocation(value: unknown): value is PlayhtmlSpectatorAllocation {
  if (!value || typeof value !== "object") return false;
  const allocation = value as Record<string, unknown>;
  return typeof allocation.allocationId === "string" && allocation.allocationId.trim().length > 0 &&
    typeof allocation.room === "string" && allocation.room.trim().length > 0 &&
    typeof allocation.ticket === "string" && allocation.ticket.trim().length > 0;
}

/** Owns the single shared runtime and serializes every App provider transition. */
export class AppLifecycleCoordinator {
  private runtime: RuntimeBridge;
  private gateway: OnlineLobbyGateway;
  private createLobbyStream: (runtime: RuntimeBridge) => OnlineLobbyStream;
  private queue: Promise<void> | null = null;
  private activeSession: GameSession | null = null;
  private lobbyStream: OnlineLobbyStream | null = null;
  private activeRuntime: RuntimeBridge | null = null;
  private activeRuntimeOwnerToken: number | null = null;
  private runtimeInUse = false;
  private generation = 0;
  private disposed = false;
  private readonly disposedSessions = new WeakMap<object, Set<number>>();
  private readonly disposedStreams = new WeakMap<object, Set<number>>();
  private readonly sessionDisposals = new WeakMap<object, Map<number, Promise<void>>>();
  private readonly streamDisposals = new WeakMap<object, Map<number, Promise<void>>>();
  private readonly sessionTokens = new WeakMap<object, number>();
  private readonly streamTokens = new WeakMap<object, number>();
  private readonly retiredRuntimes = new Set<RuntimeBridge>();
  private nextOwnerToken = 0;
  private activeSessionOwner: ResourceOwner<GameSession> | null = null;
  private activeStreamOwner: ResourceOwner<OnlineLobbyStream> | null = null;
  private readonly pendingSessionCleanups = new Set<Promise<void>>();
  private readonly pendingStreamCleanups = new Set<Promise<void>>();
  private readonly pendingSpectatorTransitions = new Set<PendingSpectatorTransition>();

  constructor(deps: AppLifecycleCoordinatorDependencies) {
    this.runtime = deps.runtime;
    this.gateway = deps.gateway;
    this.createLobbyStream = deps.createLobbyStream;
  }

  updateDependencies(deps: AppLifecycleCoordinatorDependencies): void {
    if (this.disposed) return;
    const previousRuntime = this.runtime;
    this.runtime = deps.runtime;
    this.gateway = deps.gateway;
    this.createLobbyStream = deps.createLobbyStream;
    if (previousRuntime !== deps.runtime) {
      this.retiredRuntimes.add(previousRuntime);
      void this.enqueueDeferred(async () => {
        if (this.activeRuntime !== previousRuntime) await this.disposeRetiredRuntime(previousRuntime);
      }).catch(() => undefined);
    }
  }

  transition(request: AppLifecycleTransition): Promise<void> {
    this.cancelPendingSpectatorTransitions();
    const generation = ++this.generation;
    const dependencies: CapturedDependencies = {
      runtime: this.runtime,
      gateway: this.gateway,
      createLobbyStream: this.createLobbyStream,
    };
    const run = async () => {
      if (this.disposed || generation !== this.generation) return;
      if (this.activeSession || this.lobbyStream || this.runtimeInUse) {
        await this.releaseCurrent();
      }
      if (this.disposed || generation !== this.generation) return;

      if (request.options.mode === "spectator") {
        if ("allocation" in (request.options as Record<string, unknown>)) {
          if (request.lobby && !this.disposed && generation === this.generation) await this.startLobby(request.lobby, request, generation, dependencies);
          return;
        }
        await this.startSpectatorTransition(request, generation, dependencies);
        return;
      }

      await this.startSession(request.factory, request.options, request, generation, dependencies.runtime);
      if (request.openLobbyStream && !this.disposed && generation === this.generation) {
        await this.startLobbyStream(request, generation, dependencies);
      }
    };
    return this.enqueue(run);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.cancelPendingSpectatorTransitions();
    const run = async () => {
      await this.releaseCurrent();
    };
    return this.enqueue(run);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.queue;
    let next: Promise<void>;
    if (previous) {
      next = previous.then(operation, operation);
    } else {
      try { next = operation(); } catch (error) { next = Promise.reject(error); }
    }
    let tracked!: Promise<void>;
    tracked = next.finally(() => {
      if (this.queue === tracked) this.queue = null;
    });
    this.queue = tracked;
    return tracked;
  }

  private enqueueDeferred(operation: () => Promise<void>): Promise<void> {
    const previous = this.queue;
    const next = Promise.resolve().then(() => previous ? previous.then(operation, operation) : operation());
    let tracked!: Promise<void>;
    tracked = next.finally(() => {
      if (this.queue === tracked) this.queue = null;
    });
    this.queue = tracked;
    return tracked;
  }

  private async getSpectatorAllocationFrom(gateway: OnlineLobbyGateway, intent: SpectatorIntent): Promise<PlayhtmlSpectatorAllocation | null> {
    try {
      const allocation = await gateway.getSpectatorTicket(intent.allocationId);
      if (!isSpectatorAllocation(allocation) || allocation.allocationId !== intent.allocationId || allocation.room !== intent.roomId) return null;
      return allocation;
    } catch {
      return null;
    }
  }

  private async startSpectatorTransition(
    request: AppLifecycleTransition,
    generation: number,
    dependencies: CapturedDependencies,
  ): Promise<void> {
    const context: SpectatorTransitionContext = { request, generation, dependencies };
    let pending!: PendingSpectatorTransition;
    const continuation = (async () => {
      if (!context.request || !context.dependencies) return;
      const { allocationId, roomId } = context.request.options as SpectatorIntent;
      const allocation = await this.getSpectatorAllocationFrom(context.dependencies.gateway, {
        mode: "spectator",
        allocationId,
        roomId,
      });
      const currentRequest = context.request;
      const currentDependencies = context.dependencies;
      context.request = null;
      context.dependencies = null;
      if (!currentRequest || !currentDependencies || this.disposed || context.generation !== this.generation) return;
      if (!allocation) {
        if (currentRequest.lobby && !this.disposed && context.generation === this.generation) {
          await this.startLobby(currentRequest.lobby, currentRequest, context.generation, currentDependencies);
        }
        return;
      }
      await this.startSession(currentRequest.factory, { mode: "spectator", allocation }, currentRequest, context.generation, currentDependencies.runtime);
    })();
    pending = { context, promise: continuation };
    this.pendingSpectatorTransitions.add(pending);
    void continuation.then(
      () => this.pendingSpectatorTransitions.delete(pending),
      () => this.pendingSpectatorTransitions.delete(pending),
    );

    // Let immediately-resolved tickets preserve the existing await semantics, but do not
    // let a network promise hold the lifecycle queue hostage indefinitely.
    const completedQuickly = await Promise.race([
      continuation.then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);
    if (completedQuickly) await continuation;
  }

  private cancelPendingSpectatorTransitions(): void {
    for (const pending of this.pendingSpectatorTransitions) {
      pending.context.request = null;
      pending.context.dependencies = null;
    }
    this.pendingSpectatorTransitions.clear();
  }

  private async startSession(
    factory: () => GameSession,
    options: StartGameOptions,
    request: AppLifecycleTransition,
    generation: number,
    runtime: RuntimeBridge,
  ): Promise<void> {
    let session: GameSession;
    try {
      session = factory();
    } catch (error) {
      if (generation === this.generation) request.onError?.(error, null, generation);
      return;
    }
    const ownerToken = ++this.nextOwnerToken;
    if (this.disposed || generation !== this.generation) {
      await this.disposeSession(session, ownerToken);
      return;
    }

    this.sessionTokens.set(session, ownerToken);
    this.activeSessionOwner = { resource: session, token: ownerToken, generation };
    this.activeSession = session;
    this.runtimeInUse = options.mode === "online" || options.mode === "spectator";
    this.activeRuntime = this.runtimeInUse ? runtime : null;
    this.activeRuntimeOwnerToken = this.runtimeInUse ? ownerToken : null;
    try {
      request.onSession(session, generation);
    } catch (error) {
      try { request.onError?.(error, session, generation); } finally { await this.releaseCurrent(); }
      return;
    }
    if (this.disposed || generation !== this.generation) {
      await this.disposeSession(session, ownerToken);
      return;
    }
    try {
      const starting = Promise.resolve(session.start(options));
      void starting.then(
        () => {
          if (this.activeSessionOwner?.token === ownerToken && !this.disposed && generation === this.generation) return;
          if (this.sessionTokens.get(session) === ownerToken) void this.disposeSession(session, ownerToken);
        },
        (error) => {
          void this.handleSessionStartFailure(error, session, request, generation, ownerToken);
        },
      );
    } catch (error) {
      void this.handleSessionStartFailure(error, session, request, generation, ownerToken);
    }
  }

  private async startLobby(
    lobby: NonNullable<AppLifecycleTransition["lobby"]>,
    request: AppLifecycleTransition,
    generation: number,
    dependencies: CapturedDependencies = { runtime: this.runtime, gateway: this.gateway, createLobbyStream: this.createLobbyStream },
  ): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    await this.startSession(lobby.factory, lobby.options, { ...request, onSession: lobby.onSession ?? request.onSession }, generation, dependencies.runtime);
    if (!this.disposed && generation === this.generation) await this.startLobbyStream(request, generation, dependencies);
  }

  private async startLobbyStream(request: AppLifecycleTransition, generation: number, dependencies: CapturedDependencies): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    // Lobby streams may close their injected runtime, so expose a non-owning facade.
    let stream: OnlineLobbyStream;
    try {
      stream = dependencies.createLobbyStream({ ...dependencies.runtime, dispose: async () => undefined });
    } catch (error) {
      await this.handleStreamFailure(error, request, generation);
      return;
    }
    const ownerToken = ++this.nextOwnerToken;
    if (this.disposed || generation !== this.generation) {
      await this.disposeStream(stream, ownerToken);
      return;
    }
    this.streamTokens.set(stream, ownerToken);
    this.activeStreamOwner = { resource: stream, token: ownerToken, generation };
    this.lobbyStream = stream;
    this.runtimeInUse = true;
    this.activeRuntime = dependencies.runtime;
    this.activeRuntimeOwnerToken = ownerToken;
    try {
      request.onLobbyStream(stream, generation);
    } catch (error) {
      await this.handleStreamFailure(error, request, generation, stream, ownerToken);
      return;
    }
    try {
      const starting = Promise.resolve(stream.start());
      void starting.then(
        () => {
          if (this.activeStreamOwner?.token === ownerToken && !this.disposed && generation === this.generation) return;
          if (this.streamTokens.get(stream) === ownerToken) void this.disposeStream(stream, ownerToken);
        },
        (error) => {
          void this.handleStreamFailure(error, request, generation, stream, ownerToken);
        },
      );
    } catch (error) {
      // The stream exposes startup failures through its unavailable snapshot.
      void this.handleStreamFailure(error, request, generation, stream, ownerToken);
    }
  }

  private async handleSessionStartFailure(
    cause: unknown,
    session: GameSession,
    request: AppLifecycleTransition,
    generation: number,
    ownerToken: number,
  ): Promise<void> {
    try {
      if (!this.disposed && generation === this.generation) request.onError?.(cause, session, generation);
    } finally {
      await this.cleanupSessionOwner(session, ownerToken);
    }
  }

  private async handleStreamFailure(
    cause: unknown,
    request: AppLifecycleTransition,
    generation: number,
    stream?: OnlineLobbyStream,
    ownerToken?: number,
  ): Promise<void> {
    if (stream && ownerToken !== undefined && this.streamTokens.get(stream) !== ownerToken) return;
    const currentStream = stream && this.activeStreamOwner?.token === ownerToken ? stream : this.lobbyStream;
    if (currentStream !== stream && stream) {
      await this.disposeStream(stream, ownerToken);
      return;
    }
    try {
      if (!this.disposed && generation === this.generation) request.onError?.(cause, this.activeSession, generation);
    } finally {
      if (currentStream && this.activeStreamOwner?.token === ownerToken) await this.cleanupStreamOwner(currentStream, ownerToken!);
      else if (stream) await this.disposeStream(stream, ownerToken);
    }
  }

  private async releaseCurrent(): Promise<void> {
    await Promise.all([
      ...this.pendingSessionCleanups,
      ...this.pendingStreamCleanups,
    ]);
    const stream = this.lobbyStream;
    const streamOwner = this.activeStreamOwner;
    this.lobbyStream = null;
    this.activeStreamOwner = null;
    if (stream) {
      await this.disposeStream(stream, streamOwner?.token);
    }

    const session = this.activeSession;
    const sessionOwner = this.activeSessionOwner;
    this.activeSession = null;
    this.activeSessionOwner = null;
    if (session) await this.disposeSession(session, sessionOwner?.token);

    if (this.runtimeInUse) {
      this.runtimeInUse = false;
      const runtime = this.activeRuntime ?? this.runtime;
      this.activeRuntime = null;
      this.activeRuntimeOwnerToken = null;
      try { await runtime.dispose(); } catch { /* the next owner still gets a clean bind */ }
      this.retiredRuntimes.delete(runtime);
    }
    await this.disposeRetiredRuntimes();
  }

  private async cleanupSessionOwner(session: GameSession, ownerToken: number): Promise<void> {
    const cleanup = this.cleanupSessionOwnerInternal(session, ownerToken);
    this.pendingSessionCleanups.add(cleanup);
    void cleanup.then(
      () => this.pendingSessionCleanups.delete(cleanup),
      () => this.pendingSessionCleanups.delete(cleanup),
    );
    await cleanup;
  }

  private async cleanupSessionOwnerInternal(session: GameSession, ownerToken: number): Promise<void> {
    if (this.activeSessionOwner?.token !== ownerToken) {
      await this.disposeSession(session, ownerToken);
      return;
    }
    this.activeSession = null;
    this.activeSessionOwner = null;
    await this.disposeSession(session, ownerToken);
    if (this.activeRuntimeOwnerToken === ownerToken) {
      const runtime = this.activeRuntime;
      this.activeRuntime = null;
      this.activeRuntimeOwnerToken = null;
      this.runtimeInUse = false;
      if (runtime) {
        try { await runtime.dispose(); } catch { /* failed owner cleanup must not block later transitions */ }
        this.retiredRuntimes.delete(runtime);
      }
    }
  }

  private async cleanupStreamOwner(stream: OnlineLobbyStream, ownerToken: number): Promise<void> {
    const cleanup = this.cleanupStreamOwnerInternal(stream, ownerToken);
    this.pendingStreamCleanups.add(cleanup);
    void cleanup.then(
      () => this.pendingStreamCleanups.delete(cleanup),
      () => this.pendingStreamCleanups.delete(cleanup),
    );
    await cleanup;
  }

  private async cleanupStreamOwnerInternal(stream: OnlineLobbyStream, ownerToken: number): Promise<void> {
    if (this.activeStreamOwner?.token !== ownerToken) {
      await this.disposeStream(stream, ownerToken);
      return;
    }
    this.lobbyStream = null;
    this.activeStreamOwner = null;
    await this.disposeStream(stream, ownerToken);
    if (this.activeRuntimeOwnerToken === ownerToken) {
      const runtime = this.activeRuntime;
      this.activeRuntime = null;
      this.activeRuntimeOwnerToken = null;
      this.runtimeInUse = false;
      if (runtime) {
        try { await runtime.dispose(); } catch { /* failed owner cleanup must not block later transitions */ }
        this.retiredRuntimes.delete(runtime);
      }
    }
  }

  private async disposeRetiredRuntime(runtime: RuntimeBridge): Promise<void> {
    if (!this.retiredRuntimes.has(runtime) || this.activeRuntime === runtime || this.runtime === runtime) return;
    this.retiredRuntimes.delete(runtime);
    try { await runtime.dispose(); } catch { /* a replaced runtime must not block later transitions */ }
  }

  private async disposeRetiredRuntimes(): Promise<void> {
    for (const runtime of [...this.retiredRuntimes]) await this.disposeRetiredRuntime(runtime);
  }

  private async disposeSession(session: GameSession, ownerToken = this.sessionTokens.get(session) ?? ++this.nextOwnerToken): Promise<void> {
    if (this.sessionTokens.get(session) !== undefined && this.sessionTokens.get(session) !== ownerToken) return;
    const pending = this.sessionDisposals.get(session)?.get(ownerToken);
    if (pending) {
      await pending;
      return;
    }
    let disposedOwners = this.disposedSessions.get(session);
    if (!disposedOwners) {
      disposedOwners = new Set<number>();
      this.disposedSessions.set(session, disposedOwners);
    }
    if (disposedOwners.has(ownerToken)) return;
    disposedOwners.add(ownerToken);
    const disposal = (async () => {
      try { await session.dispose(); } catch { /* a failed close must not block the next transition */ }
    })();
    let disposals = this.sessionDisposals.get(session);
    if (!disposals) {
      disposals = new Map();
      this.sessionDisposals.set(session, disposals);
    }
    disposals.set(ownerToken, disposal);
    await disposal;
  }

  private async disposeStream(stream: OnlineLobbyStream, ownerToken = this.streamTokens.get(stream) ?? ++this.nextOwnerToken): Promise<void> {
    if (this.streamTokens.get(stream) !== undefined && this.streamTokens.get(stream) !== ownerToken) return;
    const pending = this.streamDisposals.get(stream)?.get(ownerToken);
    if (pending) {
      await pending;
      return;
    }
    let disposedOwners = this.disposedStreams.get(stream);
    if (!disposedOwners) {
      disposedOwners = new Set<number>();
      this.disposedStreams.set(stream, disposedOwners);
    }
    if (disposedOwners.has(ownerToken)) return;
    disposedOwners.add(ownerToken);
    const disposal = (async () => {
      try { await stream.dispose(); } catch { /* a failed close must not block the next transition */ }
    })();
    let disposals = this.streamDisposals.get(stream);
    if (!disposals) {
      disposals = new Map();
      this.streamDisposals.set(stream, disposals);
    }
    disposals.set(ownerToken, disposal);
    await disposal;
  }
}
