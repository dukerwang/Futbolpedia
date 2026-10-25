/**
 * Barrel for the dossier modules, kept so existing imports of './dossierStore' keep working.
 *
 * - dossierCards:   card identity, slugs and evaluation dates (pure)
 * - dossierCache:   Supabase cache, versioned archive, sharing and the Global Dossier Hub
 * - dossierContext: dossiers as prompt context (history, references, locked/saved/prior blocks)
 * - dossierLedger:  grep_saved_dossiers and the positional peer ledger
 * - dossierPatch:   applying a challenge patch to a card
 */
export * from './dossierCards';
export * from './dossierCache';
export * from './dossierContext';
export * from './dossierLedger';
export * from './dossierPatch';
