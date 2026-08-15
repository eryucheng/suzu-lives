import { useState } from 'react';
import styles from './ChatVoice.module.css';

/** 波形高度种子（%），循环取值 */
const BAR_HEIGHTS = [35, 62, 46, 84, 56, 92, 48, 74, 39, 66, 45, 78];

/** 语音条宽度随时长增长：线性映射后钳制在 [minW, maxW] */
const MIN_W = 170;
const MAX_W = 320;
function widthForSeconds(s: number) {
  return Math.min(MAX_W, Math.max(MIN_W, 150 + s * 2.2));
}

/* 波形数量：随条宽在 [BAR_MIN, BAR_MAX] 内插值，保持始终宽松、长短有差异但不挤密 */
const BAR_MIN = 14;
const BAR_MAX = 26;
function barsForWidth(w: number) {
  const t = (w - MIN_W) / (MAX_W - MIN_W); // 0~1
  return Math.round(BAR_MIN + (BAR_MAX - BAR_MIN) * t);
}

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function secondsOf(duration: number) {
  return Math.max(0, Math.round(duration));
}

export interface ChatVoiceProps {
  /** 时长（秒）。决定条宽与波形数量 */
  duration?: number;
  /** 播放进度 0-100；提供时受控 */
  progress?: number;
  /** 是否正在播放；提供时受控 */
  playing?: boolean;
  /** 点击播放 / 暂停回调 */
  onToggle?: (playing: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * ChatVoice —— 语音条气泡（移植自 .conversation-voice）。
 * 条宽与波形数量随时长变化；播放态由内部 state 驱动（或受控）。
 * 只做视觉展示，不接管真实音频播放——由业务方用 Audio 之类实现。
 */
export function ChatVoice({
  duration = 0,
  progress,
  playing,
  onToggle,
  className,
  style,
}: ChatVoiceProps) {
  const [innerPlaying, setInnerPlaying] = useState(false);
  const [innerProgress, setInnerProgress] = useState(0);

  const secs = secondsOf(duration);
  const isPlaying = playing !== undefined ? playing : innerPlaying;
  const pct = progress !== undefined ? progress : innerProgress;

  const width = widthForSeconds(secs);
  const bars = Array.from(
    { length: barsForWidth(width) },
    (_, i) => BAR_HEIGHTS[i % BAR_HEIGHTS.length],
  );

  const handleClick = () => {
    const next = !isPlaying;
    if (playing === undefined) {
      setInnerPlaying(next);
      // 播放时进度自动推进（模拟；真实播放由业务方实现）
      if (next) {
        const timer = setInterval(() => {
          setInnerProgress((p) => {
            if (p >= 100) {
              clearInterval(timer);
              setInnerPlaying(false);
              return 100;
            }
            return Math.min(100, p + 2);
          });
        }, 200);
        return;
      }
      setInnerProgress(0);
    }
    onToggle?.(next);
  };

  const cls = [styles.voice, isPlaying && styles.playing, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      style={{ ...style, width }}
    >
      <button
        type="button"
        className={styles.toggle}
        onClick={handleClick}
        aria-label={isPlaying ? '暂停' : '播放'}
      >
        <svg className={styles.toggleIcon} viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          {isPlaying ? (
            <>
              <rect x="3" y="2" width="3" height="10" rx="1" />
              <rect x="8" y="2" width="3" height="10" rx="1" />
            </>
          ) : (
            <path className={styles.iconPlay} d="M4 2.2v9.6a.5.5 0 0 0 .77.42l7.4-4.8a.5.5 0 0 0 0-.84l-7.4-4.8a.5.5 0 0 0-.77.42z" />
          )}
        </svg>
      </button>

      <div className={styles.content}>
        <div className={styles.wave}>
          {bars.map((h, i) => (
            <i
              key={i}
              className={styles.bar}
              style={{ ['--voice-bar-height' as string]: `${h}%` }}
            />
          ))}
        </div>
        <div className={styles.meta}>
          <div className={styles.progress}>
            <span className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.time}>{formatSeconds(secs)}</span>
        </div>
      </div>
    </div>
  );
}
