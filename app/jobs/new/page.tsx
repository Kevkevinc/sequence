'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NewJobPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [productName, setProductName] = useState('');
  const [sizingOn, setSizingOn] = useState(false);
  const [sizeWorn, setSizeWorn] = useState('');
  const [lengthSeconds, setLengthSeconds] = useState(30);
  const [pacing, setPacing] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [variationCount, setVariationCount] = useState(5);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setSubmitting(true);
    setErrors([]);

    try {
      const clips = [];
      for (const file of files) {
        const presignRes = await fetch('/api/uploads/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, contentType: file.type }),
        });
        if (!presignRes.ok) {
          throw new Error(`Failed to get an upload URL for "${file.name}".`);
        }
        const { url, storageKey } = await presignRes.json();

        const uploadRes = await fetch(url, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        });
        if (!uploadRes.ok) {
          throw new Error(`Failed to upload "${file.name}". Please try again.`);
        }

        clips.push({ storageKey, originalFilename: file.name });
      }

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName,
          sizingOverlayEnabled: sizingOn,
          sizeWorn: sizingOn ? sizeWorn : undefined,
          lengthSeconds,
          pacing,
          variationCount,
          clips,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        setErrors(body.errors ?? [{ field: 'form', message: 'Something went wrong.' }]);
        setSubmitting(false);
        return;
      }

      router.push('/jobs');
    } catch (err) {
      setErrors([
        { field: 'form', message: err instanceof Error ? err.message : 'Something went wrong.' },
      ]);
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>New Video</h1>

      <label>
        Raw clips
        <input
          type="file"
          multiple
          accept="video/*"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
      </label>

      <label>
        Product name
        <input value={productName} onChange={(e) => setProductName(e.target.value)} />
      </label>

      <label>
        <input type="checkbox" checked={sizingOn} onChange={(e) => setSizingOn(e.target.checked)} />
        Show sizing info
      </label>

      {sizingOn && (
        <label>
          Size worn
          <input value={sizeWorn} onChange={(e) => setSizeWorn(e.target.value)} />
        </label>
      )}

      <label>
        Length
        <select value={lengthSeconds} onChange={(e) => setLengthSeconds(Number(e.target.value))}>
          <option value={15}>15s</option>
          <option value={30}>30s</option>
          <option value={45}>45s</option>
          <option value={60}>60s</option>
        </select>
      </label>

      <label>
        Pacing
        <select value={pacing} onChange={(e) => setPacing(e.target.value as typeof pacing)}>
          <option value="slow">Slow</option>
          <option value="medium">Medium</option>
          <option value="fast">Fast</option>
        </select>
      </label>

      <label>
        Variations
        <input
          type="number"
          min={1}
          max={20}
          value={variationCount}
          onChange={(e) => setVariationCount(Number(e.target.value))}
        />
      </label>

      <button onClick={handleSubmit} disabled={submitting}>
        {submitting ? 'Creating...' : 'Create'}
      </button>

      {errors.map((err) => (
        <p key={err.field} style={{ color: 'red' }}>
          {err.message}
        </p>
      ))}
    </main>
  );
}
