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
};

export const DEFAULT_CONFIG: AppConfig = {
  transcriptionContext: DEFAULT_CONTEXT,
  collaborationMode: false,
};
