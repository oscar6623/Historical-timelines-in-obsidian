'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHistoricalDate: date, dateUpperBound, eventFromFrontmatter } = require('../src/model');

function event(frontmatter) {
  return eventFromFrontmatter(frontmatter, 'History/Rome.md', 'Rome');
}

test('signed historical years and era aliases resolve without a year zero', () => {
  for (const input of ['44 BCE', '44 BC', '44 bce', -44, '-44', '-44 BCE']) {
    const parsed = date(input);
    assert.equal(parsed.year, -44);
    assert.equal(parsed.sortValue, -43);
    assert.equal(parsed.canonical, '44 BCE');
  }
  for (const input of [2024, '2024', '+2024', '2024 CE', '2024 AD', 'AD 2024']) {
    assert.equal(date(input).year, 2024);
  }
  for (const input of [0, -0, '0000', '0 BCE', '0000-01-01 CE']) {
    assert.throws(() => date(input), /year 0/);
  }
  assert.throws(() => date('-44 CE'), /negative year/);
  assert.throws(() => date('+44 BCE'), /positive year sign/);
  assert.throws(() => date('AD 44 BCE'), /only once/);
});

test('BCE to CE coordinates are continuous and BCE dates sort chronologically', () => {
  const ordered = ['2 BCE', '0002-12-31 BCE', '1 BCE', '0001-12-31 BCE', '1 CE', '0001-01-02 CE'];
  const coordinates = ordered.map(value => date(value).sortValue);
  assert.deepEqual([...coordinates].sort((a, b) => a - b), coordinates);
  assert.equal(dateUpperBound(date('1 BCE')), date('1 CE').sortValue);
  assert.equal(dateUpperBound(date('0001-12 BCE')), date('1 CE').sortValue);
  assert.equal(dateUpperBound(date('0001-12-31 BCE')), date('1 CE').sortValue);
  assert.equal(date('1 CE').sortValue - date('1 BCE').sortValue, 1);
});

test('partial dates preserve precision, labels, and canonical editable values', () => {
  assert.deepEqual(date('44 BCE'), {
    year: -44, month: null, day: null, precision: 'year', approximate: false,
    sortValue: -43, label: '44 BCE', canonical: '44 BCE',
  });
  const month = date('44-3 BCE');
  assert.equal(month.precision, 'month');
  assert.equal(month.day, null);
  assert.equal(month.canonical, '0044-03 BCE');
  assert.equal(month.label, 'Mar 44 BCE');
  const day = date('0044-03-15 BCE');
  assert.equal(day.precision, 'day');
  assert.equal(day.label, '15 Mar 44 BCE');
  assert.equal(date('2024-1-9').canonical, '2024-01-09');
  assert.equal(date('2024').label, '2024 CE');
  assert.ok(month.sortValue < day.sortValue);
  assert.equal(dateUpperBound(month), date('0044-04 BCE').sortValue);
});

test('approximation prefixes preserve the same sort position', () => {
  for (const input of ['c. 500 BCE', 'circa 500 BCE', '~500 BCE', 'c 500 BCE']) {
    const parsed = date(input);
    assert.equal(parsed.approximate, true);
    assert.equal(parsed.label, 'c. 500 BCE');
    assert.equal(parsed.canonical, 'c. 500 BCE');
    assert.equal(parsed.sortValue, date('500 BCE').sortValue);
  }
});

test('Gregorian day validation accounts for century and BCE leap years', () => {
  for (const input of ['2024-02-29', '2000-02-29', '0001-02-29 BCE', '0005-02-29 BCE']) {
    assert.equal(date(input).day, 29);
  }
  for (const input of ['1900-02-29', '2023-02-29', '0001-02-29 CE', '0004-02-29 BCE', '2024-04-31', '2024-01-00']) {
    assert.throws(() => date(input), /day must be/);
  }
  for (const input of ['2024-00', '2024-13', '2024-99-01']) {
    assert.throws(() => date(input), /month must be/);
  }
});

test('invalid dates, ranges, arbitrary objects, and out-of-bounds years are rejected', () => {
  for (const input of ['', '   ', 'yesterday', '44 BCE – 23 BCE', '2024-01-01T00:00:00', '1e3', '1000000', '-1000000', '2024-03-15-1']) {
    assert.throws(() => date(input));
  }
  for (const input of [NaN, Infinity, -Infinity, 2024.5, null, undefined, true, [], new Date(), Symbol('year')]) {
    assert.throws(() => date(input));
  }
  let coerced = false;
  assert.throws(() => date({ toString() { coerced = true; return '2024'; } }));
  assert.equal(coerced, false);
  assert.equal(date('999999 BCE').year, -999999);
  assert.equal(date('999999-12-31').year, 999999);
});

test('canonical representations round-trip across the supported range', () => {
  for (const input of ['999999 BCE', 'c. 0001-02-29 BCE', '-123456-12-31', '0001-01-01', '2024-12', '~999999-12-31 CE']) {
    const parsed = date(input);
    assert.deepEqual(date(parsed.canonical), parsed);
    assert.ok(dateUpperBound(parsed) > parsed.sortValue);
  }
});

test('day endpoints meet the next month exactly, including distant years', () => {
  for (const year of [-999999, -400, -1, 1, 2024, 999999]) {
    for (let month = 1; month <= 12; month += 1) {
      let lastDay = 31;
      while (true) {
        try {
          date(`${year}-${month}-${lastDay}`);
          break;
        } catch {
          lastDay -= 1;
        }
      }
      const nextMonth = month < 12 ? date(`${year}-${month + 1}`).sortValue : dateUpperBound(date(year));
      assert.equal(dateUpperBound(date(`${year}-${month}-${lastDay}`)), nextMonth);
    }
  }
});

test('ordinary notes are skipped and invalid timeline notes have useful errors', () => {
  for (const frontmatter of [null, undefined, [], {}, { title: 'Ordinary note' }, Object.create({ 'timeline-date': '44 BCE' })]) {
    assert.deepEqual(event(frontmatter), { event: null, error: null });
  }
  for (const value of [null, '', {}, '2024-02-30']) {
    const result = event({ 'timeline-date': value });
    assert.equal(result.event, null);
    assert.match(result.error, /timeline-date/);
  }
});

test('events retain their path and apply intentional property defaults', () => {
  const result = event({ 'timeline-date': '44 BCE' });
  assert.equal(result.error, null);
  assert.equal(result.event.id, 'History/Rome.md');
  assert.equal(result.event.path, 'History/Rome.md');
  assert.equal(result.event.title, 'Rome');
  assert.deepEqual(result.event.groups, []);
  assert.equal(result.event.category, 'Uncategorized');
  assert.equal(result.event.summary, '');
  assert.equal(result.event.location, '');
  assert.equal(result.event.source, '');
  assert.equal(result.event.end, null);
});

test('scalar and list timeline names are trimmed and deduplicated', () => {
  assert.deepEqual(event({ 'timeline-date': '44 BCE', timeline: ' Roman history ' }).event.groups, ['Roman history']);
  assert.deepEqual(event({ 'timeline-date': '44 BCE', timeline: [' Rome ', 'World', 'Rome', ''] }).event.groups, ['Rome', 'World']);
  for (const value of ['', '  ', [], ['', '  '], null]) {
    assert.deepEqual(event({ 'timeline-date': '44 BCE', timeline: value }).event.groups, []);
  }
  for (const value of [42, {}, ['History', {}], ['History', null], true]) {
    const result = event({ 'timeline-date': '44 BCE', timeline: value });
    assert.equal(result.event, null);
    assert.match(result.error, /timeline must be/);
  }
});

test('optional textual frontmatter is trimmed without coercing unsafe objects', () => {
  const result = event({
    'timeline-date': '44 BCE', 'timeline-title': ' Caesar ', 'timeline-category': ' Politics ',
    'timeline-summary': ' A note ', 'timeline-location': ' Rome ', 'timeline-source': ' [[Source]] ',
  });
  assert.equal(result.event.title, 'Caesar');
  assert.equal(result.event.category, 'Politics');
  assert.equal(result.event.summary, 'A note');
  assert.equal(result.event.location, 'Rome');
  assert.equal(result.event.source, '[[Source]]');
  let coerced = false;
  const bad = { toString() { coerced = true; throw new Error('must not run'); } };
  for (const key of ['timeline-title', 'timeline-category', 'timeline-summary', 'timeline-location', 'timeline-source']) {
    const invalid = event({ 'timeline-date': '44 BCE', [key]: bad });
    assert.equal(invalid.event, null);
    assert.equal(invalid.error, `${key} must be text.`);
  }
  assert.equal(coerced, false);
});

test('range endpoints respect the entire period of less precise end dates', () => {
  const accepted = [
    ['2024-12-31', '2024'], ['2024-03-31', '2024-03'], ['2024-03-31', '2024-03-31'],
    ['44 BCE', '30 BCE'], ['0001-12-31 BCE', '1 CE'], ['0001-12-31 BCE', '1 BCE'],
  ];
  for (const [start, end] of accepted) {
    const result = event({ 'timeline-date': start, 'timeline-end': end });
    assert.equal(result.error, null, `${start} → ${end}`);
    assert.ok(result.event.end);
  }
  const rejected = [
    ['2025', '2024'], ['2024-04-01', '2024-03'], ['2024-03-31', '2024-03-30'],
    ['30 BCE', '44 BCE'], ['1 CE', '1 BCE'],
  ];
  for (const [start, end] of rejected) {
    const result = event({ 'timeline-date': start, 'timeline-end': end });
    assert.equal(result.event, null, `${start} → ${end}`);
    assert.match(result.error, /timeline-end must include or follow/);
  }
  assert.match(event({ 'timeline-date': '2024', 'timeline-end': {} }).error, /timeline-end:/);
});

test('decades preserve precision, era, approximation and canonical round trips', () => {
  for (const input of ['1930s', 'c. 1930s', '40s BCE', 'AD 1930s', '0s', '0s BCE']) {
    const parsed = date(input);
    assert.equal(parsed.precision, 'decade');
    assert.deepEqual(date(parsed.canonical), parsed);
    assert.ok(dateUpperBound(parsed) > parsed.sortValue);
  }
  assert.equal(date('1930s').sortValue, date('1930').sortValue);
  assert.equal(dateUpperBound(date('1930s')), date('1940').sortValue);
  assert.equal(date('40s BCE').sortValue, date('49 BCE').sortValue);
  assert.equal(dateUpperBound(date('40s BCE')), date('39 BCE').sortValue);
  for (const invalid of ['1933s', '1930s-01', '1000000s', '-1930s']) assert.throws(() => date(invalid));
  assert.equal(event({'timeline-date':'1939', 'timeline-end':'1930s'}).error, null);
  assert.match(event({'timeline-date':'1940', 'timeline-end':'1930s'}).error, /must include/);
});

test('century inputs preserve full CE and BCE spans and round trip',()=>{
 for(const [input,start,end] of [['19th century','1801','1901'],['5th century BCE','500 BCE','400 BCE'],['1st century BCE','100 BCE','1 CE'],['1st century','1 CE','101']]) {
  const parsed=date(input);assert.equal(parsed.precision,'century');
  assert.equal(parsed.sortValue,date(start).sortValue);assert.equal(dateUpperBound(parsed),date(end).sortValue);
  assert.deepEqual(date(parsed.canonical),parsed);
 }
 assert.equal(date('c. 21st century').approximate,true);
 assert.equal(event({'timeline-date':'1899','timeline-end':'19th century'}).error,null);
 assert.match(event({'timeline-date':'1901','timeline-end':'19th century'}).error,/must include/);
 assert.throws(()=>date('0th century'));assert.throws(()=>date('10000th century'));
});

test('explicit undated events retain metadata while ordinary missing dates remain skipped',()=>{
 const result=event({'timeline-undated':true,'timeline-title':'Unknown event','timeline-perspectives':[{historian:' A ',interpretation:' View ',source:'Book'}]});
 assert.equal(result.error,null);assert.equal(result.event.start,null);assert.equal(result.event.perspectives[0].historian,'A');
 assert.equal(event({'timeline-title':'Ordinary note'}).event,null);
 assert.match(event({'timeline-undated':true,'timeline-end':'1900'}).error,/undated/);
 assert.match(event({'timeline-date':'1900','timeline-perspectives':'bad'}).error,/list/);
});

test('event aliases accept native note properties and preserve punctuation while deduplicating names',()=>{
 const parsed=eventFromFrontmatter({'timeline-date':'1937',aliases:[' 七七事变 ','Marco Polo, Beijing','七七事变','MPBI','mpbi']},'event.md','Event');
 assert.equal(parsed.error,null);
 assert.deepEqual(parsed.event.aliases,['七七事变','Marco Polo, Beijing','MPBI']);
 assert.deepEqual(eventFromFrontmatter({'timeline-date':'1937',aliases:'MPBI'},'event.md','Event').event.aliases,['MPBI']);
 assert.match(eventFromFrontmatter({'timeline-date':'1937',aliases:[5]},'event.md','Event').error,/aliases/);
});
