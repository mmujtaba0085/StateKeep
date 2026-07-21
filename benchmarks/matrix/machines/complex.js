// Media processing pipeline — deeply nested parallel inside parallel.
//
// Structure:
//   idle → processing (parallel) → done → idle
//
//   processing is parallel across 3 independent regions:
//     transcode (parallel inside parallel):
//       video: waiting → encoding → compressed(final)  | retrying
//       audio: waiting → normalizing → normalized(final) | retrying
//     thumbnail: waiting → generating → generated(final)  | retrying
//     metadata:  waiting → extracting → extracted(final)  | retrying
//
//   processing.onDone fires when all 4 leaf regions reach their final state.
//   A failed retry loop can continue indefinitely (no max-retry guard needed
//   in the benchmark — we only use the happy path).
export const def = {
  id: 'media-pipeline',
  initial: 'idle',
  states: {
    idle: { on: { UPLOAD: 'processing' } },
    processing: {
      type: 'parallel',
      onDone: 'done',
      states: {
        transcode: {
          type: 'parallel',
          states: {
            video: {
              initial: 'waiting',
              states: {
                waiting:    { on: { VIDEO_START: 'encoding'     } },
                encoding:   { on: { VIDEO_DONE:  'compressed', VIDEO_ERROR: 'retrying' } },
                retrying:   { on: { VIDEO_RETRY: 'encoding'     } },
                compressed: { type: 'final' },
              },
            },
            audio: {
              initial: 'waiting',
              states: {
                waiting:     { on: { AUDIO_START: 'normalizing'  } },
                normalizing: { on: { AUDIO_DONE:  'normalized', AUDIO_ERROR: 'retrying' } },
                retrying:    { on: { AUDIO_RETRY: 'normalizing'  } },
                normalized:  { type: 'final' },
              },
            },
          },
        },
        thumbnail: {
          initial: 'waiting',
          states: {
            waiting:    { on: { THUMB_START: 'generating'   } },
            generating: { on: { THUMB_DONE:  'generated', THUMB_ERROR: 'retrying' } },
            retrying:   { on: { THUMB_RETRY: 'generating'   } },
            generated:  { type: 'final' },
          },
        },
        metadata: {
          initial: 'waiting',
          states: {
            waiting:    { on: { META_START: 'extracting'   } },
            extracting: { on: { META_DONE:  'extracted', META_ERROR: 'retrying' } },
            retrying:   { on: { META_RETRY: 'extracting'   } },
            extracted:  { type: 'final' },
          },
        },
      },
    },
    done: { on: { RESET: 'idle' } },
  },
};

// Happy-path cycle — 10 events per cycle.
// After META_DONE the machine auto-transitions to done via processing.onDone,
// so RESET is always sent from the done state.
export const HAPPY_CYCLE = [
  'UPLOAD',
  'VIDEO_START', 'AUDIO_START', 'THUMB_START', 'META_START',
  'VIDEO_DONE',  'AUDIO_DONE',  'THUMB_DONE',  'META_DONE',
  'RESET',
];

// Region paths tracked by APV fingerprinting.
// Each maps to one entry in the region_fingerprints JSON blob.
export const REGIONS = [
  'processing.transcode.video',
  'processing.transcode.audio',
  'processing.thumbnail',
  'processing.metadata',
];
