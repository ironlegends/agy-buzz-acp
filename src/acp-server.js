import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promptToText } from './prompt.js';
import { AgySession } from './agy-session.js';
import { parseBuzzContext, buzzContextFailure } from './buzz-context.js';
import { BuzzPublisher } from './buzz-publisher.js';
import { createConfiguredOutbox } from './delivery/outbox.js';
import { getBuzzPublicKey } from './delivery/identity.js';
import { ownershipFailureReason, createConfiguredSessionState } from './session-state.js';
import { listModels, modelConfigOptions } from './models.js';
import { createSteeringCoordinator, inspectSteeringBridge, reconcileSteeringBridge, MAX_STEERING_TEXT_LENGTH, readBooleanFlag } from './steering.js';
import { attachLineDecoder, FRAME_TOO_LARGE, FRAME_INVALID_UTF8, resolveFrameLimits } from './frame-codec.js';

const JSON_RPC = '2.0';
const TERMINAL_SESSION_CONTEXT_MESSAGE = 'agy session context lost; resume unsupported';
const STEERING_RPC_CODE = -32004;
const STEERING_UNCERTAIN_MESSAGE = 'agy steering outcome is uncertain';
const OWNER_RE = /^[0-9a-f]{64}$/i;

function steeringConfiguration(env = process.env, override = {}) {
  const hookConfigured = readBooleanFlag(override.hookConfigured ?? env.AGY_STEER_HOOK_CONFIGURED);
  const injectorExclusive = readBooleanFlag(override.injectorExclusive ?? env.AGY_STEER_INJECTOR_EXCLUSIVE);
  const ownerId = override.ownerId ?? env.AGY_STEER_OWNER ?? env.AGY_SESSION_OWNER;
  return {
    hookConfigured,
    injectorExclusive,
    ownerId,
    rootDir: override.rootDir ?? env.AGY_STEER_ROOT_DIR,
    enabled: Boolean(hookConfigured && injectorExclusive && OWNER_RE.test(ownerId ?? ''))
  };
}

function steeringRpcError(message, code = STEERING_RPC_CODE) {
  return Object.assign(new Error(message), { rpcCode: code, rpcMessage: message, code: 'AGY_STEER_PROTOCOL' });
}

function normalizeSteeringPrompt(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw steeringRpcError('agy steering prompt must contain text blocks', -32602);
  }
  let text = '';
  for (const block of prompt) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      throw steeringRpcError('only ACP text steering prompt blocks are supported', -32602);
    }
    text += block.text;
    if (text.length > MAX_STEERING_TEXT_LENGTH) {
      throw steeringRpcError('agy steering prompt is too long', -32602);
    }
  }
  if (text.trim().length === 0) throw steeringRpcError('agy steering prompt is invalid', -32602);
  return text;
}

function rpcResult(id, result) {
  return { jsonrpc: JSON_RPC, id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: JSON_RPC, id: id ?? null, error: { code, message } };
}

const CONTEXT_PROBE_MARKERS = [
  '[Base]', '[Context]', '[Thread Context', '[Buzz event:', '[Buzz events',
  '<base>', '<context>', '<thread-context', '<buzz-event'
];

// Structural shape only: block count, block sizes, and marker presence. No message
// bodies, identifiers or secrets are emitted.
export function describePromptShape(prompt) {
  if (!Array.isArray(prompt)) return `notArray type=${typeof prompt}`;
  const blocks = prompt.map((block, index) => {
    if (!block || typeof block !== 'object') return `${index}:nonObject`;
    if (block.type !== 'text' || typeof block.text !== 'string') return `${index}:type=${String(block.type)}`;
    const starts = CONTEXT_PROBE_MARKERS.filter((marker) => block.text.startsWith(marker)).join('|') || 'none';
    const contains = CONTEXT_PROBE_MARKERS.filter((marker) => block.text.includes(marker)).join('|') || 'none';
    return `${index}:len=${block.text.length}:startsWith=${starts}:contains=${contains}`;
  });
  return `blocks=${prompt.length} ${blocks.join(' ; ')}`;
}

export function createAcpServer({ input = process.stdin, output = process.stdout, diagnostics = process.stderr, sessionFactory, publisherFactory, outboxFactory, identityFactory, sessionStateFactory, modelCatalogFactory, steeringFactory, steeringConfig, steeringSupported, frameLimits = {} } = {}) {
  const resolvedFrameLimits = resolveFrameLimits(frameLimits);
  const maxFrameBytes = resolvedFrameLimits.maxFrameBytes;
  const sessions = new Map();
  const activeTurns = new Map();
  const recoveries = new Map();
  const recoveryClaims = new Set();
  const channelSessions = new Map();
  const activeHandles = new Set();
  const makeSession = sessionFactory ?? ((options) => new AgySession({ ...options,
    command: process.env.AGY_COMMAND || 'agy',
    prefixArgs: process.env.AGY_FAKE_SCRIPT ? [process.env.AGY_FAKE_SCRIPT] : [],
    frameLimits: resolvedFrameLimits
  }));
  const modelCommand = process.env.AGY_COMMAND || 'agy';
  const modelPrefixArgs = process.env.AGY_FAKE_SCRIPT ? [process.env.AGY_FAKE_SCRIPT] : [];
  const getModelCatalog = modelCatalogFactory ?? ((options) => {
    // Fixture providers are prompt-only and intentionally do not implement `models`.
    // Keep those integration tests offline while the normal path probes agy lazily.
    if (sessionFactory || process.env.AGY_FAKE_SCRIPT) return Promise.resolve([]);
    return listModels(options);
  });
  const makePublisher = publisherFactory ?? (() => new BuzzPublisher({
    command: process.env.BUZZ_CLI_COMMAND || 'buzz',
    prefixArgs: process.env.BUZZ_FAKE_SCRIPT ? [process.env.BUZZ_FAKE_SCRIPT] : []
  }));
  const outbox = outboxFactory ? outboxFactory() : createConfiguredOutbox();
  const sessionState = sessionStateFactory ? sessionStateFactory() : createConfiguredSessionState();
  const resolvedSteeringConfig = steeringConfiguration(process.env, steeringConfig);
  const steeringCapability = Boolean(steeringSupported ?? Boolean(steeringFactory ? true : resolvedSteeringConfig.enabled));
  const makeSteering = steeringFactory ?? ((options) => createSteeringCoordinator(options));
  const makeIdentity = identityFactory ?? (() => getBuzzPublicKey({
    command: process.env.BUZZ_CLI_COMMAND || 'buzz',
    prefixArgs: process.env.BUZZ_FAKE_SCRIPT ? [process.env.BUZZ_FAKE_SCRIPT] : []
  }));
  let publisher;
  let initialized = false;
  let closing = false;
  function steeringLocation(channelId) {
    const ownerId = resolvedSteeringConfig.ownerId ?? sessionState?.owner;
    const rootDir = resolvedSteeringConfig.rootDir ?? join(tmpdir(), 'agy-buzz-steering');
    const bridgeKey = createHash('sha256').update(`${ownerId ?? 'test'}:${channelId}`).digest('hex');
    const steeringSessionId = `channel_${createHash('sha256').update(channelId).digest('hex').slice(0, 96)}`;
    return { ownerId, rootDir, bridgeDir: join(rootDir, `channel-${bridgeKey}`), steeringSessionId };
  }

  // Channels whose current turn has invalidated durable state and has not yet
  // finished. This is a liveness guard, not process-lifetime ownership: once the
  // turn fully settles, a later prompt may reconcile under the durable outbox and
  // channel-lock guards, exactly as a fresh adapter process would.
  const channelsWithLiveBlock = new Set();

  // Durable half of the same question, and the only one that survives a restart: an
  // outbox record still `inflight` or `uncertain` means an external effect happened
  // whose outcome nobody has settled. That block is not orphaned, it is waiting for
  // an operator, and reconciliation must leave it exactly where it is.
  //
  // A disabled or unreadable outbox cannot answer that question at all, and an
  // unanswered question refuses. Answering `no unsettled delivery` there left the
  // only durable condition inert in the default configuration, where the outbox
  // is off, and every test of reconciliation ran in exactly that configuration.
  const unsettledDeliveryRefusal = async (channelId) => {
    if (!outbox?.enabled || typeof outbox.list !== 'function') return 'delivery outbox is disabled';
    let records;
    try { records = await outbox.list(); }
    catch { return 'delivery outbox is unreadable'; }
    return records.some((record) => record?.channelId === channelId &&
      (record.status === 'uncertain' || record.status === 'inflight'))
      ? 'an unsettled delivery is waiting'
      : null;
  };

  // In-process half of the reconciliation guard. The other half is the session
  // ownership lock, which no second adapter can hold at the same time; neither guard
  // proves that a provider descendant of a dead parent has exited.
  const channelBusyElsewhere = (channelId, sessionId) => {
    for (const activeSessionId of activeTurns.keys()) {
      if (activeSessionId === sessionId) continue;
      if (sessions.get(activeSessionId)?.channelId === channelId) return true;
    }
    return false;
  };

  // Retain the liveness guard through cleanup; no recovery can race an active turn.
  const settleLiveBlock = (channelId, sessionId) => {
    if (!channelId || channelBusyElsewhere(channelId, sessionId)) return;
    channelsWithLiveBlock.delete(channelId);
  };

  const reconciliationRefusal = async (channelId, sessionId) => {
    if (channelsWithLiveBlock.has(channelId)) return 'a live turn in this process owns the block';
    if (channelBusyElsewhere(channelId, sessionId)) return 'another turn holds the channel';
    return unsettledDeliveryRefusal(channelId);
  };

  // Durable state is loaded before steering inspection. A fresh parent's unknown
  // blocked record therefore refuses before a bridge can be archived, while a
  // settled turn still inspects an existing bridge before creating its own block.
  // The inspection's ownership check remains idempotent with the state operations.
  const steeringReconciliationRefusal = async (channelId, sessionId) => {
    if (!sessionState?.enabled) return 'durable session state is disabled';
    try { await sessionState.ensureOwnership(channelId); }
    catch (error) { return ownershipFailureReason(error); }
    return reconciliationRefusal(channelId, sessionId);
  };

  async function inspectExistingSteering(entry, channelId, sessionId) {
    if (!steeringCapability || steeringFactory) return;
    const location = steeringLocation(channelId);
    if (!OWNER_RE.test(location.ownerId ?? '')) return;
    const status = await inspectSteeringBridge({
      bridgeDir: location.bridgeDir,
      ownerId: location.ownerId,
      channelId
    });
    // The bridge on disk is authoritative and is inspected on every prompt. Copying
    // the verdict onto the pool entry would keep masking a repaired bridge for the
    // whole life of this process, long after the durable state became sound again.
    if (!status.blocked) return;
    const refusal = await steeringReconciliationRefusal(channelId, sessionId);
    if (refusal) {
      report(`steering reconciliation refused channel=${channelId} reason=${refusal}`);
      throw steeringRpcError('agy steering is durably blocked');
    }
    const { archivedTo } = await reconcileSteeringBridge({
      bridgeDir: location.bridgeDir,
      ownerId: location.ownerId,
      channelId
    });
    if (!archivedTo) throw steeringRpcError('agy steering is durably blocked');
    // The coordinator cached on the entry still points at the directory that was just
    // renamed. Drop it so `ensureSteering` builds one on the bridge that replaces it.
    entry.steering = null;
    entry.session.setSteeringCoordinator?.(null);
    report(`steering bridge reconciled channel=${channelId} archived=${archivedTo}`);
  }

  async function ensureSteering(entry, channelId) {
    if (!steeringCapability || entry.steering) return entry.steering ?? null;
    const knownConversationId = entry.session.getConversationId?.();
    const ownerId = resolvedSteeringConfig.ownerId ?? sessionState?.owner;
    if (!steeringFactory && !OWNER_RE.test(ownerId ?? '')) return null;
    const location = steeringLocation(channelId);
    const conversationBound = typeof knownConversationId === 'string' && knownConversationId.length > 0;
    const conversationId = conversationBound ? knownConversationId : `pending-${location.steeringSessionId}`;
    const coordinator = await makeSteering({
      rootDir: location.rootDir,
      bridgeDir: location.bridgeDir,
      ownerId,
      channelId,
      sessionId: location.steeringSessionId,
      conversationId,
      hookConfigured: steeringFactory ? true : resolvedSteeringConfig.hookConfigured,
      injectorExclusive: steeringFactory ? true : resolvedSteeringConfig.injectorExclusive,
      conversationBound
    });
    if (!coordinator?.enabled || typeof coordinator.enqueue !== 'function' ||
        typeof coordinator.observeUserInput !== 'function' || typeof coordinator.snapshot !== 'function' ||
        typeof coordinator.block !== 'function') {
      throw steeringRpcError('agy steering dedicated hook is unavailable');
    }
    coordinator.assertBinding?.({ ownerId, channelId, sessionId: location.steeringSessionId, conversationId });
    entry.steering = coordinator;
    entry.session.setSteeringCoordinator?.(coordinator);
    return coordinator;
  }

  // With durable session state the record on disk already carries the block, and
  // `session/prompt` reads it again on every turn. Only the memory-only mode has no
  // record to re-read, so it is the only mode that still needs a sticky marker.
  const blockEntry = (entry) => {
    if (sessionState?.enabled) return;
    entry.stateError ??= TERMINAL_SESSION_CONTEXT_MESSAGE;
  };

  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const report = (message) => diagnostics.write(`[agy-buzz-acp] ${message}\n`);
  const emitActivity = (sessionId, update) => write({
    jsonrpc: JSON_RPC,
    method: 'session/update',
    params: { sessionId, update }
  });
  const emitDeliveryDiagnostic = (sessionId, status, recoveryId) => write({
    jsonrpc: JSON_RPC,
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `[Delivery status] ${status}${recoveryId ? `; recovery ${recoveryId}` : ''}` } } }
  });

  async function handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      write(rpcError(null, -32600, 'invalid JSON-RPC request'));
      return;
    }
    const idPresent = Object.prototype.hasOwnProperty.call(message, 'id');
    const rawId = message.id;
    const idValid = !idPresent || rawId === null || typeof rawId === 'string' ||
      (typeof rawId === 'number' && Number.isFinite(rawId));
    if (!idValid) {
      write(rpcError(null, -32600, 'invalid JSON-RPC request id'));
      return;
    }
    const id = idPresent ? rawId : undefined;
    if (message.jsonrpc !== JSON_RPC || typeof message.method !== 'string') {
      write(rpcError(id, -32600, 'invalid JSON-RPC request'));
      return;
    }
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    try {
      if (closing) throw Object.assign(new Error('agy adapter is closed'), { rpcCode: -32000, rpcMessage: 'agy adapter is closed' });
      if (message.method === 'initialize') {
        if (![1, 2].includes(params.protocolVersion)) throw Object.assign(new Error('unsupported ACP protocol version'), { rpcCode: -32602 });
        initialized = true;
        const negotiatedVersion = 1;
        if (id !== undefined) write(rpcResult(id, {
          protocolVersion: negotiatedVersion,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false }
          },
          _meta: { steering: { supported: steeringCapability } },
            agentInfo: { name: 'agy-buzz-acp', version: '0.5.9' }
        }));
        return;
      }
      if (!initialized) throw Object.assign(new Error('initialize is required'), { rpcCode: -32000 });
      if (message.method === 'session/new') {
        if (typeof params.cwd !== 'string' || !params.cwd.trim() || !isAbsolute(params.cwd)) {
          throw Object.assign(new Error('session cwd must be a non-empty absolute path'), { rpcCode: -32602 });
        }
        const sessionId = `ses_${randomUUID().replaceAll('-', '')}`;
        if (Object.prototype.hasOwnProperty.call(params, 'model')) {
          throw Object.assign(new Error('model override is not supported'), { rpcCode: -32602 });
        }
        const configuredModel = process.env.AGY_MODEL ?? 'gemini-3.8-flash-high';
        let catalog;
        try {
          const result = await getModelCatalog({ command: modelCommand, cwd: params.cwd, prefixArgs: modelPrefixArgs });
          catalog = Array.isArray(result) ? result : [];
        } catch {
          catalog = [];
        }
        catalog = Object.freeze(catalog.reduce((models, candidate) => {
          if (candidate && typeof candidate.modelId === 'string' && typeof candidate.name === 'string' &&
              /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(candidate.modelId) && candidate.name.trim() &&
              !models.some((model) => model.modelId === candidate.modelId)) {
            models.push(Object.freeze({ modelId: candidate.modelId, name: candidate.name.trim() }));
          }
          return models;
        }, []));
        if (closing) throw Object.assign(new Error('agy adapter is closed'), { rpcCode: -32000, rpcMessage: 'agy adapter is closed' });
        const requestedModel = configuredModel;
        if (typeof requestedModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(requestedModel)) {
          throw Object.assign(new Error('model must be a non-empty bounded string'), { rpcCode: -32602 });
        }
        // ACP transports MCP declarations here, but this adapter deliberately does not bridge or persist them.
        const systemPrompt = typeof params.systemPrompt === 'string' && params.systemPrompt.trim() ? params.systemPrompt : undefined;
        const session = makeSession({
          sessionId,
          cwd: params.cwd,
          systemPrompt,
          model: requestedModel,
          frameLimits: resolvedFrameLimits
        });
        session.setModelCatalog?.(catalog);
        sessions.set(sessionId, { session, sessionId, cwd: params.cwd,
          model: requestedModel, modelCatalog: catalog, bound: false, stateError: null,
          steering: null, systemPrompt, needsReplacement: false, cachedConversationBound: false,
          providerEverStarted: false, blockCreatedByThisParent: false,
          safeToTransfer: false, channelTransferInvalidated: false });
        if (id !== undefined) write(rpcResult(id, { sessionId, configOptions: modelConfigOptions(catalog, requestedModel) }));
        return;
      }
      if (message.method === 'session/set_config_option') {
        const entry = sessions.get(params.sessionId);
        if (!entry) throw Object.assign(new Error('unknown session'), { rpcCode: -32001 });
        if (activeTurns.has(params.sessionId)) throw Object.assign(new Error('session turn is busy'), { rpcCode: -32002 });
        const configId = params.configId ?? params.id;
        if (configId !== 'model') throw Object.assign(new Error('unknown config option'), { rpcCode: -32602 });
        const value = params.value;
        if (typeof value !== 'string' || !entry.modelCatalog.some((item) => item.modelId === value)) {
          throw Object.assign(new Error('agy model is not available in this session catalog'), { rpcCode: -32602 });
        }
        if (typeof entry.session.setModel !== 'function') {
          throw Object.assign(new Error('session model configuration is unavailable'), { rpcCode: -32603 });
        }
        entry.session.setModel(value);
        entry.model = value;
        if (id !== undefined) write(rpcResult(id, { configOptions: modelConfigOptions(entry.modelCatalog, value) }));
        return;
      }
      if (message.method === '_session/steering') {
        const entry = sessions.get(params.sessionId);
        if (!entry) throw Object.assign(new Error('unknown session'), { rpcCode: -32001 });
        if (!steeringCapability || !entry.steering || typeof entry.session.steer !== 'function') {
          throw steeringRpcError('agy steering is unavailable without a confirmed dedicated hook');
        }
        if (entry.stateError) throw steeringRpcError(entry.stateError);
        const steerText = normalizeSteeringPrompt(params.prompt);
        const outcome = await entry.session.steer(steerText);
        if (outcome?.outcome !== 'injected') throw steeringRpcError(STEERING_UNCERTAIN_MESSAGE);
        if (id !== undefined) write(rpcResult(id, { outcome: 'injected' }));
        return;
      }
      if (message.method === 'session/prompt') {
        if (Object.prototype.hasOwnProperty.call(params, 'model')) throw Object.assign(new Error('model override is not supported'), { rpcCode: -32602 });
        const entry = sessions.get(params.sessionId);
        if (!entry) throw Object.assign(new Error('unknown session'), { rpcCode: -32001 });
        let session = entry.session;
        if (activeTurns.has(params.sessionId)) throw Object.assign(new Error('session turn is busy'), { rpcCode: -32002 });
        if (entry.stateError) throw Object.assign(new Error(entry.stateError), { rpcCode: -32603, rpcMessage: entry.stateError });
        if (entry.channelTransferInvalidated) {
          throw Object.assign(new Error('agy ACP session no longer owns the channel'), {
            rpcCode: -32002, rpcMessage: 'agy ACP session no longer owns the channel'
          });
        }
        const text = promptToText(params.prompt);
        report(`session/prompt blocks=${Array.isArray(params.prompt) ? params.prompt.length : 0}`);
        const buzzContext = parseBuzzContext(params.prompt);
        if (!buzzContext) {
          report(`context parse failed ${describePromptShape(params.prompt)}`);
          const reason = buzzContextFailure(params.prompt);
          throw Object.assign(new Error(reason), { rpcCode: -32603, rpcMessage: reason });
        }
        if (entry.channelId && entry.channelId !== buzzContext.channelId) {
          throw Object.assign(new Error('agy session channel scope cannot change'), { rpcCode: -32602, rpcMessage: 'agy session channel scope cannot change' });
        }
        entry.channelId ??= buzzContext.channelId;
        // Reserve before the first await, including steering inspection/recovery.
        const controller = new AbortController();
        activeTurns.set(params.sessionId, controller);
        let stateScope = null;
        let transferFrom = null;
        let transferCommitted = false;
        let directProviderRetired = false;
        const ownershipPreviouslyHeld = sessionState?.ownsChannel?.(buzzContext.channelId) !== false;
        try {
          if ((sessionState?.enabled || steeringCapability) && channelBusyElsewhere(buzzContext.channelId, params.sessionId)) {
            throw steeringRpcError('agy channel turn is busy');
          }
          if (sessionState?.configurationError) {
            throw Object.assign(new Error(sessionState.configurationError), { rpcCode: -32602, rpcMessage: sessionState.configurationError });
          }
          if (sessionState?.enabled) {
            await sessionState.verifyIdentity(makeIdentity);
            stateScope = await sessionState.scope({ channelId: buzzContext.channelId, cwd: entry.cwd, model: entry.model });
            const existingSessionId = channelSessions.get(buzzContext.channelId);
            if (existingSessionId && existingSessionId !== params.sessionId) {
              const existingEntry = sessions.get(existingSessionId);
              const transferable = Boolean(existingEntry && existingEntry.safeToTransfer &&
                !existingEntry.channelTransferInvalidated && !existingEntry.needsReplacement &&
                !existingEntry.stateError && !activeTurns.has(existingSessionId) &&
                !channelsWithLiveBlock.has(buzzContext.channelId));
              if (!transferable) {
                throw Object.assign(new Error('agy channel session is already owned'), {
                  rpcCode: -32002, rpcMessage: 'agy channel session is already owned'
                });
              }
              const deliveryRefusal = await unsettledDeliveryRefusal(buzzContext.channelId);
              if (deliveryRefusal) {
                report(`channel transfer refused channel=${buzzContext.channelId} reason=${deliveryRefusal}`);
                throw Object.assign(new Error('agy channel session transfer is not yet safe'), {
                  rpcCode: -32002, rpcMessage: 'agy channel session transfer is not yet safe'
                });
              }
              transferFrom = existingEntry;
            }
            channelSessions.set(buzzContext.channelId, params.sessionId);
          }
          if (entry.needsReplacement) {
            if (!stateScope) throw steeringRpcError('agy recovery requires durable session state');
            const refusal = await reconciliationRefusal(buzzContext.channelId, params.sessionId);
            if (refusal) {
              report(`session recovery refused channel=${buzzContext.channelId} reason=${refusal}`);
              throw Object.assign(new Error('agy session state is blocked after an incomplete turn'), { rpcMessage: 'agy session state is blocked after an incomplete turn' });
            }
            if (typeof session.retireForRecovery !== 'function' || await session.retireForRecovery() !== true) {
              throw steeringRpcError('agy provider retirement could not be confirmed');
            }
            directProviderRetired = true;
          }
          if (sessionState?.enabled) {
            let saved;
            try {
              saved = await sessionState.load(stateScope);
            } catch (error) {
              if (error?.code !== 'AGY_SESSION_STATE_BLOCKED') {
                // Keep the steering refusal category when durable ownership cannot
                // be reread. This path never archives: inspection only repeats the
                // same ownership guard before the original state error escapes.
                const stateDataError = error?.code === 'AGY_SESSION_STATE' ||
                  error?.code === 'AGY_SESSION_SCOPE_MISMATCH';
                if (steeringCapability && !stateDataError) {
                  await inspectExistingSteering(entry, buzzContext.channelId, params.sessionId);
                }
                throw error;
              }
              const noStartProof = Boolean(entry.blockCreatedByThisParent && !entry.providerEverStarted &&
                !transferFrom && channelSessions.get(buzzContext.channelId) === params.sessionId);
              if (!directProviderRetired && !noStartProof) {
                const refusal = await reconciliationRefusal(buzzContext.channelId, params.sessionId);
                if (refusal) {
                  report(`session record reconciliation refused channel=${buzzContext.channelId} reason=${refusal}`);
                  throw error;
                }
                report(`session record reconciliation refused channel=${buzzContext.channelId} reason=provider retirement proof unavailable`);
                throw error;
              }
              directProviderRetired = true;
              const outcome = await sessionState.reconcile(stateScope, { directProviderRetired: true });
              if (!outcome.reconciled) throw error;
              report(`session record reconciled channel=${buzzContext.channelId} conversation=${outcome.conversationId ?? 'none'}`);
              saved = await sessionState.load(stateScope);
            }
            if (transferFrom && (!saved || saved.status !== 'ready')) {
              throw Object.assign(new Error('agy channel session transfer requires a ready checkpoint'), {
                rpcCode: -32002, rpcMessage: 'agy channel session transfer requires a ready checkpoint'
              });
            }
            if (transferFrom) {
              // The old entry remains addressable for cleanup, but its ACP identity
              // is irrevocably stale once the durable ready checkpoint is reread.
              transferFrom.safeToTransfer = false;
              transferFrom.channelTransferInvalidated = true;
              transferCommitted = true;
            }
            // A blocked record observed as ready or reconciled no longer carries a
            // no-start proof. The next invalidate below creates a new one for this
            // parent and turn only.
            entry.blockCreatedByThisParent = false;
            if (entry.needsReplacement) {
              // Do not reset contextLost on the failed object or reuse its buffers.
              // Rebind only the association validated above, never an unconfirmed ID.
              const replacement = makeSession({ sessionId: params.sessionId, cwd: entry.cwd,
                model: entry.model, systemPrompt: entry.systemPrompt, frameLimits: resolvedFrameLimits });
              if (!replacement || replacement === session) throw steeringRpcError('agy replacement session is unavailable');
              replacement.setModelCatalog?.(entry.modelCatalog);
              entry.session = session = replacement;
              entry.bound = false;
              entry.cachedConversationBound = false;
              entry.steering = null;
              entry.needsReplacement = false;
              report(`provider session rebuilt channel=${buzzContext.channelId}; interrupted work is not replayed by the adapter`);
              emitDeliveryDiagnostic(params.sessionId, 'Previous turn interrupted; provider session rebuilt. Prior correction consumption and external effects may remain uncertain.');
            }
            if (!entry.bound) {
              if (saved) {
                session.setTrustedConversation?.(saved.conversationId);
                entry.cachedConversationBound = true;
              }
              entry.bound = true;
            }
            // State was loaded (or reconciled with proof) before this inspection, so
            // a fresh parent's unknown blocked record has already been refused. Keep
            // inspection before this turn creates its own durable block, preserving
            // the lock/bridge ordering for a settled turn.
            if (steeringCapability) await inspectExistingSteering(entry, buzzContext.channelId, params.sessionId);
            await sessionState.invalidate(stateScope);
            entry.blockCreatedByThisParent = true;
            channelsWithLiveBlock.add(buzzContext.channelId);
          }
          if (steeringCapability && !sessionState?.enabled) await inspectExistingSteering(entry, buzzContext.channelId, params.sessionId);
          if (steeringCapability) await ensureSteering(entry, buzzContext.channelId);
          if (outbox?.configurationError) {
            throw Object.assign(new Error(outbox.configurationError), { rpcCode: -32602, rpcMessage: outbox.configurationError });
          }
          publisher ??= makePublisher();
          if (!publisher || typeof publisher.publish !== 'function') throw Object.assign(new Error('Buzz publisher unavailable'), { rpcCode: -32603, rpcMessage: 'Buzz publisher unavailable' });
          if (controller.signal.aborted) throw Object.assign(new Error('prompt cancelled'), { code: 'CANCELLED' });
        } catch (error) {
          // Release only an unused lease acquired by this preflight. Keep the
          // active reservation and pin until release completes, so another prompt
          // cannot race ownership cleanup. Cached conversation bindings and previous
          // providers/leases remain pinned, so a peer cannot change their association.
          if (!ownershipPreviouslyHeld && !entry.cachedConversationBound && !entry.providerEverStarted && !entry.needsReplacement &&
              sessionState?.ownsChannel?.(buzzContext.channelId)) {
            try {
              await sessionState.releaseOwnership(buzzContext.channelId);
              // A peer may now establish an association: discard empty cached
              // preflight state so the next attempt binds the new disk record.
              entry.bound = false;
              entry.steering = null;
              session.setSteeringCoordinator?.(null);
            }
            catch {
              entry.stateError = 'agy channel ownership release could not be confirmed';
              report('unused channel ownership release could not be confirmed');
            }
          }
          activeTurns.delete(params.sessionId);
          settleLiveBlock(buzzContext.channelId, params.sessionId);
          // Retain the channel pin after an unconfirmed retirement: a new ACP
          // session must not bypass the failed session's recovery guard.
          if (transferFrom && !transferCommitted && channelSessions.get(buzzContext.channelId) === params.sessionId) {
            channelSessions.set(buzzContext.channelId, transferFrom.sessionId);
          } else if (!transferCommitted && !entry.needsReplacement && !entry.stateError &&
              !entry.blockCreatedByThisParent && channelSessions.get(buzzContext.channelId) === params.sessionId) {
            channelSessions.delete(buzzContext.channelId);
          }
          if (stateScope) blockEntry(entry);
          throw error;
        }
        const toolCallId = `delivery_${randomUUID().replaceAll('-', '')}`;
        const deliveryActivity = (sessionUpdate, title, status, content = title) => emitActivity(params.sessionId, {
          sessionUpdate,
          toolCallId,
          toolName: 'buzz_delivery',
          title,
          kind: 'other',
          status,
          content: [{ type: 'content', content: { type: 'text', text: content } }]
        });
        let providerStarted = false;
        let turnSafe = false;
        let providerRetired = false;
        try {
          providerStarted = true;
          entry.providerEverStarted = true;
          const response = await session.prompt(text, (delta) => write({
            jsonrpc: JSON_RPC,
            method: 'session/update',
            params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } } }
          }), (update) => {
            if (update && typeof update === 'object') emitActivity(params.sessionId, update);
          });
          if (typeof response !== 'string' || !response.trim()) {
            throw Object.assign(new Error('provider produced an empty response'), { rpcCode: -32603, rpcMessage: 'provider produced an empty response' });
          }
          let stagedConversationId = null;
          if (stateScope && sessionState?.enabled) {
            const conversationId = session.getConversationId?.();
            if (!conversationId || !session.hasConfirmedConversation?.() ||
                typeof session.retireForCheckpoint !== 'function' ||
                await session.retireForCheckpoint() !== conversationId) {
              throw steeringRpcError('agy provider retirement could not be confirmed before publication');
            }
            providerRetired = true;
            if (controller.signal.aborted) throw Object.assign(new Error('prompt cancelled'), { code: 'CANCELLED' });
            await sessionState.stageCheckpoint(stateScope, conversationId);
            stagedConversationId = conversationId;
          }
          deliveryActivity('tool_call', 'Response produced', 'pending');
          let recoveryId = null;
          let durabilityFailed = false;
          try { recoveryId = await outbox?.begin({ ...buzzContext, content: response }); }
          catch (error) {
            durabilityFailed = Boolean(outbox?.enabled);
            recoveryId = `mem_${randomUUID().replaceAll('-', '')}`;
            recoveries.set(recoveryId, { ...buzzContext, content: response, owner: outbox?.owner, status: 'failed-before-start' });
            report(`outbox prepare failed code=${error?.code ?? 'unknown'} recovery=${recoveryId}`);
          }
          if (durabilityFailed) {
            blockEntry(entry);
            const delivery = { status: 'failed-before-start', recoveryId };
            deliveryActivity('tool_call_update', 'Publication failed', 'failed', `Publication failed; recovery ${recoveryId}`);
            emitDeliveryDiagnostic(params.sessionId, delivery.status, recoveryId);
            if (id !== undefined) write(rpcResult(id, { stopReason: 'end_turn', publication: delivery }));
            return;
          }
          deliveryActivity('tool_call_update', 'Publication in progress', 'in_progress');
          let publication;
          try { publication = await publisher.publish({ ...buzzContext, content: response }, controller.signal); }
          catch (error) {
            publication = error?.publicationStatus ? { status: error.publicationStatus } : { status: 'uncertain', code: error?.code };
          }
          if (!publication || typeof publication !== 'object') publication = { status: 'uncertain' };
          let status = ['sent', 'failed-before-start', 'uncertain'].includes(publication.status) ? publication.status : 'uncertain';
          if (recoveryId) {
            try {
              const persisted = await outbox.update(recoveryId, { status, ...(publication.eventId ? { eventId: publication.eventId } : {}) });
              if (outbox.enabled && (!persisted || persisted.status !== status ||
                  (status === 'sent' && persisted.eventId?.toLowerCase() !== publication.eventId?.toLowerCase()))) {
                throw new Error('outbox update did not confirm persistence');
              }
            } catch (error) {
              if (outbox.enabled) status = 'uncertain';
              report(`outbox update failed code=${error?.code ?? 'unknown'} recovery=${recoveryId}`);
            }
          }
          if (status !== 'sent') blockEntry(entry);
          const delivery = { status, ...(status === 'sent' && publication.eventId ? { eventId: publication.eventId } : {}), ...(recoveryId ? { recoveryId } : {}) };
          if (status === 'sent') deliveryActivity('tool_call_update', 'Response sent', 'completed');
          else if (status === 'failed-before-start') deliveryActivity('tool_call_update', 'Publication failed', 'failed', `Publication failed; recovery ${recoveryId ?? 'unavailable'}`);
          else deliveryActivity('tool_call_update', 'Delivery uncertain', 'failed', `Delivery uncertain; recovery ${recoveryId ?? 'unavailable'}`);
          if (status === 'sent' && stateScope && sessionState?.enabled) {
            try {
              if (!providerRetired || !stagedConversationId) throw new Error('checkpoint was not staged');
              if (controller.signal.aborted) throw new Error('checkpoint cancelled');
              await sessionState.save(stateScope, stagedConversationId);
              // Keep adjacent to save: there must be no await before releasing
              // the in-process liveness guard for this completed checkpoint.
              channelsWithLiveBlock.delete(buzzContext.channelId);
              entry.blockCreatedByThisParent = false;
              // This token is deliberately memory-only. It is minted only after the
              // publication is durably `sent` and the version-1 state is `ready`;
              // a later ACP session may consume it exactly once for channel transfer.
              entry.safeToTransfer = Boolean(outbox?.enabled && recoveryId);
              turnSafe = true;
            } catch {
              // The staged record remains blocked but retains this turn's ID.
              report('session association could not be saved');
            }
          } else if (status === 'sent' && !sessionState?.enabled) {
            try {
              if (steeringCapability) {
                await ensureSteering(entry, buzzContext.channelId);
                if (entry.steering && !providerRetired) {
                  const steeringConversationId = session.getConversationId?.();
                  if (typeof session.retireForCheckpoint !== 'function' ||
                      await session.retireForCheckpoint() !== steeringConversationId) {
                    throw steeringRpcError('agy steering provider retirement could not be confirmed');
                  }
                  providerRetired = true;
                }
              }
              turnSafe = true;
            } catch (error) {
              entry.stateError = error?.rpcMessage ?? 'agy steering provider retirement could not be confirmed';
              report('steering provider retirement could not be confirmed');
            }
          }
          if (status !== 'sent') {
            report(`publication ${status}${recoveryId ? ` recovery=${recoveryId}` : ''}`);
            emitDeliveryDiagnostic(params.sessionId, status, recoveryId);
          }
          if (controller.signal.aborted || publication.code === 'CANCELLED') {
            if (id !== undefined) write(rpcResult(id, { stopReason: 'cancelled', publication: delivery }));
          } else if (id !== undefined) {
            write(rpcResult(id, { stopReason: 'end_turn', publication: delivery }));
          }
        } finally {
          if (providerStarted && !turnSafe) {
            blockEntry(entry);
            entry.needsReplacement = true;
          }
          activeTurns.delete(params.sessionId);
          settleLiveBlock(buzzContext.channelId, params.sessionId);
        }
        return;
      }
      if (message.method === 'session/cancel') {
        activeTurns.get(params.sessionId)?.abort();
        sessions.get(params.sessionId)?.session?.cancel();
        return;
      }
      if (id !== undefined) write(rpcError(id, -32601, 'method not found'));
    } catch (error) {
      if (id === undefined) return;
      if (error?.code === 'CANCELLED') write(rpcResult(id, { stopReason: 'cancelled' }));
      else {
        const code = error?.rpcCode ?? (error instanceof TypeError ? -32602 : -32603);
        const message = error?.rpcMessage ?? (code === -32602 ? error.message : 'provider request failed');
        if (message === 'provider request failed') report('provider request failed');
        write(rpcError(id, code, message));
      }
    }
  }

  attachLineDecoder(input, {
    maxLineBytes: maxFrameBytes,
    onLine: (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { report('invalid JSON input'); write(rpcError(null, -32700, 'parse error')); return; }
      const task = handle(message);
      activeHandles.add(task);
      void task.then(() => activeHandles.delete(task), () => activeHandles.delete(task));
    },
    onError: (error) => {
      if (error.code === FRAME_TOO_LARGE) {
        report(`input line exceeded ${maxFrameBytes} byte limit`);
        write(rpcError(null, -32700, 'parse error: request too large'));
      } else if (error.code === FRAME_INVALID_UTF8) {
        report('input stream contained invalid UTF-8');
        write(rpcError(null, -32700, 'parse error: invalid UTF-8'));
      } else {
        report('input stream ended with an incomplete request');
      }
    }
  });
  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
    closing = true;
    for (const controller of activeTurns.values()) controller.abort();
    for (const entry of sessions.values()) entry.session.close?.();
    await Promise.allSettled([...activeHandles]);
    await Promise.allSettled([...sessions.values()].map((entry) => entry.session.waitForClose?.()));
    await sessionState?.release?.();
    })();
    return closePromise;
  }
  input.on('end', () => { void close(); });
  async function retryDelivery(recoveryId) {
    const record = recoveries.get(recoveryId);
    if (!record || record.status !== 'failed-before-start') return { status: 'blocked' };
    if (recoveryClaims.has(recoveryId)) return { status: 'blocked', reason: 'busy' };
    recoveryClaims.add(recoveryId);
    try {
      let owner;
      try { owner = await makeIdentity(); } catch { return { status: 'blocked', reason: 'owner-mismatch' }; }
      if (!owner || owner !== outbox?.owner || owner !== record.owner) return { status: 'blocked', reason: 'owner-mismatch' };
      if (recoveries.get(recoveryId) !== record || record.status !== 'failed-before-start') return { status: 'blocked', reason: 'busy' };
      record.status = 'uncertain';
      let publication;
      try { publication = await publisher.publish({ channelId: record.channelId, replyTo: record.replyTo, content: record.content }); }
      catch { publication = { status: 'uncertain' }; }
      const status = ['sent', 'failed-before-start', 'uncertain'].includes(publication?.status) ? publication.status : 'uncertain';
      record.status = status;
      return { status, ...(publication?.eventId ? { eventId: publication.eventId } : {}) };
    } finally {
      recoveryClaims.delete(recoveryId);
    }
  }
  return { handle, sessions, recoveries, retryDelivery, close };
}
