import { detectSpeechRuns, mergeShortGaps, padRuns } from '@/lib/pipeline/speech';
async function main() {
  const file = process.argv[2];
  for (const floor of [-35, -30, -25, -20]) {
    const { runs, durationSeconds } = await detectSpeechRuns(file, { noiseFloorDb: floor });
    const merged = padRuns(mergeShortGaps(runs, 0.35), 0.08, durationSeconds);
    const kept = merged.reduce((t,r)=>t+(r.endSeconds-r.startSeconds),0);
    console.log(`floor ${floor}dB: ${runs.length} raw runs -> ${merged.length} after merge, keeps ${kept.toFixed(1)}s of ${durationSeconds.toFixed(1)}s (cuts ${(durationSeconds-kept).toFixed(1)}s)`);
  }
  process.exit(0);
}
main().catch((e)=>{console.error(e);process.exit(1);});
