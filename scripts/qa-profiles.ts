#!/usr/bin/env npx tsx
/**
 * Spot-check Futbolpedia formal profiles after grounding changes.
 *
 * Usage:
 *   API_KEY=... npx tsx scripts/qa-profiles.ts
 *   npx tsx scripts/qa-profiles.ts --limit 3
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlayerProfile } from '../types';
import { findUnverifiedManagerMentions } from '../packages/engine/src/gates/managerMentions.ts';
import { sendMessageToAI, resetChat } from '../services/geminiService';

const DEFAULT_PLAYERS = [
  'Estêvão',
  'João Pedro',
  'Cole Palmer',
  'Bukayo Saka',
  'James Tarkowski',
  'Tosin Adarabioyo',
  'Morgan Rogers',
  'Kobbie Mainoo',
  'Lucas Bergvall',
  'Gabriel Martinelli',
];

const STALE_CHELSEA_MANAGERS = /\b(enzo maresca|maresca|mauricio pochettino|pochettino|graham potter|potter|frank lampard|lampard)\b/i;

function loadEnvLocal() {
  const candidates = [
    resolve(process.cwd(), '.env.local'),
    resolve(process.cwd(), '../Fantasy Futbol/.env.local'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

function parseArgs() {
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : DEFAULT_PLAYERS.length;
  return { limit };
}

function profileProse(p: PlayerProfile): string {
  return [p.shortBio, p.latestUpdate, p.playstyleAndRole?.playstyle?.description]
    .filter(Boolean)
    .join('\n');
}

function scanIssues(p: PlayerProfile) {
  const prose = profileProse(p);
  const issues: string[] = [];
  const club = p.basicInfo.club ?? '';

  for (const issue of findUnverifiedManagerMentions(prose, {
    verifiedFacts: [],
    currentHeadCoach: null,
  })) {
    issues.push(`manager mention: ${issue}`);
  }

  if (/chelsea/i.test(club) && STALE_CHELSEA_MANAGERS.test(prose)) {
    issues.push('stale Chelsea manager name in prose (pre-Alonso era)');
  }

  if (/\b(fantasy points|form rating|match rating|points per game)\b/i.test(prose)) {
    issues.push('scoring/meta language in prose');
  }

  if (/\b(buy|sell|hold|monitor|target|fade)\b/i.test(prose)) {
    issues.push('trade-advice language');
  }

  if ((p.shortBio?.trim().split(/\s+/).length ?? 0) < 60) {
    issues.push('shortBio under 60 words');
  }

  return issues;
}

async function main() {
  loadEnvLocal();
  const { limit } = parseArgs();

  if (!process.env.API_KEY) {
    console.error('Missing API_KEY');
    process.exit(1);
  }

  const targets = DEFAULT_PLAYERS.slice(0, limit);
  const report: Array<Record<string, unknown>> = [];

  console.log(`Futbolpedia profile QA — ${targets.length} players (default mode)\n`);

  for (const name of targets) {
    resetChat();
    const started = Date.now();
    process.stdout.write(`→ ${name} ... `);
    try {
      const result = await sendMessageToAI(
        `Give me a scouting report on ${name}`,
        [],
        undefined,
      );
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      if (typeof result === 'string' || !('basicInfo' in result)) {
        console.log(`FAIL (${elapsed}s) — non-profile response`);
        report.push({ name, ok: false, elapsedSec: Number(elapsed), error: 'non-profile response' });
        continue;
      }

      const profile = result as PlayerProfile;
      const issues = scanIssues(profile);
      const ok = issues.length === 0;
      console.log(`${ok ? 'PASS' : 'WARN'} (${elapsed}s) — ${profile.basicInfo.name} @ ${profile.basicInfo.club}`);

      report.push({
        name,
        ok,
        elapsedSec: Number(elapsed),
        player: profile.basicInfo.name,
        club: profile.basicInfo.club,
        overall: profile.ratings.overall,
        issues,
        shortBio: profile.shortBio,
        latestUpdate: profile.latestUpdate,
        playstyle: profile.playstyleAndRole?.playstyle?.description,
      });
    } catch (err) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const message = err instanceof Error ? err.message : String(err);
      console.log(`FAIL (${elapsed}s) — ${message}`);
      report.push({ name, ok: false, elapsedSec: Number(elapsed), error: message });
    }
  }

  const outPath = '/tmp/futbolpedia-qa-report.json';
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const passed = report.filter((r) => r.ok === true).length;
  const warned = report.filter((r) => r.ok === false && !r.error).length;
  const failed = report.filter((r) => r.error).length;

  console.log(`\nSummary: ${passed} pass, ${warned} warn, ${failed} fail`);
  console.log(`Full report: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
