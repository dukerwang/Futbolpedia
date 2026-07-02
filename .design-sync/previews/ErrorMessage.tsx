import React from 'react';
import { ErrorMessage } from 'futbolpedia-ai';

export const Default = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6 max-w-md">
    <ErrorMessage message="Could not generate a scouting report — the player name wasn't recognized." />
  </div>
);
