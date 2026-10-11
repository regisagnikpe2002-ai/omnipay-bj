"use strict";

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider, priority = 100) {
    if (!provider?.name) throw new Error("Provider invalide.");
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider déjà enregistré: ${provider.name}`);
    }
    this.providers.set(provider.name, { provider, priority });
    return provider;
  }

  get(name) {
    const entry = this.providers.get(String(name || "").toLowerCase());
    if (!entry) throw new Error(`Provider inconnu: ${name}`);
    return entry.provider;
  }

  list() {
    return [...this.providers.values()]
      .sort((a, b) => a.priority - b.priority)
      .map(({ provider, priority }) => ({
        name: provider.name,
        enabled: provider.enabled,
        capabilities: provider.capabilities,
        priority,
      }));
  }

  select({ providerName, capability }) {
    if (providerName) {
      const provider = this.get(providerName);
      provider.assertCapability(capability);
      return provider;
    }

    const selected = [...this.providers.values()]
      .sort((a, b) => a.priority - b.priority)
      .find(({ provider }) =>
        provider.enabled && provider.capabilities[capability]
      );

    if (!selected) {
      throw new Error(`Aucun provider disponible pour ${capability}.`);
    }

    return selected.provider;
  }
}

module.exports = ProviderRegistry;
