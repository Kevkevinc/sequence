'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Job = {
  id: string;
  productName: string;
  status: string;
  lengthSeconds: number;
  pacing: string;
  variationCount: number;
  createdAt: string;
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    fetch('/api/jobs')
      .then((res) => res.json())
      .then(setJobs);
  }, []);

  return (
    <main>
      <h1>Your Videos</h1>
      <Link href="/jobs/new">+ New Video</Link>
      <ul>
        {jobs.map((job) => (
          <li key={job.id}>
            {job.productName} — {job.lengthSeconds}s, {job.pacing} pacing, {job.variationCount} variations —{' '}
            {job.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
