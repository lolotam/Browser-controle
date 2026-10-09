// The fixed showcase: ten tasks on public sites (no sign-in, no CAPTCHA), run the
// same way for every model so the results compare. Each check grades the final
// report: `pass` needs every required fact; `notes` explains what was missing.
// Expected values were read from the sites on 2026-10-09; the live ones (news,
// rates, releases) are checked by shape, not value.

const has = (report, re) => re.test(report);
const grade = (report, checks) => {
  const missing = checks.filter(([, re]) => !has(report, re)).map(([what]) => what);
  return { pass: missing.length === 0, score: (checks.length - missing.length) / checks.length, notes: missing.length ? `missing: ${missing.join(', ')}` : 'all facts present' };
};

export const TASKS = [
  {
    id: 'books',
    title: 'Cheapest travel books',
    site: 'books.toscrape.com',
    startUrl: 'https://books.toscrape.com/',
    task: 'On this site, find the 3 cheapest books in the Travel category. Report their titles and prices in a table.',
    check: (r) => grade(r, [
      // The site's list shortens this title to "The Road to Little ...".
      ['The Road to Little Dribbling £23.21', /Road to Little[\s\S]{0,200}23\.21|23\.21[\s\S]{0,200}Road to Little/i],
      ['1,000 Places to See £26.08', /1,?000 Places[\s\S]{0,200}26\.08|26\.08[\s\S]{0,200}1,?000 Places/i],
      ['The Great Railway Bazaar £30.54', /Railway Bazaar[\s\S]{0,200}30\.54|30\.54[\s\S]{0,200}Railway Bazaar/i],
    ]),
  },
  {
    id: 'quotes',
    title: 'Einstein quotes, two pages',
    site: 'quotes.toscrape.com',
    startUrl: 'https://quotes.toscrape.com/',
    task: 'List every quote by Albert Einstein on the first two pages of this site.',
    check: (r) => grade(r, [
      ['"world as we have created it"', /world as we have created it/i],
      ['"only two ways to live"', /only two ways to live/i],
      ['"man of success"', /man of success/i],
      ['"six year old" (page 2)', /six[- ]year[- ]old/i],
    ]),
  },
  {
    id: 'hackernews',
    title: 'Hacker News top 5',
    site: 'news.ycombinator.com',
    startUrl: 'https://news.ycombinator.com/',
    task: 'Report the top 5 stories on the Hacker News front page right now, with their titles and points, in a table.',
    check: (r) => grade(r, [
      ['five rows with points', /(?:\d+\s*points?[\s\S]*?){5}|(?:\|[^\n]*\d+[^\n]*\|\s*\n[\s\S]*?){5}/i],
    ]),
  },
  {
    id: 'wikipedia',
    title: 'Population of Japan',
    site: 'en.wikipedia.org',
    startUrl: 'https://en.wikipedia.org/',
    task: 'Using Wikipedia, what is the population of Japan and the year of that estimate? Include the source link.',
    check: (r) => grade(r, [
      ['about 120–125 million', /12[0-5](?:[.,]\d+)?\s*million|12[0-5][,.\s]\d{3}[,.\s]\d{3}/i],
      ['a year (2020s)', /20[2-3]\d/],
      ['Wikipedia link', /wikipedia\.org/i],
    ]),
  },
  {
    id: 'arabic-pyramid',
    title: 'الهرم الأكبر (بالعربي)',
    site: 'ar.wikipedia.org',
    startUrl: 'https://ar.wikipedia.org/',
    task: 'من ويكيبيديا العربية: ما ارتفاع الهرم الأكبر في الجيزة (الأصلي والحالي) ومتى بُني تقريبًا؟ اكتب الإجابة بالعربية مع رابط المصدر.',
    check: (r) => grade(r, [
      ['original height ≈146 m', /14[56](?:[.,]\d+)?/],
      ['current height ≈138 m', /13[7-9](?:[.,]\d+)?/],
      ['built ≈2560 BC', /25[5-9]\d|26\d\d/],
      ['answer in Arabic', /(?:[؀-ۿ][^؀-ۿ]{0,3}){40,}/],
    ]),
  },
  {
    id: 'the-internet',
    title: 'Dropdown, checkboxes, dynamic loading',
    site: 'the-internet.herokuapp.com',
    startUrl: 'https://the-internet.herokuapp.com/',
    task: 'On this site: open "Dropdown" and choose Option 2. Then open "Checkboxes" and make sure both boxes are checked. Then open "Dynamic Loading", run Example 2, and report the text that appears when it finishes.',
    check: (r) => grade(r, [
      ['Option 2 chosen', /option\s*2/i],
      ['both checkboxes checked', /check/i],
      ['"Hello World!"', /hello world/i],
    ]),
  },
  {
    id: 'demoqa-form',
    title: 'Fill and submit a form',
    site: 'demoqa.com',
    startUrl: 'https://demoqa.com/text-box',
    task: 'Fill in this form: Full Name "Postora Agent", Email "agent@example.com", Current Address "1 Nile Street, Cairo", Permanent Address "2 Tahrir Square, Cairo". Submit it and report exactly what the page shows under the form.',
    check: (r) => grade(r, [
      ['name echoed', /Postora Agent/],
      ['email echoed', /agent@example\.com/],
      ['address echoed', /Nile Street/i],
    ]),
  },
  {
    id: 'github',
    title: 'Playwright stars and release',
    site: 'github.com',
    startUrl: 'https://github.com/microsoft/playwright',
    task: 'How many stars does this repository have, and what is its latest release version and date?',
    check: (r) => grade(r, [
      ['star count', /\d[\d.,]*\s*k?\s*(?:stars?|⭐)|stars?[^\n]{0,20}\d/i],
      ['release version v1.x', /v?1\.\d{2,}(?:\.\d+)?/],
    ]),
  },
  {
    id: 'exchange-rate',
    title: 'USD to EUR',
    site: 'x-rates.com',
    // x-rates.com does not list the Egyptian Pound; the first run of 2026-10-09 asked for
    // it and every model rightly reported that, so the task now uses the Euro.
    startUrl: 'https://www.x-rates.com/',
    task: 'What is the current exchange rate from 1 US Dollar to Euro on this site? Also give 250 USD in EUR.',
    check: (r) => grade(r, [
      ['a USD→EUR rate (0.6–1.3)', /(?:^|[^\d.])(?:0\.[6-9]\d*|1\.[0-2]\d*)\s*(?:EUR|€|Euro)/im],
      ['the 250 USD amount (150–325 EUR)', /(?:^|[^\d.])(?:1[5-9]\d|2\d\d|3[0-2]\d)(?:[.,]\d+)?\s*(?:EUR|€|Euro)|€\s*(?:1[5-9]\d|2\d\d|3[0-2]\d)/im],
    ]),
  },
  {
    id: 'python',
    title: 'Latest Python release',
    site: 'python.org',
    startUrl: 'https://www.python.org/',
    task: 'What is the latest Python 3 release, when was it released, and what was the release before it?',
    check: (r) => grade(r, [
      ['a 3.x.y version', /3\.1\d\.\d+/],
      ['a release date', /20[2-3]\d/],
    ]),
  },
];
