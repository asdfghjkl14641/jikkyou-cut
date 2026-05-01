import React, { useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import type { SubtitleStyle } from '../../../common/types';
import styles from './SubtitleOverlay.module.css';

function subtitleTextStyle(style: SubtitleStyle): React.CSSProperties {
  return {
    fontFamily: `"${style.fontFamily}", sans-serif`,
    fontSize: `${style.fontSize / 2}px`,  // Scale down to 50% for preview
    color: style.textColor,
    WebkitTextStroke: style.outlineWidth > 0 
      ? `${style.outlineWidth / 2}px ${style.outlineColor}` 
      : 'none',
    textShadow: style.shadow.enabled
      ? `${style.shadow.offsetPx / 2}px ${style.shadow.offsetPx / 2}px 0 ${style.shadow.color}`
      : 'none',
    fontWeight: 'bold',
    paintOrder: 'stroke fill',
  };
}

function overlayPositionStyle(position: 'top' | 'middle' | 'bottom'): React.CSSProperties {
  switch (position) {
    case 'top': return { top: '8%' };
    case 'middle': return { top: '50%', transform: 'translate(-50%, -50%)' };
    case 'bottom': return { bottom: '12%' };
    default: return { bottom: '12%' };
  }
}

const SubtitleOverlay: React.FC = () => {
  const currentSec = useEditorStore((s) => s.currentSec);
  const cues = useEditorStore((s) => s.cues);
  const subtitleSettings = useEditorStore((s) => s.subtitleSettings);
  
  if (!subtitleSettings?.enabled) return null;
  
  // Find the cue that is currently playing
  const currentCue = cues.find(c => 
    !c.deleted &&
    c.showSubtitle &&
    currentSec >= c.startSec && 
    currentSec < c.endSec
  );
  
  if (!currentCue) return null;
  
  const activeStyle = subtitleSettings.styles.find(
    s => s.id === subtitleSettings.activeStyleId
  );
  if (!activeStyle) return null;
  
  return (
    <div 
      className={styles.overlay} 
      style={overlayPositionStyle(activeStyle.position)}
    >
      <span 
        className={styles.subtitleText} 
        style={subtitleTextStyle(activeStyle)}
      >
        {currentCue.text}
      </span>
    </div>
  );
};

export default SubtitleOverlay;
