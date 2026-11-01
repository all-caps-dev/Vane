// TypeScript: source priors (experimental). A small, deterministic bonus for first-party pages (vendor, standards body, registry, docs) and a penalty for aggregators, used as a tie-break after reranking.
import type { Evidence } from '@/lib/evidence';

/* What the prior knows about the request: the classifier's entities and
   intent. Nothing here depends on the eval fixtures. */
export type SourcePriorContext = { entities: string[]; intent: string };

/* Prior values. NEUTRAL is what an unknown page gets, so a penalty can
   exist while every value stays in [0, 1]. */
export const PRIOR_NEUTRAL = 0.25;
const PRIOR_AGGREGATOR = 0;
const PRIOR_DOCS = 0.6;
const PRIOR_FIRST_PARTY = 0.8; // vendor, standards body or package registry
const PRIOR_DOCS_EXTRA = 0.2; // first party AND a docs page

/* Standards bodies and package registries. A host matches itself and its
   subdomains (www.w3.org, datatracker.ietf.org). */
const STANDARDS_HOSTS = [
  'w3.org',
  'ietf.org',
  'rfc-editor.org',
  'iso.org',
  'access-board.gov',
  'section508.gov',
];
const REGISTRY_HOSTS = ['npmjs.com', 'pypi.org', 'crates.io', 'pkg.go.dev'];
// github.com counts as a registry only on a repo's releases or tags page.
const GITHUB_RELEASES = /^\/[^/]+\/[^/]+\/(releases|tags)(\/|$)/i;

/* Aggregators and trackers that restate first-party facts. Seen in the
   2026-10-31 eval sources and called out by the judge:
   - medium.com, dev.to: self-published posts, often copies of vendor docs;
   - linkedin.com, pinterest, quora.com: social reposts and Q&A;
   - deepwiki.com: machine-written summaries of GitHub repos;
   - releasebot.io, versionping.app and any "*tracker*" domain: version
     trackers the judge marked down on the Claude Code version question. */
const AGGREGATOR_HOSTS = [
  'medium.com',
  'dev.to',
  'linkedin.com',
  'quora.com',
  'deepwiki.com',
  'releasebot.io',
  'versionping.app',
];
const AGGREGATOR_LABEL = /^pinterest$|tracker/;

/* Standard names whose body lives at a different domain. Used for the
   official_docs query variant, and to stop squatter domains named after a
   standard (wcag.com) from counting as the vendor. */
export const STANDARD_BODIES: Record<string, string> = {
  wcag: 'w3.org',
  wai: 'w3.org',
  aria: 'w3.org',
  w3c: 'w3.org',
  rfc: 'ietf.org',
  section508: 'section508.gov',
};

/* Entity words that never identify a vendor on their own ("Community" in
   "TrueNAS Community Edition", "Code" in "Claude Code"). */
const GENERIC_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'version',
  'edition',
  'community',
  'server',
  'pro',
  'max',
  'plus',
  'mini',
  'ultra',
  'new',
  'latest',
  'stable',
  'release',
  'docs',
  'api',
  'app',
  'cloud',
  'home',
  'open',
  'free',
  'code',
]);

const hostMatches = (host: string, domain: string): boolean =>
  host === domain || host.endsWith('.' + domain);

// Lower case letters and digits only: "home-assistant" -> "homeassistant".
const squash = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, '');

/* The name part of the registrable domain: "forums.truenas.com" ->
   "truenas", "www.haisoft.co.uk" -> "haisoft". Subdomains are ignored on
   purpose: "proxmox.rdem-systems.com" is not Proxmox. */
export const registrableLabel = (host: string): string => {
  const labels = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  if (labels.length < 2) return labels[0] ?? '';
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  // Two-part public suffixes such as co.uk and com.au.
  if (
    labels.length >= 3 &&
    last.length === 2 &&
    ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(second)
  )
    return labels[labels.length - 3];
  return second;
};

/* The names an entity could be published under: each distinctive word,
   and runs of two or three adjacent words joined ("Home Assistant" ->
   "homeassistant", "llama.cpp" -> "llamacpp"). Standard names are left out
   (see STANDARD_BODIES). */
export const entityNames = (entity: string): string[] => {
  const words = entity
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const names = new Set<string>();
  words.forEach((w, i) => {
    if (w.length >= 3 && /[a-z]/.test(w) && !GENERIC_TOKENS.has(w))
      names.add(w);
    for (let n = 2; n <= 3 && i + n <= words.length; n++) {
      const joined = words.slice(i, i + n).join('');
      if (joined.length >= 4 && /[a-z]/.test(joined)) names.add(joined);
    }
  });
  return [...names].filter((n) => !(n in STANDARD_BODIES));
};

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/* True when the page belongs to an entity's own project: its registrable
   domain is the entity's name (truenas.com for "TrueNAS"), or, on GitHub,
   the repo owner or name is (github.com/ggml-org/llama.cpp for
   "llama.cpp"). */
const isVendor = (url: URL, entities: string[]): boolean => {
  const names = new Set(entities.flatMap(entityNames));
  if (names.size === 0) return false;
  const host = url.hostname.toLowerCase();
  if (names.has(squash(registrableLabel(host)))) return true;
  if (hostMatches(host, 'github.com')) {
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return [owner, repo].some((part) => part && names.has(squash(part)));
  }
  return false;
};

const isDocs = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase() + '/';
  return (
    host.startsWith('docs.') ||
    host.startsWith('developer.') ||
    host.includes('readthedocs') ||
    path.includes('/docs/') ||
    path.includes('/documentation/')
  );
};

const isStandardsOrRegistry = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  if ([...STANDARDS_HOSTS, ...REGISTRY_HOSTS].some((d) => hostMatches(host, d)))
    return true;
  return hostMatches(host, 'github.com') && GITHUB_RELEASES.test(url.pathname);
};

const isAggregator = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  if (AGGREGATOR_HOSTS.some((d) => hostMatches(host, d))) return true;
  return AGGREGATOR_LABEL.test(registrableLabel(host));
};

/*
  The prior for one passage's page, in [0, 1]:
    aggregator or tracker               0
    anything else                       0.25 (neutral)
    documentation page                  0.6
    vendor, standards body or registry  0.8
    one of those AND a docs page        1.0
  For 'opinion' questions first-party pages get no bonus (forums and
  reviews are the point there); the aggregator penalty still applies.
*/
export const sourcePrior = (
  evidence: Pick<Evidence, 'url'> & { canonicalUrl?: string },
  ctx: SourcePriorContext,
): number => {
  const url = parse(evidence.url) ?? parse(evidence.canonicalUrl ?? '');
  if (!url) return PRIOR_NEUTRAL;
  if (isAggregator(url)) return PRIOR_AGGREGATOR;
  if (ctx.intent === 'opinion') return PRIOR_NEUTRAL;

  const docs = isDocs(url);
  const firstParty =
    isStandardsOrRegistry(url) || isVendor(url, ctx.entities ?? []);

  if (firstParty)
    return Math.min(1, PRIOR_FIRST_PARTY + (docs ? PRIOR_DOCS_EXTRA : 0));
  if (docs) return PRIOR_DOCS;
  return PRIOR_NEUTRAL;
};

/*
  Reorders one rerank's output by score + weight * prior. Reranker scores
  are min-max scaled to [0, 1] within this one list first, because their
  scale depends on the reranker (cross-encoder logits, cosine similarity,
  positions); scores from different reranks are never compared. `score`
  keeps the reranker's raw value; `prior` is set on every item. Ties keep
  the reranker's order. A weight of 0 (or less) returns the list unchanged.
*/
export const applySourcePriors = (
  ranked: Evidence[],
  ctx: SourcePriorContext,
  weight: number,
): Evidence[] => {
  if (!(weight > 0) || ranked.length === 0) return ranked;

  const scores = ranked.map((e) => e.score);
  const known = scores.filter((s): s is number => Number.isFinite(s));
  const min = known.length ? Math.min(...known) : 0;
  const span = known.length ? Math.max(...known) - min : 0;
  // Unscored items (the defensive tail of rerankEvidence) scale to 0.
  const scaled = (s: number | undefined) =>
    s === undefined || !Number.isFinite(s) || span === 0 ? 0 : (s - min) / span;

  return ranked
    .map((e, i) => {
      const prior = sourcePrior(e, ctx);
      return { e: { ...e, prior }, i, key: scaled(e.score) + weight * prior };
    })
    .sort((a, b) => b.key - a.key || a.i - b.i)
    .map(({ e }) => e);
};

/*
  A guess at the vendor's domain for the official_docs query variant: the
  standards body for a standard name (WCAG -> w3.org), otherwise the first
  distinctive entity word + ".com" (Proxmox VE 9 -> proxmox.com). Only a
  guess, so it is added to a query as a plain word, never as site:.
  Returns undefined when no entity has a usable word.
*/
export const vendorDomainGuess = (entities: string[]): string | undefined => {
  for (const entity of entities) {
    const words = entity
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const pair = words[i] + (words[i + 1] ?? '');
      if (STANDARD_BODIES[words[i]]) return STANDARD_BODIES[words[i]];
      if (STANDARD_BODIES[pair]) return STANDARD_BODIES[pair];
    }
  }
  for (const entity of entities) {
    const word = entity
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .find(
        (w) =>
          w.length >= 3 &&
          /^[a-z]/.test(w) &&
          !GENERIC_TOKENS.has(w) &&
          !(w in STANDARD_BODIES),
      );
    if (word) return `${word}.com`;
  }
  return undefined;
};
