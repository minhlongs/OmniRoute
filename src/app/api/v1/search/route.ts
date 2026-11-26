import { handleSearch, resolveSearchBaseUrl } from "@omniroute/open-sse/handlers/search.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  extractApiKey,
  isValidApiKey,
} from "@/sse/services/auth";
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
  SEARCH_PROVIDERS,
  getSearchCredentialFallbacks,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1SearchSchema } from "@/shared/validation/schemas";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";
import { recordCost } from "@/domain/costRules";
import {
  computeCacheKey,
  getOrCoalesce,
  SEARCH_CACHE_DEFAULT_TTL_MS,
} from "@omniroute/open-sse/services/searchCache.ts";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
  type RateLimitedCredentials,
} from "@/app/api/v1/_shared/rateLimit";
import { getSettings } from "@/lib/db/settings";
import { isProviderBlockedByIdOrAlias } from "@/shared/utils/noAuthProviders";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * GET /v1/search — list available search providers
 */
export async function GET() {
  const settings = await getSettings().catch(() => ({}) as any);
  const blockedProviders = settings?.blockedProviders || [];
  const providers = getAllSearchProviders(blockedProviders);
  const timestamp = Math.floor(Date.now() / 1000);

  const data = providers.map((p) => ({
    id: p.id,
    object: "search_provider",
    created: timestamp,
    name: p.name,
    search_types: p.searchTypes,
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

type SearchCredentials = Record<string, any>;
type SearchCredentialLookup = SearchCredentials | RateLimitedCredentials | null;

async function resolveSearchCredentials(providerId: string): Promise<SearchCredentialLookup> {
  const credentials = await getProviderCredentialsWithQuotaPreflight(providerId).catch(() => null);
  if (credentials && !isAllRateLimitedCredentials(credentials)) return credentials;

  for (const fallbackId of getSearchCredentialFallbacks(providerId)) {
    const fallbackCredentials = await getProviderCredentialsWithQuotaPreflight(fallbackId).catch(
      () => null
    );
    if (fallbackCredentials && !isAllRateLimitedCredentials(fallbackCredentials)) {
      return fallbackCredentials;
    }
    if (fallbackCredentials) return fallbackCredentials;
  }

  return credentials;
}

async function resolveSearchExecutionCredentials(providerConfig: {
  id: string;
  authType: string;
}): Promise<SearchCredentialLookup> {
  const credentials = await resolveSearchCredentials(providerConfig.id);
  if (credentials) return credentials;
  if (providerConfig.authType === "none" || isAnonymousCapableSearchProvider(providerConfig.id)) {
    return {};
  }
  return null;
}

async function resolveAvailableFreeSearchCandidates(
  searchType: string,
  blockedProviders: string[],
  excludeProviderId?: string,
  options: { keylessOnly?: boolean } = {}
): Promise<
  Array<{
    config: NonNullable<ReturnType<typeof getSearchProvider>>;
    credentials: SearchCredentials;
  }>
> {
  const resolved: Array<{
    config: NonNullable<ReturnType<typeof getSearchProvider>>;
    credentials: SearchCredentials;
  }> = [];
  for (const freeId of resolvePreferredFreeSearchProviderIds()) {
    if (freeId === excludeProviderId) continue;
    if (isProviderBlockedByIdOrAlias(freeId, blockedProviders)) continue;
    const freeConfig = getSearchProvider(freeId);
    if (!freeConfig || freeConfig.disabled || !supportsSearchType(freeConfig, searchType)) continue;
    if (options.keylessOnly) {
      if (freeConfig.authType === "none" || isAnonymousCapableSearchProvider(freeConfig.id)) {
        resolved.push({ config: freeConfig, credentials: {} });
      }
      continue;
    }
    const freeCreds = await resolveSearchExecutionCredentials(freeConfig);
    if (freeCreds && !isAllRateLimitedCredentials(freeCreds)) {
      resolved.push({ config: freeConfig, credentials: freeCreds });
    }
  }
  return resolved;
}

// Helper: build domain filter array from filters object
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

/**
 * POST /v1/search — execute a web search
 */
async function postHandler(request: Request, context: unknown) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1SearchSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, formatValidationMessage(validation.error));
  }
  const body = validation.data;
  if (body.provider === "x_search") body.provider = "x-search";
  if (body.provider === "x-search") body.search_type = "x";

  // Enforce API key policies — use "search" as model identifier for consistent policy config
  const policy = await enforceApiKeyPolicy(request, "search");
  if (policy.rejection) return policy.rejection;

  const settings = await getSettings().catch(() => ({}) as any);
  const blockedProviders = settings?.blockedProviders || [];

  // Resolve provider and credentials
  if (body.provider) {
    if (isProviderBlockedByIdOrAlias(body.provider, blockedProviders)) {
      return errorResponse(
        HTTP_STATUS.FORBIDDEN,
        `Search provider ${body.provider} is blocked by security policy`
      );
    }
    const explicitProvider = resolveSearchProvider(body.provider);
    if (!explicitProvider) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown search provider: ${body.provider}`);
    }
    if (!supportsSearchType(explicitProvider, body.search_type)) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `Search provider ${body.provider} does not support search_type: ${body.search_type}`
      );
    }
  }

  let providerConfig = selectProvider(body.provider, body.search_type);
  if (
    providerConfig &&
    !body.provider &&
    isProviderBlockedByIdOrAlias(providerConfig.id, blockedProviders)
  ) {
    const unblockedCandidate = Object.values(SEARCH_PROVIDERS)
      .filter(
        (p) =>
          !p.fallbackOnly &&
          supportsSearchType(p, body.search_type) &&
          !isProviderBlockedByIdOrAlias(p.id, blockedProviders)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)[0];
    providerConfig = unblockedCandidate || null;
  }
  if (!providerConfig) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      body.provider ? `Unknown search provider: ${body.provider}` : "No search providers available"
    );
  }

  let credentials: Record<string, any> | null = null;
  let alternateProviderId: string | undefined;
  let alternateCredentials: Record<string, any> | null = null;
  let firstRateLimitedCredentials: {
    providerId: string;
    credentials: RateLimitedCredentials;
  } | null = null;

  if (body.provider) {
    // Explicit provider — single credential lookup (with fallback)
    const explicitCredentials = await resolveSearchExecutionCredentials(providerConfig);
    if (isAllRateLimitedCredentials(explicitCredentials)) {
      return rateLimitedProviderResponse(providerConfig.id, explicitCredentials);
    }
    credentials = explicitCredentials;
    if (
      credentials &&
      (providerConfig.id === "duckduckgo-free" || providerConfig.id === "anysearch-search")
    ) {
      const freeAlts = await resolveAvailableFreeSearchCandidates(
        body.search_type,
        blockedProviders,
        providerConfig.id,
        { keylessOnly: providerConfig.id === "duckduckgo-free" }
      );
      if (freeAlts.length > 0) {
        alternateProviderId = freeAlts[0].config.id;
        alternateCredentials = freeAlts[0].credentials;
      }
    }
    if (
      !credentials &&
      isUnconfiguredSearchProviderFallbackEnabled() &&
      !isDocCorpusOnlySearchProvider(providerConfig.id)
    ) {
      const freeFallbacks = await resolveAvailableFreeSearchCandidates(
        body.search_type,
        blockedProviders,
        providerConfig.id
      );
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
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials configured for search provider: ${providerConfig.id}. Add an API key for "${providerConfig.id}" in the dashboard.`
      );
    }
  } else {
    // Auto-select — try the resolved provider first, then iterate others by cost
    const selectedCredentials = await resolveSearchExecutionCredentials(providerConfig);
    if (isAllRateLimitedCredentials(selectedCredentials)) {
      firstRateLimitedCredentials = {
        providerId: providerConfig.id,
        credentials: selectedCredentials,
      };
    } else {
      credentials = selectedCredentials;
    }

    if (!credentials) {
      // Sort by cost to find cheapest with credentials (fallback-only providers
      // are reached via the last-resort step below, never the primary pick).
      const sortedIds = Object.values(SEARCH_PROVIDERS)
        .filter(
          (provider) =>
            !provider.fallbackOnly &&
            supportsSearchType(provider, body.search_type) &&
            !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
        )
        .sort((a, b) => a.costPerQuery - b.costPerQuery)
        .map((p) => p.id);

      for (const pid of sortedIds) {
        if (pid === providerConfig.id) continue;
        const altConfig = getSearchProvider(pid);
        const altCreds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
        if (isAllRateLimitedCredentials(altCreds)) {
          firstRateLimitedCredentials ??= { providerId: pid, credentials: altCreds };
          continue;
        }
        if (altConfig && altCreds) {
          providerConfig = altConfig;
          credentials = altCreds;
          break;
        }
      }
    }

    // Next: check configured/credentialed fallback-only providers (e.g. a stored
    // self-hosted searxng-search connection or a configured paid anysearch-search
    // key) BEFORE promoting unconfigured keyless free providers.
    if (!credentials) {
      const fallbackProviders = Object.values(SEARCH_PROVIDERS)
        .filter(
          (provider) =>
            provider.fallbackOnly &&
            !isDocCorpusOnlySearchProvider(provider.id) &&
            supportsSearchType(provider, body.search_type) &&
            !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
        )
        .sort((a, b) => a.costPerQuery - b.costPerQuery);

      for (const fallbackProvider of fallbackProviders) {
        const fallbackCreds = await resolveSearchCredentials(fallbackProvider.id);
        if (isAllRateLimitedCredentials(fallbackCreds)) {
          firstRateLimitedCredentials ??= {
            providerId: fallbackProvider.id,
            credentials: fallbackCreds,
          };
          continue;
        }
        if (!fallbackCreds) continue;
        const effectiveBaseUrl = resolveSearchBaseUrl(fallbackProvider, {
          query: body.query,
          searchType: body.search_type,
          maxResults: body.max_results,
          providerOptions: body.provider_options,
          providerSpecificData:
            fallbackCreds.providerSpecificData &&
            typeof fallbackCreds.providerSpecificData === "object"
              ? fallbackCreds.providerSpecificData
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
        credentials = fallbackCreds;
        break;
      }
    }

    // Last resort before failing: promote a fallback-only free provider
    // (duckduckgo-free or anysearch-search) so out-of-the-box search works when
    // no credentialed provider is configured at all.
    if (!credentials) {
      const preferredFree = await resolveAvailableFreeSearchCandidates(
        body.search_type,
        blockedProviders
      );
      if (preferredFree.length > 0) {
        providerConfig = preferredFree[0].config;
        credentials = preferredFree[0].credentials;
      }
    }

    if (!credentials) {
      if (firstRateLimitedCredentials) {
        return rateLimitedProviderResponse(
          firstRateLimitedCredentials.providerId,
          firstRateLimitedCredentials.credentials
        );
      }
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials configured for any search provider. Add an API key for a search provider (${Object.keys(SEARCH_PROVIDERS).join(", ")}) in the dashboard.`
      );
    }

    // Find alternate for failover — must bind credentials to the matched provider.
    // Exclude fallback-only providers; they are handled in priority order below.
    const otherIds = Object.values(SEARCH_PROVIDERS)
      .filter(
        (provider) =>
          !provider.fallbackOnly &&
          supportsSearchType(provider, body.search_type) &&
          !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)
      .map((p) => p.id)
      .filter((id) => id !== providerConfig.id);

    for (const pid of otherIds) {
      const altConfig = getSearchProvider(pid);
      const creds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
      if (isAllRateLimitedCredentials(creds)) continue;
      if (creds) {
        alternateProviderId = pid;
        alternateCredentials = creds;
        break;
      }
    }

    // Next: credentialed fallback-only providers (e.g. configured searxng-search
    // or configured paid anysearch-search) before keyless free providers.
    if (!alternateProviderId) {
      for (const provider of Object.values(SEARCH_PROVIDERS)) {
        if (!provider.fallbackOnly || provider.id === providerConfig.id) continue;
        if (isDocCorpusOnlySearchProvider(provider.id)) continue;
        if (isProviderBlockedByIdOrAlias(provider.id, blockedProviders)) continue;
        if (!supportsSearchType(provider, body.search_type)) continue;
        const storedCreds = await resolveSearchCredentials(provider.id);
        if (!storedCreds || isAllRateLimitedCredentials(storedCreds)) continue;
        const effectiveBaseUrl = resolveSearchBaseUrl(provider, {
          query: body.query,
          searchType: body.search_type,
          maxResults: body.max_results,
          providerOptions: body.provider_options,
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

    // Last-resort: guarantee a general-web free no-key fallback (never doc-only
    // context7) as the failover so out-of-the-box search still works when the
    // primary provider fails or times out.
    if (!alternateProviderId) {
      const preferredFreeAlts = await resolveAvailableFreeSearchCandidates(
        body.search_type,
        blockedProviders,
        providerConfig.id
      );
      if (preferredFreeAlts.length > 0) {
        alternateProviderId = preferredFreeAlts[0].config.id;
        alternateCredentials = preferredFreeAlts[0].credentials;
      }
    }
  }

  // Clamp max_results to provider limit
  const clampedMaxResults = Math.min(body.max_results, providerConfig.maxMaxResults);

  // Cache key — includes all fields that affect results
  const cacheKey = computeCacheKey(
    body.query,
    providerConfig.id,
    body.search_type,
    clampedMaxResults,
    body.country,
    body.language,
    {
      filters: body.filters,
      offset: body.offset,
      time_range: body.time_range,
      content: body.content,
      provider_options: body.provider_options,
    }
  );

  const ttl = providerConfig.cacheTTLMs ?? SEARCH_CACHE_DEFAULT_TTL_MS;

  try {
    const { data: searchResult, cached } = await getOrCoalesce(cacheKey, ttl, async () => {
      const result = await handleSearch({
        query: body.query,
        provider: providerConfig.id,
        maxResults: clampedMaxResults,
        searchType: body.search_type,
        country: body.country,
        language: body.language,
        timeRange: body.time_range,
        offset: body.offset,
        domainFilter: buildDomainFilter(body.filters),
        contentOptions: body.content,
        strictFilters: body.strict_filters,
        providerOptions: body.provider_options,
        credentials,
        alternateProvider: alternateProviderId,
        alternateCredentials,
        log,
        connectionId: credentials?.connectionId || undefined,
        apiKeyId: policy.apiKeyInfo?.id || undefined,
      });

      if (!result.success) {
        throw new SearchError(result.error || "Search failed", result.status || 502);
      }

      return result.data!;
    });

    // Record cost for budget tracking (skip cache hits — no provider cost)
    if (!cached && policy.apiKeyInfo?.id && searchResult.usage?.search_cost_usd > 0) {
      try {
        recordCost(policy.apiKeyInfo.id, searchResult.usage.search_cost_usd);
      } catch (e: any) {
        log.warn("SEARCH", `Cost recording failed: ${e?.message}`);
      }
    }

    const response = {
      id: `search-${crypto.randomUUID()}`,
      ...searchResult,
      cached,
      usage: cached ? { queries_used: 0, search_cost_usd: 0 } : searchResult.usage,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err: any) {
    if (err instanceof SearchError) {
      const errorPayload = toJsonErrorPayload(err.message, "Search provider error");
      return new Response(JSON.stringify(errorPayload), {
        status: err.statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    log.error("SEARCH", `Unexpected error: ${err.message}`);
    const errorPayload = toJsonErrorPayload(err.message, "Internal search error");
    return new Response(JSON.stringify(errorPayload), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
}

class SearchError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const POST = withInjectionGuard(postHandler);
