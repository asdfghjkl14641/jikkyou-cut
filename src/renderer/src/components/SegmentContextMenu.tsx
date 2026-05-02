import { useEffect, useRef } from 'react';
import { Trash2, Edit2 } from 'lucide-react';
import styles from './SegmentContextMenu.module.css';

type Props = {
  // Viewport-relative position of the click that opened the menu.
  // The menu is positioned with `position: fixed` so coordinates are
  // viewport-space, not container-space.
  x: number;
  y: number;
  onDelete: () => void;
  onEditTitle: () => void;
  onClose: () => void;
};

export default function SegmentContextMenu({ x, y, onDelete, onEditTitle, onClose }: Props) {
  const menuRef = useRef<HTMLUListElement>(null);

  // Close on outside click + Escape. We listen on the document so any
  // click anywhere on the page (including inside an iframe-less app)
  // dismisses the menu.
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer the doc-click listener by one event so the click that
    // opened the menu doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handleDocClick);
    }, 0);
    document.addEventListener('keydown', handleKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <ul
      ref={menuRef}
      className={styles.menu}
      style={{ left: x, top: y }}
      role="menu"
    >
      <li role="menuitem" onClick={() => { onEditTitle(); onClose(); }} className={styles.item}>
        <Edit2 size={13} />
        <span>タイトル編集</span>
      </li>
      <li role="menuitem" onClick={() => { onDelete(); onClose(); }} className={`${styles.item} ${styles.itemDanger}`}>
        <Trash2 size={13} />
        <span>この区間を削除</span>
      </li>
    </ul>
  );
}
