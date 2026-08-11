import { describe, it, expect } from 'vitest';
import { jobFinishedMessage } from '@/lib/push';

describe('jobFinishedMessage', () => {
  it('says how many videos are ready', () => {
    const many = jobFinishedMessage({ productName: 'baggy sweats', videoCount: 5, jobId: 'abc' });
    expect(many.title).toBe('Your 5 videos are ready');
    expect(many.body).toContain('baggy sweats');
  });

  it('uses the singular for a talking-head edit', () => {
    // Talking mode always produces exactly one video, and "Your 1 videos are
    // ready" is the kind of wrongness that makes a product feel unfinished.
    expect(jobFinishedMessage({ productName: 'x', videoCount: 1, jobId: 'abc' }).title)
      .toBe('Your video is ready');
  });

  it('trims the product name a creator typed with trailing spaces', () => {
    // Real product names in the database have them.
    expect(jobFinishedMessage({ productName: 'baggy sweats ', videoCount: 2, jobId: 'a' }).body)
      .toContain('"baggy sweats"');
  });

  it('links to the job and collapses repeats about it', () => {
    const message = jobFinishedMessage({ productName: 'x', videoCount: 2, jobId: 'job-1' });
    expect(message.url).toBe('/jobs/job-1');
    // Same tag means a second push about one job replaces the first rather
    // than stacking another line in the notification shade.
    expect(message.tag).toBe('job-job-1');
  });
});
