import { useState } from 'react';
import styles from './ChatComposer.module.css';

export interface ChatComposerProps {
  /** 占位文案 */
  placeholder?: string;
  /** 发送回调，回传输入的文本。组件不管理数据流，由调用方决定受控与否。 */
  onSend?: (text: string) => void;
  /** 禁用（对应真实软件的「发送中 / 未就绪」态：表情与发送按钮禁用） */
  disabled?: boolean;
  /** 最大字符数 */
  maxLength?: number;
  /** 替换默认工具行左侧的图标（默认内置 表情/附件/文件/截图/语音输入 线条图标） */
  tools?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * ChatComposer —— 消息输入框（忠实移植 .conversation-composer）。
 * 表面嵌套 textarea（Enter 发送、Shift/Ctrl+Enter 换行）+ 工具行（线条图标）+ 绿色发送按钮。
 * tools 缺省渲染与 Suzu 一致的基础图标；disabled 时表情与发送禁用（静态工具图标常显不可点）。
 */
export function ChatComposer({
  placeholder = '输入消息（Enter 发送；Shift+Enter 换行）',
  onSend,
  disabled = false,
  maxLength = 20000,
  tools,
  className,
  style,
}: ChatComposerProps) {
  const [value, setValue] = useState('');

  const canSend = !disabled && value.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    onSend?.(value.trim());
    setValue('');
  };

  return (
    <div className={[styles.composer, className].filter(Boolean).join(' ')} style={style}>
      <div className={styles.surface}>
        <textarea
          className={styles.textarea}
          value={value}
          rows={3}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送，Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <div className={styles.footer}>
          <div className={styles.tools} aria-label="聊天工具">
            {tools ?? (
              <>
                <button
                  type="button"
                  className={styles.tool}
                  aria-label="表情"
                  title="表情"
                  disabled={disabled}
                >
                  <EmojiIcon />
                </button>
                <span className={styles.staticTool} title="附件" aria-hidden="true"><BoxIcon /></span>
                <span className={styles.staticTool} title="文件" aria-hidden="true"><FolderIcon /></span>
                <span className={styles.staticTool} title="截图" aria-hidden="true"><ScissorsIcon /></span>
                <span className={styles.staticTool} title="语音输入" aria-hidden="true"><MicIcon /></span>
              </>
            )}
          </div>
          <div className={styles.submitArea}>
            <span className={styles.staticTool} title="语音消息" aria-hidden="true"><SoundIcon /></span>
            <button
              type="button"
              className={styles.sendButton}
              onClick={handleSend}
              disabled={!canSend}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type IconProps = { className?: string };
const iconStyle = { display: 'block', width: 21, height: 21 } as const;

const baseIcon = (cls: string, body: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className={cls} style={iconStyle} aria-hidden="true">
    {body}
  </svg>
);

function EmojiIcon({ className }: IconProps) {
  return baseIcon(className, (
    <>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M8.4 14.2c.9 1.2 2.1 1.8 3.6 1.8s2.7-.6 3.6-1.8M9 9.5h.01M15 9.5h.01" />
    </>
  ));
}
function BoxIcon({ className }: IconProps) {
  return baseIcon(className, (
    <>
      <path d="m12 3 8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z" />
      <path d="m4 7.4 8 4.4 8-4.4M12 11.8V21" />
    </>
  ));
}
function FolderIcon({ className }: IconProps) {
  return baseIcon(className, (
    <path d="M3.5 7.2h6l1.9 2h9.1v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z" />
  ));
}
function ScissorsIcon({ className }: IconProps) {
  return baseIcon(className, (
    <>
      <circle cx="6.4" cy="17.2" r="2.2" />
      <circle cx="6.4" cy="6.8" r="2.2" />
      <path d="m8.2 8.2 10.3 7.1M8.2 15.8l4-2.8" />
    </>
  ));
}
function MicIcon({ className }: IconProps) {
  return baseIcon(className, (
    <>
      <rect x="8.5" y="3" width="7" height="12" rx="3.5" />
      <path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7V21M8.5 21h7" />
    </>
  ));
}
function SoundIcon({ className }: IconProps) {
  return baseIcon(className, (
    <>
      <path d="M4 14h3.2L12 18V6L7.2 10H4v4Z" />
      <path d="M15 9.2a4.2 4.2 0 0 1 0 5.6M17.8 6.4a8.1 8.1 0 0 1 0 11.2" />
    </>
  ));
}
