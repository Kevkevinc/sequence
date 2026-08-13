'use client';

import { useEffect, useState } from 'react';
import { estimateRemainingSeconds, formatRemaining } from '@/lib/estimate';
import type { JobDetail, JobStatus } from '@/lib/jobView';

/**
 * The six stages the worker actually walks, with a plain sentence about what is
 * happening in each.
 *
 * The waits here are minutes, not seconds: tagging alone measures around two
 * and a half minutes on real phone footage. Without saying so, a creator
 * watching a spinner assumes it has hung and reloads, or gives up.
 */
const STAGES: { status: JobStatus; title: string; detail: string }[] = [
  { status: 'pending', title: 'Queued', detail: 'Waiting on a free slot.' },
  { status: 'tagging', title: 'Tagging clips', detail: 'Reading what is in every shot.' },
  { status: 'planning', title: 'Planning cuts', detail: 'Deciding where every edit breaks.' },
  { status: 'planned', title: 'Planned', detail: 'Cuts locked, rendering next.' },
  { status: 'rendering', title: 'Rendering', detail: 'Making each video at full quality.' },
  { status: 'done', title: 'Done', detail: 'Everything ready to download.' },
];

/** The vertical rail of stages, with a live count on the rendering row. */
export function StageTimeline({ job, doneCount }: { job: JobDetail; doneCount: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const currentIndex = STAGES.findIndex((stage) => stage.status === job.status);
  const remaining = estimateRemainingSeconds(
    {
      status: job.status,
      createdAt: job.createdAt,
      variationCount: job.variationCount,
      doneCount,
      clipCount: job.clipCount,
    },
    now
  );

  return (
    <div className="glass" style={{ padding: 16 }}>
      <div className="sectionLabelRow" style={{ marginBottom: 14 }}>
        <span className="sectionLabel">Cutting your videos</span>
        {remaining !== null && <span className="meta">{formatRemaining(remaining)}</span>}
      </div>

      {STAGES.map((stage, index) => {
        const state =
          currentIndex === -1
            ? 'upcoming'
            : index < currentIndex
              ? 'complete'
              : index === currentIndex
                ? 'current'
                : 'upcoming';
        const isLast = index === STAGES.length - 1;

        return (
          <div key={stage.status} className="stageRow" data-state={state}>
            <span className="stageRail">
              <span className="stageCircle" />
              {!isLast && <span className="stageLine" />}
            </span>
            <span style={{ paddingBottom: isLast ? 0 : 10 }}>
              <span className="stageTitle" style={{ display: 'block' }}>
                {stage.title}
              </span>
              <span className="meta" style={{ display: 'block' }}>
                {stage.status === 'rendering' && state === 'current'
                  ? `${doneCount} of ${job.variationCount} rendered`
                  : stage.detail}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
