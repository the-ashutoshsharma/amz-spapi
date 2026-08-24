import { cache } from 'react';
import type { AmazonApiType } from '@farvisionllc/models';
import {
  credentialService,
  type CredentialProfileView,
} from '../services/credential-service';

/**
 * One listing per API type per request, however many callers ask.
 *
 * The mint next door in `amazon-clients` was memoized for exactly this reason
 * and this was not, which left the asymmetry that `ads-ops.resolve()` runs on
 * EVERY ads tool call — so a chat turn touching three ads tools made three
 * round trips to list the same five profiles, at roughly 2.7s each.
 *
 * **`cache` from React, which is REQUEST-scoped — not a module-level map.** A
 * module-level cache lives for the life of the server instance, and one Vercel
 * instance serves many users, so it would hand one seller's connection list to
 * the next request that asked for the same API type. Request scope cannot.
 *
 * Keyed on `apiType` alone, deliberately: React's `cache` compares arguments by
 * identity, so memoizing on the filter OBJECT would miss on every call — each
 * caller passes a fresh literal. Filtering and sorting stay outside, where they
 * are pure and cost nothing.
 *
 * Outside a request scope this simply does not memoize, which is the behaviour
 * before it existed — slower, never wrong.
 */
const listingForRequest = cache(async (apiType: AmazonApiType) => {
  const credentials = await credentialService();
  return credentials.list(apiType);
});

/**
 * Which Amazon connections the current user has (#55).
 *
 * Read from the credentials API, not from the database. Every field here is
 * metadata — marketplace, region, seller id, advertiser profile id, and a
 * boolean for whether a refresh token is held. **No secret is in this file's
 * types**, which is the property that makes the rest of step 5 possible: a
 * caller that cannot name a refresh token cannot pass one to a client.
 *
 * The old `env-self-auth` fallback is gone. It read `LWA_REFRESH_TOKEN` from the
 * environment and synthesised a connection out of it — a long-lived seller
 * credential in the Vercel runtime, which is exactly what #55 exists to remove.
 * It was also already dead: the variable is set in no environment.
 */

export type AmazonConnection = {
  profileName: string;
  profile: CredentialProfileView;
  isDefault: boolean;
  /**
   * What this connection lacks in order to be usable. Empty means usable.
   *
   * Kept as strings because it is shown to the user on the connections page.
   */
  missing: string[];
};

type ConnectionFilters = {
  apiType: AmazonApiType;
  /**
   * Ignored, and kept only so the many call sites that pass it still compile.
   *
   * The API takes the caller from the verified JWT, so there is no user to
   * choose. Passing a different one here does nothing — which is the point, and
   * is why it is not simply deleted: a signature change would let a call site
   * silently keep an id it believed was being honoured.
   */
  userId?: string;
  marketplaceId?: string;
  profileName?: string;
  requireAdvertiserProfileId?: boolean;
  requireRefreshToken?: boolean;
};

type ResolveResult =
  | {
      connected: true;
      connection: AmazonConnection;
      candidates: AmazonConnection[];
    }
  | {
      connected: false;
      reason: string;
      candidates: AmazonConnection[];
    };

function getMissingFields(
  profile: CredentialProfileView,
  options: Pick<
    ConnectionFilters,
    'apiType' | 'requireAdvertiserProfileId' | 'requireRefreshToken'
  >
): string[] {
  const missing: string[] = [];
  if (!profile.client_id) missing.push('client_id');

  if (options.requireRefreshToken !== false && !profile.has_refresh_token) {
    // `has_refresh_token_known: false` means the stored document predates #55
    // and carries no flag, so `false` here is a default rather than a fact.
    // Said plainly rather than reported as a definite missing credential — the
    // remedy differs, and a user told to reconnect a working account will.
    missing.push(
      profile.has_refresh_token_known
        ? 'refresh_token'
        : 'refresh_token (unverified)'
    );
  }

  if (
    options.apiType === 'ADS_API' &&
    options.requireAdvertiserProfileId &&
    !profile.advertiser_profile_id
  ) {
    missing.push('advertiser_profile_id');
  }
  return missing;
}

function matchesMarketplace(
  profile: CredentialProfileView,
  marketplaceId?: string
) {
  return !marketplaceId || profile.marketplace_id === marketplaceId;
}

function sortConnections(
  connections: AmazonConnection[],
  preferredMarketplaceId?: string
) {
  return [...connections].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (preferredMarketplaceId) {
      const aMatches = a.profile.marketplace_id === preferredMarketplaceId;
      const bMatches = b.profile.marketplace_id === preferredMarketplaceId;
      if (aMatches !== bMatches) return aMatches ? -1 : 1;
    }
    return (b.profile.updated_at || 0) - (a.profile.updated_at || 0);
  });
}

/**
 * Every connection for one API, best first.
 *
 * One API call for the whole answer, per ADR-0007 — the previous version made
 * one call to list names and then one per name to fetch each profile, which was
 * N+1 against the database and decrypted every profile to answer a question
 * about none of them.
 */
export async function listAmazonConnections(
  options: ConnectionFilters
): Promise<AmazonConnection[]> {
  const listing = await listingForRequest(options.apiType);
  const defaultProfileName = listing.defaults[options.apiType];

  const connections = listing.profiles
    .filter((profile) => profile.api_type === options.apiType)
    .filter(
      (profile) =>
        !options.profileName || profile.profile_name === options.profileName
    )
    .filter((profile) => matchesMarketplace(profile, options.marketplaceId))
    .map((profile) => ({
      profileName: profile.profile_name,
      profile,
      isDefault: profile.profile_name === defaultProfileName,
      missing: getMissingFields(profile, options),
    }));

  return sortConnections(connections, options.marketplaceId);
}

export async function resolveAmazonConnection(
  options: ConnectionFilters
): Promise<ResolveResult> {
  const candidates = await listAmazonConnections(options);
  const ready = candidates.find((candidate) => candidate.missing.length === 0);

  if (ready) {
    return {
      connected: true,
      connection: ready,
      candidates,
    };
  }

  if (!candidates.length) {
    return {
      connected: false,
      reason: `${options.apiType} is not connected${
        options.marketplaceId ? ` for marketplace ${options.marketplaceId}` : ''
      }.`,
      candidates,
    };
  }

  return {
    connected: false,
    reason: `${
      options.apiType
    } connection is missing ${candidates[0].missing.join(', ')}.`,
    candidates,
  };
}
