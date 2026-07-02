import React from 'react';
import { ChatMessage } from 'futbolpedia-ai';

const OLD_TIMESTAMP = Date.now() - 60_000;

export const UserMessage = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6 max-w-2xl">
    <ChatMessage
      message={{
        id: '1',
        sender: 'user',
        content: 'How does Bukayo Saka compare to Jeremy Doku in one-on-one dribbling situations?',
        timestamp: OLD_TIMESTAMP,
      }}
    />
  </div>
);

export const AiAnalysis = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6 max-w-2xl">
    <ChatMessage
      message={{
        id: '2',
        sender: 'ai',
        content:
          '**Saka** edges out in close control under pressure, with a *slightly* higher first-touch rating. **Doku** wins on raw acceleration and is more explosive in transition. Both rate elite for flair.\n\n- Saka: 91 first touch, 88 dribbling\n- Doku: 84 first touch, 93 acceleration',
        timestamp: OLD_TIMESTAMP,
      }}
    />
  </div>
);
