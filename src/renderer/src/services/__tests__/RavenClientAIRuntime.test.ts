import type { RavenClientAICapabilitySnapshot } from '@renderer/types/aiServiceAgent'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AIServiceAgentClient } from '../AIServiceAgentClient'
import { AIServiceAuthError } from '../AIServiceAgentClient'
import { RavenClientAIRuntime } from '../RavenClientAIRuntime'

const testState = vi.hoisted(() => ({
  llm: {
    providers: [] as any[],
    defaultModel: undefined as any,
    quickModel: undefined as any,
    translateModel: undefined as any
  },
  assistants: {
    assistants: [{ id: 'assistant-1', model: undefined, defaultModel: undefined }] as any[],
    defaultAssistant: { id: 'default-assistant', model: undefined, defaultModel: undefined } as any
  }
}))

const store = vi.hoisted(() => ({
  getState: () => testState,
  dispatch: (action: { type: string; payload: any }) => {
    switch (action.type) {
      case 'llm/updateProviders':
        testState.llm.providers = action.payload
        break
      case 'llm/setDefaultModel':
        testState.llm.defaultModel = action.payload.model
        break
      case 'llm/setQuickModel':
        testState.llm.quickModel = action.payload.model
        break
      case 'llm/setTranslateModel':
        testState.llm.translateModel = action.payload.model
        break
      case 'assistants/updateAssistants':
        testState.assistants.assistants = action.payload
        break
      case 'assistants/updateDefaultAssistant':
        testState.assistants.defaultAssistant = action.payload.assistant
        break
    }
    return action
  }
}))

vi.mock('@renderer/store', () => ({ default: store }))
vi.mock('@renderer/store/llm', () => ({
  updateProviders: (payload: any) => ({ type: 'llm/updateProviders', payload }),
  setDefaultModel: (payload: any) => ({ type: 'llm/setDefaultModel', payload }),
  setQuickModel: (payload: any) => ({ type: 'llm/setQuickModel', payload }),
  setTranslateModel: (payload: any) => ({ type: 'llm/setTranslateModel', payload })
}))
vi.mock('@renderer/store/assistants', () => ({
  updateAssistants: (payload: any) => ({ type: 'assistants/updateAssistants', payload }),
  updateDefaultAssistant: (payload: any) => ({ type: 'assistants/updateDefaultAssistant', payload })
}))

function snapshot(revision = 'rev-1', model = 'service-model'): RavenClientAICapabilitySnapshot {
  const now = Math.floor(Date.now() / 1000)
  return {
    revision,
    issued_at: now,
    expires_at: now + 3600,
    refresh_after_seconds: 900,
    routes: [
      {
        slot: 'primary',
        provider: 'anthropic',
        base_url: 'https://provider.example.test',
        api_key: 'server-only-secret',
        model,
        small_fast_model: `${model}-fast`,
        capabilities: {
          image_input: true,
          document_input: true,
          tool_use: true,
          partial_streaming: true,
          thinking_budget: false
        }
      }
    ]
  }
}

const runtimes: RavenClientAIRuntime[] = []

afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.stop())
})

describe('RavenClientAIRuntime', () => {
  it('routes a synchronized OpenAI vision model through Responses without persisting its key', async () => {
    const capabilities = snapshot('openai-rev', 'gpt-6.1-terra')
    Object.assign(capabilities.routes[0], {
      provider: 'openai',
      api_protocol: 'openai_responses',
      base_url: 'https://api.openai.com/v1',
      small_fast_model: 'gpt-6.1-terra'
    })
    const client = {
      getClientAICapabilities: vi.fn().mockResolvedValue(capabilities),
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)
    await runtime.start(client)

    const state = store.getState()
    expect(state.llm.providers[0].type).toBe('openai-response')
    expect(state.llm.defaultModel.endpoint_type).toBe('openai-response')
    expect(state.llm.defaultModel.capabilities).toContainEqual({ type: 'vision' })
    expect(state.llm.quickModel.id).toBe('gpt-6.1-terra')
    expect(JSON.stringify(state.llm)).not.toContain('server-only-secret')
    expect(runtime.resolveProvider(state.llm.providers[0])).toMatchObject({
      type: 'openai-response',
      apiKey: 'server-only-secret'
    })
  })
  it('synchronizes server routing while keeping credentials out of Redux', async () => {
    const client = {
      getClientAICapabilities: vi.fn().mockResolvedValue(snapshot()),
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)

    await runtime.start(client)

    const state = store.getState()
    expect(state.llm.providers).toHaveLength(1)
    expect(state.llm.providers[0]).toMatchObject({
      id: 'raven-service-primary',
      apiKey: '',
      apiHost: 'https://provider.example.test'
    })
    expect(state.llm.providers[0].models.map((item: any) => item.id)).toEqual(['service-model', 'service-model-fast'])
    expect(state.llm.defaultModel).toMatchObject({ id: 'service-model', provider: 'raven-service-primary' })
    expect(state.llm.quickModel).toMatchObject({ id: 'service-model-fast', provider: 'raven-service-primary' })
    expect(JSON.stringify(state.llm)).not.toContain('server-only-secret')
    expect(runtime.resolveProvider(state.llm.providers[0])?.apiKey).toBe('server-only-secret')
  })

  it('applies a changed server revision to every Assistant default', async () => {
    const getClientAICapabilities = vi
      .fn()
      .mockResolvedValueOnce(snapshot('rev-1', 'model-a'))
      .mockResolvedValueOnce(snapshot('rev-2', 'model-b'))
    const client = {
      getClientAICapabilities,
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)

    await runtime.start(client)
    await runtime.refresh('manual')

    const state = store.getState()
    expect(runtime.getState()).toMatchObject({ status: 'ready', revision: 'rev-2' })
    expect(state.llm.defaultModel?.id).toBe('model-b')
    expect(state.assistants.defaultAssistant.model?.id).toBe('model-b')
    expect(state.assistants.assistants.every((assistant) => assistant.model?.id === 'model-b')).toBe(true)
  })

  it('clears the in-memory snapshot and synchronized providers on logout', async () => {
    const client = {
      getClientAICapabilities: vi.fn().mockResolvedValue(snapshot()),
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)
    await runtime.start(client)

    runtime.stop()

    expect(runtime.getState().status).toBe('idle')
    expect(store.getState().llm.providers).toEqual([])
    expect(() => runtime.getRoutes()).toThrow(/unavailable|expired/)
  })

  it('does not restore credentials when an in-flight refresh resolves after logout', async () => {
    let resolveSnapshot!: (value: RavenClientAICapabilitySnapshot) => void
    const client = {
      getClientAICapabilities: vi.fn().mockReturnValue(
        new Promise<RavenClientAICapabilitySnapshot>((resolve) => {
          resolveSnapshot = resolve
        })
      ),
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)

    const startPromise = runtime.start(client)
    runtime.stop()
    resolveSnapshot(snapshot())

    await expect(startPromise).rejects.toThrow('cancelled')
    expect(store.getState().llm.providers).toEqual([])
    expect(() => runtime.getRoutes()).toThrow(/unavailable|expired/)
  })

  it('refuses expired credentials when a mandatory refresh fails', async () => {
    vi.useFakeTimers()
    const current = snapshot()
    current.expires_at = Math.floor(Date.now() / 1000) + 1
    const client = {
      getClientAICapabilities: vi.fn().mockResolvedValueOnce(current).mockRejectedValueOnce(new Error('offline')),
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)
    await runtime.start(client)
    vi.advanceTimersByTime(2_000)

    await expect(runtime.ensureFresh()).rejects.toThrow('offline')
    expect(runtime.getState().status).toBe('expired')
    expect(() => runtime.getRoutes()).toThrow(/unavailable|expired/)
    vi.useRealTimers()
  })

  it('clears credentials and notifies the account gate on authentication failure', async () => {
    const onAuthenticationFailure = vi.fn().mockResolvedValue(undefined)
    const client = {
      getClientAICapabilities: vi.fn().mockRejectedValue(new AIServiceAuthError('expired', 401)),
      reportClientAIUsage: vi.fn().mockResolvedValue(undefined)
    } as unknown as AIServiceAgentClient
    const runtime = new RavenClientAIRuntime()
    runtimes.push(runtime)

    await expect(runtime.start(client, onAuthenticationFailure)).rejects.toThrow('expired')

    expect(onAuthenticationFailure).toHaveBeenCalledOnce()
    expect(() => runtime.getRoutes()).toThrow(/unavailable|expired/)
  })
})
