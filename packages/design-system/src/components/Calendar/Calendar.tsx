import type { ReactNode } from 'react';
import styles from './Calendar.module.css';

export type EventKind = 'holiday' | 'personal';
/** dateKey 形如 'YYYY-MM-DD' */
export type CalendarEvents = Record<string, EventKind[]>;
export type CalendarLayout = 'content' | 'compact' | 'fill';

export interface CalendarProps {
  /** 显示年份，如 2026 */
  year: number;
  /** 月份 0-11（0 为 1 月） */
  month: number;
  /** 事件标记：dateKey -> 圆点种类数组 */
  events?: CalendarEvents;
  /** 当前选中日 dateKey */
  selected?: string;
  /** 选中回调 */
  onSelect?: (dateKey: string) => void;
  /** 上一月 / 下一月回调（展示态由外部控制） */
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  /** 回到今天回调 */
  onGoToday?: () => void;
  /** 标题右侧自定义操作 */
  controls?: ReactNode;
  /** 星期头文字，默认中文简写 */
  weekdayLabels?: string[];
  /**
   * 布局模式。fill 适用于父容器已有确定高度的场景：日历会撑满可用高度，
   * 每周日期行平分剩余空间；compact 使用固定的紧凑行高，适合仪表盘卡片。
   */
  layout?: CalendarLayout;
  className?: string;
}

/**
 * Calendar —— 月历（移植自 today-calendar）。7 列网格，含上/下月补白、
 * 今日强调色、选中渐变底、事件小圆点（holiday 黄 / personal 青）。
 * 月份与其显示完全由 year/month+onPrev/onNext 受控决定。
 */
export function Calendar({
  year,
  month,
  events = {},
  selected,
  onSelect,
  onPrevMonth,
  onNextMonth,
  onGoToday,
  controls,
  weekdayLabels = ['一', '二', '三', '四', '五', '六', '日'],
  layout = 'content',
  className,
}: CalendarProps) {
  const weekdays = weekdayLabels.length === 7 ? weekdayLabels : ['一', '二', '三', '四', '五', '六', '日'];

  // 本月第一天与总天数
  const firstDay = new Date(year, month, 1);
  // JS getDay(): 0=Sun..6=Sat；周一起始要转成 0=Mon
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const p2 = (n: number) => String(n).padStart(2, '0');

  const dateKey = (day: number) => `${year}-${p2(month + 1)}-${p2(day)}`;

  const cells: ReactNode[] = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push(<span key={`b${i}`} className={styles.blank} aria-hidden />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(day);
    const isToday = key === todayStr;
    const isSelected = key === selected;
    const dots = events[key] ?? [];
    const hasDots = dots.length > 0;
    cells.push(
      <button
        key={key}
        type="button"
        className={[
          styles.day,
          hasDots && styles.dayWithDots,
          isToday && styles.dayToday,
          isSelected && styles.daySelected,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onSelect?.(key)}
      >
        <span className={styles.dayNumber}>{day}</span>
        {hasDots && (
          <i className={styles.dots}>
            {dots.map((kind, j) => (
              <b
                key={j}
                className={[styles.dot, kind === 'holiday' && styles.dotHoliday]
                  .filter(Boolean)
                  .join(' ')}
              />
            ))}
          </i>
        )}
      </button>,
    );
  }

  const monthLabel = `${year} 年 ${month + 1} 月`;

  return (
    <div
      className={[
        styles.board,
        layout === 'compact' && styles['layout-compact'],
        layout === 'fill' && styles['layout-fill'],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.head}>
        <h4 className={styles.title}>{monthLabel}</h4>
        <div className={styles.controls}>
          {controls}
          <button
            type="button"
            className={styles.navButton}
            onClick={onPrevMonth}
            aria-label="上一月"
          >
            ‹
          </button>
          <button
            type="button"
            className={styles.todayButton}
            onClick={onGoToday}
          >
            今天
          </button>
          <button
            type="button"
            className={styles.navButton}
            onClick={onNextMonth}
            aria-label="下一月"
          >
            ›
          </button>
        </div>
      </div>
      <div className={styles.weekdays}>
        {weekdays.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div
        className={[
          styles.grid,
          layout === 'compact' && styles['grid-compact'],
          layout === 'fill' && styles['grid-fill'],
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {cells}
      </div>
    </div>
  );
}
