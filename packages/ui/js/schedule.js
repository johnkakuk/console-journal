/* ==== schedule.js — Template repeat helpers ================================= */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_MAP = {
    sun: 0,
    sunday: 0,
    '0': 0,
    mon: 1,
    monday: 1,
    '1': 1,
    tue: 2,
    tuesday: 2,
    '2': 2,
    wed: 3,
    wednesday: 3,
    '3': 3,
    thu: 4,
    thursday: 4,
    '4': 4,
    fri: 5,
    friday: 5,
    '5': 5,
    sat: 6,
    saturday: 6,
    '6': 6
};

const DAY_MS = 86400000;

export const TEMPLATE_SCHEDULE_PRIORITY = ['year', 'month', 'week', 'day'];
export const TEMPLATE_SCHEDULE_WEIGHT = { year: 3, month: 2, week: 1, day: 0 };

export function cloneTemplateSchedule(schedule) {
    if (!schedule) return null;
    return JSON.parse(JSON.stringify(schedule));
}

export function isISODate(value) {
    return typeof value === 'string' && ISO_DATE_RE.test(value);
}

function isoToday() {
    return new Date().toISOString().slice(0, 10);
}

function toPositiveInt(value) {
    if (value === '' || value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const int = Math.floor(num);
    return int >= 1 ? int : null;
}

function normalizeWeekday(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isInteger(value)) {
        return ((value % 7) + 7) % 7;
    }
    const str = String(value).trim().toLowerCase();
    if (!str) return null;
    if (WEEKDAY_MAP.hasOwnProperty(str)) return WEEKDAY_MAP[str];
    if (/^[0-6]$/.test(str)) return Number(str);
    if (str.length === 1) {
        // Allow single-letter abbreviations when unambiguous
        if (str === 'm') return 1;
        if (str === 't') return 2;
        if (str === 'w') return 3;
        if (str === 'r') return 4; // Thursday
        if (str === 'f') return 5;
        if (str === 's') return 6;
    }
    return null;
}

function normalizeWeekdayList(values) {
    if (values === null || values === undefined) return [];
    const arr = Array.isArray(values) ? values : [values];
    const out = [];
    for (const v of arr) {
        const n = normalizeWeekday(v);
        if (n !== null) out.push(n);
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
}

function isSectionEnabled(section) {
    if (!section || typeof section !== 'object') return false;
    if (typeof section.enabled === 'boolean') return section.enabled;
    // Backwards compatibility: assume enabled if useful properties exist
    const keys = Object.keys(section);
    return keys.length > 0;
}

export function normalizeTemplateSchedule(raw, { defaultAnchorDate } = {}) {
    if (!raw || typeof raw !== 'object') return null;

    const anchorCandidate =
        typeof raw.anchorDate === 'string' ? raw.anchorDate :
        typeof raw.anchor === 'string' ? raw.anchor :
        null;
    const fallbackAnchor = isISODate(defaultAnchorDate) ? defaultAnchorDate : isoToday();
    const anchorDate = isISODate(anchorCandidate) ? anchorCandidate : fallbackAnchor;

    const candidate = {};
    let candidateAnchor = anchorDate;

    const daySection = raw.day;
    if (isSectionEnabled(daySection)) {
        const interval = toPositiveInt(
            daySection?.interval ?? daySection?.every ?? daySection?.value ?? daySection
        );
        if (interval) {
            candidate.day = { interval };
        }
    }

    const weekSection = raw.week;
    if (isSectionEnabled(weekSection)) {
        const interval = toPositiveInt(
            weekSection?.interval ?? weekSection?.every ?? weekSection?.value
        );
        const weekdays = normalizeWeekdayList(weekSection?.weekdays ?? weekSection?.days ?? weekSection?.day);
        if (interval && weekdays.length) {
            candidate.week = { interval, weekdays };
        }
    }

    const monthSection = raw.month;
    if (isSectionEnabled(monthSection)) {
        const interval = toPositiveInt(
            monthSection?.interval ?? monthSection?.every ?? monthSection?.value
        );
        const modeRaw = String(monthSection?.mode || '').toLowerCase();
        const mode = modeRaw === 'weekday' ? 'weekday' : 'day';
        if (interval) {
            if (mode === 'day') {
                const dayValue = toPositiveInt(monthSection?.day ?? monthSection?.value ?? monthSection?.number);
                if (dayValue) {
                    candidate.month = {
                        interval,
                        mode: 'day',
                        day: Math.min(Math.max(dayValue, 1), 31)
                    };
                }
            } else {
                const rawNth = monthSection?.nth ?? monthSection?.value ?? monthSection?.number;
                let nthValue = null;
                if (typeof rawNth === 'string') {
                    const trimmed = rawNth.trim().toLowerCase();
                    if (trimmed === 'last') {
                        nthValue = 'last';
                    } else {
                        const n = toPositiveInt(trimmed);
                        if (n) nthValue = Math.min(Math.max(n, 1), 4);
                    }
                } else {
                    const n = toPositiveInt(rawNth);
                    if (n) nthValue = Math.min(Math.max(n, 1), 4);
                }
                const weekdayValue = normalizeWeekday(monthSection?.weekday ?? monthSection?.day ?? monthSection?.weekdayIndex);
                if (nthValue && weekdayValue !== null) {
                    candidate.month = {
                        interval,
                        mode: 'weekday',
                        weekday: weekdayValue,
                        nth: nthValue
                    };
                }
            }
        }
    }

    const yearSection = raw.year;
    if (isSectionEnabled(yearSection)) {
        const interval = toPositiveInt(yearSection?.interval ?? yearSection?.every ?? yearSection?.value);
        const dateValue = typeof yearSection?.date === 'string'
            ? yearSection.date
            : typeof yearSection?.startDate === 'string'
                ? yearSection.startDate
                : null;
        if (interval && isISODate(dateValue)) {
            candidate.year = {
                interval,
                monthDay: dateValue.slice(5),
                startDate: dateValue
            };
            candidateAnchor = dateValue;
        }
    }

    const priorityOrder = ['year', 'month', 'week', 'day'];
    let chosenLevel = null;
    for (const level of priorityOrder) {
        if (candidate[level]) {
            chosenLevel = level;
            break;
        }
    }

    if (!chosenLevel) return null;

    const schedule = {
        version: 1,
        anchorDate: candidateAnchor,
        [chosenLevel]: candidate[chosenLevel]
    };

    return schedule;
}

export function parseTemplateSchedule(raw, options = {}) {
    if (!raw) return null;
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    return normalizeTemplateSchedule(parsed, options);
}

function parseISODate(dateStr) {
    if (!isISODate(dateStr)) return null;
    const dt = new Date(dateStr + 'T00:00:00Z');
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function diffDays(start, end) {
    return Math.floor((end.getTime() - start.getTime()) / DAY_MS);
}

function diffMonths(anchor, target) {
    return (target.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (target.getUTCMonth() - anchor.getUTCMonth());
}

function getDaysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function getNthWeekdayOfMonth(year, monthIndex, weekday, nth) {
    const dim = getDaysInMonth(year, monthIndex);
    if (nth === 'last') {
        const lastOfMonth = new Date(Date.UTC(year, monthIndex, dim));
        const lastWeekday = lastOfMonth.getUTCDay();
        const offset = (lastWeekday - weekday + 7) % 7;
        return dim - offset;
    }
    const n = Number(nth);
    if (!Number.isFinite(n) || n <= 0) return null;
    const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1));
    const firstWeekday = firstOfMonth.getUTCDay();
    const delta = (weekday - firstWeekday + 7) % 7;
    const date = 1 + delta + (n - 1) * 7;
    if (date > dim) return null;
    return date;
}

function matchesDay(rule, target, anchor) {
    const days = diffDays(anchor, target);
    if (days < 0) return false;
    return days % rule.interval === 0;
}

function matchesWeek(rule, target, anchor) {
    const days = diffDays(anchor, target);
    if (days < 0) return false;
    const weeks = Math.floor(days / 7);
    if (weeks % rule.interval !== 0) return false;
    const weekday = target.getUTCDay();
    return rule.weekdays.includes(weekday);
}

function matchesMonth(rule, target, anchor) {
    const months = diffMonths(anchor, target);
    if (months < 0) return false;
    if (months % rule.interval !== 0) return false;
    const year = target.getUTCFullYear();
    const monthIdx = target.getUTCMonth();
    if (rule.mode === 'day') {
        const dim = getDaysInMonth(year, monthIdx);
        const targetDay = target.getUTCDate();
        const desired = Math.min(rule.day, dim);
        return targetDay === desired;
    }
    const nth = rule.nth;
    const weekday = rule.weekday;
    const date = getNthWeekdayOfMonth(year, monthIdx, weekday, nth);
    if (date === null) return false;
    return target.getUTCDate() === date;
}

function matchesYear(rule, target) {
    const targetMonthDay = `${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}`;
    if (targetMonthDay !== rule.monthDay) return false;
    const baseDate = parseISODate(rule.startDate);
    if (!baseDate) return false;
    const years = target.getUTCFullYear() - baseDate.getUTCFullYear();
    if (years < 0) return false;
    return years % rule.interval === 0;
}

export function matchTemplateSchedule(schedule, dateStr) {
    const normalized = normalizeTemplateSchedule(schedule, {
        defaultAnchorDate: schedule?.anchorDate
    });
    if (!normalized) return null;

    const target = parseISODate(dateStr);
    if (!target) return null;
    const anchor = parseISODate(normalized.anchorDate);
    if (!anchor) return null;

    if (normalized.year && matchesYear(normalized.year, target)) {
        return { level: 'year', schedule: normalized };
    }
    if (normalized.month && matchesMonth(normalized.month, target, anchor)) {
        return { level: 'month', schedule: normalized };
    }
    if (normalized.week && matchesWeek(normalized.week, target, anchor)) {
        return { level: 'week', schedule: normalized };
    }
    if (normalized.day && matchesDay(normalized.day, target, anchor)) {
        return { level: 'day', schedule: normalized };
    }
    return null;
}
