import React, { useState } from 'react';
import { supabase } from '../services/geminiService';

interface ShareButtonProps {
  data: any;
}

export const ShareButton: React.FC<ShareButtonProps> = ({ data }) => {
  const [status, setStatus] = useState<'idle' | 'saving' | 'copied'>('idle');

const handleShare = async () => {
  // Check if supabase actually exists before trying to use it
  if (!supabase) {
    alert("Database connection not ready. Please refresh the page.");
    return;
  }

  setStatus('saving');
  try {
    const { data: savedRow, error } = await supabase
      .from('profiles')
      .insert([{ player_data: data }])
      .select()
      .single();

    if (error) throw error;

    const shareUrl = `${window.location.origin}/#/player/${savedRow.id}`;
    await navigator.clipboard.writeText(shareUrl);
    
    setStatus('copied');
    setTimeout(() => setStatus('idle'), 3000);
  } catch (err) {
    console.error("Sharing failed:", err);
    alert("Check your Supabase Table name. Is it exactly 'profiles'?");
    setStatus('idle');
  }
};

  return (
    <button 
      onClick={handleShare}
      disabled={status === 'saving'}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-sm ${
        status === 'copied' 
          ? 'bg-green-600 text-white' 
          : 'bg-blue-600 hover:bg-blue-700 text-white active:scale-95'
      } disabled:opacity-50`}
    >
      <span className="text-lg">
        {status === 'saving' ? '⏳' : status === 'copied' ? '✅' : '🔗'}
      </span>
      {status === 'saving' ? 'Generating Link...' : status === 'copied' ? 'Link Copied!' : 'Share Scouting Report'}
    </button>
  );
};