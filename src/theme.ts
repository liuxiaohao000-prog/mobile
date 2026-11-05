// Yanban V2.0.11: calendar-first visual language.
// Shared colors deliberately keep healthcare meaning consistent across every screen.
export const theme = {
  ink: '#0A3442',
  muted: '#68858D',
  canvas: '#EAF8F8',
  paper: '#FFFFFF',
  primary: '#009F9F',
  primaryDark: '#007E82',
  primarySoft: '#DBF7F4',
  accent: '#D8792E',
  danger: '#DB343D',
  dangerSoft: '#FFEAEA',
  success: '#008B81',
  successSoft: '#DAF8F0',
  border: '#D7EDEE',
  blueSoft: '#E4F8FB',
};

export const typeScale = {
  pageTitle: { fontSize: 28, lineHeight: 37, fontWeight: '900' as const },
  sectionTitle: { fontSize: 18, lineHeight: 26, fontWeight: '800' as const },
  cardTitle: { fontSize: 16, lineHeight: 24, fontWeight: '800' as const },
  body: { fontSize: 15, lineHeight: 23, fontWeight: '400' as const },
  label: { fontSize: 14, lineHeight: 21, fontWeight: '700' as const },
  caption: { fontSize: 12, lineHeight: 19, fontWeight: '400' as const },
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { control: 14, card: 21, hero: 26, pill: 999 } as const;
