import React, { useState } from 'react';
import type { PlayerProfile } from '../types';
import { AttributeTable } from './AttributeTable';
import { getTierForRating } from '../constants/ratingTiers';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface PlayerProfileDisplayProps {
  profile: PlayerProfile;
}

const ProfileSection: React.FC<{
  title: string;
  children: React.ReactNode;
  icon: string;
  badge?: React.ReactNode;
  className?: string;
}> = ({ title, children, icon, badge, className = '' }) => (
  <div
    className={`bg-white dark:bg-charcoal-surface/80 rounded-2xl shadow-sm p-6 border border-cream-300/80 dark:border-charcoal-border transition-all ${className}`}
  >
    <div className="flex items-center justify-between mb-5">
      <h3 className="text-lg font-serif font-bold text-charcoal dark:text-cream-100 flex items-center">
        <span className="mr-2.5 text-xl">{icon}</span>
        {title}
      </h3>
      {badge}
    </div>
    {children}
  </div>
);

export const PlayerProfileDisplay: React.FC<PlayerProfileDisplayProps> = ({ profile }) => {
  const [showEvidenceModal, setShowEvidenceModal] = useState(false);

  const {
    basicInfo,
    ratings,
    strengths,
    weaknesses,
    attributes,
    goalkeeperAttributes,
    shortBio,
    playstyleAndRole,
    latestUpdate,
  } = profile;

  const getRatingTier = (rating: number) => getTierForRating(rating);

  const evalDate =
    profile.evaluationDate ||
    (profile.createdAt ? new Date(profile.createdAt).toISOString().split('T')[0] : null);
  const formattedDate = evalDate
    ? new Date(`${evalDate}T12:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'Undated Card';

  const versionType =
    profile.version?.type ||
    (basicInfo.name.toLowerCase().includes('prime') ? 'prime' : 'current');
  const isPrime = versionType === 'prime';
  const versionLabel =
    profile.version?.label ||
    (isPrime
      ? `Prime Zenith (${profile.version?.seasonOrEra || 'Apex'})`
      : `Current Form (${evalDate || '2026'})`);

  const confidence = profile.confidence;
  const scoutingDebate = profile.scoutingDebate;
  const archetypeAnalysis = profile.archetypeAnalysis;
  const ageCurve = profile.ageCurve;
  const definingMoments = profile.definingMoments;

  const renderMarkdown = (text: string | undefined) => {
    if (!text) return { __html: '' };
    try {
      const rawMarkup = marked.parse(text, { gfm: true, breaks: true }) as string;
      const sanitizedMarkup = DOMPurify.sanitize(rawMarkup);
      return { __html: sanitizedMarkup };
    } catch (e) {
      console.error('Markdown rendering error:', e);
      return { __html: text };
    }
  };

  return (
    <div className="space-y-8 animate-fade-in w-full max-w-5xl mx-auto pb-12">
      {/* Primary Card Shell with subtle card aesthetics */}
      <header
        className={`rounded-2xl shadow-sm p-6 sm:p-8 text-center relative overflow-hidden transition-all border ${
          isPrime
            ? 'bg-gradient-to-b from-amber-500/[0.04] via-white to-white dark:from-amber-500/[0.07] dark:via-charcoal-surface dark:to-charcoal-surface border-amber-500/30 ring-1 ring-amber-500/20'
            : 'bg-white dark:bg-charcoal-surface border-cream-300/80 dark:border-charcoal-border'
        }`}
      >
        {/* Subtle decorative watermark/accent line */}
        <div
          className={`absolute top-0 left-0 right-0 h-1.5 ${
            isPrime
              ? 'bg-gradient-to-r from-amber-400 via-yellow-500 to-amber-600'
              : 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600'
          }`}
        />

        {/* Card Header & Version Stamp */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 mb-6 border-b border-cream-200 dark:border-charcoal-border text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-bold tracking-wider uppercase border flex items-center gap-1.5 shadow-2xs ${
                isPrime
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">
                {isPrime ? 'workspace_premium' : 'bolt'}
              </span>
              {versionLabel}
            </span>

            {profile.version?.seasonOrEra && (
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-cream-100 dark:bg-charcoal text-charcoal/70 dark:text-cream-300 border border-cream-300/60 dark:border-charcoal-border">
                {profile.version.seasonOrEra}
              </span>
            )}

            {ageCurve && (
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/40 flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px]">trending_up</span>
                {ageCurve.phase}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Interactive Confidence & Evidence Grade Badge */}
            {confidence && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowEvidenceModal((prev) => !prev)}
                  className={`group px-2.5 py-1 rounded-md text-[11px] font-mono font-bold border flex items-center gap-1.5 transition-all cursor-pointer ${
                    confidence.grade === 'A'
                      ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                      : confidence.grade === 'B'
                        ? 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/30'
                        : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/30'
                  }`}
                  title="Click to view scouting evidence report and data confidence"
                >
                  <span className="material-symbols-outlined text-[13px]">verified</span>
                  <span>Evidence: Grade {confidence.grade}</span>
                  <span className="material-symbols-outlined text-[12px] opacity-70 group-hover:translate-x-0.5 transition-transform">
                    info
                  </span>
                </button>

                {/* Evidence Tooltip Popover */}
                {showEvidenceModal && (
                  <>
                    <div
                      className="fixed inset-0 z-30"
                      onClick={() => setShowEvidenceModal(false)}
                    />
                    <div className="absolute right-0 top-full mt-2 w-80 p-4 bg-white dark:bg-charcoal border border-cream-300 dark:border-charcoal-border rounded-xl shadow-xl z-40 text-left animate-fade-in text-xs font-sans">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-cream-200 dark:border-charcoal-border">
                        <span className="font-bold uppercase tracking-wider text-[10px] text-charcoal/60 dark:text-cream-400">
                          Scouting Evidence Report
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded font-mono font-bold text-[10px] ${
                            confidence.grade === 'A'
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : confidence.grade === 'B'
                                ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          Grade {confidence.grade}
                        </span>
                      </div>
                      <p className="font-semibold text-charcoal dark:text-cream-50 mb-2">
                        {confidence.verdict}
                      </p>
                      <div className="space-y-1.5 text-charcoal/70 dark:text-cream-300 text-[11px]">
                        <div>
                          <span className="font-bold text-charcoal/80 dark:text-cream-200">
                            Sample Window:{' '}
                          </span>
                          {confidence.sampleSize}
                        </div>
                        {confidence.dataGaps && confidence.dataGaps.length > 0 && (
                          <div className="pt-2 border-t border-cream-200 dark:border-charcoal-border">
                            <span className="font-bold text-amber-600 dark:text-amber-400 block mb-1">
                              Scouting Data Gaps:
                            </span>
                            <ul className="list-disc list-inside space-y-0.5 text-[10px]">
                              {confidence.dataGaps.map((gap, idx) => (
                                <li key={idx}>{gap}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-1.5 text-xs font-mono font-semibold text-charcoal/60 dark:text-cream-400">
              <span className="material-symbols-outlined text-[14px]">calendar_today</span>
              <span>{formattedDate}</span>
            </div>
          </div>
        </div>

        {/* Peak Context Note for Prime Cards */}
        {profile.version?.peakContext && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-amber-500/[0.07] border border-amber-500/25 text-left">
            <p className="text-xs font-serif italic text-amber-950 dark:text-amber-200 leading-relaxed">
              <span className="font-bold not-italic font-sans uppercase text-[10px] tracking-wider text-amber-700 dark:text-amber-400 mr-2">
                Zenith Context:
              </span>
              {profile.version.peakContext}
            </p>
          </div>
        )}

        <h2 className="text-3xl sm:text-4xl font-serif font-extrabold text-charcoal dark:text-cream-50 mb-3 tracking-tight">
          {basicInfo.name}
        </h2>

        {/* Metadata Pill Row */}
        <div className="flex flex-wrap justify-center gap-2 mb-6">
          <span className="px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs font-mono font-bold border border-emerald-500/25">
            {basicInfo.position}
          </span>
          <span className="px-3 py-1 rounded-full bg-cream-200/60 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 text-xs font-medium border border-cream-300/80 dark:border-charcoal-border">
            {basicInfo.club}
          </span>
          <span className="px-3 py-1 rounded-full bg-cream-200/60 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 text-xs font-medium border border-cream-300/80 dark:border-charcoal-border">
            {basicInfo.nationality}
          </span>
          <span className="px-3 py-1 rounded-full bg-cream-200/60 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 text-xs font-medium border border-cream-300/80 dark:border-charcoal-border font-mono">
            Age {basicInfo.age}
          </span>
          {basicInfo.height && basicInfo.height !== 'N/A' && (
            <span className="px-3 py-1 rounded-full bg-cream-200/60 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 text-xs font-medium border border-cream-300/80 dark:border-charcoal-border">
              {basicInfo.height}
            </span>
          )}
          {basicInfo.weight && basicInfo.weight !== 'N/A' && (
            <span className="px-3 py-1 rounded-full bg-cream-200/60 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 text-xs font-medium border border-cream-300/80 dark:border-charcoal-border">
              {basicInfo.weight}
            </span>
          )}
        </div>

        {/* Main Overall / Potential Twin Badges */}
        <div className="flex justify-center items-center gap-10 sm:gap-14 my-4">
          <div className="text-center group">
            <p className="text-charcoal/50 dark:text-cream-400 text-[11px] font-mono font-bold tracking-widest uppercase">
              OVERALL
            </p>
            <p className="text-5xl sm:text-6xl font-serif font-black text-emerald-600 dark:text-emerald-400 tracking-tight my-0.5">
              {ratings.overall}
            </p>
            <p className="text-emerald-700 dark:text-emerald-300 text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 inline-block">
              {getRatingTier(ratings.overall)}
            </p>
          </div>

          <div className="w-px h-16 bg-cream-200 dark:bg-charcoal-border" />

          <div className="text-center group">
            <p className="text-charcoal/50 dark:text-cream-400 text-[11px] font-mono font-bold tracking-widest uppercase">
              POTENTIAL
            </p>
            <p className="text-5xl sm:text-6xl font-serif font-black text-teal-600 dark:text-teal-400 tracking-tight my-0.5">
              {ratings.potential}
            </p>
            <p className="text-teal-700 dark:text-teal-300 text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-teal-500/10 border border-teal-500/20 inline-block">
              {getRatingTier(ratings.potential)}
            </p>
          </div>
        </div>

        {/* Peer Benchmark Annotation */}
        {profile.peerBenchmark && (
          <div className="mt-4 text-xs font-serif text-charcoal/70 dark:text-cream-300 italic">
            Tier Benchmark: <span className="not-italic font-sans font-semibold">{profile.peerBenchmark}</span>
          </div>
        )}

        {/* Signature Ceiling Spikes & Flaws Badges */}
        {((profile.signatureSpikes && profile.signatureSpikes.length > 0) ||
          (profile.genuineFlaws && profile.genuineFlaws.length > 0)) && (
          <div className="mt-6 pt-5 border-t border-cream-200 dark:border-charcoal-border flex flex-wrap items-center justify-center gap-4 text-xs font-sans">
            {profile.signatureSpikes && profile.signatureSpikes.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap justify-center">
                <span className="font-bold text-[10px] tracking-wider uppercase text-emerald-600 dark:text-emerald-400">
                  Ceiling Spikes:
                </span>
                {profile.signatureSpikes.map((spike) => (
                  <span
                    key={spike}
                    className="px-2.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-mono text-[11px] font-semibold border border-emerald-200 dark:border-emerald-800/60"
                  >
                    {spike}
                  </span>
                ))}
              </div>
            )}
            {profile.genuineFlaws && profile.genuineFlaws.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap justify-center">
                <span className="font-bold text-[10px] tracking-wider uppercase text-red-600 dark:text-red-400">
                  Tactical Flaws:
                </span>
                {profile.genuineFlaws.map((flaw) => (
                  <span
                    key={flaw}
                    className="px-2.5 py-0.5 rounded-full bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 font-mono text-[11px] font-semibold border border-red-200 dark:border-red-800/60"
                  >
                    {flaw}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      {/* Archetype & System Blueprint (New High-Detail Section) */}
      {archetypeAnalysis && (
        <div className="bg-white dark:bg-charcoal-surface rounded-2xl shadow-sm p-6 sm:p-7 border border-cream-300/80 dark:border-charcoal-border space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-cream-200 dark:border-charcoal-border">
            <h3 className="text-lg font-serif font-bold text-charcoal dark:text-cream-100 flex items-center gap-2">
              <span className="material-symbols-outlined text-emerald-600 dark:text-emerald-400">
                hub
              </span>
              Archetype Blueprint & Holistic Projection
            </h3>
            {archetypeAnalysis.playsLikeBlend && (
              <span className="text-xs font-serif italic text-charcoal/70 dark:text-cream-300 bg-cream-100 dark:bg-charcoal px-3 py-1 rounded-lg border border-cream-200 dark:border-charcoal-border">
                Blend:{' '}
                <span className="font-semibold not-italic">
                  {archetypeAnalysis.playsLikeBlend}
                </span>
              </span>
            )}
          </div>

          {/* Holistic Player Projection (Evaluating inherent profile vs transient role) */}
          {archetypeAnalysis.holisticProjection && (
            <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.04] border border-emerald-500/20">
              <div className="flex items-center gap-2 mb-1.5 text-emerald-700 dark:text-emerald-300 font-mono text-[11px] font-bold uppercase tracking-wider">
                <span className="material-symbols-outlined text-[15px]">psychology</span>
                Holistic Scouting Projection (Beyond Transient Role)
              </div>
              <p className="text-xs sm:text-sm font-sans text-charcoal/90 dark:text-cream-100 leading-relaxed">
                {archetypeAnalysis.holisticProjection}
              </p>
            </div>
          )}

          {/* Playstyle Trait Chips */}
          {archetypeAnalysis.playstyleTags && archetypeAnalysis.playstyleTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-charcoal/50 dark:text-cream-400 mr-1">
                Profile Tags:
              </span>
              {archetypeAnalysis.playstyleTags.map((tag, idx) => (
                <span
                  key={idx}
                  className="px-2.5 py-1 rounded-lg text-xs font-mono font-semibold bg-cream-100 dark:bg-charcoal text-charcoal dark:text-cream-200 border border-cream-300/80 dark:border-charcoal-border shadow-2xs"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Tactical Synergy vs Kryptonite Matrix */}
          <div className="grid sm:grid-cols-2 gap-4 pt-2">
            <div className="p-4 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/70 dark:border-emerald-800/40">
              <div className="flex items-center gap-2 mb-2 text-emerald-700 dark:text-emerald-300 font-mono text-xs font-bold uppercase tracking-wider">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Optimal Ecosystem (Unlocking Ceiling)
              </div>
              <p className="text-xs text-charcoal/80 dark:text-cream-200 leading-relaxed">
                {archetypeAnalysis.tacticalSynergy}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-red-50/50 dark:bg-red-950/20 border border-red-200/70 dark:border-red-800/40">
              <div className="flex items-center gap-2 mb-2 text-red-700 dark:text-red-300 font-mono text-xs font-bold uppercase tracking-wider">
                <span className="material-symbols-outlined text-[16px]">warning</span>
                Tactical Kryptonite (Exploitative Setups)
              </div>
              <p className="text-xs text-charcoal/80 dark:text-cream-200 leading-relaxed">
                {archetypeAnalysis.tacticalKryptonite}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* The Scouting Debate: Case for Higher vs Lower (+2 / -2 OVR) */}
      {scoutingDebate && (
        <div className="bg-white dark:bg-charcoal-surface rounded-2xl shadow-sm p-6 sm:p-7 border border-cream-300/80 dark:border-charcoal-border space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-cream-200 dark:border-charcoal-border">
            <h3 className="text-lg font-serif font-bold text-charcoal dark:text-cream-100 flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-500">balance</span>
              The Rating Debate (Dialectical Margin)
            </h3>
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-charcoal/50 dark:text-cream-400">
              ±2 OVR Spectrum
            </span>
          </div>

          <div className="grid sm:grid-cols-2 gap-5">
            <div className="p-4 rounded-xl bg-emerald-500/[0.04] border border-emerald-500/25 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">trending_up</span>
                  The Case for +2 OVR
                </span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-mono text-[10px] font-bold">
                  Ceiling Argument
                </span>
              </div>
              <p className="text-xs text-charcoal/85 dark:text-cream-100 leading-relaxed">
                {scoutingDebate.caseForHigher}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-rose-500/[0.04] border border-rose-500/25 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px]">trending_down</span>
                  The Case for -2 OVR
                </span>
                <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-700 dark:text-rose-300 font-mono text-[10px] font-bold">
                  Floor Risk
                </span>
              </div>
              <p className="text-xs text-charcoal/85 dark:text-cream-100 leading-relaxed">
                {scoutingDebate.caseForLower}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Strengths & Weaknesses Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        <ProfileSection title="Strengths & Advantage Generators" icon="📈">
          <ul className="space-y-3">
            {strengths.map((s, i) => (
              <li
                key={i}
                className="text-xs sm:text-sm text-charcoal/90 dark:text-cream-200 flex items-start gap-2.5 leading-relaxed"
              >
                <span className="text-emerald-600 dark:text-emerald-400 shrink-0 font-bold mt-0.5">
                  ✓
                </span>
                <span
                  className="markdown-content inline"
                  dangerouslySetInnerHTML={renderMarkdown(s)}
                />
              </li>
            ))}
          </ul>
        </ProfileSection>

        <ProfileSection title="Weaknesses & Tactical Constraints" icon="📉">
          <ul className="space-y-3">
            {weaknesses.map((w, i) => (
              <li
                key={i}
                className="text-xs sm:text-sm text-charcoal/90 dark:text-cream-200 flex items-start gap-2.5 leading-relaxed"
              >
                <span className="text-rose-500 dark:text-rose-400 shrink-0 font-bold mt-0.5">
                  ✗
                </span>
                <span
                  className="markdown-content inline"
                  dangerouslySetInnerHTML={renderMarkdown(w)}
                />
              </li>
            ))}
          </ul>
        </ProfileSection>
      </div>

      {/* 25-Attribute Disambiguation Table */}
      <ProfileSection title="Technical & Physical Attributes (25-Vector Matrix)" icon="📋">
        <AttributeTable
          attributes={attributes}
          goalkeeperAttributes={goalkeeperAttributes}
        />
      </ProfileSection>

      {/* Defining Moments Timeline (When Present) */}
      {definingMoments && definingMoments.length > 0 && (
        <ProfileSection title="Defining Career Moments" icon="🏆">
          <div className="grid sm:grid-cols-3 gap-4">
            {definingMoments.map((moment, idx) => (
              <div
                key={idx}
                className="p-4 rounded-xl bg-cream-100/60 dark:bg-charcoal border border-cream-200 dark:border-charcoal-border space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                    {moment.year}
                  </span>
                </div>
                <h4 className="font-serif font-bold text-sm text-charcoal dark:text-cream-50">
                  {moment.title}
                </h4>
                <p className="text-xs text-charcoal/70 dark:text-cream-300 leading-relaxed">
                  {moment.description}
                </p>
              </div>
            ))}
          </div>
        </ProfileSection>
      )}

      {/* Short Bio & Tactico View */}
      <div className="grid lg:grid-cols-2 gap-6">
        <ProfileSection title="Scouting Snapshot" icon="📜">
          <div
            className="markdown-content text-xs sm:text-sm text-charcoal/90 dark:text-cream-200 leading-relaxed space-y-2"
            dangerouslySetInnerHTML={renderMarkdown(shortBio)}
          />
        </ProfileSection>

        <ProfileSection title="Tactico View (Mould & Identity)" icon="🧠">
          <div className="space-y-4">
            <div>
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-charcoal/50 dark:text-cream-400 block mb-1">
                Player Mould & Archetype
              </span>
              <p className="font-serif font-bold text-base text-charcoal dark:text-cream-50">
                {playstyleAndRole.playstyle.archetype}
              </p>
            </div>
            <div className="border-t border-cream-200 dark:border-charcoal-border pt-3">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-charcoal/50 dark:text-cream-400 block mb-1">
                On-Pitch Signature Mechanics
              </span>
              <div
                className="markdown-content text-xs sm:text-sm text-charcoal/85 dark:text-cream-200 leading-relaxed"
                dangerouslySetInnerHTML={renderMarkdown(
                  playstyleAndRole.playstyle.description,
                )}
              />
            </div>
            <div className="border-t border-cream-200 dark:border-charcoal-border pt-3">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-charcoal/50 dark:text-cream-400 block mb-1">
                Calibrated System Roles
              </span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {playstyleAndRole.bestRoles.map((role, i) => (
                  <span
                    key={i}
                    className="px-2.5 py-1 rounded-md text-xs font-mono font-semibold bg-cream-100 dark:bg-charcoal text-charcoal/80 dark:text-cream-200 border border-cream-300/80 dark:border-charcoal-border"
                  >
                    {role}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </ProfileSection>
      </div>

      {/* Latest Competitive Update */}
      <ProfileSection title="Latest Competitive Status" icon="🔄">
        <div
          className="markdown-content text-xs sm:text-sm text-charcoal/90 dark:text-cream-200 leading-relaxed"
          dangerouslySetInnerHTML={renderMarkdown(latestUpdate)}
        />
      </ProfileSection>
    </div>
  );
};