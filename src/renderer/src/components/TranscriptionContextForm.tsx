import { useEffect, useRef, useState } from 'react';
import type { TranscriptionContext } from '../../../common/config';
import styles from './TranscriptionContextForm.module.css';

type Props = {
  initial: TranscriptionContext;
  onChange: (next: TranscriptionContext) => void;
};

const DEBOUNCE_MS = 500;

const isFilled = (ctx: TranscriptionContext): boolean =>
  Boolean(
    ctx.gameTitle.trim() ||
      ctx.characters.trim() ||
      ctx.catchphrases.trim() ||
      ctx.notes.trim(),
  );

export default function TranscriptionContextForm({ initial, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TranscriptionContext>(initial);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const updateField = (
    field: keyof TranscriptionContext,
  ) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next: TranscriptionContext = { ...draft, [field]: e.target.value };
      setDraft(next);
    };

  const flushOnBlur = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChangeRef.current(draft);
    }, DEBOUNCE_MS);
  };

  const filled = isFilled(draft);

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.headerLabel}>
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>
            ▶
          </span>
          📝 ゲーム情報を追加(精度向上)
          {filled && <span className={styles.badge}>入力済み</span>}
        </span>
      </button>

      {open && (
        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="ctx-game">
              ゲーム名
            </label>
            <input
              id="ctx-game"
              type="text"
              className={styles.fieldInput}
              value={draft.gameTitle}
              onChange={updateField('gameTitle')}
              onBlur={flushOnBlur}
              placeholder="例: プリンセスコネクト!Re:Dive"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="ctx-chars">
              登場するキャラ名・固有名詞
            </label>
            <textarea
              id="ctx-chars"
              className={styles.fieldInput}
              rows={2}
              value={draft.characters}
              onChange={updateField('characters')}
              onBlur={flushOnBlur}
              placeholder="例: ペコリーヌ、コッコロ、キャル(改行またはカンマ区切り)"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="ctx-phrases">
              配信者の口癖
            </label>
            <input
              id="ctx-phrases"
              type="text"
              className={styles.fieldInput}
              value={draft.catchphrases}
              onChange={updateField('catchphrases')}
              onBlur={flushOnBlur}
              placeholder="例: いやー、マジで、ありがとうございます"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="ctx-notes">
              その他の補足情報
            </label>
            <textarea
              id="ctx-notes"
              className={styles.fieldInput}
              rows={2}
              value={draft.notes}
              onChange={updateField('notes')}
              onBlur={flushOnBlur}
              placeholder="例: 第○話のクエスト周回中、声が小さい"
            />
          </div>

          <div className={styles.hint}>
            フォーカスを外すと自動保存されます。
          </div>
        </div>
      )}
    </div>
  );
}
