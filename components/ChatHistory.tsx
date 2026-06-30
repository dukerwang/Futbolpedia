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
             <div className="w-full flex gap-6 py-6 border-b border-cream-300/30 dark:border-charcoal-border/30">
                 <div className="size-10 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal flex items-center justify-center shrink-0 mt-1 shadow-md animate-pulse">
                    <span className="font-serif font-bold italic text-xl">F</span>
                </div>
                <div className="flex flex-col gap-1.5 flex-1 justify-center">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-sans font-bold text-charcoal/60 dark:text-cream-400 uppercase tracking-widest">
                            Analyst Thinking
                        </span>
                        {/* Three bouncing progress dots */}
                        <div className="flex items-center gap-1 ml-1 h-3">
                            <span className="size-1.5 rounded-full bg-charcoal/60 dark:bg-cream-400/60 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                            <span className="size-1.5 rounded-full bg-charcoal/60 dark:bg-cream-400/60 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                            <span className="size-1.5 rounded-full bg-charcoal/60 dark:bg-cream-400/60 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                        </div>
                    </div>
                    <div className="flex items-center">
                        <span className="text-sm font-serif italic text-charcoal/70 dark:text-cream-100/70">
                            {loadingMessage}
                        </span>
                    </div>
                </div>
            </div>
        )}
        
        <div ref={endOfMessagesRef} className="h-4" />
      </div>
    </div>
  );
};