import React, { useEffect, useRef } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { ChatMessage } from './ChatMessage';
import { LoadingSpinner } from './LoadingSpinner';

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
    <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
      {messages.map(msg => <ChatMessage key={msg.id} message={msg} />)}
      {isLoading && 
        <div className="flex justify-start">
            <div className="bg-gray-200 dark:bg-gray-800 rounded-lg p-4 max-w-lg">
                <LoadingSpinner message={loadingMessage} />
            </div>
        </div>
      }
      <div ref={endOfMessagesRef} />
    </div>
  );
};