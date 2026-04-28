import { useEffect, useRef, useState } from 'react';
import type { TranscriptionContext } from '../../../common/config';
import { SlidersHorizontal } from 'lucide-react';
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
        className={`${styles.header} ${open ? styles.headerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="文字起こしコンテキスト（精度向上設定）"
      >
        <SlidersHorizontal strokeWidth={1.5} size={18} />
        {filled && <span className={styles.indicator} />}
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
              登場キャラ・固有名詞
            </label>
            <textarea
              id="ctx-chars"
              className={styles.fieldInput}
              rows={2}
              value={draft.characters}
              onChange={updateField('characters')}
              onBlur={flushOnBlur}
              placeholder="カンマ区切り"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="ctx-phrases">
              口癖・よく使う言葉
            </label>
            <input
              id="ctx-phrases"
              type="text"
              className={styles.fieldInput}
              value={draft.catchphrases}
              onChange={updateField('catchphrases')}
              onBlur={flushOnBlur}
              placeholder=""
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="ctx-notes">
              補足情報
            </label>
            <textarea
              id="ctx-notes"
              className={styles.fieldInput}
              rows={2}
              value={draft.notes}
              onChange={updateField('notes')}
              onBlur={flushOnBlur}
              placeholder=""
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
