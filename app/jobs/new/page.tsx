'use client';

import { useEffect, useState } from 'react';
import { CaptionPreview, type CaptionBlock } from '@/components/CaptionPreview';
import { resolveCaptionSettings, type CaptionSettings } from '@/lib/render/captionSettings';
import { CAPTION_FONTS } from '@/lib/render/fonts';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { VideoTile } from '@/components/ui';
import { IconCheck, IconImage, IconUpload } from '@/components/icons';
import {
  MAX_LENGTH_SECONDS,
  MIN_CLIP_SECONDS,
  MIN_LENGTH_SECONDS,
  checkClipDurations,
  maxVariationsForFootage,
  recommendedFootageSeconds,
} from '@/lib/validation/job';

/**
 * The hook shown in the preview.
 *
 * A representative line rather than the creator's real hook, which does not
 * exist yet — the AI writes it during planning. Chosen to be long enough to
 * wrap onto a second line at the default size, so the preview shows how a real
 * hook behaves rather than flattering the layout with one short word.
 */
const PREVIEW_HOOK = 'POV: you finally found the perfect fit';

/** One labelled slider in the caption controls. */
function CaptionSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span className="label" style={{ margin: 0 }}>{label}</span>
        <span style={{ opacity: 0.7 }}>{format ? format(value) : Math.round(value)}</span>
      </div>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${((value - min) / (max - min)) * 100}%`, width: '100%' }}
      />
    </div>
  );
}

type Style = {
  id: string;
  name: string;
  description: string;
  usesInspirationOverlay: boolean;
  usesFitInspoIntro: boolean;
  /** The style's own caption look, previewed and applied when this style is picked. */
  captionSettings: Partial<CaptionSettings> | null;
};

/**
 * One Fit Inspo upload.
 *
 * Model shots only for now, per creator direction, so there is nothing to
 * classify or confirm — every upload is a person whose background gets removed.
 */
type FitPic = {
  file: File;
  previewUrl: string;
};


const PACINGS = ['slow', 'medium', 'fast'] as const;

/**
 * Cut lengths per preset, mirroring PACING_PRESET_SECONDS in the director.
 * Shown because "medium" means nothing on its own — the creator is choosing how
 * long each shot holds, and that is the number they actually care about.
 */
const PACING_HELP: Record<(typeof PACINGS)[number], string> = {
  slow: 'Each cut holds 4–7 seconds.',
  medium: 'Each cut holds 1.5–4 seconds.',
  fast: 'Each cut holds 1–2 seconds.',
};

/**
 * The playing length of a video File, read via a throwaway <video> element.
 * Resolves 0 on anything the browser can't decode, so a weird file never blocks
 * the footage hint.
 */
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

export default function NewJobPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'custom' | 'style'>('custom');
  /*
   * Which editor this job goes through.
   *
   * `cuts` re-sequences silent footage into several variations for the creator
   * to voice over; `talking` tightens one take of them speaking, keeps the
   * audio and burns captions. They share the upload and almost nothing else,
   * which is why the form hides most of its controls in talking mode rather
   * than offering settings that do not apply.
   */
  const [jobKind, setJobKind] = useState<'cuts' | 'talking'>('cuts');
  const isTalking = jobKind === 'talking';
  const [styles, setStyles] = useState<Style[]>([]);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [inspirationFile, setInspirationFile] = useState<File | null>(null);
  const [fitPics, setFitPics] = useState<FitPic[]>([]);

  const [files, setFiles] = useState<File[]>([]);
  /** Total seconds of raw footage selected, read from the files in the browser. */
  const [footageSeconds, setFootageSeconds] = useState(0);
  /** Names of clips dropped for being too short to cut from. */
  const [skippedShortClips, setSkippedShortClips] = useState<string[]>([]);
  const [productName, setProductName] = useState('');
  const [sizingOn, setSizingOn] = useState(false);
  const [sizeWorn, setSizeWorn] = useState('');
  const [lengthSeconds, setLengthSeconds] = useState<number>(30);
  const [pacing, setPacing] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [variationCount, setVariationCount] = useState(5);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /** Drives the upload progress bar: which stage, and how far through the bytes. */
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'creating'>('idle');
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalUploadBytes, setTotalUploadBytes] = useState(0);

  // The preview rail shows the sizing overlay exactly as the renderer will
  // build it, which means it needs the creator's stored measurements.
  const [profile, setProfile] = useState<{ height?: string; weight?: string }>({});
  /**
   * The caption look for this job.
   *
   * Seeded from the style (Style mode) or the creator's saved look (Custom
   * mode) whenever that source changes, unless the creator has already tweaked
   * something — `captionsTouched` is what stops switching style from silently
   * discarding their edits.
   */
  const [tweakedCaptions, setTweakedCaptions] = useState<CaptionSettings | null>(null);
  const [savedCaptions, setSavedCaptions] = useState<unknown>(null);
  const [savingCaptions, setSavingCaptions] = useState(false);
  const [captionsSavedAt, setCaptionsSavedAt] = useState<number | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<CaptionBlock>('hook');

  useEffect(() => {
    fetch('/api/styles')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Style[]) => setStyles(data))
      .catch(() => setStyles([]));

    fetch('/api/profile')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setProfile({ height: data.height ?? '', weight: data.weight ?? '' });
          setSavedCaptions(data.captionSettings ?? null);
        }
      })
      .catch(() => {});
  }, []);

  // Built the same way the director builds the real overlay — height, weight,
  // then size worn — so the preview shows a block of the right shape and length.
  const previewSizingText =
    [profile.height, profile.weight, sizeWorn ? `Size ${sizeWorn}` : '']
      .filter(Boolean)
      .join(', ') || 'Size M';

  const selectedStyle = styles.find((s) => s.id === selectedStyleId) ?? null;

  /*
   * Mirrors the renderer's layering, so what is drawn here is what will be
   * burned in: style look in Style mode, personal look in Custom mode.
   *
   * Derived during render rather than copied into state by an effect. The
   * effect version had to re-seed whenever the inherited look changed, which
   * meant either stamping on the creator's edits or serialising an object into
   * a dependency array to spot the change. Deriving makes "switching style
   * updates the preview, unless you have taken over" fall out for free.
   */
  const inheritedCaptions = mode === 'style' ? selectedStyle?.captionSettings : savedCaptions;
  const baseCaptions = resolveCaptionSettings(inheritedCaptions);
  const captions = tweakedCaptions ?? baseCaptions;
  const captionsTouched = tweakedCaptions !== null;

  /** Applies one caption change, taking over from the inherited look. */
  function tweakCaptions(patch: Partial<CaptionSettings>) {
    setTweakedCaptions((current) => ({ ...(current ?? baseCaptions), ...patch }));
  }
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  /** Adds Fit Inspo images, capped at what the intro can show legibly. */
  function addFitPics(files: File[]) {
    setFitPics((current) =>
      [...current, ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) }))].slice(0, 4)
    );
  }

  /**
   * Sets the clips and measures their combined duration in the browser, so the
   * "enough footage?" hint is instant and no upload is wasted on a job that
   * cannot make its variations.
   */
  function selectClips(selected: File[]) {
    Promise.all(selected.map(readVideoDuration)).then((durations) => {
      /*
       * Clips too short to cut from are dropped here, before they upload.
       *
       * A clip barely longer than one cut offers exactly one legal cut, so
       * every variation using it shows identical frames with nowhere to move
       * them. Every editing failure on record came from an upload that was
       * mostly clips like this, and each one cost three model calls and four
       * minutes before saying so. Dropping them at selection is the difference
       * between a job that cannot succeed and one that is never created.
       */
      const { tooShortIndexes } = checkClipDurations(durations);
      const keep = selected.filter((_, index) => !tooShortIndexes.includes(index));
      const keptDurations = durations.filter((_, index) => !tooShortIndexes.includes(index));

      setSkippedShortClips(tooShortIndexes.map((index) => selected[index].name));
      setFiles(keep);
      setFootageSeconds(keptDurations.reduce((sum, d) => sum + d, 0));
    });
  }



  const recommendedSeconds = recommendedFootageSeconds(lengthSeconds, variationCount);
  const footageShort =
    !isTalking && files.length > 0 && footageSeconds > 0 && footageSeconds < recommendedSeconds;
  /*
   * How many variations this upload can actually carry.
   *
   * The old hint only said "add more footage", which is easy to read past — a
   * creator asked for ten 30s videos from 40s of footage, waited four minutes,
   * and got a Zod rule name back. Naming the number their footage supports
   * turns the warning into a decision they can make in one tap.
   */
  const supportedVariations = maxVariationsForFootage(footageSeconds, lengthSeconds);

  const uploadPercent =
    totalUploadBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalUploadBytes) * 100)) : 0;
  const formatMb = (bytes: number) => Math.round(bytes / 1e6);

  /**
   * PUTs one file to R2, reporting bytes as they go.
   *
   * XMLHttpRequest rather than fetch: fetch cannot report *upload* progress at
   * all, which is why this screen used to sit silent for minutes on a phone
   * while 100MB+ of 4K footage went up with no sign it was working.
   */
  function putWithProgress(
    url: string,
    file: File,
    onProgress: (bytesSent: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`Upload of "${file.name}" failed (${xhr.status}).`));
      xhr.onerror = () => reject(new Error(`Upload of "${file.name}" failed. Check your connection.`));
      xhr.onabort = () => reject(new Error(`Upload of "${file.name}" was cancelled.`));
      xhr.send(file);
    });
  }

  async function uploadFile(
    file: File,
    onProgress: (bytesSent: number) => void = () => {}
  ): Promise<{ storageKey: string; originalFilename: string }> {
    const presignRes = await fetch('/api/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
    });
    if (!presignRes.ok) {
      throw new Error(`Failed to get an upload URL for "${file.name}".`);
    }
    const { url, storageKey } = await presignRes.json();

    await putWithProgress(url, file, onProgress);

    return { storageKey, originalFilename: file.name };
  }

  /**
   * Uploads with a ceiling on how many are in flight.
   *
   * Was strictly sequential, so three 130MB clips went up one after another on
   * a phone connection. Two at a time keeps the pipe busy while the request
   * bodies stay small enough not to stall a mobile uplink.
   */
  async function uploadAll(
    toUpload: File[],
    onProgress: (bytesSentPerFile: number[]) => void
  ): Promise<{ storageKey: string; originalFilename: string }[]> {
    const sent = new Array(toUpload.length).fill(0);
    const results = new Array<{ storageKey: string; originalFilename: string }>(toUpload.length);
    let next = 0;

    const workers = Array.from({ length: Math.min(2, toUpload.length) }, async () => {
      for (let index = next++; index < toUpload.length; index = next++) {
        results[index] = await uploadFile(toUpload[index], (bytes) => {
          sent[index] = bytes;
          onProgress([...sent]);
        });
        sent[index] = toUpload[index].size;
        onProgress([...sent]);
      }
    });

    await Promise.all(workers);
    return results;
  }

  async function handleSubmit() {
    setSubmitting(true);
    setErrors([]);

    // Inspiration photos are tiny next to video; counting them would make the
    // bar jump. They upload after, under the same "uploading" state.
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    setUploadedBytes(0);
    setTotalUploadBytes(totalBytes);
    setPhase('uploading');

    try {
      const clips = await uploadAll(files, (perFile) =>
        setUploadedBytes(perFile.reduce((a, b) => a + b, 0))
      );

      // Fit Inspo images ride the same presigned-upload path as the clips.
      const inspirationImages: { storageKey: string; kind: 'person' }[] = [];
      if (mode === 'style' && selectedStyle?.usesFitInspoIntro) {
        for (const pic of fitPics) {
          const uploaded = await uploadFile(pic.file);
          inspirationImages.push({ storageKey: uploaded.storageKey, kind: 'person' });
        }
      }

      let inspirationImage: { storageKey: string } | undefined;
      if (mode === 'style' && selectedStyle?.usesInspirationOverlay && inspirationFile) {
        const uploaded = await uploadFile(inspirationFile);
        inspirationImage = { storageKey: uploaded.storageKey };
      }

      setPhase('creating');

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
          variationCount: isTalking ? 1 : variationCount,
          // Only sent when the creator actually changed something, so an
          // untouched job keeps inheriting from its style or profile later
          // rather than freezing today's defaults into the row.
          captionSettings: captionsTouched ? captions : undefined,
          kind: jobKind,
          clips,
          inspirationImage,
          inspirationImages,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        setErrors(body.errors ?? [{ field: 'form', message: 'Something went wrong.' }]);
        setSubmitting(false);
        setPhase('idle');
        return;
      }

      const job = await res.json();
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setErrors([
        { field: 'form', message: err instanceof Error ? err.message : 'Something went wrong.' },
      ]);
      setSubmitting(false);
      setPhase('idle');
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
                {footageSeconds > 0 ? ` · ${Math.round(footageSeconds)}s` : ''}
              </span>
            )}
            {skippedShortClips.length > 0 && (
              <span
                className="pill"
                style={{ marginTop: 4, color: 'var(--status-failed)', borderColor: 'var(--status-failed)' }}
              >
                Skipped {skippedShortClips.length} clip
                {skippedShortClips.length === 1 ? '' : 's'} under {MIN_CLIP_SECONDS}s —
                too short to cut from. Record longer takes.
              </span>
            )}
            {footageShort && (
              <span
                className="pill"
                style={{ marginTop: 4, color: 'var(--status-queued)', borderColor: 'var(--status-queued)' }}
              >
                {Math.round(footageSeconds)}s of footage makes about {supportedVariations} good
                variation{supportedVariations === 1 ? '' : 's'} at {lengthSeconds}s — {variationCount} needs
                roughly {recommendedSeconds}s. Add clips, or drop to {supportedVariations}.
              </span>
            )}
            <input
              type="file"
              multiple
              accept="video/*"
              onChange={(e) => selectClips(Array.from(e.target.files ?? []))}
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
              <div className="labelRow">
                <span className="label" style={{ marginBottom: 0 }}>
                  Length
                </span>
                <span className="labelValue">{lengthSeconds}s</span>
              </div>
              <input
                type="range"
                className="slider"
                min={MIN_LENGTH_SECONDS}
                max={MAX_LENGTH_SECONDS}
                step={1}
                value={lengthSeconds}
                onChange={(e) => setLengthSeconds(Number(e.target.value))}
                aria-label="Video length in seconds"
              />
              <div className="sliderScale">
                <span>{MIN_LENGTH_SECONDS}s</span>
                <span>{MAX_LENGTH_SECONDS}s</span>
              </div>
              {errorFor('lengthSeconds') && (
                <p className="errorText">{errorFor('lengthSeconds')}</p>
              )}
            </div>

            <div className="formSection">
              <span className="label">What are you making?</span>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  type="button"
                  className="modeTab"
                  data-active={!isTalking}
                  onClick={() => setJobKind('cuts')}
                >
                  <div className="modeTabTitle">Silent cuts</div>
                  <div className="modeTabSub">You add a voiceover after</div>
                </button>
                <button
                  type="button"
                  className="modeTab"
                  data-active={isTalking}
                  onClick={() => setJobKind('talking')}
                >
                  <div className="modeTabTitle">Talking to camera</div>
                  <div className="modeTabSub">Keeps your audio, adds captions</div>
                </button>
              </div>
              {isTalking && (
                <p className="helper" style={{ marginTop: 10 }}>
                  Upload one take of yourself talking. Pauses and dead air get cut out, your
                  audio stays in sync, and captions are burned on automatically. One clean
                  edit — no variations, because the audio fixes the order of the cuts.
                </p>
              )}
            </div>

            <div className="formSection" style={{ display: isTalking ? 'none' : undefined }}>
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
                  <p className="helper">{PACING_HELP[pacing]}</p>
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

                  {selectedStyle?.usesFitInspoIntro && (
                    <div style={{ marginTop: 4 }}>
                      <label className="styleCard" style={{ cursor: 'pointer', alignItems: 'center' }}>
                        <span className="styleRadio" style={{ border: 'none', background: 'none' }}>
                          <IconImage size={18} />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className="styleName">Fit inspo images</span>
                          <span className="styleDesc" style={{ display: 'block' }}>
                            {fitPics.length > 0
                              ? `${fitPics.length} added — up to 4`
                              : 'Photos of people wearing the fit, shown over the opening seconds'}
                          </span>
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => addFitPics(Array.from(e.target.files ?? []))}
                          style={{ display: 'none' }}
                        />
                      </label>

                      {fitPics.length > 0 && (
                        <div className="fitPicList">
                          {fitPics.map((pic, index) => (
                            <div className="fitPicRow" key={`${pic.file.name}-${index}`}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={pic.previewUrl} alt="" className="fitPicThumb" />
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div className="jobTitle" style={{ fontSize: 13.5 }}>
                                  {pic.file.name}
                                </div>
                                <p className="helper" style={{ marginTop: 3 }}>
                                  Background removed, shown {(1.5 + index * 0.35).toFixed(2)}s-4s
                                </p>
                              </div>
                              <button
                                type="button"
                                className="btn btnGhost"
                                onClick={() =>
                                  setFitPics((current) => current.filter((_, i) => i !== index))
                                }
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {errorFor('inspirationImage') && (
                    <p className="errorText">{errorFor('inspirationImage')}</p>
                  )}
                </div>
              )}
            </div>

            {/* One take, one edit: the audio fixes the order of the cuts, so a
                second "variation" would be the same video or a broken one. */}
            <div className="formSection" style={{ display: isTalking ? 'none' : undefined }}>
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

          <section className="glass card" style={{ marginTop: 20 }}>
            <label className="label">On-screen text</label>
            <p className="helper" style={{ marginTop: 2 }}>
              Drag the text on the preview, or use the sliders. The hook shown here is an
              example — the AI writes the real one.
            </p>

            <div
              style={{
                display: 'flex',
                gap: 18,
                marginTop: 14,
                flexWrap: 'wrap',
                alignItems: 'flex-start',
              }}
            >
              <CaptionPreview
                settings={captions}
                hookText={PREVIEW_HOOK}
                sizingText={sizingOn ? previewSizingText : null}
                clip={files[0] ?? null}
                selected={selectedBlock}
                onSelect={setSelectedBlock}
                onMove={(block, x, y) =>
                  tweakCaptions(
                    block === 'hook' ? { hookX: x, hookY: y } : { sizingX: x, sizingY: y }
                  )
                }
              />

              <div style={{ flex: '1 1 260px', minWidth: 240 }}>
                <label className="label" htmlFor="captionFont">Font</label>
                <select
                  id="captionFont"
                  className="input"
                  value={captions.fontId}
                  onChange={(e) => tweakCaptions({ fontId: e.target.value as CaptionSettings['fontId'] })}
                >
                  {CAPTION_FONTS.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.label} — {font.description}
                    </option>
                  ))}
                </select>

                {/* Which block the sliders act on. The preview outlines it too. */}
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  {(['hook', 'sizing'] as CaptionBlock[]).map((block) => (
                    <button
                      key={block}
                      type="button"
                      className="btn"
                      data-active={selectedBlock === block}
                      disabled={block === 'sizing' && !sizingOn}
                      onClick={() => setSelectedBlock(block)}
                      style={{ flex: 1, opacity: block === 'sizing' && !sizingOn ? 0.45 : 1 }}
                    >
                      {block === 'hook' ? 'Hook text' : 'Sizing info'}
                    </button>
                  ))}
                </div>

                <CaptionSlider
                  label="Size"
                  value={selectedBlock === 'hook' ? captions.hookFontSize : captions.sizingFontSize}
                  min={selectedBlock === 'hook' ? 20 : 16}
                  max={selectedBlock === 'hook' ? 72 : 60}
                  step={1}
                  onChange={(value) =>
                    tweakCaptions(
                      selectedBlock === 'hook'
                        ? { hookFontSize: value }
                        : { sizingFontSize: value }
                    )
                  }
                />
                <CaptionSlider
                  label="Across"
                  value={selectedBlock === 'hook' ? captions.hookX : captions.sizingX}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(value) =>
                    tweakCaptions(selectedBlock === 'hook' ? { hookX: value } : { sizingX: value })
                  }
                />
                <CaptionSlider
                  label="Down"
                  value={selectedBlock === 'hook' ? captions.hookY : captions.sizingY}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(value) =>
                    tweakCaptions(selectedBlock === 'hook' ? { hookY: value } : { sizingY: value })
                  }
                />

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                  <label className="label" htmlFor="captionColor" style={{ margin: 0 }}>Colour</label>
                  <input
                    id="captionColor"
                    type="color"
                    value={captions.textColor}
                    onChange={(e) => tweakCaptions({ textColor: e.target.value.toUpperCase() })}
                    style={{ width: 44, height: 30, padding: 0, border: 'none', background: 'none' }}
                  />
                  {captionsTouched && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button type="button" className="btn" onClick={() => setTweakedCaptions(null)}>
                        Reset
                      </button>
                      {/* Saving is offered only in Custom mode: in Style mode the
                          look belongs to the style, and writing it to the profile
                          would have no effect on the job being created. */}
                      {mode === 'custom' && (
                        <button
                          type="button"
                          className="btn"
                          disabled={savingCaptions}
                          onClick={async () => {
                            setSavingCaptions(true);
                            try {
                              const res = await fetch('/api/profile', {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ captionSettings: captions }),
                              });
                              if (res.ok) {
                                setSavedCaptions(captions);
                                setCaptionsSavedAt(Date.now());
                              }
                            } finally {
                              setSavingCaptions(false);
                            }
                          }}
                        >
                          {savingCaptions ? 'Saving…' : 'Save as my default'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {captionsSavedAt !== null && (
                  <p className="helper" style={{ marginTop: 8 }}>
                    Saved. New Custom-mode videos will start from this look.
                  </p>
                )}
              </div>
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
              <SummaryRow label="Editor" value={isTalking ? 'Talking to camera' : 'Silent cuts'} />
              {!isTalking && (
                <SummaryRow label="Mode" value={mode === 'custom' ? 'Custom' : 'Style'} />
              )}
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
              {phase === 'uploading'
                ? `Uploading… ${uploadPercent}%`
                : phase === 'creating'
                  ? 'Starting…'
                  : 'Generate videos'}
            </button>

            {phase === 'uploading' && (
              /*
               * Phone footage is 100MB+ per clip, so this runs for minutes on a
               * mobile uplink. Showing real bytes is the difference between
               * "it's working" and "it's frozen".
               */
              <div style={{ marginTop: 12 }}>
                <div className="progressTrack">
                  <div className="progressFill" style={{ width: `${uploadPercent}%` }} />
                </div>
                <p className="helper" style={{ textAlign: 'center', marginTop: 6 }}>
                  {formatMb(uploadedBytes)} of {formatMb(totalUploadBytes)} MB
                  {files.length > 1 ? ` · ${files.length} clips` : ''}
                </p>
              </div>
            )}

            <p className="helper" style={{ textAlign: 'center' }}>
              {phase === 'uploading'
                ? 'Keep this tab open until the upload finishes.'
                : "Renders in the background. You'll see live progress."}
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
