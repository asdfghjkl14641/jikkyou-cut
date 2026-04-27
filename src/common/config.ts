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
};

export const DEFAULT_CONFIG: AppConfig = {
  transcriptionContext: DEFAULT_CONTEXT,
};
