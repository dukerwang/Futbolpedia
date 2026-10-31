import React, { useState } from 'react';
import type { ChatMessage as ChatMessageType, ChatDossierRef } from '../types';
import { useTypewriter } from './useTypewriter';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { GaffaTradeScorecardView, formatScorecardCopy } from './GaffaTradeScorecard';
import { DossierChatCard, getLegacyDossierRef } from './DossierChatCard';
import { pillClass, type PillTone } from './pills';
import { ratingVersionLabel } from '../services/ratingCommand';

// External links in model prose should never navigate away from an in-progress chat.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
});

const LEGACY_ERROR_PREFIX = "Editor's Note: I encountered an issue.";

/** Legacy chats may still store old comparison objects — render summary as prose. */
const getLegacyComparisonSummary = (content: unknown): string | null => {
    if (typeof content !== 'object' || content === null) return null;
    if (!('summary' in content) || !('players' in content)) return null;
    const summary = (content as { summary?: unknown }).summary;
    return typeof summary === 'string' ? summary : null;
};

const renderMarkdown = (text: string) => {
    const rawMarkup = marked.parse(text, { gfm: true, breaks: true }) as string;
    // Wrap tables so wide comparisons scroll inside the bubble instead of the whole page.
    const html = DOMPurify.sanitize(rawMarkup)
        .replace(/<table>/g, '<div class="chat-table-wrap"><table>')
        .replace(/<\/table>/g, '</table></div>');
    return { __html: html };
};

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

interface ChatMessageProps {
    message: ChatMessageType;
    onOpenDossier?: (dossier: ChatDossierRef) => void;
    onRetry?: (messageId: string) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, onOpenDossier, onRetry }) => {
    const { sender, content, timestamp } = message;
    const isUser = sender === 'user';
    const [copied, setCopied] = useState(false);

    // Determine if the message is newly received (created within the last 10 seconds)
    const isNew = !isUser && timestamp ? (Date.now() - timestamp < 10000) : false;

    const isError =
        !isUser && (message.isError || (typeof content === 'string' && content.startsWith(LEGACY_ERROR_PREFIX)));
    const dossier = message.dossier ?? (isUser ? null : getLegacyDossierRef(content));

    // Get the base text to render
    let textToRender = '';
    if (typeof content === 'string') {
        textToRender = isError ? content.replace(LEGACY_ERROR_PREFIX, '').trim() : content;
    } else if (typeof content === 'object' && content !== null && 'basicInfo' in content) {
        textToRender = `**Dossier Generated: ${content.basicInfo.name}**\n\n${content.shortBio}`;
    } else {
        const legacySummary = getLegacyComparisonSummary(content);
        if (legacySummary) textToRender = legacySummary;
    }
    // The dossier card carries the name and ratings, so drop the redundant "see the side panel" notice.
    if (dossier && typeof content === 'string' && getLegacyDossierRef(content)) textToRender = '';

    // Call typewriter hook at top level
    const typedText = useTypewriter(textToRender, isNew, 8, 6);

    const getCopyText = () => {
        let textToCopy = '';
        if (typeof content === 'string') textToCopy = content;
        else if (typeof content === 'object' && content !== null && 'basicInfo' in content) textToCopy = `Player Profile: ${content.basicInfo.name}\n${content.shortBio}`;
        else {
            const legacySummary = getLegacyComparisonSummary(content);
            if (legacySummary) textToCopy = legacySummary;
        }
        if (message.gaffaScorecard) {
            textToCopy = [formatScorecardCopy(message.gaffaScorecard), textToCopy].filter(Boolean).join('\n\n');
        }
        return textToCopy;
    };

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
        const versionTone: PillTone = edition === 'prime' ? 'amber' : edition === 'era' ? 'blue' : 'neutral';
        return (
            <div className="flex justify-end w-full py-2 sm:py-4 animate-fade-in">
                <div className="flex flex-col items-end gap-1 max-w-[88%] md:max-w-[70%]">
                    <div className="flex items-center gap-2 min-w-0 px-3 py-1.5 rounded-full border border-cream-300 dark:border-charcoal-border bg-cream-50/70 dark:bg-charcoal-surface/70 text-charcoal dark:text-cream-100">
                        <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-emerald-600 dark:text-emerald-400">star</span>
                        <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/55 dark:text-cream-400/60">Rate</span>
                        <span className="min-w-0 truncate font-serif font-bold text-[15px]">{message.rating.name}</span>
                        {version && <span className={pillClass(versionTone, 'xs')}>{version}</span>}
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
                           {typeof content === 'string' ? content : ''}
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

    const isTyping = isNew && typedText.length < textToRender.length;

    return (
        <div className="flex items-start gap-3 sm:gap-6 w-full py-3 sm:py-6 animate-fade-in group">
            <div className="hidden sm:flex size-10 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal items-center justify-center shrink-0 mt-1 shadow-md">
                <span className="font-serif font-bold italic text-xl">F</span>
            </div>
            <div className="flex flex-col gap-3 flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 border-b border-cream-300 dark:border-charcoal-border pb-2">
                    <span className="flex items-center gap-2 text-[10px] font-sans font-bold text-charcoal/60 dark:text-cream-400 uppercase tracking-widest">
                        <span className="sm:hidden size-5 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal flex items-center justify-center font-serif italic text-[11px] normal-case tracking-normal">F</span>
                        {isError ? "Editor's note" : message.gaffaScorecard ? 'Gaffa Briefing' : dossier ? 'Dossier Filed' : 'Analysis Report'}
                    </span>
                    {timestamp ? (
                        <span className="text-[10px] font-sans text-charcoal/40 dark:text-cream-400/50 tabular-nums">{formatTime(timestamp)}</span>
                    ) : null}
                </div>

                {message.gaffaScorecard ? (
                    <GaffaTradeScorecardView card={message.gaffaScorecard} />
                ) : null}

                {dossier ? <DossierChatCard dossier={dossier} onOpen={onOpenDossier} /> : null}

                {isError ? (
                    <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3 border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3">
                        <span className="material-symbols-outlined text-[20px] text-amber-600 dark:text-amber-400 shrink-0">report</span>
                        <p className="flex-1 text-sm font-sans leading-relaxed text-charcoal/80 dark:text-cream-200/85 break-words">
                            {textToRender || 'Something went wrong while preparing this report.'}
                        </p>
                        {onRetry && (
                            <button
                                type="button"
                                onClick={() => onRetry(message.id)}
                                className="shrink-0 self-start sm:self-auto min-h-9 px-3 flex items-center gap-1.5 bg-charcoal dark:bg-cream-200 text-cream-50 dark:text-charcoal text-[11px] font-sans font-bold uppercase tracking-widest hover:opacity-90 transition-opacity"
                            >
                                <span className="material-symbols-outlined text-[16px]">refresh</span>
                                Retry
                            </button>
                        )}
                    </div>
                ) : typedText ? (
                    <div
                        className={`chat-prose prose max-w-none text-charcoal dark:text-cream-100 text-[16px] font-light font-sans ${isTyping ? 'is-typing' : ''}`}
                        dangerouslySetInnerHTML={renderMarkdown(typedText)}
                    />
                ) : null}

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
