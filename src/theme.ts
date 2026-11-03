export const theme = {
  ink: '#14212B',
  muted: '#637580',
  canvas: '#F6F8FA',
  paper: '#FFFFFF',
  primary: '#146C76',
  primaryDark: '#0F545E',
  primarySoft: '#E5F2F2',
  accent: '#A15C00',
  danger: '#B42318',
  dangerSoft: '#FEECEB',
  success: '#0F766E',
  successSoft: '#E5F4F1',
  border: '#E1E8EA',
  blueSoft: '#EFF6F7',
};

export const typeScale = {
  pageTitle: { fontSize: 26, lineHeight: 34, fontWeight: '700' as const },
  sectionTitle: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  cardTitle: { fontSize: 16, lineHeight: 23, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 19, fontWeight: '400' as const },
};


/** Shared spacing and shape tokens for the V2.0 interface. */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { control: 12, card: 16, hero: 20, pill: 999 } as const;
