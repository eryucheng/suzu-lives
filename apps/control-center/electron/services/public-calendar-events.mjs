// Public dates shown by the local calendar.  Personal dates intentionally live
// elsewhere, under the selected Agent's private data directory.
//
// 2026 leave and makeup-workday entries follow 国办发明电〔2025〕7号.  2027
// has not received its annual State Council timetable yet, so it contains only
// the statutory festival dates themselves -- never guessed leave ranges.

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

  // 2026 State Council leave timetable.
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

  // Traditional dates which vary with the lunar calendar.
  single("2026-02-17", "festival-2026-spring-festival", "春节", "法定节日"),
  single("2026-03-03", "festival-2026-lantern", "元宵节", "公共节日"),
  single("2026-06-19", "festival-2026-dragon-boat", "端午节", "法定节日"),
  single("2026-09-25", "festival-2026-mid-autumn", "中秋节", "法定节日"),
  single("2027-02-05", "festival-2027-new-years-eve", "除夕", "法定节日"),
  single("2027-02-06", "festival-2027-spring-festival", "春节", "法定节日"),
  single("2027-02-20", "festival-2027-lantern", "元宵节", "公共节日"),
  single("2027-04-05", "festival-2027-qingming", "清明节", "法定节日"),
  single("2027-06-09", "festival-2027-dragon-boat", "端午节", "法定节日"),
  single("2027-09-15", "festival-2027-mid-autumn", "中秋节", "法定节日"),
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

export const PUBLIC_CALENDAR_EVENTS = Object.freeze(PUBLIC_EVENT_SEED.map((event) => Object.freeze({ ...event })));

export function publicCalendarEvents() {
  return PUBLIC_CALENDAR_EVENTS.map((event) => ({ ...event }));
}
