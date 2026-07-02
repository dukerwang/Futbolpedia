import React from 'react';
import { AttributeTable } from 'futbolpedia-ai';

const outfieldAttributes = {
  finishing: 88,
  firstTouch: 91,
  dribbling: 85,
  vision: 93,
  retention: 89,
  combinationPlay: 87,
  delivery: 76,
  progressivePassing: 90,
  footballIQ: 94,
  offensivePositioning: 86,
  defensivePositioning: 68,
  tackling: 62,
  interceptions: 65,
  pressingIntensity: 74,
  speed: 82,
  acceleration: 84,
  agility: 88,
  strength: 71,
  aerialProwess: 60,
  stamina: 79,
  composure: 92,
  clutch: 87,
  leadership: 81,
  consistency: 90,
  flair: 95,
};

const goalkeeperAttributes = {
  reflexes: 91,
  handling: 88,
  distribution: 85,
  commandOfArea: 83,
  GKpositioning: 90,
  sweeping: 77,
  ballPlaying: 86,
};

export const Outfield = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6 max-w-3xl">
    <AttributeTable attributes={outfieldAttributes} />
  </div>
);

export const Goalkeeper = () => (
  <div className="bg-cream-100 dark:bg-charcoal p-6 max-w-3xl">
    <AttributeTable attributes={outfieldAttributes} goalkeeperAttributes={goalkeeperAttributes} />
  </div>
);
