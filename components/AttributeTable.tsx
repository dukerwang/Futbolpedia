import React from 'react';
import type { Attributes, GoalkeeperAttributes } from '../types';
import { ATTRIBUTE_CATEGORIES, GK_ATTRIBUTE_CATEGORIES } from '../constants';

interface AttributeTableProps {
  attributes: Attributes;
  goalkeeperAttributes?: GoalkeeperAttributes;
}

const getRatingColor = (rating: number): string => {
  if (rating >= 90) return 'from-green-400 to-teal-400';
  if (rating >= 80) return 'from-sky-400 to-blue-500';
  if (rating >= 70) return 'from-yellow-400 to-orange-400';
  if (rating >= 60) return 'from-orange-400 to-red-500';
  return 'from-red-500 to-red-600';
};

const AttributeRow: React.FC<{ label: string; rating: number }> = ({ label, rating }) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <span className="text-sm font-medium text-gray-600 dark:text-gray-300 w-1/3">{label}</span>
    <div className="w-2/3 flex items-center gap-3">
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
        <div 
          className={`bg-gradient-to-r ${getRatingColor(rating)} h-2.5 rounded-full`} 
          style={{ width: `${rating}%` }}
        ></div>
      </div>
      <span className={`text-sm font-bold w-8 text-right ${rating >= 80 ? 'text-gray-800 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>{rating}</span>
    </div>
  </div>
);

export const AttributeTable: React.FC<AttributeTableProps> = ({ attributes, goalkeeperAttributes }) => {
  const isGoalkeeper = !!goalkeeperAttributes && Object.keys(goalkeeperAttributes).length > 0;
  
  const categoriesToRender = isGoalkeeper ? GK_ATTRIBUTE_CATEGORIES : ATTRIBUTE_CATEGORIES;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-x-8 gap-y-6">
      {Object.entries(categoriesToRender).map(([category, attrList]) => (
        <div key={category}>
          <h4 className="text-lg font-semibold text-gray-500 dark:text-gray-400 mb-2 border-b border-gray-200 dark:border-gray-700 pb-1">{category}</h4>
          <div className="space-y-1">
            {attrList.map(({ key, label }) => {
              let ratingValue = 0;
              if (isGoalkeeper && goalkeeperAttributes && key in goalkeeperAttributes) {
                 ratingValue = (goalkeeperAttributes as any)[key];
              } else {
                 ratingValue = (attributes as any)[key];
              }
              return <AttributeRow key={key} label={label} rating={ratingValue || 0} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
