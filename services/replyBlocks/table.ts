import { Type } from '@google/genai';
import type { ReadyBlock } from '../../types';
import { clubKey, type TableRow, type TableViewData } from '../../components/views/viewData';
import { getCurrentSeasonInfo } from '../aiClient';
import { executeCall, fileOutcomes, type ResearchCall } from '../researchTools';
import { formatLeagueTable } from '../liveFootball';
import { BLOCK_TEXT } from './blockText';
import { readyBlock, type BlockEntry } from './entry';

export const tableBlock = (id: string, data: TableViewData): ReadyBlock<'table'> => readyBlock('table', id, data);

const startYear = (season: string | null | undefined): number | null => {
  const m = season?.match(/\d{4}/);
  return m ? Number(m[0]) : null;
};

/** A league's current table from the live feed, with the clubs the reply is about marked. */
export const tableEntry: BlockEntry<'table'> = {
  kind: 'table',
  tool: {
    name: 'show_table',
    description:
      "Draws a league's current table in the reply, read from the live feed: position, club, played, goal difference and points for every club, with the clubs you name in highlight marked. Use it when a point rests on where clubs stand, and call it where the reader needs the table in your argument. It shows today's table only, never a past season's. Free: it doesn't count against your lookups.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        league: { type: Type.STRING, description: 'The league name.' },
        country: { type: Type.STRING, description: 'The league\'s country, when the name is shared by several leagues.' },
        highlight: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Club names the reply is about, spelled as the league lists them.' },
      },
      required: ['league'],
    },
  },
  hint: ({ league }) => ({ league }),

  async build({ league, country, season, highlight }, ctx) {
    if (!league?.trim()) return { error: 'Missing league' };
    // Only today's table exists; past tables can come later from the history routes.
    const wanted = startYear(season);
    if (wanted !== null && wanted !== getCurrentSeasonInfo().seasonStartYear) {
      return { error: 'No past tables yet: only the current season has a table to draw. Write around it.' };
    }
    const call: ResearchCall = { tool: 'league_table', subject: league.trim(), ...(country?.trim() ? { country: country.trim() } : {}), stage: 'facts' };
    const outcome = await executeCall(call, ctx.tools);
    ctx.ledger.write(fileOutcomes(ctx.ledger.read(), [call], [outcome]));
    const table = outcome.result?.table;
    if (!table || table.rows.length === 0) {
      const why = outcome.note ?? (outcome.status === 'not_covered' ? 'no free source covers it' : outcome.status === 'failed' ? 'the feed did not answer' : 'the feed returned no table');
      return { error: `No live table for ${league.trim()} (${why}), so none is drawn.` };
    }
    const rows: TableRow[] = table.rows.flatMap((r) => (r.team ? [{ ...r, team: r.team }] : []));
    if (rows.length === 0) return { error: `No live table for ${league.trim()} (the feed returned no clubs), so none is drawn.` };
    const groups = [...new Set(rows.flatMap((r) => (r.group ? [r.group] : [])))];
    const names = (Array.isArray(highlight) ? highlight : []).filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim());
    const data: TableViewData = {
      league: table.league,
      season: table.season,
      rows,
      ...(groups.length > 1 ? { groups } : {}),
      highlight: names,
    };
    return { block: tableBlock(ctx.newId(), data) };
  },

  toolResult: ({ data }) => {
    const known = new Set(data.rows.map((r) => clubKey(r.team)));
    const unmatched = data.highlight.filter((h) => !known.has(clubKey(h)));
    return {
      shown: true,
      league: data.league,
      season: data.season,
      ...(unmatched.length ? { notInTheTable: unmatched } : {}),
      table: formatLeagueTable(data.rows),
    };
  },
  ...BLOCK_TEXT.table,
};
