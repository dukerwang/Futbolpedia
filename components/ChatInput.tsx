import React, { useState, useRef, useCallback } from 'react';

interface ChatInputProps {
  onSendMessage: (message: string, imageData?: string) => void;
  isLoading: boolean;
  loadingMessage: string;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSendMessage, isLoading, loadingMessage }) => {
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      setImage(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!message.trim() && !image) || isLoading) return;
    onSendMessage(message, image || undefined);
    setMessage('');
    setImage(null);
  };

  const removeImage = () => setImage(null);

  return (
    <div className="p-4 border-t border-gray-200 dark:border-gray-700/50 transition-colors duration-300">
      {image && (
        <div className="mb-3 relative inline-block">
          <img src={image} alt="Preview" className="h-24 w-24 object-cover rounded-lg border-2 border-blue-500 shadow-md" />
          <button 
            onClick={removeImage}
            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow-lg hover:bg-red-600 transition-colors"
            title="Remove image"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      
      <form 
        onSubmit={handleSubmit}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex items-center gap-3 p-1 bg-white dark:bg-gray-800 border rounded-full shadow-sm transition-all duration-300 ${
          isDragging ? 'border-blue-500 scale-[1.01] bg-blue-50 dark:bg-blue-900/10' : 
          isLoading ? 'border-blue-500/50 dark:border-blue-400/50 animate-pulse' : 
          'border-gray-300 dark:border-gray-700'
        }`}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="ml-2 w-10 h-10 flex-shrink-0 flex items-center justify-center text-gray-500 hover:text-blue-500 dark:text-gray-400 dark:hover:text-blue-400 transition-colors"
          title="Upload image"
          disabled={isLoading}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6.75a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6.75v11.25a1.5 1.5 0 0 0 1.5 1.5ZM12 12.75h.008v.008H12v-.008ZM9.75 15.75h.008v.008h-.008v-.008Z" />
          </svg>
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={onFileChange} 
          accept="image/*" 
          className="hidden" 
        />
        
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={isLoading ? loadingMessage : isDragging ? "Drop image here..." : "Ask anything about football..."}
          className="flex-grow w-full px-2 py-2 bg-transparent border-none text-gray-900 dark:text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-0"
          disabled={isLoading}
          aria-label="Chat input"
        />
        <button
          type="submit"
          className="w-10 h-10 flex-shrink-0 bg-blue-600 text-white font-semibold rounded-full shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-100 dark:focus:ring-offset-gray-800 transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          disabled={isLoading || (!message.trim() && !image)}
          aria-label="Send message"
        >
          {isLoading ? (
            <div className="w-5 h-5 border-2 border-white/50 border-t-white rounded-full animate-spin"></div>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
            </svg>
          )}
        </button>
      </form>
    </div>
  );
};
