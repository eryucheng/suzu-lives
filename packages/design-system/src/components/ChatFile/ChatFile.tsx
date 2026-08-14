import styles from './ChatFile.module.css';

export interface ChatFileProps {
  /** 文件名 */
  name: string;
  /** 大小文案，如「1.2 MB」（展示用，不做换算） */
  size?: string;
  /** 类型文案，如「文档」「压缩包」 */
  label?: string;
  /** 点击回调（如下载） */
  onClick?: () => void;
  className?: string;
}

/**
 * ChatFile —— 文件消息卡片（移植自 .conversation-media--file）。
 * 图标 + 文件名 + 大小。图片请用 ChatImage + ChatBubble mediaOnly。
 */
export function ChatFile({
  name,
  size,
  label = '文件',
  onClick,
  className,
}: ChatFileProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={[styles.file, className].filter(Boolean).join(' ')}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onClick) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className={styles.fileRow}>
        <div className={styles.fileIcon}>
          <Icon />
        </div>
        <div className={styles.copy}>
          <span className={styles.kind}>{label}</span>
          <strong className={styles.name}>{name}</strong>
          {size != null && <span className={styles.size}>{size}</span>}
        </div>
      </div>
    </div>
  );
}

function Icon() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" aria-hidden="true">
      <path
        d="M3 1.5h6l4 4v9h-10v-13z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9 1.5v4h4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5.5 9h5M5.5 11.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
