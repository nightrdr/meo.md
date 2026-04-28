// Seed content for the Meo notes prototype. Realistic, varied —
// travel planning, recipes, meeting notes, essays, checklists.

const NOTES = [
  {
    id: 'n1', folder: 'work', title: 'Q3 review — design team',
    updated: 'Today', preview: 'Shipped: onboarding v2, settings refresh. In flight: dashboard…',
    tags: ['work', 'review'],
    pinned: true,
    blocks: [
      { t: 'h1', v: 'Q3 review — design team' },
      { t: 'meta', v: 'Oct 14  ·  Apr Kaelin' },
      { t: 'p', v: 'Three themes stood out this quarter. We shipped the long-delayed onboarding rewrite, we made a real dent in the notifications mess, and we started — finally — to treat mobile as a first-class surface.' },
      { t: 'h2', v: 'Shipped' },
      { t: 'check', v: 'Onboarding v2 — rolled to 100% on Tuesday', done: true },
      { t: 'check', v: 'Settings refresh (desktop + web)', done: true },
      { t: 'check', v: 'Notification preference audit', done: true },
      { t: 'check', v: 'Mobile editor parity — still 3 blockers', done: false },
      { t: 'h2', v: 'In flight' },
      { t: 'p', v: 'Dashboard redesign goes to usability testing next week. I\'m nervous about the density — we\'ll know on Thursday.' },
      { t: 'callout', v: 'Reminder: invite Priya to the Thursday session. Her notes from the pilot were what made this work.' },
      { t: 'h2', v: 'Links' },
      { t: 'link', v: '→ Mobile editor tracker', href: '#' },
      { t: 'link', v: '→ Dashboard research plan', href: '#' },
    ],
  },
  {
    id: 'n2', folder: 'travel', title: 'Kyoto — November trip',
    updated: 'Yesterday', preview: 'Arashiyama bamboo grove before 8am. Pontocho for dinner.…',
    tags: ['travel', 'kyoto'],
    pinned: true,
    blocks: [
      { t: 'h1', v: 'Kyoto — November trip' },
      { t: 'meta', v: '5 days  ·  Nov 12–17' },
      { t: 'p', v: 'Keeping this loose — half planned, half room to wander.' },
      { t: 'h2', v: 'Must do' },
      { t: 'check', v: 'Arashiyama bamboo grove — before 8am, trust me', done: false },
      { t: 'check', v: 'Fushimi Inari — sunrise climb to the top', done: false },
      { t: 'check', v: 'Pontocho alley for dinner one night', done: false },
      { t: 'check', v: 'Nishiki market breakfast', done: false },
      { t: 'h2', v: 'Reservations' },
      { t: 'p', v: 'Book ryokan 8 weeks out. Kichisen waitlist is real.' },
    ],
  },
  {
    id: 'n3', folder: 'recipes', title: 'Miso butter pasta',
    updated: '2 days ago', preview: 'White miso, brown butter, black pepper. 15 minutes flat.',
    tags: ['recipes', 'quick'],
    blocks: [
      { t: 'h1', v: 'Miso butter pasta' },
      { t: 'meta', v: '15 min  ·  Serves 2' },
      { t: 'h2', v: 'What you need' },
      { t: 'ul', items: ['200g spaghetti', '3 tbsp unsalted butter', '1.5 tbsp white miso', 'Black pepper, coarse', '1 clove garlic, grated', 'Parmesan, a lot', 'Chives or scallion greens'] },
      { t: 'h2', v: 'Method' },
      { t: 'ol', items: [
        'Salt the pasta water less than usual — miso is salty.',
        'Melt butter until it foams then browns. Kill the heat. Whisk in miso and garlic.',
        'Drain pasta, keep a cup of water. Add pasta to the pan with a splash of water. Toss hard.',
        'Pepper, cheese, herbs. Eat standing up.',
      ]},
    ],
  },
  {
    id: 'n4', folder: 'work', title: 'Thursday research session — script',
    updated: '2 days ago', preview: 'Opening, tasks, debrief questions. 45 minutes.',
    tags: ['work', 'research'],
    blocks: [
      { t: 'h1', v: 'Thursday research session — script' },
      { t: 'meta', v: '45 min  ·  6 participants' },
      { t: 'h2', v: 'Opening (5 min)' },
      { t: 'p', v: 'Thanks for making time. No wrong answers today — we\'re here to see what gets in your way.' },
      { t: 'h2', v: 'Tasks' },
      { t: 'ol', items: [
        'Create a new note from the home screen.',
        'Move that note into a folder called "Trip".',
        'Find a note you wrote last week.',
      ] },
    ],
  },
  {
    id: 'n5', folder: 'ideas', title: 'Things I keep coming back to',
    updated: '5 days ago', preview: 'A running list. Keep it low-stakes.',
    tags: ['ideas'],
    blocks: [
      { t: 'h1', v: 'Things I keep coming back to' },
      { t: 'p', v: 'A running list. Not every idea needs a home — some just need to be written down.' },
      { t: 'ul', items: [
        'Tools that trust their users more.',
        'Designing for the second visit, not the first.',
        'Why checklists feel better than prose for most plans.',
      ] },
    ],
  },
  {
    id: 'n6', folder: 'journal', title: 'Sunday — October 12',
    updated: 'Last week', preview: 'Long walk along the canal. Talked to Mom.',
    tags: ['journal'],
    blocks: [
      { t: 'h1', v: 'Sunday — October 12' },
      { t: 'p', v: 'Long walk along the canal. Cold air, but the sun was out. Talked to Mom for almost an hour — she sounded good.' },
    ],
  },
  {
    id: 'n7', folder: 'work', title: 'Hiring — Senior Designer',
    updated: 'Last week', preview: 'JD draft. Focus on product judgment, not craft alone.',
    tags: ['work', 'hiring'],
    blocks: [
      { t: 'h1', v: 'Hiring — Senior Designer' },
      { t: 'p', v: 'Draft of the JD. Keep pulling toward judgment and away from pixel-fidelity-as-the-job.' },
    ],
  },
  {
    id: 'n8', folder: 'recipes', title: 'Weeknight dal',
    updated: 'Last week', preview: 'Red lentils, turmeric, cumin, hot ghee finish.',
    tags: ['recipes'],
    blocks: [{ t: 'h1', v: 'Weeknight dal' }],
  },
  {
    id: 'n9', folder: 'travel', title: 'Packing list — cold weather',
    updated: 'Oct 2', preview: 'Base layer, down vest, beanie, the good socks.',
    tags: ['travel', 'packing'],
    blocks: [{ t: 'h1', v: 'Packing list — cold weather' }],
  },
  {
    id: 'n10', folder: 'ideas', title: 'Notes on notes',
    updated: 'Sep 28', preview: 'Why every notes app eventually becomes a mess.',
    tags: ['ideas'],
    blocks: [{ t: 'h1', v: 'Notes on notes' }],
  },
];

const FOLDERS = [
  { id: 'all',     name: 'All notes',  icon: 'Note',    count: 10, system: true },
  { id: 'pinned',  name: 'Pinned',     icon: 'Pin',     count: 2,  system: true },
  { id: 'recent',  name: 'Recent',     icon: 'Star',    count: 6,  system: true },
];

const USER_FOLDERS = [
  { id: 'work',    name: 'Work',     count: 3, children: [
    { id: 'work/hiring', name: 'Hiring', count: 1 },
    { id: 'work/reviews', name: 'Reviews', count: 1 },
  ]},
  { id: 'travel',  name: 'Travel',   count: 2 },
  { id: 'recipes', name: 'Recipes',  count: 2 },
  { id: 'journal', name: 'Journal',  count: 1 },
  { id: 'ideas',   name: 'Ideas',    count: 2 },
];

const TAGS = ['work', 'travel', 'recipes', 'ideas', 'journal', 'hiring', 'research'];

Object.assign(window, { NOTES, FOLDERS, USER_FOLDERS, TAGS });
