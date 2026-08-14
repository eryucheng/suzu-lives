import type { ReactNode } from 'react';
import styles from './ChatBubble.module.css';

export interface ChatBubbleProps {
  /** 消息归属：left 系统/对方，right 用户本人 */
  align?: 'left' | 'right';
  /** 头像（可选，推荐用 Avatar 组件） */
  avatar?: ReactNode;
  /** 顶部元信息（如角色名） */
  meta?: ReactNode;
  /** 时间戳。默认微信样式：消息上方居中独立一行 */
  time?: ReactNode;
  /** 时间戳改为气泡内右下角（另一种模式） */
  timeInline?: boolean;
  /** 正在生成：发光状态 */
  live?: boolean;
  /** 仅媒体（图片等）：去掉气泡底透明展示 */
  mediaOnly?: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * ChatBubble —— 聊天气泡。
 * left（对方）左上角切角、right（用户）右上角切角 + 紫色渐变。文本 pre-wrap 自动换行。
 * 时间戳默认居中显示在消息上方（微信风格）；timeInline 时改为气泡内右下角。
 */
export function ChatBubble({
  align = 'left',
  avatar,
  meta,
  time,
  timeInline = false,
  live = false,
  mediaOnly = false,
  children,
  className,
  style,
}: ChatBubbleProps) {
  const cls = [
    styles.message,
    align === 'right' && styles.user,
    live && styles.live,
    mediaOnly && styles.mediaOnly,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const row = (
    <>
      {avatar != null && <div className={styles.avatar}>{avatar}</div>}
      <div className={styles.bubble}>
        {meta != null && <div className={styles.meta}>{meta}</div>}
        <div className={styles.text}>{children}</div>
        {time != null && timeInline && (
          <div className={styles.time}>{time}</div>
        )}
      </div>
    </>
  );

  // 微信风格：时间戳作为独立居中行显示在消息上方
  if (time != null && !timeInline) {
    return (
      <div className={styles.wrap} style={style}>
        <div className={styles.timeline}>{time}</div>
        <div className={cls}>{row}</div>
      </div>
    );
  }

  return (
    <div className={cls} style={style}>
      {row}
    </div>
  );
}
