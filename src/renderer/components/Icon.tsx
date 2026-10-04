export type IconName = 'file' | 'folder' | 'outline' | 'search' | 'command' | 'settings' | 'sun' | 'save' | 'image' | 'plus' | 'split' | 'code' | 'eye' | 'target' | 'clock' | 'close' | 'check' | 'export' | 'undo' | 'redo'
const paths: Record<IconName, string> = {
  undo: 'M3 10h11a6 6 0 0 1 0 12 M3 10l5-5 M3 10l5 5',
  redo: 'M21 10H10a6 6 0 0 0 0 12 M21 10l-5-5 M21 10l-5 5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M8 13h8 M8 17h5',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  outline: 'M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  command: 'M9 7V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3l-1 3-3 1-2 3 2 2-1 3 3 2 2-1 2 3h4l1-3 3-1 2-3-2-2 1-3-3-2-2 1-2-3Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5',
  save: 'M5 3h12l4 4v14H3V3Z M7 3v6h10V3 M7 21v-8h10v8',
  image: 'M3 3h18v18H3Z M3 17l6-6 5 5 3-3 4 4 M16 7h.01',
  plus: 'M12 5v14 M5 12h14', split: 'M3 4h18v16H3Z M12 4v16',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10 M12 11v2',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  close: 'M6 6l12 12 M6 18L18 6', check: 'M5 12l4 4L19 6', export: 'M12 16V3 M7 8l5-5 5 5 M4 14v7h16v-7',
}
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
