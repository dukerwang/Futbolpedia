import React from 'react';
import { ShareButton } from 'futbolpedia-ai';

export const Default = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6">
    <ShareButton data={{ basicInfo: { name: 'Sample Player' } }} />
  </div>
);
