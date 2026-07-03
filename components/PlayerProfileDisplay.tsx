import React from 'react';
import type { PlayerProfile } from '../types';
import { AttributeTable } from './AttributeTable';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface PlayerProfileDisplayProps {
  profile: PlayerProfile;
}

const ProfileSection: React.FC<{ title: string; children: React.ReactNode; icon: string }> = ({ title, children, icon }) => (
  <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
    <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
      <span className="mr-3 text-2xl">{icon}</span>
      {title}
    </h3>
    {children}
  </div>
);

export const PlayerProfileDisplay: React.FC<PlayerProfileDisplayProps> = ({ profile }) => {
  const { 
    basicInfo, 
    ratings, 
    strengths, 
    weaknesses, 
    attributes, 
    goalkeeperAttributes, 
    shortBio, 
    playstyleAndRole, 
    latestUpdate 
  } = profile;

  const getRatingTier = (rating: number) => {
    if (rating >= 99) return "GOAT Status";
    if (rating >= 96) return "Generational Icon";
    if (rating >= 94) return "Ballon d'Or Standard";
    if (rating >= 91) return "World-Class Elite";
    if (rating >= 89) return "Elite Match-Winner";
    if (rating >= 86) return "World-Class Starter";
    if (rating >= 84) return "Borderline World-Class";
    if (rating >= 81) return "High-Caliber Starter";
    if (rating >= 79) return "UCL Standard";
    if (rating >= 76) return "Quality Starter";
    if (rating >= 74) return "Impact Specialist / 12th Man";
    if (rating >= 71) return "Strong Rotation Option";
    if (rating >= 66) return "Squad Depth";
    if (rating >= 61) return "Developing Professional";
    return "Amateur";
  }

  const renderMarkdown = (text: string | undefined) => {
    if (!text) return { __html: '' };
    try {
      const rawMarkup = marked.parse(text, { gfm: true, breaks: true }) as string;
      const sanitizedMarkup = DOMPurify.sanitize(rawMarkup);
      return { __html: sanitizedMarkup };
    } catch (e) {
      console.error("Markdown rendering error:", e);
      return { __html: text };
    }
  };

  return (
    <div className="space-y-8 animate-fade-in w-full">
      <header className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 text-center border border-gray-200 dark:border-gray-700">
        <h2 className="text-4xl font-extrabold text-gray-900 dark:text-white mb-4">{basicInfo.name}</h2>
        
        {/* Meta Data Grid */}
        <div className="flex flex-wrap justify-center gap-3 mb-6">
          <span className="px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-sm font-semibold border border-blue-200 dark:border-blue-800">
             {basicInfo.position}
          </span>
          <span className="px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 text-sm font-semibold border border-gray-200 dark:border-gray-600">
            {basicInfo.club}
          </span>
          <span className="px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 text-sm font-semibold border border-gray-200 dark:border-gray-600">
            {basicInfo.nationality}
          </span>
           <span className="px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 text-sm font-semibold border border-gray-200 dark:border-gray-600">
            Age: {basicInfo.age}
          </span>
          {basicInfo.height && basicInfo.height !== 'N/A' && (
            <span className="px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 text-sm font-semibold border border-gray-200 dark:border-gray-600">
              📏 {basicInfo.height}
            </span>
          )}
          {basicInfo.weight && basicInfo.weight !== 'N/A' && (
            <span className="px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 text-sm font-semibold border border-gray-200 dark:border-gray-600">
              ⚖️ {basicInfo.weight}
            </span>
          )}
        </div>

        <div className="flex justify-center gap-8">
          <div className="text-center">
            <p className="text-gray-500 dark:text-gray-400 text-sm">OVERALL</p>
            <p className="text-5xl font-bold text-blue-500 dark:text-blue-400">{ratings.overall}</p>
            <p className="text-blue-500/80 dark:text-blue-300/80 text-xs font-semibold uppercase tracking-wider">{getRatingTier(ratings.overall)}</p>
          </div>
          <div className="text-center">
            <p className="text-gray-500 dark:text-gray-400 text-sm">POTENTIAL</p>
            <p className="text-5xl font-bold text-green-500 dark:text-green-400">{ratings.potential}</p>
             <p className="text-green-500/80 dark:text-green-300/80 text-xs font-semibold uppercase tracking-wider">{getRatingTier(ratings.potential)}</p>
          </div>
        </div>
      </header>

      <div className="grid md:grid-cols-2 gap-8">
        <ProfileSection title="Strengths" icon="📈">
          <ul className="space-y-2 list-inside">
            {strengths.map((s, i) => (
              <li key={i} className="text-gray-700 dark:text-gray-300 flex items-start">
                <span className="text-green-500 dark:text-green-400 mr-2 mt-1">✓</span>
                <span className="markdown-content inline" dangerouslySetInnerHTML={renderMarkdown(s)} />
              </li>
            ))}
          </ul>
        </ProfileSection>
        <ProfileSection title="Weaknesses" icon="📉">
          <ul className="space-y-2 list-inside">
            {weaknesses.map((w, i) => (
              <li key={i} className="text-gray-700 dark:text-gray-300 flex items-start">
                <span className="text-red-500 dark:text-red-400 mr-2 mt-1">✗</span>
                <span className="markdown-content inline" dangerouslySetInnerHTML={renderMarkdown(w)} />
              </li>
            ))}
          </ul>
        </ProfileSection>
      </div>

      <ProfileSection title="Attributes" icon="📋">
        <AttributeTable attributes={attributes} goalkeeperAttributes={goalkeeperAttributes} />
      </ProfileSection>

      <div className="grid lg:grid-cols-2 gap-8">
        <ProfileSection title="Short Bio" icon="📜">
          <div className="markdown-content text-gray-700 dark:text-gray-300" dangerouslySetInnerHTML={renderMarkdown(shortBio)} />
        </ProfileSection>

        <ProfileSection title="Tactical Profile" icon="🧠">
            <div className="space-y-4">
                <div>
                    <h4 className="font-semibold text-md text-gray-800 dark:text-gray-200">Archetype</h4>
                    <p className="font-bold text-lg text-gray-900 dark:text-white">{playstyleAndRole.playstyle.archetype}</p>
                </div>
                <div className="border-t border-gray-200 dark:border-gray-700/50 pt-4">
                    <h4 className="font-semibold text-md text-gray-800 dark:text-gray-200">Player Identity</h4>
                    <div className="markdown-content text-gray-700 dark:text-gray-300 mt-2" dangerouslySetInnerHTML={renderMarkdown(playstyleAndRole.playstyle.description)} />
                </div>
                <div className="border-t border-gray-200 dark:border-gray-700/50 pt-4">
                    <h4 className="font-semibold text-md text-gray-800 dark:text-gray-200">Best Position(s)</h4>
                    <ul className="mt-2 space-y-1 list-disc list-inside text-gray-700 dark:text-gray-300">
                        {playstyleAndRole.bestRoles.map((role, i) => <li key={i}>{role}</li>)}
                    </ul>
                </div>
            </div>
        </ProfileSection>
      </div>

      <ProfileSection title="Latest Update" icon="🔄">
        <div className="markdown-content text-gray-700 dark:text-gray-300" dangerouslySetInnerHTML={renderMarkdown(latestUpdate)}></div>
      </ProfileSection>
    </div>
  );
};