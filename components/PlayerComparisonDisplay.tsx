import React from 'react';
import type { PlayerComparison, PlayerProfile, Attributes, GoalkeeperAttributes } from '../types';
import { ATTRIBUTE_CATEGORIES, GK_ATTRIBUTE_CATEGORIES } from '../constants';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const renderMarkdown = (text: string | undefined) => {
    if (!text) return { __html: '' };
    const rawMarkup = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
    const sanitizedMarkup = DOMPurify.sanitize(rawMarkup);
    return { __html: sanitizedMarkup };
};

const getRatingTier = (rating: number) => {
    if (rating >= 99) return "GOAT Status";
    if (rating >= 96) return "Generational Icons";
    if (rating >= 91) return "World-Class Elite";
    if (rating >= 86) return "World-Class Starters";
    if (rating >= 81) return "High-End Starters";
    if (rating >= 76) return "Quality Starters";
    if (rating >= 71) return "Strong Rotation Options";
    if (rating >= 66) return "Squad Depth / Fringe Starters";
    if (rating >= 61) return "Developing Professionals / Lower-League Starters";
    return "Amateur";
};

const AttributeComparisonRow: React.FC<{ label: string; p1_rating: number; p2_rating: number }> = ({ label, p1_rating, p2_rating }) => {
    const p1_isHigher = p1_rating > p2_rating;
    const p2_isHigher = p2_rating > p1_rating;

    const p1_class = p1_isHigher ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400';
    const p2_class = p2_isHigher ? 'font-bold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400';
    
    const getRatingColor = (rating: number): string => {
        if (rating >= 90) return 'bg-green-400/70';
        if (rating >= 80) return 'bg-sky-400/70';
        if (rating >= 70) return 'bg-yellow-400/70';
        if (rating >= 60) return 'bg-orange-400/70';
        return 'bg-red-500/70';
    };

    return (
        <tr className="border-b border-gray-200 dark:border-gray-700/50">
            <td className="py-3 px-2 sm:px-4 text-sm font-medium text-gray-600 dark:text-gray-300">{label}</td>
            <td className={`py-3 px-2 sm:px-4 text-center text-sm ${p1_class}`}>
                <span className={`inline-block w-8 h-6 leading-6 rounded ${getRatingColor(p1_rating)}`}>{p1_rating}</span>
            </td>
            <td className={`py-3 px-2 sm:px-4 text-center text-sm ${p2_class}`}>
                <span className={`inline-block w-8 h-6 leading-6 rounded ${getRatingColor(p2_rating)}`}>{p2_rating}</span>
            </td>
        </tr>
    );
};

export const PlayerComparisonDisplay: React.FC<{ comparison: PlayerComparison }> = ({ comparison }) => {
    const { summary, players } = comparison;
    
    // This component is optimized for 2 players. If more, it will only show the first two.
    if (!players || players.length < 2) {
        return <div className="text-red-500">Not enough player data to create a comparison.</div>;
    }
    
    const [player1, player2] = players;

    return (
        <div className="space-y-8 animate-fade-in w-full">
            <header className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700">
                <h2 className="text-3xl md:text-4xl font-extrabold text-gray-900 dark:text-white text-center tracking-tight">
                    {player1.basicInfo.name} vs. {player2.basicInfo.name}
                </h2>
                
                <div className="mt-6 grid grid-cols-2 gap-4 text-center">
                    {/* Player 1 Card */}
                    <div>
                         <p className="font-bold text-lg text-gray-800 dark:text-gray-200">{player1.basicInfo.name}</p>
                         <p className="text-sm text-gray-500 dark:text-gray-400">{player1.basicInfo.position} | {player1.basicInfo.club}</p>
                         <div className="mt-4 flex justify-center gap-4">
                            <div>
                                <p className="text-xs text-gray-500 dark:text-gray-400">OVR</p>
                                <p className={`text-3xl font-bold ${player1.ratings.overall > player2.ratings.overall ? 'text-blue-500 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}>{player1.ratings.overall}</p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-500 dark:text-gray-400">POT</p>
                                <p className={`text-3xl font-bold ${player1.ratings.potential > player2.ratings.potential ? 'text-green-500 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}>{player1.ratings.potential}</p>
                            </div>
                        </div>
                    </div>
                     {/* Player 2 Card */}
                    <div>
                         <p className="font-bold text-lg text-gray-800 dark:text-gray-200">{player2.basicInfo.name}</p>
                         <p className="text-sm text-gray-500 dark:text-gray-400">{player2.basicInfo.position} | {player2.basicInfo.club}</p>
                         <div className="mt-4 flex justify-center gap-4">
                            <div>
                                <p className="text-xs text-gray-500 dark:text-gray-400">OVR</p>
                                <p className={`text-3xl font-bold ${player2.ratings.overall > player1.ratings.overall ? 'text-blue-500 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}>{player2.ratings.overall}</p>
                            </div>
                            <div>
                                <p className="text-xs text-gray-500 dark:text-gray-400">POT</p>
                                <p className={`text-3xl font-bold ${player2.ratings.potential > player1.ratings.potential ? 'text-green-500 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}>{player2.ratings.potential}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

             <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
                <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
                  <span className="mr-3 text-2xl">🔍</span>
                  Analytical Summary
                </h3>
                <div className="markdown-content text-gray-700 dark:text-gray-300" dangerouslySetInnerHTML={renderMarkdown(summary)} />
            </div>

            <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
                <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
                  <span className="mr-3 text-2xl">📊</span>
                  Attribute Comparison
                </h3>
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-gray-50 dark:bg-gray-700/30">
                                <th className="py-2 px-2 sm:px-4 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Attribute</th>
                                <th className="py-2 px-2 sm:px-4 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{player1.basicInfo.name.split(' ').pop()}</th>
                                <th className="py-2 px-2 sm:px-4 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{player2.basicInfo.name.split(' ').pop()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(ATTRIBUTE_CATEGORIES).map(([category, attrList]) => (
                                <React.Fragment key={category}>
                                    <tr>
                                        <td colSpan={3} className="py-3 px-2 sm:px-4 bg-gray-100 dark:bg-gray-900/40 text-sm font-bold text-gray-700 dark:text-gray-200">{category}</td>
                                    </tr>
                                    {attrList.map(({ key, label }) => (
                                        <AttributeComparisonRow 
                                            key={key} 
                                            label={label}
                                            p1_rating={player1.attributes[key as keyof Attributes]}
                                            p2_rating={player2.attributes[key as keyof Attributes]}
                                        />
                                    ))}
                                </React.Fragment>
                            ))}
                             {(player1.goalkeeperAttributes || player2.goalkeeperAttributes) && Object.entries(GK_ATTRIBUTE_CATEGORIES).map(([category, attrList]) => (
                                <React.Fragment key={category}>
                                    <tr>
                                        <td colSpan={3} className="py-3 px-2 sm:px-4 bg-gray-100 dark:bg-gray-900/40 text-sm font-bold text-gray-700 dark:text-gray-200">{category}</td>
                                    </tr>
                                    {attrList.map(({ key, label }) => (
                                        <AttributeComparisonRow 
                                            key={key} 
                                            label={label}
                                            p1_rating={player1.goalkeeperAttributes?.[key as keyof GoalkeeperAttributes] ?? 0}
                                            p2_rating={player2.goalkeeperAttributes?.[key as keyof GoalkeeperAttributes] ?? 0}
                                        />
                                    ))}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
                <div>
                    <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
                        <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
                          <span className="mr-3 text-2xl">📈</span>
                          {player1.basicInfo.name.split(' ').pop()}'s Strengths
                        </h3>
                        <ul className="space-y-2 list-inside">
                            {player1.strengths.map((s, i) => (
                              <li key={i} className="text-gray-700 dark:text-gray-300 flex items-start"><span className="text-green-500 dark:text-green-400 mr-2 mt-1">✓</span>{s}</li>
                            ))}
                        </ul>
                    </div>
                </div>
                 <div>
                    <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
                        <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
                          <span className="mr-3 text-2xl">📈</span>
                          {player2.basicInfo.name.split(' ').pop()}'s Strengths
                        </h3>
                        <ul className="space-y-2 list-inside">
                            {player2.strengths.map((s, i) => (
                              <li key={i} className="text-gray-700 dark:text-gray-300 flex items-start"><span className="text-green-500 dark:text-green-400 mr-2 mt-1">✓</span>{s}</li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
             <div className="grid md:grid-cols-2 gap-8">
                <div>
                    <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
                        <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
                          <span className="mr-3 text-2xl">📉</span>
                          {player1.basicInfo.name.split(' ').pop()}'s Weaknesses
                        </h3>
                        <ul className="space-y-2 list-inside">
                            {player1.weaknesses.map((w, i) => (
                              <li key={i} className="text-gray-700 dark:text-gray-300 flex items-start"><span className="text-red-500 dark:text-red-400 mr-2 mt-1">✗</span>{w}</li>
                            ))}
                        </ul>
                    </div>
                </div>
                 <div>
                    <div className="bg-white dark:bg-gray-800/70 rounded-xl shadow-lg p-6 border border-gray-200 dark:border-gray-700/50">
                        <h3 className="text-xl font-bold text-blue-500 dark:text-blue-400 mb-4 flex items-center">
                          <span className="mr-3 text-2xl">📉</span>
                          {player2.basicInfo.name.split(' ').pop()}'s Weaknesses
                        </h3>
                        <ul className="space-y-2 list-inside">
                            {player2.weaknesses.map((w, i) => (
                              <li key={i} className="text-gray-700 dark:text-gray-300 flex items-start"><span className="text-red-500 dark:text-red-400 mr-2 mt-1">✗</span>{w}</li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>

        </div>
    );
};
