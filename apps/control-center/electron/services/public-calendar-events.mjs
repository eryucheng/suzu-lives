// Public dates shown by the local calendar. Personal dates intentionally live
// elsewhere, under the selected Agent's private data directory.
//
// The statutory leave timetable is published yearly and is therefore kept as
// exact dates. Traditional festivals and solar terms come from a Chinese
// calendar implementation, not a short hand-written list of individual years.

import { Solar } from "lunar-typescript";

const STATUTORY_LUNAR_FESTIVALS = new Set(["除夕", "春节", "端午节", "中秋节"]);

const PUBLIC_EVENT_SEED = [
  // Fixed statutory holidays and widely used public observances.
  { id: "holiday-new-year", date: "01-01", name: "元旦", type: "法定节假日" },
  { id: "observance-womens-day", date: "03-08", name: "妇女节", type: "公共节日" },
  { id: "observance-arbor-day", date: "03-12", name: "植树节", type: "公共节日" },
  { id: "holiday-labour-day", date: "05-01", name: "劳动节", type: "法定节假日" },
  { id: "observance-youth-day", date: "05-04", name: "青年节", type: "公共节日" },
  { id: "observance-childrens-day", date: "06-01", name: "儿童节", type: "公共节日" },
  { id: "observance-party-founding-day", date: "07-01", name: "建党节", type: "公共节日" },
  { id: "observance-army-day", date: "08-01", name: "建军节", type: "公共节日" },
  { id: "observance-teachers-day", date: "09-10", name: "教师节", type: "公共节日" },
  { id: "holiday-national-day", date: "10-01", name: "国庆节", type: "法定节假日" },

  // 2026 State Council leave timetable (国办发明电〔2025〕7号).
  ...dateRange("2026-01-01", "2026-01-03", "holiday-2026-new-year-leave", "元旦假期", "放假"),
  single("2026-01-04", "holiday-2026-new-year-workday", "元旦调休上班", "调休上班"),
  single("2026-02-14", "holiday-2026-spring-festival-workday-before", "春节调休上班", "调休上班"),
  ...dateRange("2026-02-15", "2026-02-23", "holiday-2026-spring-festival-leave", "春节假期", "放假"),
  single("2026-02-28", "holiday-2026-spring-festival-workday-after", "春节调休上班", "调休上班"),
  ...dateRange("2026-04-04", "2026-04-06", "holiday-2026-qingming-leave", "清明节假期", "放假"),
  ...dateRange("2026-05-01", "2026-05-05", "holiday-2026-labour-day-leave", "劳动节假期", "放假"),
  single("2026-05-09", "holiday-2026-labour-day-workday", "劳动节调休上班", "调休上班"),
  ...dateRange("2026-06-19", "2026-06-21", "holiday-2026-dragon-boat-leave", "端午节假期", "放假"),
  single("2026-09-20", "holiday-2026-national-day-workday-before", "国庆节调休上班", "调休上班"),
  ...dateRange("2026-09-25", "2026-09-27", "holiday-2026-mid-autumn-leave", "中秋节假期", "放假"),
  ...dateRange("2026-10-01", "2026-10-07", "holiday-2026-national-day-leave", "国庆节假期", "放假"),
  single("2026-10-10", "holiday-2026-national-day-workday-after", "国庆节调休上班", "调休上班"),

];

function dateRange(from, to, idPrefix, name, type) {
  const values = [];
  const cursor = new Date(`${from}T12:00:00.000Z`);
  const last = new Date(`${to}T12:00:00.000Z`);
  for (let index = 1; cursor <= last; index += 1) {
    values.push(single(cursor.toISOString().slice(0, 10), `${idPrefix}-${index}`, name, type));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

function single(date, id, name, type) {
  return { id, date, name, type };
}

function calendarYear(value) {
  const year = Number(value);
  if (Number.isInteger(year) && year >= 1900 && year <= 2100) return year;
  return new Date().getFullYear();
}

function lunarFestivalEvents(year) {
  const events = [];
  for (let month = 1; month <= 12; month += 1) {
    const days = new Date(year, month, 0).getDate();
    for (let day = 1; day <= days; day += 1) {
      const solar = Solar.fromYmd(year, month, day);
      const lunar = solar.getLunar();
      const date = solar.toYmd();
      const festivals = [...new Set(lunar.getFestivals())];
      festivals.forEach((name, index) => {
        events.push(single(
          date,
          `lunar-festival-${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-${index + 1}`,
          name,
          STATUTORY_LUNAR_FESTIVALS.has(name) ? "法定节日" : "传统节日",
        ));
      });

      const solarTerm = lunar.getJieQi();
      if (solarTerm) {
        events.push(single(
          date,
          `solar-term-${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
          solarTerm,
          "二十四节气",
        ));
      }
    }
  }
  return events;
}

function seededEventsForYear(year) {
  return PUBLIC_EVENT_SEED.filter((event) => event.date.length === 5 || Number(event.date.slice(0, 4)) === year);
}

/**
 * Returns the built-in public dates for one Gregorian year. The selected year
 * is supplied by the visible calendar month, which keeps lunar dates accurate
 * when users browse forwards or backwards.
 */
export function publicCalendarEvents({ year = new Date().getFullYear() } = {}) {
  const selectedYear = calendarYear(year);
  return [...seededEventsForYear(selectedYear), ...lunarFestivalEvents(selectedYear)].map((event) => ({ ...event }));
}

// Preserve the old named export for code importing the default current-year
// calendar. Runtime callers that know their date use publicCalendarEvents().
export const PUBLIC_CALENDAR_EVENTS = Object.freeze(publicCalendarEvents().map((event) => Object.freeze({ ...event })));
