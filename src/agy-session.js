import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const PINNED_MODEL = 'gemini-3.8-flash-high';
export const MAX_MODEL_LENGTH = 128;
export const MAX_CONVERSATION_ID_LENGTH = 256;
export const MAX_TOOL_NAME_LENGTH = 128;
export const MAX_STEP_INDEX = 1_000_000;
export const MAX_DURATION_SECONDS = 31_536_000;
export const RESUME_INIT_TIMEOUT_MS = 15_000;
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
    resumeTimeoutMs = RESUME_INIT_TIMEOUT_MS } = {}) {
    this.command = command;
    this.prefixArgs = prefixArgs;
    this.cwd = cwd;
    this.model = validateModel(model);
    this.systemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : null;
    this.sentSystemPrompt = false;
    this.spawnFn = spawnFn;
    this.nowFn = nowFn;
    if (!Number.isInteger(resumeTimeoutMs) || resumeTimeoutMs < 1 || resumeTimeoutMs > 60_000) {
      throw new TypeError('resumeTimeoutMs must be a bounded positive integer');
    }
    this.resumeTimeoutMs = resumeTimeoutMs;
    this.child = null;
    this.pending = null;
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
  }

  prompt(text, onText, onActivity) {
    if (this.pending) return Promise.reject(wrapperError('session is busy'));
    if (this.contextLost) return Promise.reject(wrapperError(CONTEXT_LOST_MESSAGE));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, text, onText: typeof onText === 'function' ? onText : () => {},
        onActivity: typeof onActivity === 'function' ? onActivity : () => {}, emittedText: '', resuming: false,
        rotating: false, turnId: ++this.turnSequence, activeTools: new Map(), startedAt: null, providerTerminal: false };
      this.pending = pending;
      void this.startPending(pending);
    });
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
    const closePromise = this.childClosePromise;
    stopChild(child);
    if (closePromise) await closePromise;
    if (this.child === child) throw wrapperError('agy previous child did not close');
    if (!this.conversationId || !this.lastTurnIdConfirmed) {
      this.contextLost = true;
      this.resumeEligible = false;
      throw wrapperError('agy cannot rotate without a confirmed conversation');
    }
    this.resumeEligible = true;
  }

  waitForClose() {
    return this.lastChildClosePromise ?? Promise.resolve();
  }

  setTrustedConversation(conversationId) {
    if (this.pending || this.child) throw wrapperError('agy conversation is already active');
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
    const content = !pending.resuming && !this.sentSystemPrompt && this.systemPrompt
      ? `${this.systemPrompt}\n\n--- Buzz ACP bridge ---\nThe wrapper publishes your final response to Buzz using the platform transport. Return only the final answer; do not call Buzz tools or attempt to publish.\n--- End Buzz ACP bridge ---\n\n--- Buzz system prompt / user prompt ---\n${pending.text ?? ''}`
      : pending.text;
    try {
      this.child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
      this.sentSystemPrompt = true;
      pending.started = true;
      pending.startedAt = this.childStartedAt ?? this.nowFn();
      pending.onActivity({ sessionUpdate: 'tool_call', toolCallId: `agy-${this.activityNonce}-provider-${pending.turnId}`,
        title: 'Gemini generation', toolName: 'agy_provider', kind: 'other', status: 'in_progress', index: 0 });
    } catch {
      this.failResume(wrapperError('agy input failed'));
    }
  }

  cancel() {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    this.emitPendingActivity(pending, 'failed');
    pending.reject(Object.assign(new Error('prompt cancelled'), { code: 'CANCELLED' }));
    const child = this.child;
    this.child = null;
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
    const child = this.child;
    this.child = null;
    this.sentSystemPrompt = false;
    this.awaitingResumeInit = false;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.resumeEligible = false;
    if (this.pending) this.finishPending(wrapperError('agy session closed'));
    this.buffer = '';
    this.childStartedAt = null;
    if (child) stopChild(child);
  }

  ensureStarted(resume = false) {
    if (this.child) return;
    const startedAt = this.nowFn();
    const args = [...this.prefixArgs, ...pinnedAgyArgs(this.model)];
    if (resume) args.push('--conversation', this.conversationId);
    const child = this.spawnFn(this.command, args, {
      shell: false,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk, child));
    child._agyResume = resume;
    this.childStartedAt = startedAt;
    this.childClosePromise = new Promise((resolve) => { child._agyCloseResolve = resolve; });
    this.lastChildClosePromise = this.childClosePromise;
    this.awaitingResumeInit = resume;
    if (resume) this.resumeEligible = false;
    // An EPIPE on a dead child's stdin arrives as an asynchronous stream 'error'.
    // Without this listener Node would throw it as an unhandled error event and
    // take the whole adapter down instead of failing the single turn.
    child.stdin.on('error', () => {
      if (this.child !== child) return;
      child._agyCloseResolve?.();
      child._agyCloseResolve = null;
      this.child = null;
      this.buffer = '';
      this.sentSystemPrompt = false;
      this.awaitingResumeInit = false;
      this.resumeEligible = false;
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      this.contextLost = true;
      stopChild(child);
      this.finishPending(wrapperError('agy input failed'));
    });
    child.on('error', () => {
      if (this.child !== child) return;
      child._agyCloseResolve?.();
      child._agyCloseResolve = null;
      this.child = null;
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
      this.childStartedAt = null;
      this.buffer = '';
      this.sentSystemPrompt = false;
      this.awaitingResumeInit = false;
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      // Report how long this agy process had been alive. --print-timeout is a
      // per-process wall clock, so an exit that lands on the pin is a different
      // failure from a crash on the first turn, and the age is the only signal
      // that tells them apart from outside the CLI's own log files.
      if (this.pending && !this.pending.rotating) {
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
        this.failResume(wrapperError('agy returned invalid stream JSON'));
        return;
      }
      if (sourceChild._agyResume && this.awaitingResumeInit && event.event !== 'init') {
        this.failResume(wrapperError('agy resume requires matching init before provider events'));
        return;
      }
      if (!this.validateEventConversation(event, sourceChild)) return;
      if (event.event === 'init') {
        if (sourceChild._agyResume) {
          this.awaitingResumeInit = false;
          if (this.resumeTimer) clearTimeout(this.resumeTimer);
          this.resumeTimer = null;
          this.sendPendingPrompt();
        }
      } else if (event.event === 'step_update' && this.pending) {
        const step = event.step_update;
        const type = typeof step?.step_type === 'string' ? step.step_type : 'agent_response';
        if (type === 'agent_response' && typeof step.text_delta === 'string') {
          this.pending.emittedText += step.text_delta;
          this.pending.onText(step.text_delta);
        } else if (type === 'tool') {
          this.emitToolActivity(step);
        }
      } else if (event.event === 'response' && typeof event.response?.text === 'string' && this.pending) {
        this.pending.emittedText += event.response.text;
        this.pending.onText(event.response.text);
      } else if (event.event === 'result' && this.pending) {
        const result = event.result;
        if (result?.status === 'SUCCESS') {
          this.conversationEstablished = true;
          this.lastTurnSucceeded = true;
          this.lastTurnIdConfirmed = this.turnIdsCoherent && Boolean(this.conversationId &&
            typeof result.conversation_id === 'string' && result.conversation_id === this.conversationId);
          if (!this.pending.emittedText && typeof result.response === 'string') {
            this.pending.onText(result.response);
          }
          const response = typeof result.response === 'string' ? result.response : this.pending.emittedText;
          this.finishPending(null, response, result.duration_seconds);
        }
        else {
          this.lastTurnSucceeded = false;
          this.finishPending(wrapperError('agy returned an unsuccessful result'));
        }
      }
    }
  }

  validateEventConversation(event, sourceChild) {
    if (event.event === 'init') {
      const id = event.conversation_id;
      if (!validConversationId(id)) {
        this.failResume(wrapperError('agy returned an invalid conversation id'));
        return false;
      }
      if (this.conversationId && this.conversationId !== id) {
        this.failResume(wrapperError('agy resume conversation id mismatch'));
        return false;
      }
      this.conversationId ??= id;
      return true;
    }
    const isTrackedEvent = event.event === 'step_update' || event.event === 'result';
    const eventId = event.step_update?.conversation_id ?? event.result?.conversation_id;
    if (this.conversationId && isTrackedEvent) {
      if (eventId !== undefined && eventId !== this.conversationId) {
        this.failResume(wrapperError('agy conversation id mismatch'));
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
      title: 'Gemini generation', toolName: 'agy_provider', kind: 'other', status, index: 0 };
    addDuration(update, duration);
    pending.onActivity(update);
    pending.providerTerminal = true;
  }
}
