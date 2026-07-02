import React from 'react';
import { LoadingSpinner } from 'futbolpedia-ai';

export const Default = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6">
    <LoadingSpinner />
  </div>
);

export const CustomMessage = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6">
    <LoadingSpinner message="Cross-referencing scouting reports..." />
  </div>
);
