import type { Model, ModelCapability, Provider } from '@renderer/types'
import type { RavenClientAICapabilitySnapshot, RavenClientAIRoute } from '@renderer/types/aiServiceAgent'

export function serviceProviderId(slot: RavenClientAIRoute['slot']): string {
  return `raven-service-${slot}`
}

function serviceEndpointType(route: RavenClientAIRoute): 'anthropic' | 'openai-response' {
  return route.api_protocol === 'openai_responses' || route.provider === 'openai' ? 'openai-response' : 'anthropic'
}

export function serviceModelForRoute(route: RavenClientAIRoute, modelId = route.model): Model {
  const capabilities: ModelCapability[] = [{ type: 'text' }]
  if (route.capabilities.image_input) capabilities.push({ type: 'vision' })
  if (route.capabilities.tool_use) capabilities.push({ type: 'function_calling' })
  return {
    id: modelId,
    provider: serviceProviderId(route.slot),
    name: modelId,
    group: 'RavenAIService',
    owned_by: route.provider,
    capabilities,
    endpoint_type: serviceEndpointType(route),
    supported_endpoint_types: [serviceEndpointType(route)]
  }
}

export function publicServiceProviderForRoute(route: RavenClientAIRoute): Provider {
  const models = [serviceModelForRoute(route)]
  if (route.small_fast_model && route.small_fast_model !== route.model) {
    models.push(serviceModelForRoute(route, route.small_fast_model))
  }
  return {
    id: serviceProviderId(route.slot),
    type: serviceEndpointType(route),
    name: `${route.provider} (${route.slot})`,
    apiKey: '',
    apiHost: route.base_url,
    models,
    enabled: true,
    isSystem: false
  }
}

class RavenClientAICredentialVault {
  private snapshot: RavenClientAICapabilitySnapshot | null = null

  replace(snapshot: RavenClientAICapabilitySnapshot) {
    this.snapshot = snapshot
  }

  clear() {
    this.snapshot = null
  }

  getProvider(route: RavenClientAIRoute): Provider {
    return { ...publicServiceProviderForRoute(route), apiKey: route.api_key }
  }

  resolveProvider(provider?: Provider): Provider | undefined {
    if (!this.snapshot || this.snapshot.expires_at * 1000 <= Date.now()) {
      this.clear()
      return undefined
    }
    const route =
      this.snapshot.routes.find((item) => serviceProviderId(item.slot) === provider?.id) ?? this.snapshot.routes[0]
    return route ? this.getProvider(route) : undefined
  }
}

export const ravenClientAICredentialVault = new RavenClientAICredentialVault()
