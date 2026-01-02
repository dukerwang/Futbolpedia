import React, { useState, useCallback, useEffect } from 'react';
import { Header } from './components/Header';
import { ChatHistory } from './components/ChatHistory';
import { ChatInput } from './components/ChatInput';
import { ErrorMessage } from './components/ErrorMessage';
import type { ChatMessage } from './types';
import { sendMessageToAI, resetChat } from './services/geminiService';

type Status = 'idle' | 'loading' | 'error' | 'success';
type Theme = 'light' | 'dark';

const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
const CHAT_HISTORY_KEY = 'futbolpedia-chat-history';
const THEME_KEY = 'futbolpedia-theme';

const App: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string>('Researching your question...');
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_KEY);
      return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark';
    } catch {
      return 'dark';
    }
  });

  // Apply theme class and save to localStorage
  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      root.classList.add('dark');
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Load messages from localStorage on initial render
  useEffect(() => {
    try {
      const savedMessages = localStorage.getItem(CHAT_HISTORY_KEY);
      if (savedMessages) {
        const parsedMessages = JSON.parse(savedMessages);
        if (Array.isArray(parsedMessages) && parsedMessages.length > 0) {
          setMessages(parsedMessages);
          return;
        }
      }
    } catch (error) {
      console.error("Failed to load chat history from localStorage:", error);
      localStorage.removeItem(CHAT_HISTORY_KEY); // Clear corrupted data
    }
    
    // Default message if nothing is loaded
    setMessages([
      {
        id: 'initial-welcome',
        sender: 'ai',
        content: "Welcome to Futbolpedia AI! Ask me for a detailed player profile (e.g., \"rate Lionel Messi\") or any other football-related question. You can also upload images for me to analyze!"
      }
    ]);
  }, []);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages));
    }
  }, [messages]);
  
  const handleSendMessage = useCallback(async (userMessageText: string, imageData?: string) => {
    if (!userMessageText.trim() && !imageData) return;

    let specificLoadingMessage = 'Researching your question...';
    const lowerCaseMessage = userMessageText.toLowerCase();

    if (imageData) {
        specificLoadingMessage = 'Analyzing image...';
    } else if (lowerCaseMessage.includes('rate') || lowerCaseMessage.includes('profile') || lowerCaseMessage.includes('evaluation')) {
        specificLoadingMessage = 'Analyzing player data...';
    } else if (lowerCaseMessage.includes('rank') || lowerCaseMessage.includes('top') || lowerCaseMessage.includes('best')) {
        specificLoadingMessage = 'Compiling rankings...';
    } else if (lowerCaseMessage.includes('compare') || lowerCaseMessage.includes('vs')) {
        specificLoadingMessage = 'Comparing players...';
    }
    setLoadingMessage(specificLoadingMessage);

    const newUserMessage: ChatMessage = {
      id: generateId(),
      sender: 'user',
      content: userMessageText || "Image uploaded",
      image: imageData,
    };
    
    const currentMessages = [...messages, newUserMessage];
    setMessages(currentMessages);
    setStatus('loading');
    setError(null);

    try {
      const aiResponse = await sendMessageToAI(userMessageText, messages, imageData);
      const newAiMessage: ChatMessage = {
        id: generateId(),
        sender: 'ai',
        content: aiResponse,
      };
      setMessages(prev => [...prev, newAiMessage]);
      setStatus('success');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      console.error(err);
      setError(errorMessage);
      const newErrorMessage: ChatMessage = {
        id: generateId(),
        sender: 'ai',
        content: `Sorry, I encountered an error: ${errorMessage}`
      }
      setMessages(prev => [...prev, newErrorMessage]);
      setStatus('error');
    }
  }, [messages]);

  const handleNewChat = useCallback(() => {
    resetChat();
    localStorage.removeItem(CHAT_HISTORY_KEY);
    setStatus('idle');
    setError(null);
    setLoadingMessage('Researching your question...');
    setMessages([
      {
        id: 'initial-welcome-cleared',
        sender: 'ai',
        content: "Welcome to Futbolpedia AI! Ask me for a detailed player profile (e.g., \"rate Lionel Messi\") or any other football-related question. You can also upload images for me to analyze!"
      }
    ]);
  }, []);

  const handleThemeToggle = useCallback(() => {
    setTheme(prevTheme => prevTheme === 'light' ? 'dark' : 'light');
  }, []);

  return (
    <div className="flex flex-col h-screen bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-200 transition-colors duration-300">
      <Header onNewChat={handleNewChat} onThemeToggle={handleThemeToggle} theme={theme} />
      <main className="flex-1 flex flex-col overflow-hidden container mx-auto w-full max-w-4xl">
        <ChatHistory messages={messages} isLoading={status === 'loading'} loadingMessage={loadingMessage} />
        {error && <div className="px-4 pb-4"><ErrorMessage message={error} /></div>}
        <ChatInput onSendMessage={handleSendMessage} isLoading={status === 'loading'} loadingMessage={loadingMessage} />
      </main>
    </div>
  );
};

export default App;
