// TypeScript (React): an inline [N] citation link in the answer.
import React from 'react';
import { Chunk } from '@/lib/types';

// Hostname of a link, or '' when it is not a web URL (e.g. file_id://).
const hostnameOf = (href: string): string => {
  try {
    const { protocol, hostname } = new URL(href);
    return protocol === 'http:' || protocol === 'https:'
      ? hostname.replace(/^www\./, '')
      : '';
  } catch {
    return '';
  }
};

const Citation = ({
  href,
  children,
  sources = [],
}: {
  href: string;
  children: React.ReactNode;
  // The full source list (MessageBox passes it), so [N] can be named by its
  // title. It is the same list useChat used to build href, so sources[N-1]
  // is the source this link points at, however many cards the UI shows.
  sources?: Chunk[];
}) => {
  // The visible text is the citation number, e.g. "12".
  const label = React.Children.toArray(children).join('').trim();
  const n = parseInt(label, 10);
  const source = Number.isFinite(n) && n > 0 ? sources[n - 1] : undefined;
  const title = String(source?.metadata?.title ?? '').trim();
  const name = title || hostnameOf(href) || href;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Starts with "Source 12" so the visible number is part of the name
      // (WCAG 2.5.3), then says what the source is and that it opens a tab.
      aria-label={`Source ${label}: ${name}, opens in a new tab`}
      className="bg-light-secondary dark:bg-dark-secondary px-1 rounded ml-1 no-underline text-xs text-black/70 dark:text-white/70 relative"
    >
      {children}
    </a>
  );
};

export default Citation;
