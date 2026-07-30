'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Style = { id: string; name: string; description: string; usesInspirationOverlay: boolean };

export default function NewJobPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'custom' | 'style'>('custom');
  const [styles, setStyles] = useState<Style[]>([]);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [inspirationFile, setInspirationFile] = useState<File | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [productName, setProductName] = useState('');
  const [sizingOn, setSizingOn] = useState(false);
  const [sizeWorn, setSizeWorn] = useState('');
  const [lengthSeconds, setLengthSeconds] = useState(30);
  const [pacing, setPacing] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [variationCount, setVariationCount] = useState(5);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/styles')
      .then((res) => res.json())
      .then((data: Style[]) => setStyles(data))
      .catch(() => setStyles([]));
  }, []);

  const selectedStyle = styles.find((s) => s.id === selectedStyleId) ?? null;

  async function uploadFile(file: File): Promise<{ storageKey: string; originalFilename: string }> {
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

    return { storageKey, originalFilename: file.name };
  }

  async function handleSubmit() {
    setSubmitting(true);
    setErrors([]);

    try {
      const clips = [];
      for (const file of files) {
        clips.push(await uploadFile(file));
      }

      let inspirationImage: { storageKey: string } | undefined;
      if (mode === 'style' && selectedStyle?.usesInspirationOverlay && inspirationFile) {
        const uploaded = await uploadFile(inspirationFile);
        inspirationImage = { storageKey: uploaded.storageKey };
      }

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName,
          sizingOverlayEnabled: sizingOn,
          sizeWorn: sizingOn ? sizeWorn : undefined,
          lengthSeconds,
          pacing: mode === 'custom' ? pacing : undefined,
          styleId: mode === 'style' ? selectedStyleId : undefined,
          variationCount,
          clips,
          inspirationImage,
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

      <fieldset>
        <legend>How do you want to edit this?</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
          />
          Custom
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'style'}
            onChange={() => setMode('style')}
          />
          Style
        </label>
      </fieldset>

      {mode === 'custom' && (
        <label>
          Pacing
          <select value={pacing} onChange={(e) => setPacing(e.target.value as typeof pacing)}>
            <option value="slow">Slow</option>
            <option value="medium">Medium</option>
            <option value="fast">Fast</option>
          </select>
        </label>
      )}

      {mode === 'style' && (
        <div>
          {styles.map((style) => (
            <label key={style.id} style={{ display: 'block' }}>
              <input
                type="radio"
                name="style"
                checked={selectedStyleId === style.id}
                onChange={() => setSelectedStyleId(style.id)}
              />
              <strong>{style.name}</strong> — {style.description}
            </label>
          ))}

          {selectedStyle?.usesInspirationOverlay && (
            <label>
              Inspiration photo
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setInspirationFile(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>
      )}

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
