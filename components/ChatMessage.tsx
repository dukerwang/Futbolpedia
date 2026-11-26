import React, { useState } from 'react';
import type { ChatMessage as ChatMessageType, ChatDossierRef } from '../types';
import { ReplyBody } from './ReplyBody';
import { blocksOf, copyTextOf, LEGACY_ERROR_PREFIX } from '../services/replyBlocks';
import { getLegacyDossierRef } from '../services/dossierRefs';
import { ratingVersionLabel } from '../services/ratingCommand';
import { InkLabel } from './EditionLabel';

const copyText = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // navigator.clipboard is unavailable on insecure origins (for example a phone hitting the dev server over LAN).
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(el);
        return ok;
    }
};

const formatTime = (timestamp?: number) =>
    timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

const ActionButton: React.FC<{ icon: string; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        className="min-h-9 px-2 -mx-2 text-xs text-charcoal/50 dark:text-cream-400/60 hover:text-charcoal dark:hover:text-cream-100 transition-colors flex items-center gap-1 font-sans uppercase tracking-wider font-bold"
    >
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        {label}
    </button>
);

/** A user message's text with its @ mentions tinted, as they were in the chat box. */
const withMentions = (text: string, mentions?: string[]): React.ReactNode => {
    if (!mentions?.length) return text;
    const pattern = new RegExp(`(${[...mentions].sort((a, b) => b.length - a.length).map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
    return text.split(pattern).map((part, i) =>
        mentions.includes(part) ? (
            <span key={i} className="not-italic font-semibold text-emerald-700 dark:text-emerald-400">{part}</span>
        ) : (
            part
        ),
    );
};

interface ChatMessageProps {
    message: ChatMessageType;
    onOpenDossier?: (dossier: ChatDossierRef) => void;
    onScoutName?: (name: string) => void;
    onRetry?: (messageId: string) => void;
    /** Given only on the latest reply: a chip sends its text as the next message. */
    onAsk?: (text: string) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, onOpenDossier, onScoutName, onRetry, onAsk }) => {
    const { sender, content, timestamp } = message;
    const isUser = sender === 'user';
    const [copied, setCopied] = useState(false);

    // Determine if the message is newly received (created within the last 10 seconds)
    const isNew = !isUser && timestamp ? (Date.now() - timestamp < 10000) : false;

    const isError =
        !isUser && (message.isError || (typeof content === 'string' && content.startsWith(LEGACY_ERROR_PREFIX)));
    const dossier = message.dossier ?? (isUser ? null : getLegacyDossierRef(content));

    const blocks = blocksOf(message);
    const getCopyText = () => copyTextOf(blocks);

    const handleCopy = async () => {
        if (!(await copyText(getCopyText()))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const handleShare = () => {
        navigator.share({ title: 'Futbolpedia analysis', text: getCopyText() }).catch(() => {});
    };

    // A Rate command: a compact command line rather than a speech bubble.
    if (isUser && message.rating) {
        const version = ratingVersionLabel(message.rating);
        const { edition } = message.rating;
        return (
            <div className="flex justify-end w-full py-2 sm:py-4 animate-fade-in">
                <div className="flex flex-col items-end gap-1 max-w-[88%] md:max-w-[70%]">
                    <div className="flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border border-cream-300 dark:border-charcoal-border bg-cream-50/70 dark:bg-charcoal-surface/70 text-charcoal dark:text-cream-100">
                        <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-emerald-600 dark:text-emerald-400">star</span>
                        <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/55 dark:text-cream-400/60">Rate</span>
                        <span className="min-w-0 truncate font-serif font-bold text-[15px]">{message.rating.name}</span>
                        {version && <InkLabel ink={edition === 'prime' ? 'prime' : edition === 'era' ? 'era' : edition === 'season' ? 'season' : 'current'} name={version} size="xs" />}
                    </div>
                    <span className="text-[10px] text-cream-800 dark:text-cream-400 tracking-wider uppercase font-medium">
                        You{timestamp ? ` · ${formatTime(timestamp)}` : ''}
                    </span>
                </div>
            </div>
        );
    }

    // User Message
    if (isUser) {
        return (
            <div className="flex items-start justify-end gap-3 sm:gap-4 w-full py-3 sm:py-6 group animate-fade-in">
                <div className="flex flex-col items-end gap-1.5 sm:gap-2 max-w-[88%] md:max-w-[70%]">
                    <div className="bg-[#EBE8DE] dark:bg-charcoal-light text-charcoal dark:text-cream-50 px-4 py-3 sm:px-6 sm:py-4 rounded-tl-xl rounded-bl-xl rounded-br-xl shadow-sm relative border border-transparent dark:border-charcoal-border">
                        {message.image && <img src={message.image} alt="Attached image" className="max-w-[180px] max-h-[180px] object-cover mb-2 rounded border border-charcoal/10 dark:border-cream-100/10" />}
                        <p className="text-[16px] sm:text-[17px] font-serif italic leading-relaxed break-words whitespace-pre-wrap">
                           {typeof content === 'string' ? withMentions(content, message.mentions) : ''}
                        </p>
                    </div>
                    <span className="text-[10px] text-cream-800 dark:text-cream-400 tracking-wider uppercase font-medium">
                        You{timestamp ? ` · ${formatTime(timestamp)}` : ''}
                    </span>
                </div>
                 <div className="hidden sm:flex size-10 rounded-full bg-[#EBE8DE] dark:bg-charcoal-light border border-cream-400 dark:border-charcoal-border shrink-0 mt-1 items-center justify-center">
                    <span className="material-symbols-outlined text-charcoal/50 dark:text-cream-400/50">person</span>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-start gap-3 sm:gap-6 w-full py-3 sm:py-6 animate-fade-in group">
            <div className="hidden sm:flex size-10 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal items-center justify-center shrink-0 mt-1 shadow-md">
                <span className="font-serif font-bold italic text-xl">F</span>
            </div>
            <div className="flex flex-col gap-3 flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 border-b border-cream-300 dark:border-charcoal-border pb-2">
                    <span className="flex items-center gap-2 text-[10px] font-sans font-bold text-charcoal/60 dark:text-cream-400 uppercase tracking-widest">
                        <span className="sm:hidden size-5 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal flex items-center justify-center font-serif italic text-[11px] normal-case tracking-normal">F</span>
                        {isError ? "Editor's note" : blocks.some(b => b.kind === 'scorecard') ? 'Gaffa Briefing' : dossier ? 'Dossier Filed' : 'Analysis Report'}
                    </span>
                    {timestamp ? (
                        <span className="text-[10px] font-sans text-charcoal/40 dark:text-cream-400/50 tabular-nums">{formatTime(timestamp)}</span>
                    ) : null}
                </div>

                <ReplyBody
                    message={message}
                    isNew={isNew}
                    isError={Boolean(isError)}
                    onRetry={onRetry}
                    onOpenDossier={onOpenDossier}
                    onScoutName={onScoutName}
                    onAsk={onAsk}
                />

                {!isError && (
                    <div className="flex items-center gap-5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100">
                        <ActionButton icon={copied ? 'check' : 'content_copy'} label={copied ? 'Copied' : 'Copy'} onClick={handleCopy} />
                        {canShare && <ActionButton icon="ios_share" label="Share" onClick={handleShare} />}
                    </div>
                )}
            </div>
        </div>
    );
};
