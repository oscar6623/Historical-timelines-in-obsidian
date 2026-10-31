'use strict';

// Remove standalone English articles, preserving letters inside names,
// abbreviations and hyphenated words. An article-only query stays literal so
// typing "a" still offers A-prefix suggestions instead of every item.
function withoutArticles(value) {
  // Capture the separator instead of using lookbehind, which older iPhone
  // WebViews cannot parse (and would prevent the entire plugin from loading).
  return String(value).normalize('NFKC').replace(/(^|[^\p{L}\p{N}_.'’-])(?:a|an|the)(?![\p{L}\p{N}_.'’-])/giu, '$1 ').replace(/\s+/g, ' ').trim();
}
function searchText(value) {
  const original = String(value).normalize('NFKC').trim();
  return withoutArticles(original) || original;
}

// Match the start of a name or a word, never an arbitrary interior Latin letter.
// Event pickers may also offer a one-letter typo after four typed letters.
function suggestionRank(value, query, {ignoreCase = true, fuzzy = false} = {}) {
  let title = String(value).normalize('NFKC').trim();
  let text = String(query).normalize('NFKC').trim();
  if (ignoreCase) { title = title.toLocaleLowerCase(); text = text.toLocaleLowerCase(); }
  if (!text || title === text) return 0;
  if (title.startsWith(text)) return 1;
  const articleFreeQuery = withoutArticles(text);
  if (articleFreeQuery) {
    title = withoutArticles(title); text = articleFreeQuery;
    if (title === text) return 0;
    if (title.startsWith(text)) return 1;
  }
  const words = title.match(/[\p{L}\p{N}]+/gu) || [];
  const queryWords = text.match(/[\p{L}\p{N}]+/gu) || [];
  const phrase = queryWords.join(' ');
  if (phrase && words.some((_, index) => words.slice(index).join(' ').startsWith(phrase))) return 2;
  // Chinese does not separate words with spaces.
  if (/\p{Script=Han}/u.test(text) && title.includes(text)) return 2;
  if (fuzzy && /^[a-z]{4,}$/i.test(text) && words.some(word => {
    if (!ignoreCase && word[0] !== text[0]) return false;
    return [text.length - 1, text.length, text.length + 1].some(length =>
      word.length >= length && oneEditApart(text, word.slice(0, length)));
  })) return 3;
  return -1;
}

function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function matchingSuggestions(values, query, label = value => value, options) {
  return values.map(value => {
    const labels = label(value);
    const ranks = (Array.isArray(labels) ? labels : [labels]).map(name => suggestionRank(name, query, options)).filter(rank => rank >= 0);
    return {value, rank:ranks.length ? Math.min(...ranks) : -1};
  })
    .filter(item => item.rank >= 0).sort((a, b) => a.rank - b.rank).map(item => item.value);
}

module.exports = {suggestionRank, matchingSuggestions, searchText};
