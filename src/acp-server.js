import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promptToText } from './prompt.js';
import { AgySession } from './agy-session.js';
import { parseBuzzContext } from './buzz-context.js';
import { BuzzPublisher } from './buzz-publisher.js';
import { createConfiguredOutbox } from './delivery/outbox.js';
import { getBuzzPublicKey } from './delivery/identity.js';
import { createConfiguredSessionState } from './session-state.js';
import { listModels, modelConfigOptions } from './models.js';
import { createSteeringCoordinator, inspectSteeringBridge, MAX_STEERING_TEXT_LENGTH } from './steering.js';

const JSON_RPC = '2.0';
const TERMINAL_SESSION_CONTEXT_MESSAGE = 'agy session context lost; resume unsupported';
const STEERING_RPC_CODE = -32004;
const STEERING_UNCERTAIN_MESSAGE = 'agy steering outcome is uncertain';
const OWNER_RE = /^[0-9a-f]{64}$/i;

function envFlag(value) {
  return value === '1' || value === 'true';
}

function steeringConfiguration(env = process.env, override = {}) {
  const hookConfigured = override.hookConfigured ?? envFlag(env.AGY_STEER_HOOK_CONFIGURED);
  const injectorExclusive = override.injectorExclusive ?? envFlag(env.AGY_STEER_INJECTOR_EXCLUSIVE);
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

export function createAcpServer({ input = process.stdin, output = process.stdout, diagnostics = process.stderr, sessionFactory, publisherFactory, outboxFactory, identityFactory, sessionStateFactory, modelCatalogFactory, steeringFactory, steeringConfig, steeringSupported } = {}) {
  const sessions = new Map();
  const activeTurns = new Map();
  const recoveries = new Map();
  const recoveryClaims = new Set();
  const channelSessions = new Map();
  const activeHandles = new Set();
  const makeSession = sessionFactory ?? ((options) => new AgySession({ ...options,
    command: process.env.AGY_COMMAND || 'agy',
    prefixArgs: process.env.AGY_FAKE_SCRIPT ? [process.env.AGY_FAKE_SCRIPT] : []
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
  let buffer = '';

  function steeringLocation(channelId) {
    const ownerId = resolvedSteeringConfig.ownerId ?? sessionState?.owner;
    const rootDir = resolvedSteeringConfig.rootDir ?? join(tmpdir(), 'agy-buzz-steering');
    const bridgeKey = createHash('sha256').update(`${ownerId ?? 'test'}:${channelId}`).digest('hex');
    const steeringSessionId = `channel_${createHash('sha256').update(channelId).digest('hex').slice(0, 96)}`;
    return { ownerId, rootDir, bridgeDir: join(rootDir, `channel-${bridgeKey}`), steeringSessionId };
  }

  async function inspectExistingSteering(entry, channelId) {
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
    if (status.blocked) throw steeringRpcError('agy steering is durably blocked');
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
    const id = message.id;
    if (message.jsonrpc !== JSON_RPC || typeof message.method !== 'string') {
      if (id !== undefined) write(rpcError(id, -32600, 'invalid JSON-RPC request'));
      return;
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
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
            agentInfo: { name: 'agy-buzz-acp', version: '0.5.5' }
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
          model: requestedModel
        });
        session.setModelCatalog?.(catalog);
        sessions.set(sessionId, { session, sessionId, cwd: params.cwd,
          model: requestedModel, modelCatalog: catalog, bound: false, stateError: null,
          steering: null });
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
        const session = entry.session;
        if (activeTurns.has(params.sessionId)) throw Object.assign(new Error('session turn is busy'), { rpcCode: -32002 });
        if (entry.stateError) throw Object.assign(new Error(entry.stateError), { rpcCode: -32603, rpcMessage: entry.stateError });
        const text = promptToText(params.prompt);
        report(`session/prompt blocks=${Array.isArray(params.prompt) ? params.prompt.length : 0}`);
        const buzzContext = parseBuzzContext(params.prompt);
        if (!buzzContext) {
          report(`context parse failed ${describePromptShape(params.prompt)}`);
          throw Object.assign(new Error('Buzz transport context unavailable'), { rpcCode: -32603, rpcMessage: 'Buzz transport context unavailable' });
        }
        if (entry.channelId && entry.channelId !== buzzContext.channelId) {
          throw Object.assign(new Error('agy session channel scope cannot change'), { rpcCode: -32602, rpcMessage: 'agy session channel scope cannot change' });
        }
        entry.channelId ??= buzzContext.channelId;
        if (steeringCapability) await inspectExistingSteering(entry, buzzContext.channelId);
        const controller = new AbortController();
        activeTurns.set(params.sessionId, controller);
        let stateScope = null;
        try {
          if (sessionState?.configurationError) {
            throw Object.assign(new Error(sessionState.configurationError), { rpcCode: -32602, rpcMessage: sessionState.configurationError });
          }
          if (sessionState?.enabled) {
            if (entry.stateError) throw Object.assign(new Error(entry.stateError), { rpcCode: -32603, rpcMessage: entry.stateError });
            await sessionState.verifyIdentity(makeIdentity);
            stateScope = await sessionState.scope({ channelId: buzzContext.channelId, cwd: entry.cwd, model: entry.model });
            const existingSessionId = channelSessions.get(buzzContext.channelId);
            if (existingSessionId && existingSessionId !== params.sessionId) {
              throw Object.assign(new Error('agy channel session is already owned'), { rpcCode: -32002, rpcMessage: 'agy channel session is already owned' });
            }
            channelSessions.set(buzzContext.channelId, params.sessionId);
            // Every turn re-reads the record: `load` is the guard that refuses a block
            // left by an incomplete turn. Binding the trusted conversation stays a
            // one-off, because the provider refuses it once a child is running.
            const saved = await sessionState.load(stateScope);
            if (!entry.bound) {
              if (saved) session.setTrustedConversation?.(saved.conversationId);
              entry.bound = true;
            }
            await sessionState.invalidate(stateScope);
          }
          if (steeringCapability) await ensureSteering(entry, buzzContext.channelId);
          if (outbox?.configurationError) {
            throw Object.assign(new Error(outbox.configurationError), { rpcCode: -32602, rpcMessage: outbox.configurationError });
          }
          publisher ??= makePublisher();
          if (!publisher || typeof publisher.publish !== 'function') throw Object.assign(new Error('Buzz publisher unavailable'), { rpcCode: -32603, rpcMessage: 'Buzz publisher unavailable' });
          if (controller.signal.aborted) throw Object.assign(new Error('prompt cancelled'), { code: 'CANCELLED' });
        } catch (error) {
          activeTurns.delete(params.sessionId);
          if (channelSessions.get(buzzContext.channelId) === params.sessionId) channelSessions.delete(buzzContext.channelId);
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
          const response = await session.prompt(text, (delta) => write({
            jsonrpc: JSON_RPC,
            method: 'session/update',
            params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } } }
          }), (update) => {
            if (update && typeof update === 'object') emitActivity(params.sessionId, update);
          });
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
          const status = ['sent', 'failed-before-start', 'uncertain'].includes(publication.status) ? publication.status : 'uncertain';
          if (status !== 'sent') blockEntry(entry);
          if (recoveryId) {
            try { await outbox.update(recoveryId, { status, ...(publication.eventId ? { eventId: publication.eventId } : {}) }); }
            catch (error) { report(`outbox update failed code=${error?.code ?? 'unknown'} recovery=${recoveryId}`); }
          }
          const delivery = { status, ...(publication.eventId ? { eventId: publication.eventId } : {}), ...(recoveryId ? { recoveryId } : {}) };
          if (status === 'sent') deliveryActivity('tool_call_update', 'Response sent', 'completed');
          else if (status === 'failed-before-start') deliveryActivity('tool_call_update', 'Publication failed', 'failed', `Publication failed; recovery ${recoveryId ?? 'unavailable'}`);
          else deliveryActivity('tool_call_update', 'Delivery uncertain', 'failed', `Delivery uncertain; recovery ${recoveryId ?? 'unavailable'}`);
          if (status === 'sent' && stateScope && sessionState?.enabled) {
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
              const conversationId = session.getConversationId?.();
              if (conversationId && session.hasConfirmedConversation?.()) {
                if (!providerRetired && (typeof session.retireForCheckpoint !== 'function' ||
                    await session.retireForCheckpoint() !== conversationId)) {
                  throw new Error('provider retirement could not be confirmed');
                }
                if (!providerRetired) {
                  providerRetired = true;
                }
                if (controller.signal.aborted) throw new Error('checkpoint cancelled');
                await sessionState.save(stateScope, conversationId);
                turnSafe = true;
              } else {
                blockEntry(entry);
              }
            } catch (error) {
              // `save` did not run, so the record on disk stays blocked and the next
              // turn reads it. A sticky marker here would only hide a later repair.
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
          if (providerStarted && !turnSafe) blockEntry(entry);
          activeTurns.delete(params.sessionId);
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

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { report('invalid JSON input'); write(rpcError(null, -32700, 'parse error')); continue; }
      const task = handle(message);
      activeHandles.add(task);
      void task.finally(() => activeHandles.delete(task));
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
