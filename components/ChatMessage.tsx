import React, { useState } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { useTypewriter } from './useTypewriter';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Legacy chats may still store old comparison objects — render summary as prose. */
const getLegacyComparisonSummary = (content: unknown): string | null => {
    if (typeof content !== 'object' || content === null) return null;
    if (!('summary' in content) || !('players' in content)) return null;
    const summary = (content as { summary?: unknown }).summary;
    return typeof summary === 'string' ? summary : null;
};

export const ChatMessage: React.FC<{ message: ChatMessageType }> = ({ message }) => {
    const { sender, content, timestamp } = message;
    const isUser = sender === 'user';
    const [copied, setCopied] = useState(false);

    // Determine if the message is newly received (created within the last 10 seconds)
    const isNew = !isUser && timestamp ? (Date.now() - timestamp < 10000) : false;

    // Get the base text to render
    let textToRender = '';
    if (typeof content === 'string') {
        textToRender = content;
    } else if (typeof content === 'object' && content !== null && 'basicInfo' in content) {
        textToRender = `**Dossier Generated: ${content.basicInfo.name}**\n\n${content.shortBio}`;
    } else {
        const legacySummary = getLegacyComparisonSummary(content);
        if (legacySummary) textToRender = legacySummary;
    }

    // Call typewriter hook at top level
    const typedText = useTypewriter(textToRender, isNew, 8, 6);

    const handleCopy = () => {
        let textToCopy = '';
        if (typeof content === 'string') textToCopy = content;
        else if (typeof content === 'object' && content !== null && 'basicInfo' in content) textToCopy = `Player Profile: ${content.basicInfo.name}\n${content.shortBio}`;
        else {
            const legacySummary = getLegacyComparisonSummary(content);
            if (legacySummary) textToCopy = legacySummary;
        }
        
        navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // User Message
    if (isUser) {
        return (
            <div className="flex items-start justify-end gap-4 w-full py-6 group">
                <div className="flex flex-col items-end gap-2 max-w-[85%] md:max-w-[70%]">
                    <div className="bg-[#EBE8DE] dark:bg-charcoal-light text-charcoal dark:text-cream-50 px-6 py-4 rounded-tl-xl rounded-bl-xl rounded-br-xl shadow-sm relative border border-transparent dark:border-charcoal-border">
                         {message.image && <img src={message.image} alt="Upload" className="max-w-[150px] mb-2 rounded border border-charcoal/10 dark:border-cream-100/10" />}
                        <p className="text-[17px] font-serif italic leading-relaxed">
                           {typeof content === 'string' ? content : ''}
                        </p>
                    </div>
                    <span className="text-[10px] text-cream-800 dark:text-cream-400 tracking-wider uppercase font-medium">You</span>
                </div>
                 <div className="size-10 rounded-full bg-[#EBE8DE] dark:bg-charcoal-light border border-cream-400 dark:border-charcoal-border shrink-0 mt-1 flex items-center justify-center">
                    <span className="material-symbols-outlined text-charcoal/50 dark:text-cream-400/50">person</span>
                </div>
            </div>
        );
    }

    const renderContent = () => {
        const rawMarkup = marked.parse(typedText, { gfm: true, breaks: true }) as string;
        const sanitizedMarkup = DOMPurify.sanitize(rawMarkup);
        return { __html: sanitizedMarkup };
    };

    return (
        <div className="flex items-start gap-6 w-full py-6 animate-fade-in group">
            <div className="size-10 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal flex items-center justify-center shrink-0 mt-1 shadow-md">
                <span className="font-serif font-bold italic text-xl">F</span>
            </div>
            <div className="flex flex-col gap-3 flex-1 min-w-0">
                <div className="flex items-center justify-between border-b border-cream-300 dark:border-charcoal-border pb-2">
                    <span className="text-[10px] font-sans font-bold text-charcoal/60 dark:text-cream-400 uppercase tracking-widest">Analysis Report</span>
                </div>
                
                <div className="prose max-w-none text-charcoal dark:text-cream-100 leading-8 text-[16px] font-light font-sans" dangerouslySetInnerHTML={renderContent()} />

                <div className="flex justify-start pt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                     <button 
                        onClick={handleCopy}
                        className="text-xs text-charcoal/40 dark:text-cream-400/40 hover:text-charcoal dark:hover:text-cream-100 transition-colors flex items-center gap-1 font-sans uppercase tracking-wider font-bold"
                        title="Copy Analysis"
                    >
                        <span className="material-symbols-outlined text-[16px]">{copied ? 'check' : 'content_copy'}</span>
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
            </div>
        </div>
    );
};
