import React from 'react';
import type { ChatMessage as ChatMessageType, PlayerProfile, PlayerComparison } from '../types';
import { PlayerProfileDisplay } from './PlayerProfileDisplay';
import { PlayerComparisonDisplay } from './PlayerComparisonDisplay';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const isPlayerProfile = (content: any): content is PlayerProfile => {
    return typeof content === 'object' && content !== null && !React.isValidElement(content) && 'basicInfo' in content && 'ratings' in content;
};

const isPlayerComparison = (content: any): content is PlayerComparison => {
    return typeof content === 'object' && content !== null && !React.isValidElement(content) && 'summary' in content && Array.isArray(content.players);
};

export const ChatMessage: React.FC<{ message: ChatMessageType }> = ({ message }) => {
    const { sender, content, image } = message;

    const isUser = sender === 'user';

    if (isUser) {
        return (
            <div className="flex justify-end">
                <div className="bg-blue-600 text-white rounded-lg px-4 py-3 max-w-lg shadow-md space-y-2">
                    {image && (
                        <div className="mb-2">
                            <img src={image} alt="User upload" className="max-w-full h-auto rounded-lg border border-white/20 shadow-sm" />
                        </div>
                    )}
                    <div className="text-sm md:text-base">
                        {typeof content === 'string' ? content : '...'}
                    </div>
                </div>
            </div>
        );
    }

    // AI Message
    if (isPlayerComparison(content)) {
        return (
            <div className="w-full">
                <PlayerComparisonDisplay comparison={content} />
            </div>
        );
    }

    if (isPlayerProfile(content)) {
        return (
            <div className="w-full">
                <PlayerProfileDisplay profile={content} />
            </div>
        );
    }

    const renderTextContent = () => {
        if (typeof content === 'string') {
            const rawMarkup = marked.parse(content, { gfm: true, breaks: true, async: false }) as string;
            const sanitizedMarkup = DOMPurify.sanitize(rawMarkup);
            return <div className="markdown-content" dangerouslySetInnerHTML={{ __html: sanitizedMarkup }} />;
        }
        return content;
    };

    return (
        <div className="flex justify-start">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 max-w-2xl shadow-md border border-gray-200 dark:border-gray-700">
                {renderTextContent()}
            </div>
        </div>
    );
};
