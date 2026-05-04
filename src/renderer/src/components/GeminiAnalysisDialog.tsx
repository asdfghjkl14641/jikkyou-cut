import { useState } from 'react';
import { X, Copy, Check, Sparkles } from 'lucide-react';
import type { GeminiAnalysisResult } from '../../../common/types';
import styles from './GeminiAnalysisDialog.module.css';

// Result modal for the "🧪 Gemini 分析(テスト)" button. Designed as
// throwaway-quality UI per Task 1 spec — Task 2 will replace it with
// integration into the existing clip-segment list. For debugging the
// raw JSON is one click away (clipboard copy).

const formatTime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const CONTENT_TYPE_LABEL: Record<string, string> = {
  laugh: '笑い',
  surprise: '驚き',
  reaction: 'リアクション',
  narrative: '物語',
  other: 'その他',
};

type Props = {
  result: GeminiAnalysisResult;
  onClose: () => void;
};

export default function GeminiAnalysisDialog({ result, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[gemini-dialog] clipboard write failed:', err);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>
            <Sparkles size={14} />
            <span>Gemini 分析結果</span>
            <span className={styles.subtitle}>
              ({Math.round(result.totalDurationSec)} 秒)
            </span>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className={styles.content}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              タイムライン要約 ({result.timelineSummary.length})
            </h3>
            {result.timelineSummary.length === 0 ? (
              <div className={styles.empty}>(なし)</div>
            ) : (
              <ul className={styles.timeline}>
                {result.timelineSummary.map((seg, i) => (
                  <li key={i} className={styles.timelineRow}>
                    <span className={styles.timeRange}>
                      {formatTime(seg.startSec)}–{formatTime(seg.endSec)}
                    </span>
                    <span className={styles.timelineDesc}>{seg.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              ハイライト候補 ({result.highlights.length})
            </h3>
            {result.highlights.length === 0 ? (
              <div className={styles.empty}>(なし — AI が候補を抽出できませんでした)</div>
            ) : (
              <ol className={styles.highlights}>
                {result.highlights.map((h, i) => (
                  <li key={i} className={styles.highlightRow}>
                    <div className={styles.highlightHeader}>
                      <span className={styles.highlightIndex}>{i + 1}</span>
                      <span className={styles.timeRange}>
                        {formatTime(h.startSec)}–{formatTime(h.endSec)}
                      </span>
                      <span className={styles.highlightCategory}>
                        [{CONTENT_TYPE_LABEL[h.contentType] ?? h.contentType}]
                      </span>
                      <span className={styles.highlightConfidence}>
                        {h.confidence.toFixed(2)}
                      </span>
                    </div>
                    <div className={styles.highlightReason}>{h.reason}</div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {result.transcriptHints && (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>transcript ヒント</h3>
              <pre className={styles.transcript}>{result.transcriptHints}</pre>
            </section>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.copyButton} onClick={handleCopyJson}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'コピー済み' : 'JSON をコピー'}
          </button>
          <button type="button" className={styles.closeButtonText} onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
