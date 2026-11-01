/* eslint-disable @next/next/no-img-element */
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { File } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Chunk } from '@/lib/types';

/* How many source cards show inline. The rest are behind "View N more".
   The `source` block stays in [N] order (first appearance) because the
   citations index into it, so the first 8 here are sources [1] to [8];
   a citation to [12] still links to sources[11] (see useChat). */
const VISIBLE_SOURCES = 8;

const isUpload = (url: string) => url.includes('file_id://');

const domainOf = (url: string) =>
  isUpload(url) ? 'Uploaded File' : url.replace(/.+\/\/|www.|\..+/g, '');

/* Accessible name for a card link. The visible title is cut off with an
   ellipsis, so the full title goes here. It starts with the visible title
   and keeps the visible domain and number in the same order (WCAG 2.5.3,
   label in name), then says the link opens a new tab. */
const cardLabel = (source: Chunk, n: number) =>
  `${source.metadata.title || domainOf(source.metadata.url)}, ${domainOf(source.metadata.url)}, source ${n}, opens in a new tab`;

const MessageSources = ({ sources }: { sources: Chunk[] }) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const closeModal = () => {
    setIsDialogOpen(false);
    document.body.classList.remove('overflow-hidden-scrollable');
  };

  const openModal = () => {
    setIsDialogOpen(true);
    document.body.classList.add('overflow-hidden-scrollable');
  };

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      {/* With 8 or fewer sources all show and there is no "more" button. */}
      {sources.slice(0, VISIBLE_SOURCES).map((source, i) => (
        <a
          className="bg-light-100 hover:bg-light-200 dark:bg-dark-100 dark:hover:bg-dark-200 transition duration-200 rounded-lg p-3 flex flex-col space-y-2 font-medium"
          key={i}
          href={source.metadata.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={cardLabel(source, i + 1)}
        >
          <p className="dark:text-white text-xs overflow-hidden whitespace-nowrap text-ellipsis">
            {source.metadata.title}
          </p>
          <div className="flex flex-row items-center justify-between">
            <div className="flex flex-row items-center space-x-1">
              {source.metadata.url.includes('file_id://') ? (
                <div className="bg-dark-200 hover:bg-dark-100 transition duration-200 flex items-center justify-center w-6 h-6 rounded-full">
                  <File size={12} className="text-white/70" />
                </div>
              ) : (
                <img
                  src={`https://s2.googleusercontent.com/s2/favicons?domain_url=${source.metadata.url}`}
                  width={16}
                  height={16}
                  alt=""
                  className="rounded-lg h-4 w-4"
                />
              )}
              <p className="text-xs text-black/50 dark:text-white/50 overflow-hidden whitespace-nowrap text-ellipsis">
                {source.metadata.url.includes('file_id://')
                  ? 'Uploaded File'
                  : source.metadata.url.replace(/.+\/\/|www.|\..+/g, '')}
              </p>
            </div>
            <div className="flex flex-row items-center space-x-1 text-black/50 dark:text-white/50 text-xs">
              <div className="bg-black/50 dark:bg-white/50 h-[4px] w-[4px] rounded-full" />
              <span>{i + 1}</span>
            </div>
          </div>
        </a>
      ))}
      {sources.length > VISIBLE_SOURCES && (
        <button
          type="button"
          aria-haspopup="dialog"
          // Starts with the visible text, adds what "more" means.
          aria-label={`View ${sources.length - VISIBLE_SOURCES} more sources`}
          onClick={openModal}
          className="bg-light-100 hover:bg-light-200 dark:bg-dark-100 dark:hover:bg-dark-200 transition duration-200 rounded-lg p-3 flex flex-col space-y-2 font-medium"
        >
          <div className="flex flex-row items-center space-x-1">
            {sources
              .slice(VISIBLE_SOURCES, VISIBLE_SOURCES + 3)
              .map((source, i) => {
                return source.metadata.url === 'File' ? (
                  <div
                    key={i}
                    className="bg-dark-200 hover:bg-dark-100 transition duration-200 flex items-center justify-center w-6 h-6 rounded-full"
                  >
                    <File size={12} className="text-white/70" />
                  </div>
                ) : (
                  <img
                    key={i}
                    src={`https://s2.googleusercontent.com/s2/favicons?domain_url=${source.metadata.url}`}
                    width={16}
                    height={16}
                    alt=""
                    className="rounded-lg h-4 w-4"
                  />
                );
              })}
          </div>
          <p className="text-xs text-black/50 dark:text-white/50">
            View {sources.length - VISIBLE_SOURCES} more
          </p>
        </button>
      )}
      <Transition appear show={isDialogOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={closeModal}>
          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center">
              <TransitionChild
                as={Fragment}
                // motion-reduce: no fade or scale when the OS asks for
                // reduced motion; the dialog just appears and disappears.
                enter="ease-out duration-200 motion-reduce:transition-none"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-100 motion-reduce:transition-none"
                leaveFrom="opacity-100 scale-200"
                leaveTo="opacity-0 scale-95"
              >
                <DialogPanel className="w-full max-w-md transform rounded-2xl bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 p-6 text-left align-middle shadow-xl transition-all">
                  {/* Headless UI Dialog traps focus while open, closes on
                      Escape and returns focus to "View N more" on close;
                      DialogTitle names the dialog (aria-labelledby). */}
                  <DialogTitle className="text-lg font-medium leading-6 dark:text-white">
                    Sources
                  </DialogTitle>
                  <div className="grid grid-cols-2 gap-2 overflow-auto max-h-[300px] mt-2 pr-2">
                    {/* Every source, numbered as the citations number them. */}
                    {sources.map((source, i) => (
                      <a
                        className="bg-light-secondary hover:bg-light-200 dark:bg-dark-secondary dark:hover:bg-dark-200 border border-light-200 dark:border-dark-200 transition duration-200 rounded-lg p-3 flex flex-col space-y-2 font-medium"
                        key={i}
                        href={source.metadata.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={cardLabel(source, i + 1)}
                      >
                        <p className="dark:text-white text-xs overflow-hidden whitespace-nowrap text-ellipsis">
                          {source.metadata.title}
                        </p>
                        <div className="flex flex-row items-center justify-between">
                          <div className="flex flex-row items-center space-x-1">
                            {source.metadata.url === 'File' ? (
                              <div className="bg-dark-200 hover:bg-dark-100 transition duration-200 flex items-center justify-center w-6 h-6 rounded-full">
                                <File size={12} className="text-white/70" />
                              </div>
                            ) : (
                              <img
                                src={`https://s2.googleusercontent.com/s2/favicons?domain_url=${source.metadata.url}`}
                                width={16}
                                height={16}
                                alt=""
                                className="rounded-lg h-4 w-4"
                              />
                            )}
                            <p className="text-xs text-black/50 dark:text-white/50 overflow-hidden whitespace-nowrap text-ellipsis">
                              {source.metadata.url.replace(
                                /.+\/\/|www.|\..+/g,
                                '',
                              )}
                            </p>
                          </div>
                          <div className="flex flex-row items-center space-x-1 text-black/50 dark:text-white/50 text-xs">
                            <div className="bg-black/50 dark:bg-white/50 h-[4px] w-[4px] rounded-full" />
                            <span>{i + 1}</span>
                          </div>
                        </div>
                      </a>
                    ))}
                  </div>
                </DialogPanel>
              </TransitionChild>
            </div>
          </div>
        </Dialog>
      </Transition>
    </div>
  );
};

export default MessageSources;
