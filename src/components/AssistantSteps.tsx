'use client';

import {
  Brain,
  Search,
  FileText,
  ChevronDown,
  ChevronUp,
  BookSearch,
  ListOrdered,
  ClipboardCheck,
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { MutableRefObject, useEffect, useId, useRef, useState } from 'react';
import { ResearchBlock, ResearchBlockSubStep } from '@/lib/types';
import { useChat } from '@/lib/hooks/useChat';

const getStepIcon = (step: ResearchBlockSubStep) => {
  if (step.type === 'reasoning') {
    return <Brain className="w-4 h-4" />;
  } else if (step.type === 'searching' || step.type === 'upload_searching') {
    return <Search className="w-4 h-4" />;
  } else if (
    step.type === 'search_results' ||
    step.type === 'upload_search_results'
  ) {
    return <FileText className="w-4 h-4" />;
  } else if (step.type === 'reading') {
    return <BookSearch className="w-4 h-4" />;
  } else if (step.type === 'ranking') {
    return <ListOrdered className="w-4 h-4" />;
  } else if (step.type === 'gap_check') {
    return <ClipboardCheck className="w-4 h-4" />;
  }

  return null;
};

const getStepTitle = (
  step: ResearchBlockSubStep,
  isStreaming: boolean,
): string => {
  if (step.type === 'reasoning') {
    return isStreaming && !step.reasoning ? 'Thinking...' : 'Thinking';
  } else if (step.type === 'searching') {
    const queries = Array.isArray(step.searching) ? step.searching : [];
    return `Searching ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}`;
  } else if (step.type === 'search_results') {
    return `Found ${step.reading.length} ${step.reading.length === 1 ? 'result' : 'results'}`;
  } else if (step.type === 'reading') {
    return `Reading ${step.reading.length} ${step.reading.length === 1 ? 'source' : 'sources'}`;
  } else if (step.type === 'upload_searching') {
    return 'Scanning your uploaded documents';
  } else if (step.type === 'upload_search_results') {
    return `Reading ${step.results.length} ${step.results.length === 1 ? 'document' : 'documents'}`;
  } else if (step.type === 'ranking') {
    // Real counts from the selection, e.g. "Ranked 48 passages, kept 16 from 5 sources".
    return `Ranked ${step.candidates} ${step.candidates === 1 ? 'passage' : 'passages'}, kept ${step.selected} from ${step.sources} ${step.sources === 1 ? 'source' : 'sources'}`;
  } else if (step.type === 'gap_check') {
    const gaps = Array.isArray(step.gaps) ? step.gaps.length : 0;
    if (gaps > 0)
      return `Checked coverage: ${gaps} ${gaps === 1 ? 'gap' : 'gaps'}`;
    return step.covered
      ? 'Checked coverage: no gaps'
      : 'Checked coverage: not fully covered';
  }

  return 'Processing';
};

/* What a screen reader hears when a step starts. Generic on purpose: counts
   are not known yet while the step is still streaming. */
const getStepStartAnnouncement = (step: ResearchBlockSubStep): string => {
  switch (step.type) {
    case 'reasoning':
      return 'Thinking';
    case 'searching':
      return 'Searching the web';
    case 'upload_searching':
      return 'Scanning your uploaded documents';
    case 'search_results':
      return 'Collecting results';
    case 'reading':
    case 'upload_search_results':
      return 'Reading sources';
    case 'ranking':
      return 'Ranking passages';
    case 'gap_check':
      return 'Checking coverage';
    default:
      return 'Working';
  }
};

// What a screen reader hears when a step is finished, with its final counts.
const getStepDoneAnnouncement = (step: ResearchBlockSubStep): string => {
  if (step.type === 'reasoning') return 'Finished thinking';
  if (step.type === 'searching') {
    const n = Array.isArray(step.searching) ? step.searching.length : 0;
    return `Searched ${n} ${n === 1 ? 'query' : 'queries'}`;
  }
  if (step.type === 'reading') {
    const n = step.reading.length;
    return `Read ${n} ${n === 1 ? 'source' : 'sources'}`;
  }
  if (step.type === 'upload_search_results') {
    const n = step.results.length;
    return `Read ${n} ${n === 1 ? 'document' : 'documents'}`;
  }
  // The rest already read as finished ("Found 12 results", "Ranked ...").
  return getStepTitle(step, false);
};

const AssistantSteps = ({
  block,
  status,
  isLast,
  liveRegionRef,
}: {
  block: ResearchBlock;
  status: 'answering' | 'completed' | 'error';
  isLast: boolean;
  // A visually hidden role="status" element owned by MessageBox.
  liveRegionRef?: MutableRefObject<HTMLDivElement | null>;
}) => {
  const { researchEnded, loading } = useChat();
  const reduceMotion = useReducedMotion();
  const panelId = useId();

  /* Open while this message is researching, closed once research ends.
     Same rule as the old useEffect, applied while rendering instead (React's
     "adjust state when a prop changes" pattern), which is what the
     react-hooks/set-state-in-effect lint rule asks for. */
  const [isExpanded, setIsExpanded] = useState(
    isLast && status === 'answering' && !researchEnded,
  );
  const [synced, setSynced] = useState({ researchEnded, status, isLast });
  if (
    synced.researchEnded !== researchEnded ||
    synced.status !== status ||
    synced.isLast !== isLast
  ) {
    setSynced({ researchEnded, status, isLast });
    if (researchEnded && isLast) {
      setIsExpanded(false);
    } else if (status === 'answering' && isLast) {
      setIsExpanded(true);
    }
  }

  /* Screen reader announcements. The step list itself is NOT a live region:
     reasoning text streams in token by token and result lists grow, and a
     live list would re-read on every patch. Instead one short line goes to
     the status region when a step starts and when it finishes (a step is
     finished once a later step exists, or research has ended). Ids already
     announced are remembered, so each event is spoken once. */
  const announced = useRef<{
    started: Set<string>;
    done: Set<string>;
    ended: boolean;
  } | null>(null);

  useEffect(() => {
    const steps = block?.data.subSteps ?? [];
    const live = isLast && loading;

    if (announced.current === null) {
      announced.current = { started: new Set(), done: new Set(), ended: false };
      // Opening an old chat, or a finished answer: say nothing.
      if (!live || researchEnded) {
        steps.forEach((s) => {
          announced.current!.started.add(s.id);
          announced.current!.done.add(s.id);
        });
        announced.current.ended = true;
        return;
      }
    }

    const seen = announced.current;
    const parts: string[] = [];
    steps.forEach((step, i) => {
      const finished = i < steps.length - 1 || researchEnded;
      if (finished && !seen.done.has(step.id)) {
        seen.done.add(step.id);
        seen.started.add(step.id);
        parts.push(getStepDoneAnnouncement(step));
      } else if (!finished && !seen.started.has(step.id)) {
        seen.started.add(step.id);
        parts.push(getStepStartAnnouncement(step));
      }
    });
    if (researchEnded && isLast && !seen.ended) {
      seen.ended = true;
      parts.push('Research complete');
    }

    // Written straight to the DOM: React renders this node empty and never
    // touches its text, and no re-render is needed to announce.
    if (parts.length > 0 && liveRegionRef?.current) {
      liveRegionRef.current.textContent = parts.join('. ') + '.';
    }
    // `block` gets a new identity on every patch (useChat copies it), so this
    // runs per patch; it only writes when a step starts or finishes.
  }, [block, researchEnded, isLast, loading, liveRegionRef]);

  if (!block || block.data.subSteps.length === 0) return null;

  return (
    <div className="rounded-lg bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 overflow-hidden">
      <button
        type="button"
        aria-expanded={isExpanded}
        // Only point at the panel while it is in the DOM.
        aria-controls={isExpanded ? panelId : undefined}
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-light-200 dark:hover:bg-dark-200 transition duration-200"
      >
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-black dark:text-white" />
          <span className="text-sm font-medium text-black dark:text-white">
            Research Progress ({block.data.subSteps.length}{' '}
            {block.data.subSteps.length === 1 ? 'step' : 'steps'})
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-black/70 dark:text-white/70" />
        ) : (
          <ChevronDown className="w-4 h-4 text-black/70 dark:text-white/70" />
        )}
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            // prefers-reduced-motion: open and close instantly.
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="border-t border-light-200 dark:border-dark-200"
          >
            {/* Steps happen in order, so an ordered list. Tailwind's
                preflight already removes list markers and padding. */}
            <ol className="p-3 space-y-2">
              {block.data.subSteps.map((step, index) => {
                const isLastStep = index === block.data.subSteps.length - 1;
                const isStreaming = loading && isLastStep && !researchEnded;

                return (
                  <motion.li
                    key={step.id}
                    // prefers-reduced-motion: no slide-in, step just appears.
                    initial={reduceMotion ? false : { opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.2, delay: 0 }}
                    className="flex gap-2"
                  >
                    <div className="flex flex-col items-center -mt-0.5">
                      <div
                        className={`rounded-full p-1.5 bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 ${isStreaming ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                      >
                        {getStepIcon(step)}
                      </div>
                      {index < block.data.subSteps.length - 1 && (
                        <div className="w-0.5 flex-1 min-h-[20px] bg-light-200 dark:bg-dark-200 mt-1.5" />
                      )}
                    </div>

                    <div className="flex-1 pb-1">
                      <span className="text-sm font-medium text-black dark:text-white">
                        {getStepTitle(step, isStreaming)}
                      </span>

                      {step.type === 'reasoning' && (
                        <>
                          {step.reasoning && (
                            <p className="text-xs text-black/70 dark:text-white/70 mt-0.5">
                              {step.reasoning}
                            </p>
                          )}
                          {isStreaming && !step.reasoning && (
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <div
                                className="w-1.5 h-1.5 bg-black/40 dark:bg-white/40 rounded-full animate-bounce motion-reduce:animate-none"
                                style={{ animationDelay: '0ms' }}
                              />
                              <div
                                className="w-1.5 h-1.5 bg-black/40 dark:bg-white/40 rounded-full animate-bounce motion-reduce:animate-none"
                                style={{ animationDelay: '150ms' }}
                              />
                              <div
                                className="w-1.5 h-1.5 bg-black/40 dark:bg-white/40 rounded-full animate-bounce motion-reduce:animate-none"
                                style={{ animationDelay: '300ms' }}
                              />
                            </div>
                          )}
                        </>
                      )}

                      {step.type === 'searching' &&
                        Array.isArray(step.searching) &&
                        step.searching.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.searching.map((query, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                              >
                                {query}
                              </span>
                            ))}
                          </div>
                        )}

                      {(step.type === 'search_results' ||
                        step.type === 'reading') &&
                        step.reading.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.reading.slice(0, 4).map((result, idx) => {
                              const url = result.metadata.url || '';
                              const title = result.metadata.title || 'Untitled';
                              const domain = url ? new URL(url).hostname : '';
                              const faviconUrl = domain
                                ? `https://s2.googleusercontent.com/s2/favicons?domain=${domain}&sz=128`
                                : '';

                              return (
                                <a
                                  key={idx}
                                  href={url}
                                  target="_blank"
                                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                                >
                                  {faviconUrl && (
                                    // Decorative favicon from a remote host; next/image would need every domain allow-listed.
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={faviconUrl}
                                      alt=""
                                      className="w-3 h-3 rounded-sm flex-shrink-0"
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none';
                                      }}
                                    />
                                  )}
                                  <span className="line-clamp-1">{title}</span>
                                </a>
                              );
                            })}
                          </div>
                        )}

                      {step.type === 'gap_check' &&
                        Array.isArray(step.gaps) &&
                        step.gaps.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.gaps.map((gap, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                              >
                                {gap}
                              </span>
                            ))}
                          </div>
                        )}

                      {step.type === 'upload_searching' &&
                        step.queries.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {step.queries.map((query, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-light-100 dark:bg-dark-100 text-black/70 dark:text-white/70 border border-light-200 dark:border-dark-200"
                              >
                                {query}
                              </span>
                            ))}
                          </div>
                        )}

                      {step.type === 'upload_search_results' &&
                        step.results.length > 0 && (
                          <div className="mt-1.5 grid gap-3 lg:grid-cols-3">
                            {step.results.slice(0, 4).map((result, idx) => {
                              const title =
                                (result.metadata &&
                                  (result.metadata.title ||
                                    result.metadata.fileName)) ||
                                'Untitled document';

                              return (
                                <div
                                  key={idx}
                                  className="flex flex-row space-x-3 rounded-lg border border-light-200 dark:border-dark-200 bg-light-100 dark:bg-dark-100 p-2 cursor-pointer"
                                >
                                  <div className="mt-0.5 h-10 w-10 rounded-md bg-cyan-100 text-cyan-800 dark:bg-sky-500 dark:text-cyan-50 flex items-center justify-center">
                                    <FileText className="w-5 h-5" />
                                  </div>
                                  <div className="flex flex-col justify-center">
                                    <p className="text-[13px] text-black dark:text-white line-clamp-1">
                                      {title}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                    </div>
                  </motion.li>
                );
              })}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default AssistantSteps;
