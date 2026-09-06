import React, { useState, useRef, useCallback } from 'react';
import type { ChatDomain } from '../types';

interface ChatInputProps {
  onSendMessage: (
    message: string,
    imageData?: string,
    mode?: 'default' | 'fast',
    domain?: ChatDomain,
  ) => void;
  isLoading: boolean;
  loadingMessage: string;
  domain: ChatDomain;
  onDomainChange: (domain: ChatDomain) => void;
  gaffaNudge?: string | null;
  onAcceptGaffaNudge?: () => void;
  onDismissGaffaNudge?: () => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  isLoading,
  loadingMessage,
  domain,
  onDomainChange,
  gaffaNudge,
  onAcceptGaffaNudge,
  onDismissGaffaNudge,
}) => {
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [mode, setMode] = useState<'default' | 'fast'>('default');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gaffaOn = domain === 'gaffa';

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setImage(e.target?.result as string);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!message.trim() && !image) || isLoading) return;
    onSendMessage(message, image || undefined, mode, domain);
    setMessage('');
    setImage(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  return (
    <div className="relative group bg-cream-50 dark:bg-charcoal-surface rounded-none shadow-float dark:shadow-dark-float border-t-2 border-charcoal dark:border-cream-400 overflow-hidden transition-colors duration-300">
      <div className="flex flex-col relative z-10">
        {gaffaNudge && (
          <div className="px-4 pt-3 flex items-start gap-3 text-sm border-b border-charcoal/10 dark:border-cream-400/10 pb-3">
            <span className="flex-1 font-serif italic text-charcoal/80 dark:text-cream-200/80 leading-snug">
              {gaffaNudge}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onAcceptGaffaNudge}
                className="text-xs font-sans uppercase tracking-wide text-emerald-700 dark:text-emerald-400 hover:underline"
              >
                Switch
              </button>
              <button
                type="button"
                onClick={onDismissGaffaNudge}
                className="text-xs font-sans uppercase tracking-wide text-charcoal/50 dark:text-cream-400/50 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {image && (
          <div className="px-6 pt-4 pb-0 flex items-center gap-2">
            <span className="text-xs font-serif italic text-emerald-600 dark:text-emerald-400">Image attached</span>
            <button onClick={() => setImage(null)} className="text-charcoal dark:text-cream-400 hover:text-red-500">
              <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
          </div>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          className="w-full bg-transparent text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/30 text-[18px] font-serif italic px-6 py-5 pr-14 border-none focus:ring-0 resize-none max-h-32 overflow-y-auto leading-relaxed scrollbar-hide outline-none"
          placeholder={
            isLoading
              ? loadingMessage
              : gaffaOn
                ? 'Ask about rules, strategy, or a trade…'
                : 'Inquire about player statistics...'
          }
          rows={1}
        />

        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-2 text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-50 transition-colors"
              title="Attach image"
              disabled={isLoading}
            >
              <span className="material-symbols-outlined text-[20px] font-light">add_circle</span>
            </button>
            <input type="file" ref={fileInputRef} onChange={onFileChange} accept="image/*" className="hidden" />

            {/* Speed: default vs fast */}
            <div
              className="relative flex items-center bg-cream-200 dark:bg-charcoal-light rounded-full p-1 w-24 h-9 cursor-pointer ml-2 border border-cream-300 dark:border-charcoal-border select-none"
              onClick={() => setMode(mode === 'default' ? 'fast' : 'default')}
              title={mode === 'default' ? 'Deep research' : 'Fast mode'}
            >
              <div
                className={`absolute top-1 bottom-1 w-[46%] bg-white dark:bg-charcoal rounded-full shadow-sm transition-all duration-300 ease-out mx-[2%] ${mode === 'default' ? 'left-0' : 'left-[50%]'}`}
              />
              <div
                className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${mode === 'default' ? 'text-charcoal dark:text-white' : 'text-charcoal/40 dark:text-cream-400/40'}`}
              >
                <span className="material-symbols-outlined text-[18px]">psychology</span>
              </div>
              <div
                className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${mode === 'fast' ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal/40 dark:text-cream-400/40'}`}
              >
                <span className="material-symbols-outlined text-[18px]">bolt</span>
              </div>
            </div>

            {/* Domain: Gaffa */}
            <button
              type="button"
              onClick={() => onDomainChange(gaffaOn ? 'default' : 'gaffa')}
              disabled={isLoading}
              title={gaffaOn ? 'Gaffa mode on — prose answers only' : 'Switch to Gaffa mode'}
              className={`ml-1 px-3 h-9 text-xs font-sans uppercase tracking-wider border transition-colors select-none ${
                gaffaOn
                  ? 'bg-charcoal text-cream-50 border-charcoal dark:bg-emerald-600 dark:border-emerald-500 dark:text-white'
                  : 'bg-transparent text-charcoal/55 dark:text-cream-400/55 border-cream-300 dark:border-charcoal-border hover:text-charcoal dark:hover:text-cream-50'
              }`}
            >
              Gaffa
            </button>
          </div>

          <button
            onClick={handleSubmit}
            disabled={isLoading || (!message.trim() && !image)}
            className="flex items-center justify-center size-10 bg-charcoal dark:bg-emerald-500 text-cream-50 hover:bg-black dark:hover:bg-emerald-400 transition-all group disabled:opacity-50"
          >
            {isLoading ? (
              <div className="size-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
            ) : (
              <span className="material-symbols-outlined text-[20px] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">
                arrow_forward
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="absolute -bottom-1 -right-1 w-3 h-3 border-r border-b border-charcoal/20 dark:border-cream-400/20" />
      <div className="absolute -bottom-1 -left-1 w-3 h-3 border-l border-b border-charcoal/20 dark:border-cream-400/20" />
    </div>
  );
};
