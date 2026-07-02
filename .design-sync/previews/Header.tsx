import React from 'react';
import { Header } from 'futbolpedia-ai';

const noop = () => {};

export const Default = () => (
  <div className="bg-cream-100 dark:bg-charcoal">
    <Header
      onNewChat={noop}
      toggleTheme={noop}
      isDarkMode={false}
      allProfilesCount={0}
      onToggleDossier={noop}
      isPanelOpen={false}
      onToggleConversations={noop}
      isConversationsOpen={false}
    />
  </div>
);

export const WithDossierBadge = () => (
  <div className="bg-cream-100 dark:bg-charcoal">
    <Header
      onNewChat={noop}
      toggleTheme={noop}
      isDarkMode={false}
      allProfilesCount={4}
      onToggleDossier={noop}
      isPanelOpen={true}
      onToggleConversations={noop}
      isConversationsOpen={false}
    />
  </div>
);
