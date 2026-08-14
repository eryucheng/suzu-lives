import { useState } from 'react';
import styles from './ChatImage.module.css';

export interface ChatImageItem {
  /** 图片地址 */
  src: string;
  /** 名称（预览弹窗顶部 + 「跳转」回调传回） */
  name?: string;
  /** 跳转定位标记（跳转到图片所在位置时传回） */
  key?: string;
  /** 所在消息 id（跳转定位可选） */
  messageId?: string;
}

export interface ChatImageProps {
  /** 一张图片 */
  src: string;
  /** 替代文本 */
  alt?: string;
  /** 名称（弹窗顶部显示） */
  name?: string;
  /** 预览弹窗的图集（上一张/下一张导航），默认只含当前这张 */
  gallery?: ChatImageItem[];
  /** 弹窗底部「跳转到图片所在位置」回调 */
  onJump?: (item: ChatImageItem) => void;
  className?: string;
}

/**
 * ChatImage —— 聊天图片（250px 固定缩略预览 + 点击展开全屏预览弹窗）。
 * 缩略图 160×120 圆角，配 ChatBubble mediaOnly 使用。
 * 弹窗复刻 Suzu 图片预览：顶部名称 + 当前/总数，左右小箭头切换（支持图集），
 * 底部「跳转到图片所在位置」。gallery 缺省只含当前一张。
 */
export function ChatImage({
  src,
  alt = '',
  name,
  gallery,
  onJump,
  className,
}: ChatImageProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const items = gallery && gallery.length > 0
    ? gallery
    : [{ src, name, key: undefined, messageId: undefined }];

  const item = items[index] ?? items[0];
  const count = items.length;

  const handleOpen = () => {
    const start = gallery && gallery.length > 0
      ? Math.max(0, gallery.findIndex((g) => g.src === src))
      : 0;
    setIndex(start === -1 ? 0 : start);
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className={[styles.preview, className].filter(Boolean).join(' ')}
        onClick={handleOpen}
        aria-label="放大查看图片"
      >
        <img className={styles.image} src={src} alt={alt} loading="lazy" draggable={false} />
      </button>

      {open && (
        <div className={styles.overlay} onClick={() => setOpen(false)}>
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            onClick={(e) => e.stopPropagation()}
          >
            <header className={styles.dialogHead}>
              <div className={styles.dialogTitle}>
                <strong>{item?.name || '图片'}</strong>
                <span>{index + 1} / {count}</span>
              </div>
              <button
                type="button"
                className={styles.close}
                onClick={() => setOpen(false)}
                aria-label="关闭图片预览"
              >
                ×
              </button>
            </header>

            <div className={styles.stage}>
              <button
                type="button"
                className={styles.nav}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index <= 0}
                aria-label="上一张"
              >
                ‹
              </button>
              <img className={styles.dialogImg} src={item?.src} alt={alt} />
              <button
                type="button"
                className={styles.nav}
                onClick={() => setIndex((i) => Math.min(count - 1, i + 1))}
                disabled={index >= count - 1}
                aria-label="下一张"
              >
                ›
              </button>
            </div>

            <footer className={styles.dialogFoot}>
              <button
                type="button"
                className={styles.jump}
                onClick={() => onJump?.(item!)}
              >
                跳转到图片所在位置
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
