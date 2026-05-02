import React, { useMemo } from 'react';
import { X, MessageSquare, Sparkles, Scissors } from 'lucide-react';
import { ScoreSample, ChatMessage, CommentAnalysis } from '../../../common/types';
import { ReactionCategory, REACTION_KEYWORDS } from '../../../common/commentAnalysis/keywords';
import styles from './PeakDetailPanel.module.css';

type Props = {
  sample: ScoreSample | null;
  // Carries `buckets[]` so we can pull the messages that fell inside
  // [sample.timeSec, sample.timeSec + sample.windowSec). Keeping the full
  // analysis here lets us also show overall metadata if we want later.
  analysis: CommentAnalysis;
  onClose: () => void;
  onSetRange: (startSec: number, endSec: number) => void;
};

const CATEGORY_NAMES: Record<ReactionCategory, string> = {
  laugh: '笑い',
  surprise: '驚き',
  emotion: '感動',
  praise: '称賛',
  other: 'その他',
};

const CATEGORY_COLORS: Record<ReactionCategory, string> = {
  laugh: 'var(--reaction-laugh)',
  surprise: 'var(--reaction-surprise)',
  emotion: 'var(--reaction-emotion)',
  praise: 'var(--reaction-praise)',
  other: 'var(--reaction-other)',
};

const formatHMS = (totalSec: number): string => {
  const sec = Math.floor(totalSec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function PeakDetailPanel({ sample, analysis, onClose, onSetRange }: Props) {
  // Same window the rolling score covered. The "set range" button uses
  // these endpoints verbatim, and the comment list is the union of every
  // bucket that fell inside [startSec, endSec).
  const startSec = sample?.timeSec ?? 0;
  const endSec = sample ? startSec + sample.windowSec : 0;

  // Collect messages from every bucket whose start is within the
  // window. We avoid re-filtering by individual message timestamps —
  // bucketize already placed each message in exactly one bucket, so
  // walking `analysis.buckets` is enough.
  const messages = useMemo<ChatMessage[]>(() => {
    if (!sample) return [];
    const out: ChatMessage[] = [];
    for (const b of analysis.buckets) {
      if (b.timeSec < startSec) continue;
      if (b.timeSec >= endSec) break;
      // Buckets keep messages in insertion order — chat is already
      // monotonically increasing in time so this is a sorted-merge for
      // free.
      for (const msg of b.messages) out.push(msg);
    }
    return out;
  }, [sample, analysis.buckets, startSec, endSec]);

  if (!sample) return null;

  // Highlight keywords in chat messages
  const renderMessageText = (text: string) => {
    let result: React.ReactNode[] = [text];

    for (const { pattern, category } of REACTION_KEYWORDS) {
      const newResult: React.ReactNode[] = [];
      for (const node of result) {
        if (typeof node !== 'string') {
          newResult.push(node);
          continue;
        }

        const parts = node.split(new RegExp(`(${pattern})`, 'g'));
        parts.forEach((part, i) => {
          if (part.match(new RegExp(pattern))) {
            newResult.push(
              <span 
                key={`${pattern}-${i}`} 
                className={styles.keywordHighlight}
                style={{ backgroundColor: `${CATEGORY_COLORS[category]}33`, borderBottom: `1px solid ${CATEGORY_COLORS[category]}` }}
              >
                {part}
              </span>
            );
          } else if (part) {
            newResult.push(part);
          }
        });
      }
      result = newResult;
    }

    return result;
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <Sparkles className={styles.titleIcon} size={18} />
          <h3 className={styles.title}>{formatHMS(startSec)} 〜 {formatHMS(endSec)} のピーク詳細</h3>
        </div>
        <button className={styles.closeButton} onClick={onClose}>
          <X size={20} />
        </button>
      </div>

      <div className={styles.content}>
        {/* AI Summary Placeholder */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <Sparkles size={14} className={styles.sectionIcon} />
            <span className={styles.sectionTitle}>AI 要約</span>
          </div>
          <div className={styles.aiPlaceholder}>
            この区間のコメント要約は近日対応予定です
          </div>
        </section>

        {/* Category Breakdown */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>カテゴリ内訳</div>
          </div>
          <div className={styles.categoryGrid}>
            {(Object.keys(sample.categoryHits) as ReactionCategory[]).map(cat => {
              const val = sample.categoryHits[cat];
              if (val <= 0) return null;
              return (
                <div key={cat} className={styles.categoryBadge}>
                  <span className={styles.badgeDot} style={{ background: CATEGORY_COLORS[cat] }} />
                  <span className={styles.badgeLabel}>{CATEGORY_NAMES[cat]}</span>
                  <span className={styles.badgeCount}>{val}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Comment List */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <MessageSquare size={14} className={styles.sectionIcon} />
            <span className={styles.sectionTitle}>コメント一覧 ({messages.length}件)</span>
          </div>
          <div className={styles.messageList}>
            {messages.map((msg, i) => (
              <div key={i} className={styles.messageRow}>
                <span className={styles.msgTime}>{formatHMS(msg.timeSec)}</span>
                <span className={styles.msgAuthor}>{msg.author}:</span>
                <span className={styles.msgText}>{renderMessageText(msg.text)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className={styles.footer}>
        <button 
          className={styles.actionButton}
          onClick={() => onSetRange(startSec, endSec)}
        >
          <Scissors size={16} />
          <span>この区間を編集範囲に設定</span>
        </button>
      </div>
    </div>
  );
}
