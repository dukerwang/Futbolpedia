import React, { useEffect, useRef } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { ChatMessage } from './ChatMessage';

interface ChatHistoryProps {
  messages: ChatMessageType[];
  isLoading: boolean;
  loadingMessage: string;
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({ messages, isLoading, loadingMessage }) => {
  const endOfMessagesRef = useRef<null | HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  return (
    <div 
        className="flex-1 overflow-y-auto relative scroll-smooth pb-40" 
        id="chat-container" 
        style={{ overflowAnchor: 'none' }}
    >
      <div className="max-w-[800px] w-full mx-auto flex flex-col gap-2 px-6 pt-10">
        
        {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-[50vh] opacity-40 select-none">
                <div className="size-16 rounded-full border-2 border-charcoal/20 dark:border-cream-400/20 flex items-center justify-center mb-4">
                     <span className="font-serif italic text-4xl text-charcoal/40 dark:text-cream-400/40 font-bold">F</span>
                </div>
                <p className="font-serif italic text-lg text-charcoal/60 dark:text-cream-400">Awaiting Query...</p>
            </div>
        )}

        {messages.map(msg => <ChatMessage key={msg.id} message={msg} />)}
        
        {isLoading && (
             <div className="w-full flex gap-6 py-6 opacity-60 animate-pulse">
                 {/* Lighter Gray background as requested */}
                 <div className="size-10 rounded-full bg-cream-400/50 dark:bg-charcoal-light flex items-center justify-center shrink-0 mt-1 shadow-sm">
                    <span className="font-serif font-bold italic text-xl text-charcoal dark:text-cream-200">F</span>
                </div>
                <div className="flex items-center">
                    <span className="text-sm font-serif italic text-charcoal dark:text-cream-100">{loadingMessage}</span>
                </div>
            </div>
        )}
        
        <div ref={endOfMessagesRef} className="h-4" />
      </div>
    </div>
  );
};