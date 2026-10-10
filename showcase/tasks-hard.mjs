// The hard showcase set: ten multi-step tasks (several pages, filters, a complex
// form, arithmetic, an Arabic comparison). Expected values were read from the
// sites on 2026-10-10; GitHub releases are checked by shape.

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const DATE = new RegExp(`20\\d\\d-\\d\\d-\\d\\d|${MONTH}\\s+\\d{1,2},?\\s+20\\d\\d|\\d{1,2}\\s+${MONTH}\\s+20\\d\\d`, 'gi');

/** Arabic-Indic digits and separators read as Western ones, so a number is found however it is written. */
const western = (text) => text
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
  .replace(/[٬،]/g, ',')
  .replace(/٫/g, '.');

const has = (report, test) => (typeof test === 'function' ? test(report) : test.test(report));
const grade = (report, checks) => {
  const missing = checks.filter(([, test]) => !has(report, test)).map(([what]) => what);
  return { pass: missing.length === 0, score: (checks.length - missing.length) / checks.length, notes: missing.length ? `missing: ${missing.join(', ')}` : 'all facts present' };
};
/** `a` and `b` within `gap` characters of each other, in either order. */
const near = (a, b, gap = 200) => new RegExp(`(?:${a})[\\s\\S]{0,${gap}}(?:${b})|(?:${b})[\\s\\S]{0,${gap}}(?:${a})`, 'i');
const num = (digits) => new RegExp(digits.split('').map((d, i, a) => (i > 0 && (a.length - i) % 3 === 0 ? `[,.\\s]?${d}` : d)).join(''));

export const TASKS = [
  {
    id: 'mystery-5star',
    title: 'Five-star mysteries',
    site: 'books.toscrape.com',
    startUrl: 'https://books.toscrape.com/',
    task: 'In the Mystery category (it has more than one page), find every book rated 5 stars. List each title with its price, and say which one is the most expensive.',
    check: (r) => grade(r, [
      // Each title next to its own price; the list shortens long titles, so a distinctive part is matched.
      ['A Time of Torment £48.35', near('Time of Torment', '48\\.35')],
      ['What Happened on Beale Street £25.37', near('What Happened|Beale Street', '25\\.37')],
      ['The Bachelor Girl’s Guide to Murder £52.30', near('Bachelor Girl', '52\\.30?\\b')],
      ['The Silkworm £23.05', near('Silkworm', '23\\.05')],
      ['The Girl You Lost £12.29', near('Girl You Lost', '12\\.29')],
      ['the most expensive is the Bachelor Girl’s Guide', /(?:most expensive|highest)[\s\S]{0,250}Bachelor|Bachelor[\s\S]{0,250}(?:most expensive|highest)/i],
    ]),
  },
  {
    id: 'poetry-average',
    title: 'Average poetry price',
    site: 'books.toscrape.com',
    startUrl: 'https://books.toscrape.com/',
    task: 'What is the average price of all books in the Poetry category? Give the number of books, the total and the average rounded to two decimals.',
    check: (r) => grade(r, [
      ['19 books', /\b19\b/],
      ['total £683.51', /683\.51/],
      ['average £35.97', /35\.97/],
    ]),
  },
  {
    id: 'quotes-love-author',
    title: 'Most-quoted author on love',
    site: 'quotes.toscrape.com',
    startUrl: 'https://quotes.toscrape.com/',
    task: 'Look at all quotes tagged "love" (every page of that tag). Which author has the most of them, and when and where was that author born, according to the author’s page on this site?',
    check: (r) => grade(r, [
      ['Marilyn Monroe', /Marilyn Monroe/i],
      ['born June 1, 1926', /June\s+0?1,?\s+1926|1926-06-01|1\s+June\s+1926/i],
      ['in the United States', /United States|USA|U\.S\./i],
    ]),
  },
  {
    id: 'quotes-search-form',
    title: 'Search form with dependent lists',
    site: 'quotes.toscrape.com',
    startUrl: 'https://quotes.toscrape.com/search.aspx',
    task: 'Use this search form: choose the author Albert Einstein, then the tag "inspirational", search, and report every quote the search returns.',
    check: (r) => grade(r, [
      ['"There are only two ways to live your life…"', /two ways to live/i],
      ['no quote outside the search result', (t) => !/world as we have created|man of success|six[- ]year[- ]old/i.test(t)],
    ]),
  },
  {
    id: 'sortable-table',
    title: 'Largest debt, then sort',
    site: 'the-internet.herokuapp.com',
    startUrl: 'https://the-internet.herokuapp.com/tables',
    task: 'In Example 1 on this page, who owes the most (Due column)? Give their full name and email. Then sort that table by Last Name by clicking its header, and report who is in the first row after sorting.',
    check: (r) => grade(r, [
      ['Jason Doe owes the most', /Jason\s+Doe|Doe,?\s+Jason/i],
      ['jdoe@hotmail.com', /jdoe@hotmail\.com/i],
      ['Frank Bach in the first row after sorting', near('Frank\\s+Bach|Bach,?\\s+Frank', 'first|top', 120)],
    ]),
  },
  {
    id: 'dynamic-controls',
    title: 'Asynchronous controls',
    site: 'the-internet.herokuapp.com',
    startUrl: 'https://the-internet.herokuapp.com/dynamic_controls',
    task: 'On this page, remove the checkbox, then enable the text field and type "Postora" into it. Report the exact message the page showed after each step and what the text field contains at the end.',
    check: (r) => grade(r, [
      ['"It’s gone!"', /It['’]s gone/i],
      ['"It’s enabled!"', /It['’]s enabled/i],
      ['the field contains Postora', /Postora/],
    ]),
  },
  {
    id: 'practice-form',
    title: 'Long form with widgets',
    site: 'demoqa.com',
    startUrl: 'https://demoqa.com/automation-practice-form',
    task: 'Fill in and submit this form: First Name "Layla", Last Name "Hassan", Email "layla@example.com", Gender Female, Mobile "0123456789", Subjects "Maths", Hobbies "Reading", Current Address "5 Nile Street, Cairo", State "NCR", City "Delhi". Submit it, then report the values shown in the confirmation table.',
    check: (r) => grade(r, [
      ['name Layla Hassan', /Layla\s+Hassan/i],
      ['email layla@example.com', /layla@example\.com/i],
      ['gender Female', /Female/i],
      ['mobile 0123456789', /0123456789/],
      ['address 5 Nile Street', /5 Nile Street/i],
      // The date of birth is left at the form's default (today), which the task never mentions:
      // only a report read from the submitted confirmation contains it.
      ['date of birth from the confirmation', /Date of Birth[^\n]{0,40}\b20\d\d\b/i],
      ['subject Maths', /Maths/i],
      ['hobby Reading', /Reading/i],
      ['state and city NCR Delhi', /NCR[\s\S]{0,40}Delhi/i],
    ]),
  },
  {
    id: 'rivers',
    title: 'Nile versus Amazon',
    site: 'en.wikipedia.org',
    startUrl: 'https://en.wikipedia.org/',
    task: 'Using the infoboxes of the Wikipedia articles on the Nile and on the Amazon River, give each river’s length in km and work out how much longer one is than the other.',
    check: (r) => grade(r, [
      ['Nile 7,088 km', num('7088')],
      ['Amazon 6,575 km', num('6575')],
      ['difference 513 km', /\b513\b/],
    ]),
  },
  {
    id: 'github-releases',
    title: 'Three latest releases',
    site: 'github.com',
    startUrl: 'https://github.com/microsoft/playwright',
    task: 'Open this repository’s Releases and list the 3 most recent release versions with their release dates.',
    check: (r) => grade(r, [
      ['three release versions', (t) => new Set(t.match(/v?1\.\d{2,}\.\d+/g) ?? []).size >= 3],
      ['a date for each of the three', (t) => (t.match(DATE) ?? []).length >= 3],
    ]),
  },
  {
    id: 'arabic-cities',
    title: 'القاهرة والإسكندرية (بالعربي)',
    site: 'ar.wikipedia.org',
    startUrl: 'https://ar.wikipedia.org/',
    task: 'من ويكيبيديا العربية: ما عدد سكان القاهرة وعدد سكان الإسكندرية حسب التعداد المذكور في صفحتيهما، وما الفرق بينهما؟ اكتب الإجابة بالعربية مع روابط المصدر.',
    check: (r) => {
      const t = western(r);
      return grade(t, [
        ['Cairo 10,331,624', num('10331624')],
        ['Alexandria 5,408,311', num('5408311')],
        ['difference 4,923,313', (x) => num('4923313').test(x) || /4[.,]9\d*\s*(?:مليون|million)/i.test(x)],
        // Counted, not chained: numbers break up runs of Arabic letters in this answer.
        ['answer in Arabic', (x) => (x.match(/[ء-ي]/g) ?? []).length >= 40],
        ['Arabic Wikipedia links', /ar\.wikipedia\.org/i],
      ]);
    },
  },
];
