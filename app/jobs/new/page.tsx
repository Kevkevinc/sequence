'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppFrame, Screen } from '@/components/AppFrame';
import { CaptionEditor } from '@/components/CaptionEditor';
import { Thumb } from '@/components/Thumb';
import {
  IconCheck,
  IconChevronLeft,
  IconClose,
  IconUpload,
  IconWarning,
} from '@/components/icons';
import { gradeFor } from '@/lib/jobView';
import { resolveCaptionSettings, type CaptionSettings } from '@/lib/render/captionSettings';
import {
  MAX_LENGTH_SECONDS,
  MAX_VARIATION_COUNT,
  MIN_CLIP_SECONDS,
  MIN_LENGTH_SECONDS,
  checkClipDurations,
  maxVariationsForFootage,
  recommendedFootageSeconds,
} from '@/lib/validation/job';

/**
 * The four-step flow that creates a job.
 *
 * It owns the whole screen: the nav is hidden, and the only ways out are the
 * back chevron, Cancel, and the footer action. Every footer button is named
 * after its outcome ("Add clips", "Make 10 videos") rather than Next, because
 * on a phone the button is the only thing telling you what happens if you tap.
 *
 * Clips upload as soon as they are picked rather than at the end. A phone clip
 * is 100MB+ and a five-clip job is minutes of transfer; doing it while the
 * creator is still choosing pacing is time they were spending anyway, and it
 * means the last screen's button starts the render instead of starting an
 * upload.
 */

const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const PACINGS = ['slow', 'medium', 'fast'] as const;

/** What each pacing means in seconds, mirroring the director's presets. */
const PACING_HELP: Record<(typeof PACINGS)[number], string> = {
  slow: 'Each cut holds 4 to 7 seconds.',
  medium: 'Each cut holds 1.5 to 4 seconds.',
  fast: 'Each cut holds 1 to 2 seconds.',
};

/**
 * The hook shown on the caption stage.
 *
 * Representative, not the creator's real hook, which does not exist yet: the AI
 * writes one per variation during planning. Long enough to show how a real line
 * behaves at the default size.
 */
const PREVIEW_HOOK = 'THIS HOODIE ATE';

type Style = {
  id: string;
  name: string;
  description: string;
  usesInspirationOverlay: boolean;
  usesFitInspoIntro: boolean;
  captionSettings: Partial<CaptionSettings> | null;
};

type Upload = {
  id: string;
  file: File;
  sent: number;
  status: 'uploading' | 'done' | 'failed';
  storageKey?: string;
};

const STEP_TITLES = [
  'What are you making?',
  'Add your clips',
  'How it gets cut',
  'On-screen text',
];

/** The playing length of a video File, read via a throwaway <video> element. */
function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}

/**
 * PUTs one file to R2, reporting bytes as they go.
 *
 * XMLHttpRequest rather than fetch: fetch cannot report *upload* progress at
 * all, which is why this screen used to sit silent for minutes on a phone while
 * 100MB+ of 4K footage went up with no sign it was working.
 */
function putWithProgress(url: string, file: File, onProgress: (sent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload of ${file.name} failed with status ${xhr.status}.`));
    xhr.onerror = () => reject(new Error(`Upload of ${file.name} failed.`));
    xhr.onabort = () => reject(new Error(`Upload of ${file.name} was cancelled.`));
    xhr.send(file);
  });
}

async function uploadOne(file: File, onProgress: (sent: number) => void) {
  const presign = await fetch('/api/uploads/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  });
  if (!presign.ok) throw new Error(`Could not get an upload slot for ${file.name}.`);
  const { url, storageKey } = await presign.json();
  await putWithProgress(url, file, onProgress);
  return storageKey as string;
}

export default function NewJobPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  const [productName, setProductName] = useState('');
  const [kind, setKind] = useState<'cuts' | 'talking'>('cuts');
  const isTalking = kind === 'talking';

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [footageSeconds, setFootageSeconds] = useState(0);
  const [uploadStartedAt, setUploadStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);

  const [mode, setMode] = useState<'custom' | 'style'>('custom');
  const [pacing, setPacing] = useState<(typeof PACINGS)[number]>('medium');
  const [styles, setStyles] = useState<Style[]>([]);
  const [styleId, setStyleId] = useState<string | null>(null);
  const [inspirationFile, setInspirationFile] = useState<File | null>(null);
  const [fitPics, setFitPics] = useState<File[]>([]);

  const [lengthSeconds, setLengthSeconds] = useState(30);
  const [variations, setVariations] = useState(10);
  const [sizingOn, setSizingOn] = useState(false);
  const [sizeWorn, setSizeWorn] = useState('M');

  const [profile, setProfile] = useState<{ height?: string; weight?: string }>({});
  const [savedCaptions, setSavedCaptions] = useState<unknown>(null);
  const [tweaked, setTweaked] = useState<CaptionSettings | null>(null);
  const [hookText, setHookText] = useState(PREVIEW_HOOK);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/styles')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Style[]) => setStyles(Array.isArray(data) ? data : []))
      .catch(() => setStyles([]));

    fetch('/api/profile')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setProfile({ height: data.height ?? '', weight: data.weight ?? '' });
        setSavedCaptions(data.captionSettings ?? null);
      })
      .catch(() => {});
  }, []);

  // Keeps the transfer rate honest while bytes are moving; the upload callbacks
  // themselves only fire on progress, which stalls the clock when one does.
  useEffect(() => {
    if (!uploads.some((upload) => upload.status === 'uploading')) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [uploads]);

  const selectedStyle = styles.find((style) => style.id === styleId) ?? null;

  /*
   * Mirrors the renderer's layering: the style's look in Style mode, the
   * creator's own in Custom mode, with anything they changed on top. Derived
   * during render rather than copied into state, so switching style updates the
   * stage unless the creator has already taken over.
   */
  const inherited = mode === 'style' ? selectedStyle?.captionSettings : savedCaptions;
  const captions = tweaked ?? resolveCaptionSettings(inherited);

  const sizingText = sizingOn
    ? [profile.height, profile.weight, sizeWorn ? `wears ${sizeWorn}` : '']
        .filter(Boolean)
        .join(' · ') || null
    : null;

  const done = uploads.filter((upload) => upload.status === 'done');
  const failed = uploads.filter((upload) => upload.status === 'failed');
  const uploading = uploads.filter((upload) => upload.status === 'uploading');
  const totalBytes = uploads.reduce((sum, upload) => sum + upload.file.size, 0);
  const sentBytes = uploads.reduce((sum, upload) => sum + upload.sent, 0);
  const elapsed = uploadStartedAt && now ? (now - uploadStartedAt) / 1000 : 0;
  const rate = elapsed > 1 ? sentBytes / elapsed : 0;

  const neededSeconds = recommendedFootageSeconds(lengthSeconds, variations);
  const supported = maxVariationsForFootage(footageSeconds, lengthSeconds);
  const footageOk = footageSeconds === 0 || neededSeconds <= footageSeconds;

  /**
   * Takes the picked clips, drops the ones too short to cut from, and starts
   * uploading the rest two at a time.
   *
   * Clips barely longer than one cut offer exactly one legal cut, so every
   * variation using them shows identical frames. Every editing failure on
   * record came from an upload that was mostly clips like this, and each one
   * cost three model calls and four minutes before saying so. Dropping them
   * here is the difference between a job that cannot succeed and one that is
   * never created.
   */
  async function addClips(picked: File[]) {
    if (picked.length === 0) return;
    const durations = await Promise.all(picked.map(readVideoDuration));
    const { tooShortIndexes } = checkClipDurations(durations);

    const keep = picked.filter((_, index) => !tooShortIndexes.includes(index));
    const keptSeconds = durations
      .filter((_, index) => !tooShortIndexes.includes(index))
      .reduce((sum, seconds) => sum + seconds, 0);

    setSkipped((current) => current + tooShortIndexes.length);
    setFootageSeconds((current) => current + keptSeconds);
    if (keep.length === 0) return;

    const added: Upload[] = keep.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      file,
      sent: 0,
      status: 'uploading',
    }));
    setUploads((current) => [...current, ...added]);
    setUploadStartedAt((current) => current ?? Date.now());

    // Two at a time: strictly sequential left a phone uploading 130MB clips one
    // after another, and more than two stalls a mobile uplink.
    let next = 0;
    const workers = Array.from({ length: Math.min(2, added.length) }, async () => {
      for (let index = next++; index < added.length; index = next++) {
        const upload = added[index];
        try {
          const storageKey = await uploadOne(upload.file, (sent) =>
            setUploads((current) =>
              current.map((row) => (row.id === upload.id ? { ...row, sent } : row))
            )
          );
          setUploads((current) =>
            current.map((row) =>
              row.id === upload.id
                ? { ...row, status: 'done', storageKey, sent: row.file.size }
                : row
            )
          );
        } catch {
          setUploads((current) =>
            current.map((row) => (row.id === upload.id ? { ...row, status: 'failed' } : row))
          );
        }
      }
    });
    await Promise.all(workers);
  }

  function cancel() {
    router.push('/');
  }

  function back() {
    if (step === 1) {
      cancel();
      return;
    }
    setStep((current) => current - 1);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);

    try {
      // Style extras are images, tiny next to video, so they ride the same
      // presigned path at the end rather than blocking step 2.
      const inspirationImages: { storageKey: string; kind: 'person' }[] = [];
      if (mode === 'style' && selectedStyle?.usesFitInspoIntro) {
        for (const pic of fitPics) {
          inspirationImages.push({ storageKey: await uploadOne(pic, () => {}), kind: 'person' });
        }
      }

      let inspirationImage: { storageKey: string } | undefined;
      if (mode === 'style' && selectedStyle?.usesInspirationOverlay && inspirationFile) {
        inspirationImage = { storageKey: await uploadOne(inspirationFile, () => {}) };
      }

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName,
          kind,
          sizingOverlayEnabled: sizingOn,
          sizeWorn: sizingOn ? sizeWorn : undefined,
          lengthSeconds,
          // Talking mode has no style and no pacing choice of its own, but the
          // API needs exactly one of the two, so it goes through as Custom.
          pacing: isTalking || mode === 'custom' ? pacing : undefined,
          styleId: !isTalking && mode === 'style' ? styleId : undefined,
          variationCount: isTalking ? 1 : variations,
          // Only sent when the creator actually changed something, so an
          // untouched job keeps inheriting from its style or profile later
          // rather than freezing today's defaults into the row.
          captionSettings: tweaked ?? undefined,
          clips: done.map((upload) => ({
            storageKey: upload.storageKey!,
            originalFilename: upload.file.name,
          })),
          inspirationImage,
          inspirationImages,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          body?.errors?.[0]?.message ??
            'That could not be started. Check your settings and try again.'
        );
        setSubmitting(false);
        return;
      }

      const job = await res.json();
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  /* -------------------------------------------------- footer actions --- */

  const canContinue =
    step === 1
      ? productName.trim().length > 0
      : step === 2
        ? done.length + uploading.length > 0
        : step === 3
          ? !(!isTalking && mode === 'style' && !styleId)
          : done.length > 0 && uploading.length === 0;

  const footerLabel =
    step === 1
      ? 'Add clips'
      : step === 2
        ? 'Choose how it cuts'
        : step === 3
          ? 'Set on-screen text'
          : submitting
            ? 'Starting'
            : isTalking
              ? 'Make my video'
              : `Make ${variations} video${variations === 1 ? '' : 's'}`;

  return (
    <AppFrame showNav={false}>
      <header className="flowHeader">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button type="button" className="backButton" onClick={back} aria-label="Back">
            <IconChevronLeft size={18} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-meta)' }}>Step {step} of 4</div>
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {STEP_TITLES[step - 1]}
            </div>
          </div>
          <button
            type="button"
            onClick={cancel}
            style={{ fontSize: 13.5, color: 'var(--text-meta)', minHeight: 44 }}
          >
            Cancel
          </button>
        </div>

        <div className="stepBars" style={{ marginTop: 12 }}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className="stepBar" data-on={n <= step} />
          ))}
        </div>
      </header>

      <Screen flush>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, paddingTop: 18 }}>
          {step === 1 && (
            <>
              <div>
                <label className="sectionLabel" htmlFor="productName" style={{ marginBottom: 10 }}>
                  Product name
                </label>
                <input
                  id="productName"
                  className="field"
                  value={productName}
                  placeholder="Streetwear Zip-Up Hoodie"
                  onChange={(e) => setProductName(e.target.value)}
                />
                <p className="footnote" style={{ marginTop: 8 }}>
                  Use the real name. It feeds the hook the AI writes.
                </p>
              </div>

              <div>
                <p className="sectionLabel" style={{ marginBottom: 12 }}>
                  What are you making?
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <button
                    type="button"
                    className="selectCard"
                    data-active={!isTalking}
                    onClick={() => setKind('cuts')}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="optionTitle" style={{ display: 'block' }}>
                        Silent cuts
                      </span>
                      <span className="cardDesc" style={{ display: 'block', marginTop: 6 }}>
                        Many clips in, many edits out. No audio, so you record the voiceover in
                        TikTok.
                      </span>
                    </span>
                    <span className="selectRing" />
                  </button>

                  <button
                    type="button"
                    className="selectCard"
                    data-active={isTalking}
                    onClick={() => {
                      setKind('talking');
                      // One take, one edit: the audio fixes the order of the
                      // cuts, so a second variation would be the same video.
                      setVariations(1);
                      setMode('custom');
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="optionTitle" style={{ display: 'block' }}>
                        Talking to camera
                      </span>
                      <span className="cardDesc" style={{ display: 'block', marginTop: 6 }}>
                        One take of you talking. Dead air cut out, your audio kept, captions
                        written for you. Always one video.
                      </span>
                    </span>
                    <span className="selectRing" />
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <label className="dropzone">
                <span className="dropzoneIcon">
                  <IconUpload size={22} />
                </span>
                <span style={{ fontSize: 15.5, fontWeight: 600 }}>
                  {isTalking ? 'Add your take' : 'Add your clips'}
                </span>
                <span className="cardDesc">MP4 or MOV, straight off your phone</span>
                <input
                  type="file"
                  multiple={!isTalking}
                  accept="video/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    void addClips(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
              </label>

              {uploads.length > 0 && (
                <div className="panel" data-tone="success" style={{ display: 'flex', gap: 10 }}>
                  <IconCheck size={16} />
                  <p className="panelText">
                    {uploads.length} clip{uploads.length === 1 ? '' : 's'} ready
                    {footageSeconds > 0 ? ` · ${Math.round(footageSeconds)}s` : ''}
                  </p>
                </div>
              )}

              {skipped > 0 && (
                <div className="panel" data-tone="warning" style={{ display: 'flex', gap: 10 }}>
                  <IconWarning size={16} />
                  <p className="panelText">
                    Skipped {skipped} clip{skipped === 1 ? '' : 's'} under {MIN_CLIP_SECONDS}s.
                    Anything shorter has nothing to cut into. Shoot longer takes.
                  </p>
                </div>
              )}

              {failed.length > 0 && (
                <div className="panel" data-tone="failure" style={{ display: 'flex', gap: 10 }}>
                  <IconClose size={16} />
                  <p className="panelText">
                    {failed.length} clip{failed.length === 1 ? '' : 's'} did not upload. Remove
                    them and add them again.
                  </p>
                </div>
              )}

              {uploads.length > 0 && (
                <div>
                  <div className="sectionLabelRow" style={{ marginBottom: 12 }}>
                    <span className="sectionLabel">
                      {uploading.length > 0 ? 'Uploading' : 'Uploaded'}
                    </span>
                    <span className="meta">
                      {done.length} of {uploads.length}
                      {rate > 0 && uploading.length > 0
                        ? ` · ${(rate / 1e6).toFixed(1)} MB/s`
                        : ''}
                    </span>
                  </div>

                  <div className="list">
                    {uploads.map((upload, index) => {
                      const percent =
                        upload.status === 'done'
                          ? 100
                          : Math.min(
                              99,
                              Math.round((upload.sent / Math.max(1, upload.file.size)) * 100)
                            );
                      return (
                        <div key={upload.id} className="glass transferRow">
                          <Thumb grade={gradeFor(index)} width={34} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 10,
                                alignItems: 'baseline',
                              }}
                            >
                              <span className="listCardTitle" style={{ fontSize: 13.5 }}>
                                {upload.file.name}
                              </span>
                              <span
                                style={{
                                  fontSize: 12.5,
                                  fontWeight: 500,
                                  flexShrink: 0,
                                  color:
                                    upload.status === 'done'
                                      ? 'var(--success)'
                                      : upload.status === 'failed'
                                        ? 'var(--failure)'
                                        : 'var(--accent)',
                                }}
                              >
                                {upload.status === 'done'
                                  ? 'Done'
                                  : upload.status === 'failed'
                                    ? 'Failed'
                                    : `${percent}%`}
                              </span>
                            </div>
                            <div className="meta" style={{ marginBottom: 6 }}>
                              {Math.round(upload.file.size / 1e6)} MB
                            </div>
                            <div className="progressTrack">
                              <div
                                className="progressFill"
                                data-done={upload.status === 'done'}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <p className="footnote" style={{ marginTop: 12 }}>
                    Keep this screen open until the last clip finishes. The render itself carries
                    on if you close the app.
                  </p>
                </div>
              )}

              {totalBytes > 0 && uploading.length > 0 && (
                <p className="footnote">
                  {Math.round(sentBytes / 1e6)} of {Math.round(totalBytes / 1e6)} MB sent
                </p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              {!isTalking && (
                <div>
                  <p className="sectionLabel" style={{ marginBottom: 12 }}>
                    How do you want to edit this?
                  </p>
                  <div className="segmented">
                    {(['custom', 'style'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="segment"
                        data-active={mode === option}
                        onClick={() => setMode(option)}
                      >
                        {option === 'custom' ? 'Custom' : 'Style'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!isTalking && mode === 'custom' && (
                <div>
                  <p className="sectionLabel" style={{ marginBottom: 12 }}>
                    Pacing
                  </p>
                  <div className="chipRow">
                    {PACINGS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="chip"
                        style={{ flex: 1, textTransform: 'capitalize' }}
                        data-active={pacing === option}
                        onClick={() => setPacing(option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                  <p className="footnote" style={{ marginTop: 8 }}>
                    {PACING_HELP[pacing]}
                  </p>
                </div>
              )}

              {!isTalking && mode === 'style' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {styles.length === 0 && (
                    <p className="meta">No styles available yet. Custom mode works today.</p>
                  )}
                  {styles.map((style, index) => (
                    <button
                      key={style.id}
                      type="button"
                      className="selectCard"
                      data-active={styleId === style.id}
                      onClick={() => setStyleId(style.id)}
                    >
                      <Thumb grade={gradeFor(index)} width={42} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="optionTitle" style={{ display: 'block' }}>
                          {style.name}
                        </span>
                        <span className="cardDesc" style={{ display: 'block', marginTop: 4 }}>
                          {style.description}
                        </span>
                        {style.usesFitInspoIntro && (
                          <span
                            className="linkAccent"
                            style={{ display: 'block', marginTop: 6 }}
                          >
                            Needs a few photos of the fit
                          </span>
                        )}
                        {style.usesInspirationOverlay && (
                          <span
                            className="linkAccent"
                            style={{ display: 'block', marginTop: 6 }}
                          >
                            Needs one inspiration photo
                          </span>
                        )}
                      </span>
                      <span className="selectRing" />
                    </button>
                  ))}

                  {selectedStyle?.usesInspirationOverlay && (
                    <label className="glass listCard" style={{ cursor: 'pointer' }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="listCardTitle">Inspiration photo</span>
                        <span className="meta" style={{ display: 'block' }}>
                          {inspirationFile?.name ?? 'Choose the photo this style composites in'}
                        </span>
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => setInspirationFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  )}

                  {selectedStyle?.usesFitInspoIntro && (
                    <label className="glass listCard" style={{ cursor: 'pointer' }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="listCardTitle">Fit photos</span>
                        <span className="meta" style={{ display: 'block' }}>
                          {fitPics.length > 0
                            ? `${fitPics.length} added, up to 4`
                            : 'People wearing the fit, shown over the opening seconds'}
                        </span>
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) =>
                          setFitPics((current) =>
                            [...current, ...Array.from(e.target.files ?? [])].slice(0, 4)
                          )
                        }
                      />
                    </label>
                  )}
                </div>
              )}

              <div>
                <div className="sectionLabelRow" style={{ marginBottom: 4 }}>
                  <span className="sectionLabel">Video length</span>
                  <span className="sliderValue">{lengthSeconds}s</span>
                </div>
                <input
                  type="range"
                  className="slider"
                  min={MIN_LENGTH_SECONDS}
                  max={MAX_LENGTH_SECONDS}
                  value={lengthSeconds}
                  aria-label="Video length in seconds"
                  onChange={(e) => setLengthSeconds(Number(e.target.value))}
                />
                <div className="sliderBounds">
                  <span>{MIN_LENGTH_SECONDS}s</span>
                  <span>{MAX_LENGTH_SECONDS}s</span>
                </div>
              </div>

              {!isTalking && (
                <>
                  <div>
                    <div className="sectionLabelRow" style={{ marginBottom: 4 }}>
                      <span className="sectionLabel">Variations</span>
                      <span className="sliderValue">{variations}</span>
                    </div>
                    <input
                      type="range"
                      className="slider"
                      min={1}
                      max={MAX_VARIATION_COUNT}
                      value={variations}
                      aria-label="How many variations to make"
                      onChange={(e) => setVariations(Number(e.target.value))}
                    />
                    <div className="sliderBounds">
                      <span>1</span>
                      <span>{MAX_VARIATION_COUNT}</span>
                    </div>
                  </div>

                  {footageSeconds > 0 && (
                    <div
                      className="panel"
                      data-tone={footageOk ? 'success' : 'warning'}
                      style={{ display: 'flex', gap: 10 }}
                    >
                      {footageOk ? <IconCheck size={16} /> : <IconWarning size={16} />}
                      <p className="panelText">
                        {footageOk
                          ? `${Math.round(footageSeconds)}s of footage covers ${variations} video${
                              variations === 1 ? '' : 's'
                            } at ${lengthSeconds}s.`
                          : `${Math.round(footageSeconds)}s of footage makes about ${supported} good variation${
                              supported === 1 ? '' : 's'
                            } at ${lengthSeconds}s. ${variations} needs roughly ${neededSeconds}s, so add more clips or drop to ${supported}.`}
                      </p>
                    </div>
                  )}
                </>
              )}

              <div>
                <div
                  className="glass"
                  style={{ display: 'flex', gap: 14, alignItems: 'center', padding: 16 }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>Sizing info</div>
                    <p className="cardDesc" style={{ marginTop: 4 }}>
                      Stamps your height, weight and size worn onto every cut.
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
                  <div style={{ marginTop: 14 }}>
                    <p className="sectionLabel" style={{ marginBottom: 10 }}>
                      Size worn
                    </p>
                    <div className="chipRow">
                      {SIZES.map((size) => (
                        <button
                          key={size}
                          type="button"
                          className="chip"
                          data-square="true"
                          data-active={sizeWorn === size}
                          onClick={() => setSizeWorn(size)}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                    {!profile.height && !profile.weight && (
                      <p className="footnote" style={{ marginTop: 8 }}>
                        Add your height and weight on Profile and they go on every video too.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 4 && (
            <CaptionEditor
              settings={captions}
              onChange={(patch) => setTweaked({ ...captions, ...patch })}
              hookText={hookText}
              onHookTextChange={setHookText}
              sizingText={sizingText}
              clip={done[0]?.file ?? uploads[0]?.file ?? null}
              clipLabel={uploads.length > 0 ? 'Frame from clip 1' : undefined}
              footer={
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    className="btn btnOutline btnFull btnSmall"
                    onClick={() => setTweaked(null)}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className="btn btnOutline btnFull btnSmall"
                    onClick={() => {
                      void fetch('/api/profile', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ captionSettings: captions }),
                      }).then(() => setSavedCaptions(captions));
                    }}
                  >
                    Save as default
                  </button>
                </div>
              }
            />
          )}

          {error && (
            <div className="panel" data-tone="failure">
              <p className="panelText">{error}</p>
            </div>
          )}

          {step === 4 && uploading.length > 0 && (
            <p className="footnote">
              Still sending {uploading.length} clip{uploading.length === 1 ? '' : 's'}. The button
              wakes up as soon as they land.
            </p>
          )}
        </div>
      </Screen>

      <footer className="flowFooter">
        <button
          type="button"
          className="btn btnFull"
          data-pill="true"
          disabled={!canContinue || submitting}
          onClick={() => (step === 4 ? submit() : setStep(step + 1))}
        >
          {footerLabel}
        </button>
      </footer>
    </AppFrame>
  );
}
