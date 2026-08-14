import type { ReactNode } from 'react';
import styles from './Table.module.css';

export interface TableColumn<T> {
  key: keyof T & string;
  /** 列头文字 */
  label: ReactNode;
  /** 对齐，默认左 */
  align?: 'left' | 'right';
  /** 列宽（table-layout:fixed） */
  width?: string | number;
  /** 自定义单元格渲染 */
  render?: (row: T) => ReactNode;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  /** 斑马纹 */
  striped?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Table —— 数据表（移植自 .data-table）。
 * 固定布局、列头大写小字、单元格省略截断、末列可右对齐；窄容器横向滚动。
 * 数据为空时请用 Empty 组件展示空态。
 */
export function Table<T>({
  columns,
  data,
  striped = false,
  className,
  style,
}: TableProps<T>) {
  return (
    <div className={[styles.scroll, className].filter(Boolean).join(' ')} style={style}>
      <table className={[styles.table, striped && styles.striped].filter(Boolean).join(' ')}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={[
                  styles.header,
                  col.align === 'right' && styles['align-right'],
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  width: col.width != null ? col.width : undefined,
                  textAlign: col.align,
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className={styles.row}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={[
                    styles.cell,
                    col.align === 'right' && styles['align-right'],
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ textAlign: col.align }}
                >
                  {col.render ? col.render(row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
