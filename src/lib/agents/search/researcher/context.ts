// TypeScript: what the researcher LLM sees between iterations (M3): a compact digest of each search result and the user message with the queries already run.
import type { SourceGroup } from '@/lib/evidence';
import type { ChatTurnMessage } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import type { ClassifierOutput } from '../types';

// Characters of a source's best passage shown in the digest.
export const DIGEST_PASSAGE_CHARS = 200;

// The host name without "www.", 'upload' for uploaded files, '' if unknown.
const domainOf = (url: string): string => {
  if (url.startsWith('file_id://')) return 'upload';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// One line of text: newlines and runs of spaces become single spaces.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/*
  The passage with the highest reranker score, or the first one when no
  passage has a score. Scores only compare within one rerank, which is
  normally the case inside one source.
*/
const bestPassage = (group: SourceGroup) => {
  let best = group.passages[0];
  for (const p of group.passages) {
    const score = p.metadata?.score;
    const bestScore = best?.metadata?.score;
    if (
      typeof score === 'number' &&
      (typeof bestScore !== 'number' || score > bestScore)
    ) {
      best = p;
    }
  }
  return best;
};

/*
  The compact digest of some sources, one line each, plus a count line:
    [3] Title (example.com) kind=full_page extraction=ok: first 200 chars…
    selected 7 passages from 3 sources
  The researcher only needs to know what was found to decide what to search
  next; the full passages go to the writer, not here.
*/
export const formatResearchDigest = (groups: SourceGroup[]): string => {
  const lines = groups.map((group) => {
    const best = bestPassage(group);
    const text = oneLine(String(best?.content ?? ''));
    const excerpt =
      text.length > DIGEST_PASSAGE_CHARS
        ? text.slice(0, DIGEST_PASSAGE_CHARS) + '…'
        : text;
    const domain = domainOf(group.url);
    const title = oneLine(group.title) || group.url || 'Untitled';
    const extraction = best?.metadata?.extraction ?? 'n/a';
    return `[${group.index}] ${title}${domain ? ` (${domain})` : ''} kind=${group.kind} extraction=${extraction}: ${excerpt}`;
  });

  const passages = groups.reduce((n, g) => n + g.passages.length, 0);
  lines.push(
    `selected ${passages} ${passages === 1 ? 'passage' : 'passages'} from ${groups.length} ${groups.length === 1 ? 'source' : 'sources'}`,
  );
  return lines.join('\n');
};

/*
  The researcher's user message. It is rebuilt every iteration so the list
  of queries already run stays current. Freshness, intent and entities come
  from the classifier and drive query planning (see webSearch.ts).
*/
export const buildResearcherUserMessage = (args: {
  chatHistory: ChatTurnMessage[];
  followUp: string;
  classification: ClassifierOutput;
  queriesRun: string[];
}): string => {
  const c = args.classification.classification;
  const entities =
    c.entities && c.entities.length > 0
      ? c.entities.map((e) => `"${e}"`).join(', ')
      : '(none)';
  const queriesRun =
    args.queriesRun.length > 0
      ? args.queriesRun.map((q) => `- ${q}`).join('\n')
      : '(none yet)';

  return `
<conversation>
${formatChatHistoryAsString(args.chatHistory.slice(-10))}
User: ${args.followUp} (Standalone question: ${args.classification.standaloneFollowUp})
</conversation>
<query_planning>
Freshness: ${c.freshness ?? 'none'}
Intent: ${c.intent ?? 'other'}
Entities to keep verbatim: ${entities}
Queries already run:
${queriesRun}
</query_planning>
`;
};
