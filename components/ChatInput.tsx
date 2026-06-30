import React, { useState, useRef, useCallback } from 'react';

interface ChatInputProps {
  onSendMessage: (message: string, imageData?: string, mode?: 'default' | 'fast') => void;
  isLoading: boolean;
  loadingMessage: string;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSendMessage, isLoading, loadingMessage }) => {
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [mode, setMode] = useState<'default' | 'fast'>('default');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setImage(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!message.trim() && !image) || isLoading) return;
    onSendMessage(message, image || undefined, mode);
    setMessage('');
    setImage(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSubmit(e as any);
      }
  }

  return (
    <div className="relative group bg-cream-50 dark:bg-charcoal-surface rounded-none shadow-float dark:shadow-dark-float border-t-2 border-charcoal dark:border-cream-400 overflow-hidden transition-colors duration-300">
        <div className="flex flex-col relative z-10">
            {image && (
                <div className="px-6 pt-4 pb-0 flex items-center gap-2">
                    <span className="text-xs font-serif italic text-emerald-600 dark:text-emerald-400">Image attached</span>
                    <button onClick={() => setImage(null)} className="text-charcoal dark:text-cream-400 hover:text-red-500">
                        <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                </div>
            )}
            
            <textarea 
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                className="w-full bg-transparent text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/30 text-[18px] font-serif italic px-6 py-5 pr-14 border-none focus:ring-0 resize-none max-h-32 overflow-y-auto leading-relaxed scrollbar-hide outline-none" 
                placeholder={isLoading ? loadingMessage : "Inquire about player statistics..."}
                rows={1}
            />
            
            <div className="flex items-center justify-between px-4 pb-3">
                <div className="flex items-center gap-3">
                    <button 
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="p-2 text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-50 transition-colors" 
                        title="Attach image"
                        disabled={isLoading}
                    >
                        <span className="material-symbols-outlined text-[20px] font-light">add_circle</span>
                    </button>
                    <input type="file" ref={fileInputRef} onChange={onFileChange} accept="image/*" className="hidden" />
                    
                    {/* Sliding Pill Toggle */}
                    <div className="relative flex items-center bg-cream-200 dark:bg-charcoal-light rounded-full p-1 w-24 h-9 cursor-pointer ml-2 border border-cream-300 dark:border-charcoal-border select-none" onClick={() => setMode(mode === 'default' ? 'fast' : 'default')}>
                         {/* Sliding Background */}
                         <div 
                            className={`absolute top-1 bottom-1 w-[46%] bg-white dark:bg-charcoal rounded-full shadow-sm transition-all duration-300 ease-out mx-[2%] ${mode === 'default' ? 'left-0' : 'left-[50%]'}`}
                         ></div>

                         {/* Labels */}
                         <div className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${mode === 'default' ? 'text-charcoal dark:text-white' : 'text-charcoal/40 dark:text-cream-400/40'}`}>
                            <span className="material-symbols-outlined text-[18px]">psychology</span>
                         </div>
                         <div className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${mode === 'fast' ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal/40 dark:text-cream-400/40'}`}>
                            <span className="material-symbols-outlined text-[18px]">bolt</span>
                         </div>
                    </div>
                </div>

                <button 
                    onClick={handleSubmit}
                    disabled={isLoading || (!message.trim() && !image)}
                    className="flex items-center justify-center size-10 bg-charcoal dark:bg-emerald-500 text-cream-50 hover:bg-black dark:hover:bg-emerald-400 transition-all group disabled:opacity-50"
                >
                    {isLoading ? (
                        <div className="size-4 border-2 border-white/50 border-t-white rounded-full animate-spin"></div>
                    ) : (
                        <span className="material-symbols-outlined text-[20px] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">arrow_forward</span>
                    )}
                </button>
            </div>
        </div>
        
        {/* Decorative Corners */}
        <div className="absolute -bottom-1 -right-1 w-3 h-3 border-r border-b border-charcoal/20 dark:border-cream-400/20"></div>
        <div className="absolute -bottom-1 -left-1 w-3 h-3 border-l border-b border-charcoal/20 dark:border-cream-400/20"></div>
    </div>
  );
};