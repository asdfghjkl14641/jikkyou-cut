export type TranscriptionContext = {
  gameTitle: string;
  characters: string;
  catchphrases: string;
  notes: string;
};

export const DEFAULT_CONTEXT: TranscriptionContext = {
  gameTitle: '',
  characters: '',
  catchphrases: '',
  notes: '',
};

export type AppConfig = {
  transcriptionContext: TranscriptionContext;
  // Collaboration mode toggle. When true, transcription requests
  // diarization (speaker separation). Default `false` because most users
  // record solo gameplay commentary; flipping ON is a deliberate signal
  // that the source has multiple voices to label.
  collaborationMode: boolean;
  // Expected speaker count for diarization hint.
  //   `null`           → auto-detect (no `diarization_config` sent)
  //   2 / 3 / 4 / 5    → sent as `diarization_config.number_of_speakers`
  //   6                → sent as `diarization_config.min_speakers: 6`
  //                       (treated as the "6+" bucket — no upper bound)
  // Only consulted when `collaborationMode` is true.
  expectedSpeakerCount: number | null;
  // URL Download feature (yt-dlp)
  urlDownloadAccepted: boolean;
  defaultDownloadDir: string | null;
  defaultDownloadQuality: string;
};

export const DEFAULT_CONFIG: AppConfig = {
  transcriptionContext: DEFAULT_CONTEXT,
  collaborationMode: false,
  expectedSpeakerCount: null,
  urlDownloadAccepted: false,
  defaultDownloadDir: null,
  defaultDownloadQuality: 'best',
};
