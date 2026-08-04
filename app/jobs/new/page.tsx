'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { VideoTile } from '@/components/ui';
import { IconCheck, IconImage, IconUpload } from '@/components/icons';

type Style = {
  id: string;
  name: string;
  description: string;
  usesInspirationOverlay: boolean;
};

const LENGTHS = [15, 30, 45, 60] as const;
const PACINGS = ['slow', 'medium', 'fast'] as const;

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
  const [lengthSeconds, setLengthSeconds] = useState<number>(30);
  const [pacing, setPacing] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [variationCount, setVariationCount] = useState(5);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // The preview rail shows the sizing overlay exactly as the renderer will
  // build it, which means it needs the creator's stored measurements.
  const [profile, setProfile] = useState<{ height?: string; weight?: string }>({});

  useEffect(() => {
    fetch('/api/styles')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Style[]) => setStyles(data))
      .catch(() => setStyles([]));

    fetch('/api/profile')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setProfile({ height: data.height ?? '', weight: data.weight ?? '' });
      })
      .catch(() => {});
  }, []);

  const selectedStyle = styles.find((s) => s.id === selectedStyleId) ?? null;
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

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

      const job = await res.json();
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setErrors([
        { field: 'form', message: err instanceof Error ? err.message : 'Something went wrong.' },
      ]);
      setSubmitting(false);
    }
  }

  return (
    <AppShell
      title="New video"
      subtitle="Upload footage and let the AI cut it"
      showNewVideoAction={false}
    >
      <div className="newVideoLayout">
        <div>
          <label className="dropzone glass">
            <span className="dropzoneIcon">
              <IconUpload size={22} />
            </span>
            <span className="dropzoneTitle">Drop your raw clips</span>
            <span style={{ fontSize: 13, color: 'var(--text-3)', maxWidth: 280 }}>
              Phone footage of you trying on / using the product
            </span>
            {files.length > 0 && (
              <span className="pill" style={{ marginTop: 4 }}>
                <IconCheck size={13} />
                {files.length} clip{files.length === 1 ? '' : 's'} ready
              </span>
            )}
            <input
              type="file"
              multiple
              accept="video/*"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              style={{ display: 'none' }}
            />
          </label>
          {errorFor('clips') && <p className="errorText">{errorFor('clips')}</p>}

          <section className="glass card" style={{ marginTop: 20 }}>
            <div className="formSection">
              <label className="label" htmlFor="productName">
                Product name
              </label>
              <input
                id="productName"
                className="input"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. Streetwear Zip-Up Hoodie"
              />
              {errorFor('productName') ? (
                <p className="errorText">{errorFor('productName')}</p>
              ) : (
                <p className="helper">
                  Use the real product name — it feeds the AI-written hook.
                </p>
              )}
            </div>

            <div className="formSection">
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>Show sizing info</div>
                  <p className="helper" style={{ marginTop: 5 }}>
                    Burns a small &quot;size worn&quot; overlay onto every video
                  </p>
                </div>
                <button
                  type="button"
                  className="toggle"
                  data-on={sizingOn}
                  aria-pressed={sizingOn}
                  aria-label="Show sizing info"
                  onClick={() => setSizingOn((on) => !on)}
                >
                  <span className="toggleKnob" />
                </button>
              </div>

              {sizingOn && (
                <div style={{ marginTop: 16 }}>
                  <label className="label" htmlFor="sizeWorn">
                    Size worn
                  </label>
                  <input
                    id="sizeWorn"
                    className="input"
                    value={sizeWorn}
                    onChange={(e) => setSizeWorn(e.target.value)}
                    placeholder='e.g. "M" or "runs small"'
                  />
                  {errorFor('sizeWorn') && <p className="errorText">{errorFor('sizeWorn')}</p>}
                </div>
              )}
            </div>

            <div className="formSection">
              <span className="label">Length</span>
              <div className="segmented">
                {LENGTHS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="segment"
                    data-active={lengthSeconds === value}
                    onClick={() => setLengthSeconds(value)}
                  >
                    {value}s
                  </button>
                ))}
              </div>
            </div>

            <div className="formSection">
              <span className="label">How do you want to edit this?</span>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  type="button"
                  className="modeTab"
                  data-active={mode === 'custom'}
                  onClick={() => setMode('custom')}
                >
                  <div className="modeTabTitle">Custom</div>
                  <div className="modeTabSub">You set the pacing</div>
                </button>
                <button
                  type="button"
                  className="modeTab"
                  data-active={mode === 'style'}
                  onClick={() => setMode('style')}
                >
                  <div className="modeTabTitle">Style</div>
                  <div className="modeTabSub">Named presets</div>
                </button>
              </div>

              {mode === 'custom' && (
                <div style={{ marginTop: 18 }}>
                  <span className="label">Pacing</span>
                  <div className="segmented">
                    {PACINGS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className="segment"
                        data-active={pacing === value}
                        onClick={() => setPacing(value)}
                        style={{ textTransform: 'capitalize' }}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {mode === 'style' && (
                <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {styles.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      className="styleCard"
                      data-active={selectedStyleId === style.id}
                      onClick={() => setSelectedStyleId(style.id)}
                    >
                      <span className="styleRadio">
                        {selectedStyleId === style.id && <IconCheck size={12} />}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="styleName">{style.name}</span>
                        <span className="styleDesc" style={{ display: 'block' }}>
                          {style.description}
                        </span>
                        {style.usesInspirationOverlay && (
                          <span className="tag">+ INSPIRATION PHOTO</span>
                        )}
                      </span>
                    </button>
                  ))}

                  {errorFor('styleId') && <p className="errorText">{errorFor('styleId')}</p>}

                  {selectedStyle?.usesInspirationOverlay && (
                    <label
                      className="styleCard"
                      style={{ cursor: 'pointer', alignItems: 'center' }}
                    >
                      <span className="styleRadio" style={{ border: 'none', background: 'none' }}>
                        <IconImage size={18} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="styleName">Inspiration photo</span>
                        <span className="styleDesc" style={{ display: 'block' }}>
                          {inspirationFile
                            ? inspirationFile.name
                            : 'Choose the photo this style composites in'}
                        </span>
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => setInspirationFile(e.target.files?.[0] ?? null)}
                        style={{ display: 'none' }}
                      />
                    </label>
                  )}

                  {errorFor('inspirationImage') && (
                    <p className="errorText">{errorFor('inspirationImage')}</p>
                  )}
                </div>
              )}
            </div>

            <div className="formSection">
              <span className="label">Variations</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <input
                  type="range"
                  className="range"
                  min={1}
                  max={10}
                  value={variationCount}
                  onChange={(e) => setVariationCount(Number(e.target.value))}
                  style={{ ['--fill' as string]: `${((variationCount - 1) / 9) * 100}%` }}
                />
                <span className="display" style={{ fontSize: 26, minWidth: 32, textAlign: 'right' }}>
                  {variationCount}
                </span>
              </div>
              <p className="helper">Different edits generated from the same footage.</p>
              {errorFor('variationCount') && (
                <p className="errorText">{errorFor('variationCount')}</p>
              )}
            </div>
          </section>

          {errorFor('form') && (
            <div className="banner" data-tone="failed" style={{ marginTop: 16 }}>
              {errorFor('form')}
            </div>
          )}
        </div>

        <aside className="summaryRail">
          <div className="glass card">
            <span
              className="mono"
              style={{ fontSize: 10.5, letterSpacing: '0.18em', color: 'var(--text-3)' }}
            >
              PREVIEW
            </span>

            <div style={{ margin: '14px auto 0', width: 174 }}>
              <VideoTile
                hue={268}
                hook={productName || 'your hook lands here'}
                sizing={
                  sizingOn
                    ? {
                        height: profile.height,
                        weight: profile.weight,
                        sizeWorn,
                        side: selectedStyle?.usesInspirationOverlay ? 'left' : 'right',
                      }
                    : null
                }
              />
            </div>

            <dl style={{ marginTop: 20, display: 'grid', gap: 10 }}>
              <SummaryRow label="Length" value={`${lengthSeconds}s`} />
              <SummaryRow label="Mode" value={mode === 'custom' ? 'Custom' : 'Style'} />
              <SummaryRow
                label={mode === 'custom' ? 'Pacing' : 'Style'}
                value={mode === 'custom' ? pacing : selectedStyle?.name ?? 'none picked'}
              />
              <SummaryRow label="Variations" value={String(variationCount)} />
              <SummaryRow
                label="Sizing"
                value={sizingOn ? sizeWorn.trim() || 'on' : 'off'}
              />
            </dl>

            <button
              className="btn btnAccent btnFull"
              style={{ marginTop: 20 }}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Generate videos'}
            </button>

            <p className="helper" style={{ textAlign: 'center' }}>
              Renders in the background. You&apos;ll see live progress.
            </p>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <dt style={{ color: 'var(--text-3)' }}>{label}</dt>
      <dd
        style={{
          fontWeight: 700,
          textTransform: 'capitalize',
          textAlign: 'right',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </dd>
    </div>
  );
}
