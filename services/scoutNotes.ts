import { toClubKey } from './clubManagers';
import { supabase } from './dossierCache';
import { toPlayerSlug } from './dossierCards';
import { addEvidence, type EvidenceLedger } from './evidenceLedger';

/**
 * The scout's notes. During its day (services/scoutDay.ts) the server runs a grounded search for a
 * club or a player and keeps the dated digest in the `scout_notes` table, which browsers can read
 * but not write. A turn about the present reads the notes of the last two weeks for the clubs and
 * players it opens and files each as a dated `scout_note` evidence entry, so the writer can use it
 * and the figure gate counts its figures as supported.
 */

/** A note is read for this many days after the day it was written. */
export const SCOUT_NOTE_DAYS = 14;
/** Notes filed for one turn, newest first. */
const MAX_NOTES_PER_TURN = 4;
/** A turn waits this long for the table before it goes without notes. */
const NOTES_TIMEOUT_MS = 1_500;
const CACHE_MS = 5 * 60 * 1000;

export interface ScoutNote {
  /** The UTC day it was written, YYYY-MM-DD. */
  day: string;
  subject: string;
  question: string;
  note: string;
  sources: string[];
}

/** What a note is keyed by: the folded club slug, which is also the folded name for a player. */
export const scoutSubjectKey = (subject: string): string => toClubKey(subject);

/** Every key a name may be stored under: a club's normalized slug and the plain folded name. */
export const scoutSubjectKeys = (subject: string): string[] => [...new Set([toClubKey(subject), toPlayerSlug(subject)].filter(Boolean))];

export interface ScoutNoteSource {
  /** Notes written on or after `sinceDay` for any of the subjects, newest first. */
  forSubjects(subjects: string[], sinceDay: string): Promise<ScoutNote[]>;
}

const dayMinus = (today: string, days: number): string => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** The table through the app's Supabase client (the publishable key in a browser, the server's read client there). */
export function liveScoutNotes(now: () => number = Date.now): ScoutNoteSource {
  const cache = new Map<string, { expiresAt: number; notes: ScoutNote[] }>();
  return {
    async forSubjects(subjects, sinceDay) {
      const client = supabase;
      const keys = [...new Set(subjects.flatMap(scoutSubjectKeys))].slice(0, 12);
      if (!client || keys.length === 0) return [];
      const cacheKey = `${sinceDay}|${keys.sort().join(',')}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now()) return hit.notes;
      const { data, error } = await client
        .from('scout_notes')
        .select('day, subject, question, note, sources')
        .in('subject_key', keys)
        .gte('day', sinceDay)
        .order('day', { ascending: false })
        .limit(12);
      // A table that isn't there yet (its migration isn't applied) reads as no notes.
      const notes: ScoutNote[] = error || !Array.isArray(data)
        ? []
        : data.map((r: any) => ({
            day: String(r.day),
            subject: String(r.subject),
            question: String(r.question),
            note: String(r.note),
            sources: Array.isArray(r.sources) ? r.sources.map(String) : [],
          }));
      cache.set(cacheKey, { expiresAt: now() + CACHE_MS, notes });
      return notes;
    },
  };
}

/** A note as an evidence entry: dated, with the question it answers and its sources. */
export function scoutNoteEntry(n: ScoutNote): Parameters<typeof addEvidence>[1] {
  return {
    kind: 'scout_note',
    label: `${n.subject}: ${n.question} (the scout's note of ${n.day})`,
    content: `Researched ${n.day}, from a web search, between conversations. Each point carries its source's date.\n${n.note.trim()}`,
    sources: n.sources,
    stage: 'facts',
  };
}

/**
 * The ledger with the scout's notes for these subjects added, newest first, from the last
 * `SCOUT_NOTE_DAYS` days. A table that is slow or down leaves the ledger as it was.
 */
export async function fileScoutNotes(
  ledger: EvidenceLedger,
  subjects: string[],
  source: ScoutNoteSource,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<EvidenceLedger> {
  const names = [...new Set(subjects.map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) return ledger;
  const since = dayMinus(today, SCOUT_NOTE_DAYS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notes = await Promise.race([
    source.forSubjects(names, since).catch(() => [] as ScoutNote[]),
    new Promise<ScoutNote[]>((resolve) => {
      timer = setTimeout(() => resolve([]), NOTES_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  const wanted = new Set(names.flatMap(scoutSubjectKeys));
  return notes
    .filter((n) => n.day >= since && n.day <= today && scoutSubjectKeys(n.subject).some((k) => wanted.has(k)))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, MAX_NOTES_PER_TURN)
    .reduce((acc, n) => addEvidence(acc, scoutNoteEntry(n)), ledger);
}
