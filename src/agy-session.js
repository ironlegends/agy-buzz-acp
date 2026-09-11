import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const PINNED_MODEL = 'gemini-3.8-flash-high';
export const MAX_MODEL_LENGTH = 128;
export const MAX_CONVERSATION_ID_LENGTH = 256;
export const MAX_TOOL_NAME_LENGTH = 128;
export const MAX_STEP_INDEX = 1_000_000;
export const MAX_DURATION_SECONDS = 31_536_000;
export const RESUME_INIT_TIMEOUT_MS = 15_000;
export const PROVIDER_RETIRE_TIMEOUT_MS = 5_000;
export const STEERING_CLAIM_TIMEOUT_MS = 5_000;
export const STEERING_CLAIM_POLL_MS = 25;
export const STEERING_CLAIM_SNAPSHOT_ERROR_LIMIT = 3;
export const PROCESS_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const ROTATION_HEADROOM_MS = 3 * 60 * 60 * 1000;
export const ROTATION_AT_MS = PROCESS_LIFETIME_MS - ROTATION_HEADROOM_MS;
export const CONTEXT_LOST_MESSAGE = 'agy session context lost; resume unsupported';
// agy print mode aborts at --print-timeout (default 5m0s) and exits without emitting
// a terminal result event. That cap is a wall clock on the whole PROCESS, not a
// per-turn idle timer: printmode.go logs `Print mode: starting` exactly once, at
// spawn, and the observed abort landed 303.6s after that single line. AgySession
// reuses one child across turns, so a value equal to Buzz's own 7200s max-turn
// ceiling would kill a live turn on a process that had merely been alive that long.
// Pinned far above any realistic adapter lifetime so a turn is bounded by Buzz
// (idle 900s of silence, 7200s wall), never silently by the CLI.
export const PINNED_PRINT_TIMEOUT = '24h';

function validateModel(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    throw new TypeError('model must be a non-empty bounded string');
  }
  return model;
}

export function pinnedAgyArgs(model = PINNED_MODEL) {
  const selectedModel = validateModel(model);
  return [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--model', selectedModel,
    '--print-timeout', PINNED_PRINT_TIMEOUT,
    '--sandbox'
  ];
}

function wrapperError(message) {
  return Object.assign(new Error(message), { rpcMessage: message });
}

function steeringError(message, code = 'AGY_STEER_UNCERTAIN') {
  return Object.assign(new Error(message), { code, rpcMessage: message });
}

function validConversationId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CONVERSATION_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function boundedToolName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_TOOL_NAME_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/.test(name)) return null;
  return name;
}

function boundedStepIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_STEP_INDEX ? value : null;
}

function boundedDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_SECONDS
    ? value : null;
}

function activityState(value) {
  if (value === 'ACTIVE' || value === 'STARTED' || value === 'IN_PROGRESS') return 'in_progress';
  if (value === 'DONE' || value === 'SUCCESS' || value === 'COMPLETED') return 'completed';
  if (value === 'ERROR' || value === 'FAILED') return 'failed';
  return null;
}

function addDuration(update, duration) {
  const bounded = boundedDuration(duration);
  if (bounded === null) return update;
  update.durationSeconds = bounded;
  update.content = [{ type: 'content', content: { type: 'text', text: `Duration: ${bounded} s` } }];
  return update;
}

function stopChild(child) {
  try { child?.stdin?.end?.(); } catch {}
  try { child?.kill?.(); } catch {}
}

export class AgySession {
  constructor({ command = 'agy', prefixArgs = [], cwd = process.cwd(), systemPrompt,
    model = process.env.AGY_MODEL ?? PINNED_MODEL, spawnFn = spawn, nowFn = Date.now,
    resumeTimeoutMs = RESUME_INIT_TIMEOUT_MS, retireTimeoutMs = PROVIDER_RETIRE_TIMEOUT_MS,
    steeringCoordinator = null, steeringTimeoutMs = STEERING_CLAIM_TIMEOUT_MS } = {}) {
    this.command = command;
    this.prefixArgs = prefixArgs;
    this.cwd = cwd;
    this.model = validateModel(model);
    this.modelCatalog = Object.freeze([]);
    this.systemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : null;
    this.sentSystemPrompt = false;
    this.spawnFn = spawnFn;
    this.nowFn = nowFn;
    if (!Number.isInteger(resumeTimeoutMs) || resumeTimeoutMs < 1 || resumeTimeoutMs > 60_000) {
      throw new TypeError('resumeTimeoutMs must be a bounded positive integer');
    }
    this.resumeTimeoutMs = resumeTimeoutMs;
    if (!Number.isInteger(retireTimeoutMs) || retireTimeoutMs < 1 || retireTimeoutMs > 60_000) {
      throw new TypeError('retireTimeoutMs must be a bounded positive integer');
    }
    this.retireTimeoutMs = retireTimeoutMs;
    if (!Number.isInteger(steeringTimeoutMs) || steeringTimeoutMs < 1 || steeringTimeoutMs > 60_000) {
      throw new TypeError('steeringTimeoutMs must be a bounded positive integer');
    }
    this.steeringTimeoutMs = steeringTimeoutMs;
    this.child = null;
    this.pending = null;
    this.lastPending = null;
    this.buffer = '';
    this.contextLost = false;
    this.conversationEstablished = false;
    this.conversationId = null;
    this.resumeEligible = false;
    this.awaitingResumeInit = false;
    this.resumeTimer = null;
    this.childStartedAt = null;
    this.childClosePromise = null;
    this.lastChildClosePromise = null;
    this.lastTurnSucceeded = false;
    this.lastTurnIdConfirmed = false;
    this.turnIdsCoherent = true;
    this.turnSequence = 0;
    this.activityNonce = randomUUID().replaceAll('-', '');
    this.closed = false;
    this.steeringCoordinator = null;
    this.steeringBlocked = false;
    this.providerStepWatermark = 0;
    this.childSteeringEnabled = false;
    this.steeringBindingPending = false;
    this.steeringBindingPromise = Promise.resolve();
    this.steeringBindingResolve = null;
    this.steeringBindingFailed = false;
    this.steeringBindingInFlight = false;
    this.setSteeringCoordinator(steeringCoordinator);
  }

  prompt(text, onText, onActivity) {
    if (this.closed) return Promise.reject(wrapperError('agy session is closed'));
    if (this.pending) return Promise.reject(wrapperError('session is busy'));
    if (this.contextLost) return Promise.reject(wrapperError(CONTEXT_LOST_MESSAGE));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, text, onText: typeof onText === 'function' ? onText : () => {},
        onActivity: typeof onActivity === 'function' ? onActivity : () => {}, emittedText: '', resuming: false,
        rotating: false, turnId: ++this.turnSequence, activeTools: new Map(), startedAt: null, providerTerminal: false,
        segments: [''], segmentIndex: 0, injectedCount: 0, steerIds: new Set(), steerWaiters: new Map(),
        steerOperations: new Set(), steeringTimers: new Map(), steeringClaimPollers: new Map(), observationInFlight: false, deferredUserInput: null, deferredEvents: [], pendingResult: null, steeringFailure: null,
        providerInitSeen: false, initialUserInputExpected: false, initialUserInputSeen: false };
      this.pending = pending;
      this.lastPending = pending;
      void this.startPending(pending);
    });
  }

  setSteeringCoordinator(coordinator) {
    if (coordinator !== null && (!coordinator || typeof coordinator !== 'object' ||
        typeof coordinator.enqueue !== 'function' || typeof coordinator.observeUserInput !== 'function' ||
        typeof coordinator.snapshot !== 'function' || typeof coordinator.block !== 'function')) {
      throw wrapperError('agy steering coordinator is invalid');
    }
    this.steeringCoordinator = coordinator;
    this.steeringBindingPending = Boolean(coordinator?.enabled && coordinator.conversationBound === false &&
      typeof coordinator.bindConversation === 'function');
    this.steeringBindingResolve = null;
    this.steeringBindingFailed = false;
    this.steeringBindingInFlight = false;
    this.steeringBindingPromise = this.steeringBindingPending
      ? new Promise((resolve) => {
        this.steeringBindingResolve = resolve;
      })
      : Promise.resolve();
    if (this.child && !coordinator?.bridgeEnv?.()) this.childSteeringEnabled = false;
    return coordinator;
  }

  hasSteeringCoordinator() {
    return Boolean(this.steeringCoordinator?.enabled);
  }

  steer(text) {
    const pending = this.pending;
    if (!pending || !pending.started || this.steeringBlocked || this.contextLost) {
      return Promise.reject(steeringError('agy steering requires an active provider turn', 'AGY_STEER_COMPLETED'));
    }
    const coordinator = this.steeringCoordinator;
    if (!coordinator?.enabled) {
      return Promise.reject(steeringError('agy steering is unavailable without a dedicated hook', 'AGY_STEER_UNAVAILABLE'));
    }
    if (!this.childSteeringEnabled) {
      return Promise.reject(steeringError('agy steering hook is not available in the provider child', 'AGY_STEER_UNAVAILABLE'));
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return Promise.reject(steeringError('agy steering prompt is invalid', 'AGY_STEER_INPUT'));
    }
    if (!this.conversationId && !this.steeringBindingPending) {
      return Promise.reject(steeringError('agy steering conversation is not confirmed', 'AGY_STEER_UNAVAILABLE'));
    }

    pending.steerIntentCount = (pending.steerIntentCount ?? 0) + 1;
    const claimFloorStep = this.providerStepWatermark;
    const waiterKey = `pending-${randomUUID()}`;
    let resolveWaiter;
    let rejectWaiter;
    const result = new Promise((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject; });
    pending.steerWaiters.set(waiterKey, { resolve: resolveWaiter, reject: rejectWaiter });
    const operation = this.steeringBindingPromise.then(() => {
      if (this.steeringBindingFailed) throw steeringError('agy steering conversation binding failed', 'AGY_STEER_UNCERTAIN');
      if (!this.conversationId) throw steeringError('agy steering conversation is not confirmed', 'AGY_STEER_UNAVAILABLE');
      coordinator.assertBinding?.({ conversationId: this.conversationId });
      return coordinator.enqueue(text, { claimFloorStep });
    });
    pending.steerOperations.add(operation);
    operation.then((request) => {
      pending.steerOperations.delete(operation);
      if (this.pending !== pending || pending.steeringFailure) return;
      if (!request || typeof request.steerId !== 'string') {
        const failure = steeringError('agy steering request was not queued');
        void this.failSteeringPending(pending, failure);
        return;
      }
      pending.steerWaiters.delete(waiterKey);
      pending.steerIds.add(request.steerId);
      pending.steerWaiters.set(request.steerId, { resolve: resolveWaiter, reject: rejectWaiter });
      this.watchSteeringClaim(pending, request.steerId);
      this.maybeFinishResult(pending);
    }, (error) => {
      pending.steerOperations.delete(operation);
      const failure = error?.code?.startsWith?.('AGY_STEER_')
        ? error : steeringError('agy steering request could not be queued');
      void this.failSteeringPending(pending, failure);
    });
    return result;
  }

  async startPending(pending) {
    try {
      if (this.shouldRotate()) {
        pending.rotating = true;
        await this.rotateChild();
        pending.rotating = false;
      }
      if (this.contextLost) throw wrapperError(CONTEXT_LOST_MESSAGE);
      const resuming = this.resumeEligible && !this.child;
      pending.resuming = resuming;
      this.lastTurnIdConfirmed = false;
      this.turnIdsCoherent = true;
      this.ensureStarted(resuming);
      if (resuming) {
        this.resumeTimer = setTimeout(() => {
          if (this.awaitingResumeInit) this.failResume(wrapperError('agy resume timed out waiting for matching init'));
        }, this.resumeTimeoutMs);
      } else this.sendPendingPrompt();
    } catch (error) {
      pending.rotating = false;
      this.contextLost = true;
      this.finishPending(error?.rpcMessage ? error : wrapperError('agy session lifecycle failed'));
    }
  }

  shouldRotate() {
    return Boolean(this.child && this.childStartedAt !== null &&
      this.nowFn() - this.childStartedAt >= ROTATION_AT_MS && this.lastTurnSucceeded);
  }

  async rotateChild() {
    const child = this.child;
    if (!child) return;
    await this.stopAndWaitForClose(child, 'agy previous provider did not close before rotation');
    if (!this.conversationId || !this.lastTurnIdConfirmed) {
      this.contextLost = true;
      this.resumeEligible = false;
      throw wrapperError('agy cannot rotate without a confirmed conversation');
    }
    this.resumeEligible = true;
  }

  async retireForCheckpoint() {
    if (this.closed) throw wrapperError('agy session is closed');
    if (this.contextLost) throw wrapperError(CONTEXT_LOST_MESSAGE);
    if (this.pending) {
      const error = wrapperError('agy cannot retire during an active prompt');
      this.failResume(error);
      throw error;
    }
    if (!this.hasConfirmedConversation()) {
      const error = wrapperError('agy cannot retire without a confirmed conversation');
      this.failResume(error);
      throw error;
    }
    const child = this.child;
    if (!child) {
      this.resumeEligible = true;
      return this.conversationId;
    }
    await this.stopAndWaitForClose(child, 'agy provider did not close before checkpoint timeout');
    if (!this.hasConfirmedConversation()) {
      const error = wrapperError('agy cannot checkpoint without a confirmed conversation');
      this.contextLost = true;
      this.resumeEligible = false;
      throw error;
    }
    this.resumeEligible = true;
    return this.conversationId;
  }

  // Proves only local quiescence, never that prior external effects did not occur.
  // The server may then replace this object under its durable recovery guards.
  async retireForRecovery() {
    if (this.pending || this.steeringBindingInFlight ||
        this.lastPending?.steerOperations?.size || this.lastPending?.observationInFlight) {
      throw wrapperError('agy recovery requires all previous operations to settle');
    }
    const child = this.child;
    const closePromise = this.lastChildClosePromise;
    if (child && !child._agyStopRequested) {
      child._agyStopRequested = true;
      stopChild(child);
    }
    // Error/cancel paths can clear `child` before close. Never treat that as proof
    // of exit: even that case must await the recorded close promise, with a bound.
    if (closePromise) await this.waitForCloseWithin(closePromise, this.retireTimeoutMs);
    else if (child) throw wrapperError('agy provider retirement could not be confirmed');
    this.close();
    return true;
  }

  waitForCloseWithin(closePromise, timeoutMs) {
    if (!closePromise) return Promise.reject(wrapperError('agy provider close cannot be confirmed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(wrapperError('agy provider close timed out')), timeoutMs);
      closePromise.then(() => {
        clearTimeout(timer);
        resolve();
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async stopAndWaitForClose(child, failureMessage) {
    const closePromise = this.childClosePromise;
    if (!child._agyStopRequested) {
      child._agyStopRequested = true;
      stopChild(child);
    }
    try {
      await this.waitForCloseWithin(closePromise, this.retireTimeoutMs);
    } catch {
      this.failClosedAfterChildStop(child);
      throw wrapperError(failureMessage);
    }
    if (this.child === child) {
      this.failClosedAfterChildStop(child);
      throw wrapperError(failureMessage);
    }
  }

  failClosedAfterChildStop(child) {
    if (this.child === child) this.child = null;
    this.childSteeringEnabled = false;
    this.childStartedAt = null;
    this.buffer = '';
    this.sentSystemPrompt = false;
    this.awaitingResumeInit = false;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.contextLost = true;
    this.resumeEligible = false;
  }

  waitForClose() {
    return this.lastChildClosePromise ?? Promise.resolve();
  }

  setTrustedConversation(conversationId) {
    if (this.closed || this.pending || this.child) throw wrapperError('agy conversation is already active');
    if (!validConversationId(conversationId)) throw wrapperError('agy trusted conversation id is invalid');
    if (this.conversationId && this.conversationId !== conversationId) {
      throw wrapperError('agy trusted conversation id mismatch');
    }
    this.conversationId = conversationId;
    this.conversationEstablished = true;
    this.lastTurnSucceeded = true;
    this.lastTurnIdConfirmed = true;
    this.resumeEligible = true;
  }

  getConversationId() {
    return this.conversationId;
  }

  hasConfirmedConversation() {
    return Boolean(this.conversationId && this.lastTurnSucceeded && this.lastTurnIdConfirmed);
  }

  sendPendingPrompt() {
    if (!this.pending || this.pending.started || !this.child || this.awaitingResumeInit) return;
    const pending = this.pending;
    // Adapted from Xeoneid PR #9. Resumed conversations may predate the
    // directive, so deliver it once per provider process, not only fresh chats.
    const bridgeInstruction = '--- Buzz ACP bridge ---\nThe wrapper publishes your final response to Buzz using the platform transport. Return your final answer as text; do not publish this reply with buzz messages send or another transport. Other authorized Buzz operations remain available.\n--- End Buzz ACP bridge ---';
    const firstInProcess = !this.sentSystemPrompt;
    const system = firstInProcess && !pending.resuming && this.systemPrompt
      ? `${this.systemPrompt}

` : '';
    const content = firstInProcess
      ? `${system}${bridgeInstruction}

--- Buzz system prompt / user prompt ---
${pending.text ?? ''}`
      : pending.text;
    try {
      this.child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
      this.sentSystemPrompt = true;
      pending.initialUserInputExpected = true;
      pending.initialUserInputSeen = false;
      pending.started = true;
      pending.startedAt = this.childStartedAt ?? this.nowFn();
      pending.onActivity({ sessionUpdate: 'tool_call', toolCallId: `agy-${this.activityNonce}-provider-${pending.turnId}`,
        title: 'Model generation', toolName: 'agy_provider', kind: 'other', status: 'in_progress', index: 0 });
    } catch {
      this.failResume(wrapperError('agy input failed'));
    }
  }

  cancel() {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    this.rejectSteeringWaiters(pending, Object.assign(new Error('prompt cancelled'), { code: 'CANCELLED' }));
    this.emitPendingActivity(pending, 'failed');
    pending.reject(Object.assign(new Error('prompt cancelled'), { code: 'CANCELLED' }));
    const child = this.child;
    this.child = null;
    this.childSteeringEnabled = false;
    this.buffer = '';
    this.sentSystemPrompt = false;
    this.awaitingResumeInit = false;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.resumeEligible = false;
    this.contextLost = true;
    if (child) stopChild(child);
  }

  close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.childSteeringEnabled = false;
    this.sentSystemPrompt = false;
    this.awaitingResumeInit = false;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.resumeEligible = false;
    if (this.pending) {
      const pending = this.pending;
      this.rejectSteeringWaiters(pending, wrapperError('agy session closed'));
      this.finishPending(wrapperError('agy session closed'));
    }
    this.buffer = '';
    this.childStartedAt = null;
    if (child) stopChild(child);
  }

  setModelCatalog(models) {
    if (!Array.isArray(models)) throw wrapperError('agy model catalog is invalid');
    const normalized = [];
    const seen = new Set();
    for (const candidate of models) {
      if (!candidate || typeof candidate.modelId !== 'string' || typeof candidate.name !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(candidate.modelId) || !candidate.name.trim() || seen.has(candidate.modelId)) continue;
      seen.add(candidate.modelId);
      normalized.push(Object.freeze({ modelId: candidate.modelId, name: candidate.name.trim() }));
    }
    this.modelCatalog = Object.freeze(normalized);
  }

  setModel(model) {
    if (this.closed || this.pending || this.child || this.conversationEstablished || this.resumeEligible || this.contextLost) {
      throw wrapperError('agy session model is immutable after start');
    }
    const selectedModel = validateModel(model);
    if (!this.modelCatalog.some((candidate) => candidate.modelId === selectedModel)) {
      throw wrapperError('agy model is not available in this session catalog');
    }
    this.model = selectedModel;
    return this.model;
  }

  ensureStarted(resume = false) {
    if (this.child) return;
    const startedAt = this.nowFn();
    const args = [...this.prefixArgs, ...pinnedAgyArgs(this.model)];
    if (resume) args.push('--conversation', this.conversationId);
    const providerEnv = { ...process.env };
    delete providerEnv.AGY_STEER_BRIDGE_DIR;
    delete providerEnv.AGY_STEER_BINDING;
    const bridgeEnv = this.steeringCoordinator?.bridgeEnv?.();
    if (bridgeEnv && typeof bridgeEnv === 'object') Object.assign(providerEnv, bridgeEnv);
    this.childSteeringEnabled = Boolean(bridgeEnv && typeof bridgeEnv === 'object');
    const child = this.spawnFn(this.command, args, {
      shell: false,
      cwd: this.cwd,
      env: providerEnv,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk, child));
    child._agyResume = resume;
    this.childStartedAt = startedAt;
    child._agyStopRequested = false;
    this.childClosePromise = new Promise((resolve) => { child._agyCloseResolve = resolve; });
    this.lastChildClosePromise = this.childClosePromise;
    this.awaitingResumeInit = resume;
    if (resume) this.resumeEligible = false;
    // An EPIPE on a dead child's stdin arrives as an asynchronous stream 'error'.
    // Without this listener Node would throw it as an unhandled error event and
    // take the whole adapter down instead of failing the single turn.
    child.stdin.on('error', () => {
      if (this.child !== child) return;
      if (this.pending?.steeringFailure || child._agyStopRequested) return;
      if (this.pending && this.hasUnsettledSteering(this.pending)) {
        void this.failSteeringPending(this.pending, steeringError('agy provider input failed before steering consumption'));
        return;
      }
      this.child = null;
      this.childSteeringEnabled = false;
      this.buffer = '';
      this.sentSystemPrompt = false;
      this.awaitingResumeInit = false;
      this.resumeEligible = false;
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      child._agyStopRequested = true;
      stopChild(child);
      this.contextLost = true;
      this.finishPending(wrapperError('agy input failed'));
    });
    child.on('error', () => {
      if (this.child !== child) return;
      if (this.pending?.steeringFailure || child._agyStopRequested) return;
      if (this.pending && this.hasUnsettledSteering(this.pending)) {
        void this.failSteeringPending(this.pending, steeringError('agy provider exited before steering consumption'));
        return;
      }
      this.child = null;
      this.childSteeringEnabled = false;
      this.buffer = '';
      this.sentSystemPrompt = false;
      this.awaitingResumeInit = false;
      this.resumeEligible = false;
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      this.contextLost = true;
      this.finishPending(wrapperError('agy process failed to start'));
    });
    child.on('close', () => {
      child._agyCloseResolve?.();
      child._agyCloseResolve = null;
      this.childClosePromise = null;
      if (this.child !== child) return;
      this.child = null;
      this.childSteeringEnabled = false;
      this.childStartedAt = null;
      this.buffer = '';
      this.sentSystemPrompt = false;
      this.awaitingResumeInit = false;
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      if (this.pending?.steeringFailure) return;
      // Report how long this agy process had been alive. --print-timeout is a
      // per-process wall clock, so an exit that lands on the pin is a different
      // failure from a crash on the first turn, and the age is the only signal
      // that tells them apart from outside the CLI's own log files.
      if (this.pending && !this.pending.rotating && this.hasUnsettledSteering(this.pending)) {
        void this.failSteeringPending(this.pending, steeringError('agy provider exited before steering consumption'));
      } else if (this.pending && !this.pending.rotating) {
        this.contextLost = true;
        this.resumeEligible = false;
        const ageSeconds = Math.round((this.nowFn() - startedAt) / 1000);
        this.finishPending(wrapperError(`agy exited before completing the prompt (process age ${ageSeconds}s)`));
      } else if (this.lastTurnSucceeded && this.lastTurnIdConfirmed && this.conversationId) {
        this.resumeEligible = true;
      } else if (this.conversationEstablished) {
        this.contextLost = true;
      }
    });
    this.child = child;
  }

  consume(chunk, sourceChild = this.child) {
    if (sourceChild !== this.child) return;
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.failProviderEvent(wrapperError('agy returned invalid stream JSON'));
        return;
      }
      if (sourceChild._agyResume && this.awaitingResumeInit && event.event !== 'init') {
        this.failProviderEvent(wrapperError('agy resume requires matching init before provider events'));
        return;
      }
      const step = event.event === 'step_update' ? event.step_update : null;
      const isInit = event.event === 'init';
      if (this.pending && !isInit && this.steeringBindingPending) {
        if (this.hasUnsettledSteering(this.pending) && (event.event === 'result' || event.event === 'error')) {
          void this.failSteeringPending(this.pending, steeringError('agy provider terminated before steering conversation binding'));
          return;
        }
        this.pending.deferredEvents.push(event);
        continue;
      }
      const stepIndex = boundedStepIndex(step?.step_index);
      if (stepIndex !== null) this.providerStepWatermark = Math.max(this.providerStepWatermark, stepIndex);
      const isUserInput = event.event === 'step_update' && step?.step_type === 'user_input';
      if (this.pending && !isUserInput && (this.pending.deferredUserInput || this.pending.observationInFlight)) {
        this.pending.deferredEvents.push(event);
        continue;
      }
      if (isUserInput) {
        if (!this.validateSteeringEventConversation(event)) {
          void this.failSteeringPending(this.pending, steeringError('agy steering provider user_input is ambiguous'));
          return;
        }
        if (this.isInitialProviderUserInput(this.pending)) continue;
        this.handleUserInput(step);
        continue;
      }
      if (!this.validateEventConversation(event, sourceChild)) return;
      if (event.event === 'init') {
        if (this.pending?.providerInitSeen) {
          this.failProviderEvent(steeringError('agy provider repeated init during active prompt'));
          return;
        }
        if (this.pending) {
          this.pending.providerInitSeen = true;
        }
        this.beginSteeringBinding(this.conversationId);
        if (sourceChild._agyResume) {
          this.awaitingResumeInit = false;
          if (this.resumeTimer) clearTimeout(this.resumeTimer);
          this.resumeTimer = null;
          this.sendPendingPrompt();
        }
      } else if (event.event === 'step_update' && this.pending) {
        const type = typeof step?.step_type === 'string' ? step.step_type : 'agent_response';
        if (type === 'agent_response' && typeof step.text_delta === 'string') {
          this.pending.emittedText += step.text_delta;
          this.pending.segments[this.pending.segmentIndex] += step.text_delta;
          this.pending.onText(step.text_delta);
        } else if (type === 'tool') {
          this.emitToolActivity(step);
        }
      } else if (event.event === 'response' && typeof event.response?.text === 'string' && this.pending) {
        this.pending.emittedText += event.response.text;
        this.pending.segments[this.pending.segmentIndex] += event.response.text;
        this.pending.onText(event.response.text);
      } else if (event.event === 'result' && this.pending) {
        const result = event.result;
        if (result?.status === 'SUCCESS') {
          this.conversationEstablished = true;
          this.lastTurnSucceeded = true;
          this.lastTurnIdConfirmed = this.turnIdsCoherent && Boolean(this.conversationId &&
            typeof result.conversation_id === 'string' && result.conversation_id === this.conversationId);
          if (!this.pending.emittedText && typeof result.response === 'string' && this.pending.injectedCount === 0) {
            this.pending.onText(result.response);
          }
          this.pending.pendingResult = { result };
          this.maybeFinishResult(this.pending);
        }
        else {
          this.lastTurnSucceeded = false;
          this.pending.pendingResult = { result };
          this.maybeFinishResult(this.pending);
        }
      }
    }
  }

  hasUnsettledSteering(pending) {
    return Boolean(pending && (pending.steerOperations.size > 0 || pending.steerIds.size > 0 ||
      pending.observationInFlight || pending.steerIntentCount > pending.injectedCount));
  }

  watchSteeringClaim(pending, steerId) {
    const coordinator = this.steeringCoordinator;
    if (typeof coordinator?.snapshot !== 'function') return;
    let snapshotErrors = 0;
    const snapshotErrorCodes = [];
    const failClaimObservation = (message) => {
      const failure = steeringError(message);
      if (snapshotErrorCodes.length) failure.causeCodes = [...snapshotErrorCodes];
      void this.failSteeringPending(pending, failure);
    };
    const poll = async () => {
      pending.steeringClaimPollers.delete(steerId);
      if (this.pending !== pending || pending.steeringFailure || !pending.steerIds.has(steerId)) return;
      let state;
      try {
        state = await coordinator.snapshot();
      } catch (error) {
        snapshotErrors += 1;
        snapshotErrorCodes.push(typeof error?.code === 'string' ? error.code : 'UNKNOWN');
        if (snapshotErrors >= STEERING_CLAIM_SNAPSHOT_ERROR_LIMIT) {
          failClaimObservation('agy steering snapshot status could not be confirmed');
          return;
        }
        this.scheduleSteeringClaimPoll(pending, steerId, poll);
        return;
      }
      if (this.pending !== pending || pending.steeringFailure || !pending.steerIds.has(steerId)) return;
      if (state?.status === 'blocked') {
        void this.failSteeringPending(pending, steeringError('agy steering became blocked before provider confirmation'));
        return;
      }
      const entry = Array.isArray(state?.queue) ? state.queue.find((candidate) => candidate?.steerId === steerId) : null;
      if (state?.activeSteerId === steerId || entry?.status === 'awaiting_user_input') {
        if (!pending.steeringTimers.has(steerId)) {
          pending.steeringTimers.set(steerId, setTimeout(() => {
            if (this.pending === pending && !pending.steeringFailure) {
              void this.failSteeringPending(pending, steeringError('agy steering claim timed out'));
            }
          }, this.steeringTimeoutMs));
        }
        return;
      }
      if (entry?.status === 'injected') return;
      this.scheduleSteeringClaimPoll(pending, steerId, poll);
    };
    void poll();
  }

  scheduleSteeringClaimPoll(pending, steerId, poll) {
    if (this.pending !== pending || pending.steeringFailure || !pending.steerIds.has(steerId)) return;
    const delay = Math.min(STEERING_CLAIM_POLL_MS, this.steeringTimeoutMs);
    pending.steeringClaimPollers.set(steerId, setTimeout(() => { void poll(); }, delay));
  }

  beginSteeringBinding(conversationId) {
    if (!this.steeringBindingPending || !this.steeringCoordinator?.bindConversation) return;
    if (this.steeringBindingInFlight) {
      this.failProviderEvent(steeringError('agy steering conversation binding is ambiguous'));
      return;
    }
    this.steeringBindingInFlight = true;
    const pending = this.pending;
    Promise.resolve().then(() => this.steeringCoordinator.bindConversation(conversationId)).then(() => {
      this.steeringBindingInFlight = false;
      this.steeringBindingPending = false;
      this.steeringBindingResolve?.();
      this.steeringBindingResolve = null;
      if (this.pending !== pending || !pending) return;
      const deferredEvents = pending.deferredEvents.splice(0);
      for (const deferredEvent of deferredEvents) {
        if (this.pending !== pending || pending.steeringFailure) break;
        this.consume(`${JSON.stringify(deferredEvent)}\n`, this.child);
      }
      this.maybeFinishResult(pending);
    }, (error) => {
      this.steeringBindingInFlight = false;
      this.steeringBindingFailed = true;
      this.steeringBindingResolve?.();
      this.steeringBindingResolve = null;
      this.failProviderEvent(error);
    });
  }

  validateSteeringEventConversation(event) {
    const id = event.step_update?.conversation_id;
    return Boolean(this.conversationId && id === this.conversationId &&
      boundedStepIndex(event.step_update?.step_index) !== null);
  }

  isInitialProviderUserInput(pending) {
    if (!pending?.initialUserInputExpected || pending.initialUserInputSeen) return false;
    pending.initialUserInputSeen = true;
    return true;
  }

  handleUserInput(step) {
    const pending = this.pending;
    if (!pending) return;
    if (pending.deferredUserInput) {
      void this.failSteeringPending(pending, steeringError('agy steering provider user_input is ambiguous'));
      return;
    }
    if (pending.steerOperations.size > 0) {
      pending.deferredUserInput = step;
      void Promise.allSettled([...pending.steerOperations]).then(() => {
        const deferred = pending.deferredUserInput;
        pending.deferredUserInput = null;
        if (this.pending === pending && !pending.steeringFailure && deferred) this.handleUserInput(deferred);
      });
      return;
    }
    if (pending.observationInFlight || pending.steerIds.size === 0 || !this.steeringCoordinator?.enabled) {
      void this.failSteeringPending(pending, steeringError('agy steering provider user_input is ambiguous'));
      return;
    }
    pending.observationInFlight = true;
    const observation = Promise.resolve().then(() => this.steeringCoordinator.observeUserInput({
      conversationId: step.conversation_id,
      stepIndex: step.step_index
    }));
    observation.then((outcome) => {
      pending.observationInFlight = false;
      if (this.pending !== pending || pending.steeringFailure) return;
      const waiter = pending.steerWaiters.get(outcome?.steerId);
      if (!waiter || outcome?.outcome !== 'injected') {
        void this.failSteeringPending(pending, steeringError('agy steering provider user_input is ambiguous'));
        return;
      }
      pending.steerWaiters.delete(outcome.steerId);
      pending.steerIds.delete(outcome.steerId);
      clearTimeout(pending.steeringTimers.get(outcome.steerId));
      pending.steeringTimers.delete(outcome.steerId);
      pending.injectedCount += 1;
      pending.segmentIndex += 1;
      pending.segments.push('');
      waiter.resolve(outcome);
      const deferredEvents = pending.deferredEvents.splice(0);
      for (const deferredEvent of deferredEvents) {
        if (this.pending !== pending || pending.steeringFailure) break;
        this.consume(`${JSON.stringify(deferredEvent)}\n`, this.child);
      }
      this.maybeFinishResult(pending);
    }, (error) => {
      pending.observationInFlight = false;
      void this.failSteeringPending(pending, error?.code?.startsWith?.('AGY_STEER_')
        ? error : steeringError('agy steering provider user_input is ambiguous'));
    });
  }

  maybeFinishResult(pending) {
    if (this.pending !== pending || pending.steeringFailure || !pending.pendingResult ||
        pending.steerOperations.size > 0 || pending.observationInFlight) return;
    if (pending.steerIds.size > 0 || pending.steerIntentCount > pending.injectedCount) {
      void this.failSteeringPending(pending, steeringError('agy provider completed before steering consumption'));
      return;
    }
    const { result } = pending.pendingResult;
    pending.pendingResult = null;
    if (result?.status !== 'SUCCESS') {
      this.finishPending(wrapperError('agy returned an unsuccessful result'));
      return;
    }
    if (pending.injectedCount > 0) {
      const response = pending.segments[pending.segmentIndex];
      if (typeof response !== 'string' || response.length === 0) {
        void this.failSteeringPending(pending, steeringError('agy steering final response segment is missing'));
        return;
      }
      this.finishPending(null, response, result.duration_seconds);
      return;
    }
    const response = typeof result.response === 'string' ? result.response : pending.emittedText;
    this.finishPending(null, response, result.duration_seconds);
  }

  failProviderEvent(error) {
    if (this.pending && this.hasUnsettledSteering(this.pending)) {
      void this.failSteeringPending(this.pending, error);
      return;
    }
    this.failResume(error);
  }

  rejectSteeringWaiters(pending, error) {
    for (const waiter of pending?.steerWaiters?.values?.() ?? []) waiter.reject(error);
    pending?.steerWaiters?.clear?.();
    pending?.steerIds?.clear?.();
    for (const timer of pending?.steeringTimers?.values?.() ?? []) clearTimeout(timer);
    pending?.steeringTimers?.clear?.();
    for (const timer of pending?.steeringClaimPollers?.values?.() ?? []) clearTimeout(timer);
    pending?.steeringClaimPollers?.clear?.();
  }

  async failSteeringPending(pending, error) {
    if (!pending || pending.steeringFailure) return;
    const failure = error?.code?.startsWith?.('AGY_STEER_')
      ? error : steeringError('agy steering became uncertain');
    pending.steeringFailure = failure;
    let finalFailure = failure;
    if (typeof this.steeringCoordinator?.block === 'function') {
      try {
        await this.steeringCoordinator.block(failure.rpcMessage);
      } catch (blockError) {
        finalFailure = steeringError('agy steering block could not be persisted; outcome remains uncertain');
        finalFailure.cause = blockError;
        finalFailure.causeCodes = [
          ...(Array.isArray(failure.causeCodes) ? failure.causeCodes : []),
          typeof blockError?.code === 'string' ? blockError.code : 'UNKNOWN'
        ];
      }
    }
    pending.steeringFailure = finalFailure;
    this.steeringBindingFailed = true;
    this.steeringBindingResolve?.();
    this.steeringBindingResolve = null;
    this.steeringBlocked = true;
    this.contextLost = true;
    this.resumeEligible = false;
    const child = this.child;
    if (child) {
      try {
        await this.stopAndWaitForClose(child, 'agy steering provider retirement could not be confirmed');
      } catch {
        const causeCodes = [
          ...(Array.isArray(finalFailure.causeCodes) ? finalFailure.causeCodes : []),
          typeof finalFailure.code === 'string' ? finalFailure.code : 'AGY_STEER_UNCERTAIN',
          'AGY_PROVIDER_RETIREMENT_UNCONFIRMED'
        ];
        finalFailure = steeringError('agy steering provider retirement could not be confirmed');
        finalFailure.causeCodes = [...new Set(causeCodes)];
      }
    }
    pending.steeringFailure = finalFailure;
    this.rejectSteeringWaiters(pending, finalFailure);
    this.finishPending(finalFailure);
  }

  validateEventConversation(event, sourceChild) {
    if (event.event === 'init') {
      const id = event.conversation_id;
      if (!validConversationId(id)) {
        this.failProviderEvent(wrapperError('agy returned an invalid conversation id'));
        return false;
      }
      if (this.conversationId && this.conversationId !== id) {
        this.failProviderEvent(wrapperError('agy resume conversation id mismatch'));
        return false;
      }
      this.conversationId ??= id;
      return true;
    }
    const isTrackedEvent = event.event === 'step_update' || event.event === 'result';
    const eventId = event.step_update?.conversation_id ?? event.result?.conversation_id;
    if (this.conversationId && isTrackedEvent) {
      if (eventId !== undefined && eventId !== this.conversationId) {
        this.failProviderEvent(wrapperError('agy conversation id mismatch'));
        return false;
      }
      if (eventId === undefined) this.lastTurnIdConfirmed = false;
      if (eventId === undefined) this.turnIdsCoherent = false;
    }
    return true;
  }

  emitToolActivity(step) {
    const index = boundedStepIndex(step?.step_index);
    const name = boundedToolName(step?.tool_name ?? step?.tool_info?.name);
    const status = activityState(step?.state);
    if (index === null || name === null || status === null) return;
    const duration = boundedDuration(step?.duration_seconds);
    const update = { sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
      toolCallId: `agy-${this.activityNonce}-tool-${this.pending.turnId}-${index}`, title: name, toolName: name, kind: 'other', status, index };
    addDuration(update, duration);
    if (status === 'in_progress') this.pending.activeTools.set(index, { name });
    else this.pending.activeTools.delete(index);
    this.pending.onActivity(update);
  }

  failResume(error) {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.awaitingResumeInit = false;
    this.resumeEligible = false;
    this.contextLost = true;
    const child = this.child;
    this.child = null;
    this.childSteeringEnabled = false;
    this.buffer = '';
    this.sentSystemPrompt = false;
    if (child) stopChild(child);
    this.finishPending(error);
  }

  finishPending(error, value, durationOverride) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    this.emitPendingActivity(pending, error ? 'failed' : 'completed', durationOverride);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  emitPendingActivity(pending, status, durationOverride) {
    if (!pending?.started || pending.providerTerminal) return;
    if (pending.activeTools.size) {
      for (const [index, tool] of pending.activeTools) {
        pending.onActivity({ sessionUpdate: 'tool_call_update',
          toolCallId: `agy-${this.activityNonce}-tool-${pending.turnId}-${index}`,
          title: tool.name, toolName: tool.name, kind: 'other', status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'Final state unconfirmed' } }] });
      }
      pending.activeTools.clear();
    }
    const duration = boundedDuration(durationOverride) === null
      ? (pending.startedAt === null ? null : (this.nowFn() - pending.startedAt) / 1000)
      : durationOverride;
    const update = { sessionUpdate: 'tool_call_update', toolCallId: `agy-${this.activityNonce}-provider-${pending.turnId}`,
      title: 'Model generation', toolName: 'agy_provider', kind: 'other', status, index: 0 };
    addDuration(update, duration);
    pending.onActivity(update);
    pending.providerTerminal = true;
  }
}
