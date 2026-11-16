import React from 'react';
import type { LineupView } from '../../services/lineupView';
import { PitchFigure } from '../PitchView';
import { SkeletonBar, ViewFrame } from './ViewFrame';

/**
 * The first-choice XI in the view frame. `PitchFigure` is drawn as it is; the frame supplies the
 * panel and caption, so the figure's own border and tint are taken off here to keep one rule
 * around it rather than two.
 */

// The figure under the caption already names the club and its league.
const caption = (): Array<string | null> => ['First-choice XI'];

export const PitchBlockView: React.FC<{ lineup: LineupView }> = ({ lineup }) => (
  <div className="max-w-md">
    <ViewFrame kind="pitch" caption={caption()} meta={lineup.asOf} label={`${lineup.club} first-choice XI`}>
      <div className="[&>figure]:border-0 [&>figure]:bg-transparent dark:[&>figure]:bg-transparent">
        <PitchFigure lineup={lineup} />
      </div>
    </ViewFrame>
  </div>
);

/**
 * The pitch's shape while the club's data loads: the figure's header, a pitch at the SVG's 340:460
 * ratio and a caption line. The "Out" list, when there is one, adds height the skeleton can't know.
 */
export const PitchSkeleton: React.FC<{ caption?: Array<string | null | undefined> }> = ({ caption: parts = ['First-choice XI'] }) => (
  <div className="max-w-md">
  <ViewFrame kind="pitch" pending caption={parts} label="First-choice XI, loading">
    <div className="p-3 flex flex-col gap-2">
      <div className="h-5 flex items-center justify-between gap-3">
        <SkeletonBar className="h-4 w-32" />
        <SkeletonBar className="h-2.5 w-20" />
      </div>
      <SkeletonBar className="w-full aspect-[340/460]" />
      <div className="h-[15px] flex items-center"><SkeletonBar className="h-2.5 w-3/4" /></div>
    </div>
  </ViewFrame>
  </div>
);

export default PitchBlockView;
