'use strict';

// All calculations use the proleptic Gregorian calendar. Public years use the
// historical convention (there is no year zero); the coordinate uses year zero
// for 1 BCE so that moving across the era boundary stays continuous.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_YEAR = 999999;

function astronomicalYear(year) {
  return year < 0 ? year + 1 : year;
}

function daysInMonth(year, month) {
  const astronomical = astronomicalYear(year);
  if (month === 2) {
    return astronomical % 4 === 0 && (astronomical % 100 !== 0 || astronomical % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseHistoricalDate(input) {
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new Error('A date must be a year or date written as text, such as "44 BCE" or "2024-03-15".');
  }
  if (typeof input === 'number' && (!Number.isFinite(input) || !Number.isInteger(input))) {
    throw new Error('A numeric year must be a finite whole number.');
  }

  let text = String(input).trim();
  if (!text) throw new Error('A date cannot be empty.');
  const approximation = /^(?:circa\s+|c\.\s*|c\s+|~\s*)/i.exec(text);
  const approximate = Boolean(approximation);
  if (approximation) text = text.slice(approximation[0].length).trim();

  // A leading AD/CE is conventional, so allow it as well as a trailing era.
  let era = null;
  const prefix = /^(BCE|BC|CE|AD)\s+/i.exec(text);
  if (prefix) {
    era = prefix[1].toUpperCase();
    text = text.slice(prefix[0].length).trim();
  }
  const suffix = /\s*(BCE|BC|CE|AD)$/i.exec(text);
  if (suffix) {
    if (era) throw new Error('Specify the BCE or CE era only once.');
    era = suffix[1].toUpperCase();
    text = text.slice(0, suffix.index).trim();
  }

  const century = /^(\d{1,4})(?:st|nd|rd|th)?\s+century$/i.exec(text);
  if (century) {
    const number = Number(century[1]);
    if (number < 1 || number * 100 > MAX_YEAR) throw new Error('Use a century from 1 to 9999.');
    const bce = era === 'BCE' || era === 'BC';
    const year = bce ? -number * 100 : (number - 1) * 100 + 1;
    const lastYear = bce ? -((number - 1) * 100 + 1) : number * 100;
    const suffix = number % 100 >= 11 && number % 100 <= 13 ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'}[number % 10] || 'th');
    const name = `${approximate ? 'c. ' : ''}${number}${suffix} century`;
    return { year, month: null, day: null, precision: 'century', approximate,
      sortValue: astronomicalYear(year), upperBound: astronomicalYear(lastYear) + 1,
      label: `${name} ${bce ? 'BCE' : 'CE'}`, canonical: `${name}${bce ? ' BCE' : ''}` };
  }

  const decade = /^(\d{1,6})s$/i.exec(text);
  if (decade) {
    const base = Number(decade[1]);
    if (base % 10 !== 0 || base + 9 > MAX_YEAR) throw new Error('A decade must begin with a multiple of ten, such as 1930s.');
    const bce = era === 'BCE' || era === 'BC';
    // BCE decades run backwards: 40s BCE covers 49 BCE through 40 BCE.
    const year = bce ? -(base + 9) : Math.max(1, base);
    const lastYear = bce ? -Math.max(1, base) : base + 9;
    const prefix = approximate ? 'c. ' : '';
    return { year, month: null, day: null, precision: 'decade', approximate,
      sortValue: astronomicalYear(year), upperBound: astronomicalYear(lastYear) + 1,
      label: `${prefix}${base}s ${bce ? 'BCE' : 'CE'}`,
      canonical: `${prefix}${base}s${bce ? ' BCE' : ''}` };
  }

  const match = /^([+-]?\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(text);
  if (!match) {
    throw new Error('Use a century (19th century), decade (1930s), year, YYYY-MM, or YYYY-MM-DD, optionally followed by BCE or CE (years up to 999999).');
  }
  let year = Number(match[1]);
  if (year === 0) throw new Error('There is no historical year 0. Use 1 BCE or 1 CE.');
  if (Math.abs(year) > MAX_YEAR) throw new Error('The year must be between 999999 BCE and 999999 CE.');
  if (era) {
    const bce = era === 'BCE' || era === 'BC';
    if (year < 0 && !bce) throw new Error('A negative year denotes BCE and cannot have a CE or AD suffix.');
    if (match[1].startsWith('+') && bce) throw new Error('A positive year sign denotes CE and cannot have a BCE or BC suffix.');
    year = bce ? -Math.abs(year) : year;
  }

  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (month !== null && (month < 1 || month > 12)) throw new Error('The month must be between 01 and 12.');
  if (day !== null && (day < 1 || day > daysInMonth(year, month))) {
    throw new Error(`The day must be between 01 and ${daysInMonth(year, month)} for that month and year.`);
  }
  const precision = day !== null ? 'day' : month !== null ? 'month' : 'year';
  const monthFraction = month === null ? 0 : month - 1
    + (day === null ? 0 : (day - 1) / daysInMonth(year, month));
  const sortValue = astronomicalYear(year) + monthFraction / 12;
  const yearLabel = `${Math.abs(year)}${year < 0 ? ' BCE' : ' CE'}`;
  const detailLabel = day !== null ? `${day} ${MONTH_NAMES[month - 1]} ` : month !== null ? `${MONTH_NAMES[month - 1]} ` : '';
  const magnitude = month === null ? String(Math.abs(year)) : String(Math.abs(year)).padStart(4, '0');
  const canonical = `${approximate ? 'c. ' : ''}${magnitude}`
    + (month === null ? '' : `-${String(month).padStart(2, '0')}`)
    + (day === null ? '' : `-${String(day).padStart(2, '0')}`)
    + (year < 0 ? ' BCE' : '');

  return {
    year, month, day, precision, approximate, sortValue,
    label: `${approximate ? 'c. ' : ''}${detailLabel}${yearLabel}`,
    canonical,
  };
}

// Exclusive upper endpoint. For example, an end date of "2024" includes every
// date in 2024; its endpoint is the beginning of 2025.
function dateUpperBound(date) {
  if (['decade', 'century'].includes(date.precision)) return date.upperBound;
  const year = astronomicalYear(date.year);
  if (date.precision === 'year') return year + 1;
  if (date.precision === 'month') return year + date.month / 12;
  return year + (date.month - 1 + date.day / daysInMonth(date.year, date.month)) / 12;
}

function optionalText(frontmatter, key, fallback = '') {
  const value = frontmatter[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`${key} must be text.`);
  return value.trim() || fallback;
}

function timelineGroups(frontmatter) {
  const value = frontmatter.timeline;
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(group => typeof group !== 'string')) {
    throw new Error('timeline must be a timeline name or a list of timeline names.');
  }
  const groups = [...new Set(values.map(group => group.trim()).filter(Boolean))];
  return groups;
}

function normalizeTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(tag => typeof tag !== 'string')) throw new Error('timeline-tags must be text or a list of tags.');
  return [...new Set(values.flatMap(tag => tag.split(/[\s,]+/)).map(tag => tag.replace(/^#+/, '').toLowerCase()).filter(Boolean))];
}

function normalizeAliases(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(alias => typeof alias !== 'string')) throw new Error('aliases must be text or a list of names.');
  const seen = new Set();
  return values.flatMap(alias => alias.split(/\r?\n/)).map(alias => alias.trim()).filter(alias => {
    const key = alias.normalize('NFKC').toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function normalizePerspectives(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('timeline-perspectives must be a list.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each perspective must have historian, interpretation, and source text.');
    const result = {};
    for (const key of ['historian', 'interpretation', 'source']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') throw new Error('Perspective fields must be text.');
      result[key] = (item[key] || '').trim();
    }
    return result;
  }).filter(item => item.historian || item.interpretation || item.source);
}

function eventFromFrontmatter(frontmatter, path, basename) {
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { event: null, error: null };
  }
  if (frontmatter['timeline-kind'] !== 'factor' && frontmatter['timeline-undated'] !== true && !Object.prototype.hasOwnProperty.call(frontmatter, 'timeline-date')) return { event: null, error: null };

  try {
    let start = null;
    try {
      if (frontmatter['timeline-kind'] !== 'factor' && frontmatter['timeline-undated'] !== true) start = parseHistoricalDate(frontmatter['timeline-date']);
    } catch (error) {
      throw new Error(`timeline-date: ${error.message}`);
    }
    let end = null;
    const endInput = frontmatter['timeline-end'];
    if (!start && endInput) throw new Error('An undated event cannot have an end date.');
    if (endInput !== undefined && endInput !== null && endInput !== '') {
      try {
        end = parseHistoricalDate(endInput);
      } catch (error) {
        throw new Error(`timeline-end: ${error.message}`);
      }
      if (dateUpperBound(end) <= start.sortValue) {
        throw new Error('timeline-end must include or follow timeline-date.');
      }
    }
    return {
      event: {
        id: path,
        path,
        title: optionalText(frontmatter, 'timeline-title', basename),
        aliases: normalizeAliases(frontmatter.aliases),
        start,
        end,
        kind: frontmatter['timeline-kind']==='factor'?'factor':'event',
        perspectives: normalizePerspectives(frontmatter['timeline-perspectives']),
        groups: timelineGroups(frontmatter),
        important: frontmatter['timeline-important'] === true,
        tags: normalizeTags(frontmatter['timeline-tags']),
        category: optionalText(frontmatter, 'timeline-category', 'Uncategorized'),
        summary: optionalText(frontmatter, 'timeline-summary'),
        location: optionalText(frontmatter, 'timeline-location'),
        source: optionalText(frontmatter, 'timeline-source'),
      },
      error: null,
    };
  } catch (error) {
    return { event: null, error: error instanceof Error ? error.message : 'Invalid timeline properties.' };
  }
}

module.exports = { parseHistoricalDate, dateUpperBound, eventFromFrontmatter, normalizeTags, normalizeAliases };
