import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ChatDossierRef, ChatMessage, ReplyBlock } from '../types';
import { blocksOf } from '../services/replyBlocks';
import { getLegacyDossierRef } from '../services/dossierRefs';
import { useTypewriter } from './useTypewriter';
import { GaffaTradeScorecardView } from './GaffaTradeScorecard';
import { DossierChatCard } from './DossierChatCard';
import { AskChips, GoDeeperChip } from './ReplyChips';
import { ScoutOffer } from './ScoutOffer';
import { ComparisonSkeleton, ComparisonView } from './views/ComparisonView';
import { LeagueTableSkeleton, LeagueTableView } from './views/LeagueTableView';
import { PitchBlockView, PitchSkeleton } from './views/PitchBlockView';
import { RankingSkeleton, RankingView } from './views/RankingView';

// External links in model prose should never navigate away from an in-progress chat.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
});

const renderMarkdown = (text: string) => {
    const rawMarkup = marked.parse(text, { gfm: true, breaks: true }) as string;
    // Wrap tables so wide comparisons scroll inside the bubble instead of the whole page.
    const html = DOMPurify.sanitize(rawMarkup)
        .replace(/<table>/g, '<div class="chat-table-wrap"><table>')
        .replace(/<\/table>/g, '</table></div>');
    return { __html: html };
};

export interface ReplyBodyProps {
    message: ChatMessage;
    /** The reply arrived in the last few seconds, so its last stretch of prose types in. */
    isNew: boolean;
    isError: boolean;
    onRetry?: (messageId: string) => void;
    onOpenDossier?: (dossier: ChatDossierRef) => void;
    onScoutName?: (name: string) => void;
    /** Given only on the latest reply: a chip sends its text as the next message. */
    onAsk?: (text: string) => void;
    /** Given only on the latest reply: reruns the question in deep mode as a new turn. */
    onGoDeeper?: (messageId: string) => void;
}

const Prose: React.FC<{ text: string; typing?: boolean }> = ({ text, typing }) => (
    <div
        className={`chat-prose prose max-w-none text-charcoal dark:text-cream-100 text-[16px] font-light font-sans ${typing ? 'is-typing' : ''}`}
        dangerouslySetInnerHTML={renderMarkdown(text)}
    />
);

/** The skeleton of a pending view, as tall as the view that replaces it where the call says enough to know. */
const skeletonOf = (b: ReplyBlock): React.ReactNode => {
    if (b.kind === 'prose' || b.status !== 'pending') return null;
    switch (b.kind) {
        case 'pitch':
            return <PitchSkeleton />;
        case 'table':
            return <LeagueTableSkeleton caption={['Table', b.hint?.league]} />;
        case 'comparison':
            return <ComparisonSkeleton />;
        case 'ranking':
            return <RankingSkeleton title={b.hint?.title} rows={b.hint?.rows} />;
        default:
            return <div aria-busy="true" aria-label="Loading" className="h-24 border border-cream-300 dark:border-charcoal-border bg-cream-100/50 dark:bg-charcoal-surface/50 animate-pulse" />;
    }
};

/**
 * A reply's body: its blocks in order, with the prose typing in as it arrives. Blocks after the last
 * prose wait until it has finished typing; a `pending` view shows a placeholder and a `failed` one
 * draws nothing.
 */
export const ReplyBody: React.FC<ReplyBodyProps> = ({ message, isNew, isError, onRetry, onOpenDossier, onScoutName, onAsk, onGoDeeper }) => {
    const blocks = blocksOf(message);
    // The side-panel notice of an old dossier reply is redundant beside its card.
    const hideNotice = typeof message.content === 'string' && Boolean(getLegacyDossierRef(message.content));
    const lastProse = blocks.reduce((at, b, i) => (b.kind === 'prose' ? i : at), -1);
    const firstProse = blocks.findIndex(b => b.kind === 'prose');
    const lastText = lastProse >= 0 && !hideNotice ? (blocks[lastProse] as { text: string }).text : '';
    const typed = useTypewriter(lastText, isNew, 8, 6);
    const isTyping = isNew && typed.length < lastText.length;

    const proseOf = (b: ReplyBlock, i: number): string | null => {
        if (b.kind !== 'prose' || hideNotice) return null;
        return i === lastProse ? typed : b.text;
    };

    if (isError) {
        const leading = blocks.filter((b, i) => b.kind !== 'prose' && (firstProse < 0 || i < firstProse));
        const text = blocks.filter(b => b.kind === 'prose').map(b => (b as { text: string }).text).join('\n\n');
        return (
            <>
                {leading.map(b => renderOne(b, true))}
                <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3 border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3">
                    <span className="material-symbols-outlined text-[20px] text-amber-600 dark:text-amber-400 shrink-0">report</span>
                    <p className="flex-1 text-sm font-sans leading-relaxed text-charcoal/80 dark:text-cream-200/85 break-words">
                        {text || 'Something went wrong while preparing this report.'}
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
            </>
        );
    }

    /** One block outside a run. `lead` is a block ahead of the prose, drawn bare. */
    function renderOne(b: ReplyBlock, lead: boolean): React.ReactNode {
        if (b.kind === 'prose') return null;
        // A view whose data is still loading holds its place, the height of its settled state, so the
        // prose below doesn't jump; a failed view draws nothing.
        if (b.status === 'pending') return <div key={b.id} className="animate-fade-in">{skeletonOf(b)}</div>;
        if (b.status !== 'ready') return null;
        switch (b.kind) {
            case 'pitch':
                return <div key={b.id} className="animate-fade-in"><PitchBlockView lineup={b.data} /></div>;
            case 'table':
                return <div key={b.id} className="animate-fade-in"><LeagueTableView data={b.data} /></div>;
            case 'comparison':
                return <div key={b.id} className="animate-fade-in"><ComparisonView data={b.data} onOpenDossier={onOpenDossier} /></div>;
            case 'ranking':
                return <div key={b.id} className="animate-fade-in"><RankingView data={b.data} onOpenDossier={onOpenDossier} onScoutName={onScoutName} /></div>;
            case 'scorecard':
                return <GaffaTradeScorecardView key={b.id} card={b.data} />;
            case 'card':
                return <DossierChatCard key={b.id} dossier={b.data} onOpen={onOpenDossier} />;
            case 'scoutOffer':
                return onScoutName ? <ScoutOffer key={b.id} name={b.data.name} onScout={onScoutName} /> : null;
            case 'ask':
                return onAsk && b.data.options.length ? (
                    <div key={b.id} className="animate-fade-in"><AskChips options={b.data.options} onAsk={onAsk} /></div>
                ) : null;
            case 'goDeeper':
                return onGoDeeper && b.data.reason ? (
                    <div key={b.id} className="animate-fade-in"><GoDeeperChip reason={b.data.reason} onGoDeeper={() => onGoDeeper(message.id)} /></div>
                ) : null;
            default:
                return null;
        }
    }

    const out: React.ReactNode[] = [];
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const afterProse = lastProse >= 0 && i > lastProse;
        if (afterProse && isTyping) break;
        if (b.kind === 'prose') {
            const text = proseOf(b, i);
            if (text) out.push(<Prose key={b.id} text={text} typing={i === lastProse && isTyping} />);
            continue;
        }
        // Cards and Scout offers sit together in one column under the prose.
        if ((b.kind === 'card' || b.kind === 'scoutOffer') && firstProse >= 0 && i > firstProse) {
            const run: ReplyBlock[] = [];
            while (i < blocks.length && (blocks[i].kind === 'card' || blocks[i].kind === 'scoutOffer')) run.push(blocks[i++]);
            i--;
            const items = run.map(r => renderOne(r, false)).filter(Boolean);
            if (items.length) out.push(<div key={b.id} className="flex flex-col gap-2 animate-fade-in">{items}</div>);
            continue;
        }
        const node = renderOne(b, true);
        if (node) out.push(node);
    }
    return <>{out}</>;
};
