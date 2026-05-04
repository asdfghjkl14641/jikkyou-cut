import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import styles from './CreatorPickerDialog.module.css';

// Display labels for the affiliation tags stored in DB. Order also drives
// the section ordering in the picker — most-active groups first.
const GROUP_LABELS: Record<string, string> = {
  nijisanji: 'にじさんじ',
  hololive: 'ホロライブ',
  vspo: 'ぶいすぽ',
  neoporte: 'ネオポルテ',
  streamer: 'ストリーマー',
};
const GROUP_ORDER = ['nijisanji', 'hololive', 'vspo', 'neoporte', 'streamer'];
const OTHER_GROUP_LABEL = 'その他';

type Creator = { name: string; group: string | null };

type Props = {
  // Initial selection. null = current value is "指定なし". Used to
  // highlight the active row when the dialog opens.
  current: { name: string; group: string } | null;
  onPick: (creator: { name: string; group: string } | null) => void;
  onClose: () => void;
};

export default function CreatorPickerDialog({ current, onPick, onClose }: Props) {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.api.dataCollection
      .listSeedCreators()
      .then((list) => {
        if (alive) setCreators(list);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc to close — same affordance as SegmentContextMenu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grouped = useMemo(() => {
    const filter = search.trim();
    const filtered = filter
      ? creators.filter((c) => c.name.includes(filter))
      : creators;
    const map = new Map<string | null, Creator[]>();
    for (const c of filtered) {
      const key = c.group ?? null;
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
    }
    // Stable section order via GROUP_ORDER, then "その他" (null group).
    const sections: Array<{ key: string | null; label: string; items: Creator[] }> = [];
    for (const g of GROUP_ORDER) {
      const items = map.get(g);
      if (items && items.length > 0) {
        sections.push({ key: g, label: GROUP_LABELS[g] ?? g, items });
      }
    }
    const otherItems = map.get(null);
    if (otherItems && otherItems.length > 0) {
      sections.push({ key: null, label: OTHER_GROUP_LABEL, items: otherItems });
    }
    return sections;
  }, [creators, search]);

  const isCurrentNone = current === null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>配信者を選択</span>
          <button type="button" className={styles.closeButton} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <input
          autoFocus
          type="text"
          className={styles.searchInput}
          placeholder="配信者名で絞り込み"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.list}>
          <button
            type="button"
            className={`${styles.row} ${styles.rowNone} ${isCurrentNone ? styles.rowActive : ''}`}
            onClick={() => onPick(null)}
          >
            指定なし
          </button>
          {loadError && (
            <div className={styles.loadError}>配信者リスト取得失敗: {loadError}</div>
          )}
          {!loadError && creators.length === 0 && (
            <div className={styles.empty}>配信者データなし(データ収集を有効化してください)</div>
          )}
          {grouped.map((section) => (
            <div key={section.key ?? 'other'} className={styles.section}>
              <div className={styles.sectionHeader}>{section.label}</div>
              {section.items.map((c) => {
                const isActive =
                  current != null && current.name === c.name;
                return (
                  <button
                    key={c.name}
                    type="button"
                    className={`${styles.row} ${isActive ? styles.rowActive : ''}`}
                    onClick={() =>
                      onPick({ name: c.name, group: c.group ?? 'other' })
                    }
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
