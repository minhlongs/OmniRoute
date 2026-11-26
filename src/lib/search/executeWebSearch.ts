import { getProviderCredentials } from "@/sse/services/auth";
import { recordCost } from "@/domain/costRules";
import { getSettings } from "@/lib/db/settings";
import { isProviderBlockedByIdOrAlias } from "@/shared/utils/noAuthProviders";
import * as defaultLog from "@/sse/utils/logger";
import {
  getAllSearchProviders,
  getSearchProvider,
  resolveSearchProvider,
  selectProvider,
  supportsSearchType,
  isAnonymousCapableSearchProvider,
  isDocCorpusOnlySearchProvider,
  isUnconfiguredLoopbackSearchProvider,
  isUnconfiguredSearchProviderFallbackEnabled,
  resolvePreferredFreeSearchProviderIds,
  getSearchCredentialFallbacks,
  SEARCH_PROVIDERS,
  type SearchProviderConfig,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import {
  handleSearch,
  resolveSearchBaseUrl,
  type SearchResponse,
} from "@omniroute/open-sse/handlers/search.ts";
import {
  computeCacheKey,
  getOrCoalesce,
  SEARCH_CACHE_DEFAULT_TTL_MS,
} from "@omniroute/open-sse/services/searchCache.ts";

type SearchLogger = typeof defaultLog;

export interface ExecuteWebSearchInput {
  query: string;
  provider?: string;
  max_results?: number;
  limit?: number;
  search_type?: "web" | "news" | "x";
  offset?: number;
  country?: string;
  language?: string;
  time_range?: "any" | "day" | "week" | "month" | "year";
  content?: {
    snippet?: boolean;
    full_page?: boolean;
    format?: "text" | "markdown";
    max_characters?: number;
  };
  filters?: {
    include_domains?: string[];
    exclude_domains?: string[];
    safe_search?: "off" | "moderate" | "strict";
  };
  provider_options?: Record<string, unknown>;
  strict_filters?: boolean;
  apiKeyId?: string | null;
  log?: SearchLogger;
}

export interface ExecuteWebSearchResult {
  cached: boolean;
  data: SearchResponse;
}

export class WebSearchExecutionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function resolveSearchCredentials(providerId: string) {
  const creds = await getProviderCredentials(providerId).catch(() => null);
  if (creds) return creds;
  for (const fallbackId of getSearchCredentialFallbacks(providerId)) {
    const fallback = await getProviderCredentials(fallbackId).catch(() => null);
    if (fallback) return fallback;
  }
  return null;
}

function buildDomainFilter(filters?: {
  include_domains?: string[];
  exclude_domains?: string[];
}): string[] | undefined {
  if (!filters) return undefined;
  const parts: string[] = [];
  if (filters.include_domains?.length) parts.push(...filters.include_domains);
  if (filters.exclude_domains?.length) parts.push(...filters.exclude_domains.map((d) => `-${d}`));
  return parts.length > 0 ? parts : undefined;
}

function normalizeMaxResults(input: ExecuteWebSearchInput, providerConfig: SearchProviderConfig) {
  const fromMaxResults =
    typeof input.max_results === "number"
      ? input.max_results
      : typeof input.max_results === "string"
        ? Number(input.max_results)
        : Number.NaN;
  const fromLimit =
    typeof input.limit === "number"
      ? input.limit
      : typeof input.limit === "string"
        ? Number(input.limit)
        : Number.NaN;
  const requested = Number.isFinite(fromMaxResults)
    ? fromMaxResults
    : Number.isFinite(fromLimit)
      ? fromLimit
      : providerConfig.defaultMaxResults;
  return Math.min(Math.max(1, requested), providerConfig.maxMaxResults);
}

function assertValidSearchInput(input: ExecuteWebSearchInput) {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new WebSearchExecutionError("Missing required field: query", 400);
  }
  if (input.query.trim().length > 500) {
    throw new WebSearchExecutionError("Query must be 500 characters or fewer", 400);
  }
  if (
    input.search_type &&
    input.search_type !== "web" &&
    input.search_type !== "news" &&
    input.search_type !== "x"
  ) {
    throw new WebSearchExecutionError(`Unsupported search_type: ${String(input.search_type)}`, 400);
  }
}

export async function executeWebSearch(
  input: ExecuteWebSearchInput
): Promise<ExecuteWebSearchResult> {
  assertValidSearchInput(input);

  const log = input.log || defaultLog;
  if (input.provider === "x_search") input.provider = "x-search";
  if (input.provider === "xquik" || input.provider === "xquik_search") {
    input.provider = "xquik-search";
  }
  if (input.provider === "anysearch" || input.provider === "anysearch_search") {
    input.provider = "anysearch-search";
  }
  if (input.provider === "x-search" || input.provider === "xquik-search") input.search_type = "x";
  const searchType = input.search_type || "web";

  const settings = await getSettings().catch(() => ({}) as any);
  const blockedProviders: string[] = settings?.blockedProviders || [];

  if (input.provider) {
    if (isProviderBlockedByIdOrAlias(input.provider, blockedProviders)) {
      throw new WebSearchExecutionError(
        `Search provider ${input.provider} is blocked by security policy`,
        403
      );
    }
    const explicitProvider = resolveSearchProvider(input.provider);
    if (!explicitProvider) {
      throw new WebSearchExecutionError(`Unknown search provider: ${input.provider}`, 400);
    }
    if (!supportsSearchType(explicitProvider, searchType)) {
      throw new WebSearchExecutionError(
        `Search provider ${input.provider} does not support search_type: ${searchType}`,
        400
      );
    }
  }

  let providerConfig = selectProvider(input.provider, searchType);
  if (!providerConfig) {
    throw new WebSearchExecutionError(
      input.provider
        ? `Unknown search provider: ${input.provider}`
        : `No search providers available. Add an API key for a search provider (${getAllSearchProviders()
            .map((provider) => provider.id)
            .join(", ")}) in the dashboard.`,
      400
    );
  }

  let credentials: Record<string, any> | null = null;
  let alternateProviderId: string | undefined;
  let alternateCredentials: Record<string, any> | null = null;

  const resolveFreeCandidates = async (
    excludeId?: string,
    options: { keylessOnly?: boolean } = {}
  ) => {
    const list: Array<{ config: SearchProviderConfig; credentials: Record<string, any> }> = [];
    for (const freeId of resolvePreferredFreeSearchProviderIds()) {
      if (freeId === excludeId) continue;
      if (isProviderBlockedByIdOrAlias(freeId, blockedProviders)) continue;
      const cfg = getSearchProvider(freeId);
      if (!cfg || cfg.disabled || !supportsSearchType(cfg, searchType)) continue;
      if (options.keylessOnly) {
        if (cfg.authType === "none" || isAnonymousCapableSearchProvider(cfg.id)) {
          list.push({ config: cfg, credentials: {} });
        }
        continue;
      }
      const stored = await resolveSearchCredentials(cfg.id);
      list.push({ config: cfg, credentials: stored ?? {} });
    }
    return list;
  };

  if (input.provider) {
    credentials = await resolveSearchCredentials(providerConfig.id);
    if (
      !credentials &&
      providerConfig.authType === "none" &&
      typeof input.provider_options?.baseUrl === "string" &&
      input.provider_options.baseUrl.trim().length > 0
    ) {
      credentials = {
        providerSpecificData: { baseUrl: input.provider_options.baseUrl.trim() },
      };
    }
    if (
      !credentials &&
      ((providerConfig.authType === "none" &&
        !isUnconfiguredLoopbackSearchProvider(providerConfig)) ||
        isAnonymousCapableSearchProvider(providerConfig.id))
    ) {
      credentials = {};
    }
    if (
      credentials &&
      (providerConfig.id === "duckduckgo-free" || providerConfig.id === "anysearch-search")
    ) {
      const freeAlts = await resolveFreeCandidates(providerConfig.id, {
        keylessOnly: providerConfig.id === "duckduckgo-free",
      });
      if (freeAlts.length > 0) {
        alternateProviderId = freeAlts[0].config.id;
        alternateCredentials = freeAlts[0].credentials;
      }
    }
    if (
      !credentials &&
      isUnconfiguredSearchProviderFallbackEnabled() &&
      providerConfig.authType !== "none" &&
      !isDocCorpusOnlySearchProvider(providerConfig.id)
    ) {
      const freeFallbacks = await resolveFreeCandidates(providerConfig.id);
      if (freeFallbacks.length > 0) {
        log.warn(
          "SEARCH",
          `Provider ${providerConfig.id} has no credentials; falling back to ${freeFallbacks[0].config.id}`
        );
        providerConfig = freeFallbacks[0].config;
        credentials = freeFallbacks[0].credentials;
        if (freeFallbacks.length > 1) {
          alternateProviderId = freeFallbacks[1].config.id;
          alternateCredentials = freeFallbacks[1].credentials;
        }
      }
    }
    if (!credentials) {
      throw new WebSearchExecutionError(
        providerConfig.authType === "none"
          ? `Search provider ${providerConfig.id} is not configured. Set its base URL in the dashboard or pass provider_options.baseUrl.`
          : `No credentials configured for search provider: ${providerConfig.id}. Add an API key for "${providerConfig.id}" in the dashboard.`,
        400
      );
    }
  } else {
    // Auto-select: prefer the cheapest non-fallback provider that actually has
    // credentials. Fallback-only free providers are a last resort, so a
    // configured paid provider is never skipped just because a cheaper
    // no-credentials provider appears first in the cost sort (issue #11524).
    const candidateProviders = Object.values(SEARCH_PROVIDERS)
      .filter(
        (provider) =>
          !provider.fallbackOnly &&
          supportsSearchType(provider, searchType) &&
          !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery);

    for (const candidate of candidateProviders) {
      const candidateCredentials = await resolveSearchCredentials(candidate.id);
      if (candidateCredentials) {
        providerConfig = candidate;
        credentials = candidateCredentials;
        break;
      }
    }

    if (!credentials) {
      // Credentialed fallback-only providers (e.g. configured searxng-search or
      // configured paid anysearch-search) take precedence over keyless free tiers.
      const fallbackProviders = Object.values(SEARCH_PROVIDERS)
        .filter(
          (provider) =>
            provider.fallbackOnly &&
            !isDocCorpusOnlySearchProvider(provider.id) &&
            supportsSearchType(provider, searchType) &&
            !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
        )
        .sort((a, b) => a.costPerQuery - b.costPerQuery);

      for (const fallbackProvider of fallbackProviders) {
        const fallbackCredentials = await resolveSearchCredentials(fallbackProvider.id);
        if (!fallbackCredentials) continue;
        const effectiveBaseUrl = resolveSearchBaseUrl(fallbackProvider, {
          query: input.query.trim(),
          searchType,
          maxResults: fallbackProvider.defaultMaxResults,
          providerOptions: input.provider_options,
          providerSpecificData:
            fallbackCredentials.providerSpecificData &&
            typeof fallbackCredentials.providerSpecificData === "object"
              ? fallbackCredentials.providerSpecificData
              : undefined,
        });
        if (
          isUnconfiguredLoopbackSearchProvider({
            ...fallbackProvider,
            baseUrl: effectiveBaseUrl,
          })
        ) {
          continue;
        }
        providerConfig = fallbackProvider;
        credentials = fallbackCredentials;
        break;
      }
    }

    if (!credentials) {
      const preferredFree = await resolveFreeCandidates();
      if (preferredFree.length > 0) {
        providerConfig = preferredFree[0].config;
        credentials = preferredFree[0].credentials;
      }
    }

    if (!credentials) {
      throw new WebSearchExecutionError(
        `No credentials configured for any search provider. Add an API key for a search provider (${Object.keys(
          SEARCH_PROVIDERS
        ).join(", ")}) in the dashboard.`,
        400
      );
    }

    const otherIds = Object.values(SEARCH_PROVIDERS)
      .filter(
        (provider) =>
          !provider.fallbackOnly &&
          supportsSearchType(provider, searchType) &&
          !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)
      .map((provider) => provider.id)
      .filter((providerId) => providerId !== providerConfig!.id);

    for (const providerId of otherIds) {
      const altConfig = getSearchProvider(providerId);
      const altCreds = await resolveSearchCredentials(providerId);
      if (altConfig && altCreds) {
        alternateProviderId = providerId;
        alternateCredentials = altCreds;
        break;
      }
    }

    if (!alternateProviderId) {
      for (const provider of Object.values(SEARCH_PROVIDERS)) {
        if (!provider.fallbackOnly || provider.id === providerConfig!.id) continue;
        if (isDocCorpusOnlySearchProvider(provider.id)) continue;
        if (isProviderBlockedByIdOrAlias(provider.id, blockedProviders)) continue;
        if (!supportsSearchType(provider, searchType)) continue;
        const storedCreds = await resolveSearchCredentials(provider.id);
        if (!storedCreds) continue;
        const effectiveBaseUrl = resolveSearchBaseUrl(provider, {
          query: input.query.trim(),
          searchType,
          maxResults: provider.defaultMaxResults,
          providerOptions: input.provider_options,
          providerSpecificData:
            storedCreds.providerSpecificData && typeof storedCreds.providerSpecificData === "object"
              ? storedCreds.providerSpecificData
              : undefined,
        });
        if (isUnconfiguredLoopbackSearchProvider({ ...provider, baseUrl: effectiveBaseUrl })) {
          continue;
        }
        alternateProviderId = provider.id;
        alternateCredentials = storedCreds;
        break;
      }
    }

    if (!alternateProviderId) {
      const freeAlts = await resolveFreeCandidates(providerConfig.id);
      if (freeAlts.length > 0) {
        alternateProviderId = freeAlts[0].config.id;
        alternateCredentials = freeAlts[0].credentials;
      }
    }
  }

  const clampedMaxResults = normalizeMaxResults(input, providerConfig);
  const cacheKey = computeCacheKey(
    input.query.trim(),
    providerConfig.id,
    searchType,
    clampedMaxResults,
    input.country,
    input.language,
    {
      filters: input.filters,
      offset: input.offset,
      time_range: input.time_range,
    }
  );
  const ttl = providerConfig.cacheTTLMs ?? SEARCH_CACHE_DEFAULT_TTL_MS;

  const { data, cached } = await getOrCoalesce(cacheKey, ttl, async () => {
    const result = await handleSearch({
      query: input.query.trim(),
      provider: providerConfig.id,
      maxResults: clampedMaxResults,
      searchType,
      country: input.country,
      language: input.language,
      timeRange: input.time_range,
      offset: input.offset,
      domainFilter: buildDomainFilter(input.filters),
      contentOptions: input.content,
      strictFilters: input.strict_filters,
      providerOptions: input.provider_options,
      credentials,
      alternateProvider: alternateProviderId,
      alternateCredentials,
      log,
      connectionId: credentials?.connectionId || undefined,
      apiKeyId: input.apiKeyId || undefined,
    });

    if (!result.success || !result.data) {
      throw new WebSearchExecutionError(result.error || "Search failed", result.status || 502);
    }

    return result.data;
  });

  if (!cached && input.apiKeyId && input.apiKeyId !== "local" && data.usage?.search_cost_usd > 0) {
    try {
      recordCost(input.apiKeyId, data.usage.search_cost_usd);
    } catch (error: any) {
      log.warn("SEARCH", `Cost recording failed: ${error?.message || String(error)}`);
    }
  }

  return { data, cached };
}
