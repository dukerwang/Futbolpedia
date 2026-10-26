import React, { useState, useRef, useCallback, useLayoutEffect } from 'react';
import type { ChatDomain } from '../types';

interface ChatInputProps {
  onSendMessage: (
    message: string,
    imageData?: string,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gaffaOn = domain === 'gaffa';

  // Grow with the draft up to the CSS max-height, then scroll inside the field.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [message]);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setImage(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      handleFile(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!message.trim() && !image) || isLoading) return;
    onSendMessage(message, image || undefined, domain);
    setMessage('');
    setImage(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // On touch keyboards Return inserts a newline; the send button submits.
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  return (
    <div className="relative group bg-cream-50 dark:bg-charcoal-surface rounded-none shadow-float dark:shadow-dark-float border-t-2 border-charcoal dark:border-cream-400 overflow-hidden transition-colors duration-300">
      <div className="flex flex-col relative z-10">
        {gaffaNudge && (
          <div className="px-4 pt-3 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 text-sm border-b border-charcoal/10 dark:border-cream-400/10 pb-3">
            <span className="flex-1 font-serif italic text-charcoal/80 dark:text-cream-200/80 leading-snug">
              {gaffaNudge}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onAcceptGaffaNudge}
                className="min-h-9 px-1 text-xs font-sans uppercase tracking-wide text-emerald-700 dark:text-emerald-400 hover:underline"
              >
                Switch
              </button>
              <button
                type="button"
                onClick={onDismissGaffaNudge}
                className="min-h-9 px-1 text-xs font-sans uppercase tracking-wide text-charcoal/50 dark:text-cream-400/50 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {image && (
          <div className="px-4 sm:px-6 pt-3 sm:pt-4 pb-0 flex items-center gap-3">
            <div className="relative">
              <img src={image} alt="Attachment preview" className="size-14 object-cover rounded border border-charcoal/10 dark:border-cream-100/10" />
              <button
                type="button"
                onClick={() => setImage(null)}
                aria-label="Remove image"
                className="absolute -top-2 -right-2 size-6 rounded-full bg-charcoal dark:bg-cream-200 text-cream-50 dark:text-charcoal flex items-center justify-center shadow-sm hover:bg-red-600 dark:hover:bg-red-400"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
            <span className="text-xs font-serif italic text-emerald-600 dark:text-emerald-400">Image attached</span>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          enterKeyHint="send"
          aria-label="Message"
          className="w-full bg-transparent text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/30 text-[17px] sm:text-[18px] font-serif italic px-4 py-4 sm:px-6 sm:py-5 border-none focus:ring-0 resize-none max-h-40 sm:max-h-48 overflow-y-auto leading-relaxed scrollbar-hide outline-none"
          placeholder={
            isLoading
              ? loadingMessage
              : gaffaOn
                ? 'Ask about rules, strategy, or a trade…'
                : 'Inquire about player statistics...'
          }
          rows={1}
        />

        <div className="flex items-center justify-between px-2.5 sm:px-4 pb-2.5 sm:pb-3">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach image"
              className="size-10 flex items-center justify-center text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-50 transition-colors"
              title="Attach image"
              disabled={isLoading}
            >
              <span className="material-symbols-outlined text-[20px] font-light">add_circle</span>
            </button>
            <input type="file" ref={fileInputRef} onChange={onFileChange} accept="image/*" className="hidden" />

            {/* Domain Toggle: Futbolpedia vs Gaffa */}
            <button
              type="button"
              role="switch"
              aria-checked={gaffaOn}
              aria-label="Gaffa fantasy mode"
              disabled={isLoading}
              className="relative flex items-center bg-cream-200 dark:bg-charcoal-light rounded-full p-1 w-24 h-10 sm:h-9 cursor-pointer border border-cream-300 dark:border-charcoal-border select-none disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onDomainChange(gaffaOn ? 'default' : 'gaffa')}
              title={
                gaffaOn
                  ? 'Gaffa mode active — click to switch to Futbolpedia'
                  : 'Futbolpedia mode active — click to switch to Gaffa'
              }
            >
              <div
                className={`absolute top-1 bottom-1 w-[46%] bg-white dark:bg-charcoal rounded-full shadow-sm transition-all duration-300 ease-out mx-[2%] ${
                  !gaffaOn ? 'left-0' : 'left-[50%]'
                }`}
              />
              {/* Left: Futbolpedia mark */}
              <div
                className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${
                  !gaffaOn
                    ? 'text-charcoal dark:text-white'
                    : 'text-charcoal/40 dark:text-cream-400/40'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">sports_soccer</span>
              </div>
              {/* Right: Gaffa mark (football head + manager suit & tie) */}
              <div
                className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${
                  gaffaOn
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-charcoal/40 dark:text-cream-400/40'
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 128 128"
                  className="size-[19px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="5.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="64" cy="64" r="56" />
                  <g transform="translate(35.2, 82.8) scale(0.06)">
                    <path
                      fill="currentColor"
                      stroke="none"
                      d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm200-500 54-18 16-54q-32-48-77-82.5T574-786l-54 38v56l160 112Zm-400 0 160-112v-56l-54-38q-54 17-99 51.5T210-652l16 54 54 18Zm-42 308 46-4 30-54-58-174-56-20-40 30q0 65 18 118.5T238-272Zm242 112q26 0 51-4t49-12l28-60-26-44H378l-26 44 28 60q24 8 49 12t51 4Zm-90-200h180l56-160-146-102-144 102 54 160Zm332 88q42-50 60-103.5T800-494l-40-28-56 18-58 174 30 54 46 4Z"
                    />
                  </g>
                  <path d="M 24.8 104 C 34 88, 42 82, 50 82 M 103.2 104 C 94 88, 86 82, 78 82" />
                  <path d="M 50 82 L 44 94 H 49 L 64 116 L 79 94 H 84 L 78 82" />
                  <path d="M 54 82 L 64 96 L 74 82" />
                  <path
                    fill="currentColor"
                    stroke="none"
                    d="M 61 82 H 67 L 66 90 L 67.5 106 L 64 111 L 60.5 106 L 62 90 Z"
                  />
                </svg>
              </div>
            </button>
            <span className={`hidden sm:inline text-[10px] font-sans font-bold uppercase tracking-widest ${gaffaOn ? 'text-emerald-700 dark:text-emerald-400' : 'text-charcoal/40 dark:text-cream-400/50'}`}>
              {gaffaOn ? 'Gaffa' : 'Scouting'}
            </span>
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading || (!message.trim() && !image)}
            aria-label={isLoading ? 'Working' : 'Send message'}
            className="flex items-center justify-center size-11 sm:size-10 bg-charcoal dark:bg-emerald-500 text-cream-50 hover:bg-black dark:hover:bg-emerald-400 transition-all group disabled:opacity-50"
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
