// GitHub gemoji, MIT. Dataset source and license are kept beside the bundled JSON.
// https://github.com/github/gemoji/blob/master/db/emoji.json
import data from './emoji-shortcodes.json'

export interface EmojiEntry { name: string; emoji: string; description: string; tags: string[] }
export const emojiEntries: readonly EmojiEntry[] = data
const byName = new Map(emojiEntries.map((entry) => [entry.name, entry]))

export function emojiForShortcode(name: string): EmojiEntry | undefined { return byName.get(name) }

export function completeEmoji(query: string, limit = 12): EmojiEntry[] {
  const needle = query.toLowerCase()
  const exact = byName.get(needle)
  const prefix = emojiEntries.filter((entry) => entry.name.startsWith(needle) && entry !== exact).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
  const matches = emojiEntries.filter((entry) => !entry.name.startsWith(needle) && (entry.name.includes(needle) || entry.tags.some((tag) => tag.includes(needle)) || entry.description.includes(needle)))
  return [...(exact ? [exact] : []), ...prefix, ...matches].slice(0, Math.max(0, limit))
}
